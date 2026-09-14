// flow/self_iterate.js —— 自迭代：复盘已跑轮次，产出下一轮参数包 opt_points/rN+1
// 用法：node app/flow/self_iterate.js r1   → 分析 runs/r1..（全部已跑轮）→ 生成 opt_points/r2/
//
// 本版改为「DFS 剪枝式归因」（原版是"把整条长链一次性倒给一个 LLM 全局重推"）。
//   裁据层（attribution.js，确定性、业务可见）先把每段便宜判据当场裁好：
//     pricing / pricing_dead / merchant_not_publish → 归 ② 激励/lead；demand → 归 ① 选品研判（需求/用户群匹配）。
//   这里只把这些"已裁好的归属 + 裁剩窄空间的证据"喂给模型，要求它按段改、不回头改已排除的段。
//
// 可见性协议（判据：真实选品负责人能看到什么；硬编码在本文件，优化侧无其他入口）：
//   可见：大单品/簇清单/三份市场数据；各轮的选品卡、激励方案、下发包、
//         商家发布行为（发/没发，剥掉内心理由 why）、发布的品与销量（含分群明细）、破零率。
//   不可见：真值（_ground_truth）、消费者/商家画像、trust、商家内心 why、上帝侧 alerts、评卷 matrix。
//   防作弊：本文件绝对不读 _ground_truth.json、merchants.json 画像、consumer_groups.json、analyze 上帝 alerts。
//           跨轮聚合（抹噪声）只用业务可见销量；字面重放是哪里的 god-view 诊断，不进这里。
//
// 能改什么（和 main_link ①② 优化点一致，只有这两处）：
//   - 研判经验条目（judgment_experience.md）
//   - 激励权衡口径（incentive_prompt.md）
// 改不了（代码写死）：输出格式/字段、ROI 硬上限、环境、流程。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { callLLMJson } from '../llm/qodercli.js';
import { bjNow } from '../lib/time.js';
import { ZERO_BREAK_THRESHOLD } from '../lib/consts.js';
import { businessRelations } from '../lib/ontology_context.js';
import { ensureAttribution, aggregateAcrossRounds } from './attribution.js';
import { buildLedger, readLedger, writeLedger } from './improvement_ledger.js';

const APP_DIR = new URL('..', import.meta.url).pathname;

const round = process.argv[2];
if (!/^r\d+$/.test(round ?? '')) {
  console.error('用法：node app/flow/self_iterate.js rN（分析截至 rN 的全部轮次，产出 rN+1 参数包）');
  process.exit(1);
}
const n = Number(round.slice(1));
const nextRound = `r${n + 1}`;

// ---------- 读市场数据（业务可见，与 ①选品研判 同一份；只取各轮候选并集） ----------

function readJson(p) { return JSON.parse(readFileSync(p, 'utf8')); }
function readCandidates(r) {
  try { return readJson(join(APP_DIR, 'runs', r, 'snap_0.json')).candidates ?? []; } catch { return []; }
}

// 收集 r1..rN 已跑轮的裁据（有 attribution.json 用文件，老轮没有则从快照现算）
const attrs = [];
const candidatesSeen = new Set();
for (let i = 1; i <= n; i++) {
  const r = `r${i}`;
  if (!existsSync(join(APP_DIR, 'runs', r))) continue;
  for (const c of readCandidates(r)) candidatesSeen.add(c);
  attrs.push(ensureAttribution(r)); // ensureAttribution：老轮无文件则现算
}
if (attrs.length === 0) {
  console.error(`runs/ 下没有可分析的轮次（r1..${round}）`);
  process.exit(1);
}

// 跨轮聚合（抹噪声：只用观察销量；kids 4/2/1 → 判"稳定不破零→demand"，别拿单轮波动当价格信号）
const aggregation = aggregateAcrossRounds(attrs);

// 改进点台账：读上轮、合并本轮、给下一轮
const prevLedger = readLedger(round);
const ledger = buildLedger(attrs, prevLedger);

// 当前参数包 = 本轮实际用的（有 opt_points/rN 用它，否则 init）
const curOptDir = existsSync(join(APP_DIR, 'opt_points', round))
  ? join(APP_DIR, 'opt_points', round)
  : join(APP_DIR, 'opt_points', 'init');
const curExperience = readFileSync(join(curOptDir, 'judgment_experience.md'), 'utf8');
const curIncentive = readFileSync(join(curOptDir, 'incentive_prompt.md'), 'utf8');

const heroItem = readJson(join(APP_DIR, 'data/hero_item.json'));
const allClusters = readJson(join(APP_DIR, 'data/clusters.json'));
const clusters = candidatesSeen.size ? allClusters.filter((c) => candidatesSeen.has(c.cluster_id)) : allClusters;
const bySeen = (rows) => (candidatesSeen.size ? rows.filter((r) => candidatesSeen.has(r.cluster_id)) : rows);
const onSiteSales = bySeen(readJson(join(APP_DIR, 'data/on_site_sales.json')));
const offSiteSales = bySeen(readJson(join(APP_DIR, 'data/off_site_sales.json')));
const offSiteDemand = bySeen(readJson(join(APP_DIR, 'data/off_site_demand.json')));

// ---------- 把裁据表压缩成给 LLM 的视图（只留业务可见字段） ----------

const PRUNE_LABEL = {
  broke: '破零（无需归因）',
  merchant_not_publish: '商家没接（→归②激励/lead）',
  pricing_dead: '价格死局（成本>竞对卖价，→归①别推）',
  pricing: '价格/引导问题（→归②激励/lead）',
  demand: '需求/用户群匹配（→归①选品研判）',
};

const attrView = attrs.map((a) => ({
  round: a.round,
  alerts: a.alerts, // 优化侧确定性 alerts
  clusters: a.clusters.map((c) => ({
    cluster_id: c.cluster_id,
    published: c.published,
    pay: c.pay,
    competitor_mid: c.competitor_mid,
    sales_7d: c.sales_7d,
    broke: c.broke,
    pruned_at: c.pruned_at,
  })),
}));

// 裁剩的 demand 空间：每个色簇的分群销量（攻"用户群匹配"的直接依据）
const demandEvidence = attrs.flatMap((a) => a.clusters
  .filter((c) => c.pruned_at === 'demand')
  .map((c) => ({ round: a.round, cluster_id: c.cluster_id, pay: c.pay, competitor_mid: c.competitor_mid, sales: c.sales_7d, sales_by_group: c.evidence })));

// 上一轮 changelog（若无则提示用初始参数包）
const prevChangelog = existsSync(join(APP_DIR, 'opt_points', round, 'changelog.md'))
  ? readFileSync(join(APP_DIR, 'opt_points', round, 'changelog.md'), 'utf8')
  : '（本轮用初始参数包，无改动记录）';

// ---------- 组 prompt ----------

const prompt = [
  '你是出海电商平台"大单品配件选品"业务的负责人，正在做一轮实验复盘。',
  `破零率 = 破零品数 ÷ 下发包数（新品发布后 7 日销量 ≥ ${ZERO_BREAK_THRESHOLD} = 破零；下发了但商家不发 = 直接计 0）。`,
  '目标看两项：主项是破零率一轮比一轮高；率相同时比破零品数——3 推破 1 和 6 推破 2 同率，但后者更好。少推保率不是本事，多推多破才是。',
  '',
  '# 归因已经由裁据层帮你剪好（DFS 剪枝：先裁掉能裁的分支，别再去从头反推整条链）',
  '系统已用确定性规则把每个"没破零的簇"裁据定位到归属段，你不用再猜凶手在哪。三段判据：',
  '- 引导/定价段：商家上架后实付（定价−补贴）压进竞对价格带了吗？没进→裁到②激励/lead（给死目标价+留上浮余量）',
  '- 价格死局段：平台成本线高于竞对最高卖价→裁到①别推这种簇（信号全对也破不了零）',
  '- 成交段：实付已进竞对带还卖不动→裁到①需求/用户群匹配（剩下的硬空间，重点攻这里）',
  '**你的任务不是重新做整条链的全局归因，而是接着被裁据留下的窄空间往下修。** 每条改动都要注明"这是裁据层裁到哪段、补的哪块"；已经被裁据排除的段不要回头乱改。',
  '',
  '# 你能调什么（只有这两处，其他都动不了）',
  '1. 研判经验条目：给"选品研判"环节的判断知识（怎么解读三份数据、什么值得推）——主要接住 ① 被裁到 demand 的簇：需求/用户群匹配、绝对量级',
  '2. 激励权衡口径：给"价格激励"环节的补贴权衡方式（补多深、说辞口径）——主要接住 ② 被裁到 pricing/pricing_dead/merchant_not_publish 的簇：给死目标价+留上浮余量',
  '硬约束（代码写死，不用你管也改不了）：输出格式固定；补贴 ROI 上限 = 0.3 × 竞对价格带中位数，超线自动打回。',
  '',
  '# 归因裁据表（每轮每个下发簇被裁到哪段）',
  JSON.stringify(attrView, null, 2),
  '',
  '# 确定性 alerts（从数据当场各归其位，不是上帝视角）',
  attrs.flatMap((a) => a.alerts.map((x) => `- [${a.round}] ${x}`)).join('\n') || '- （本轮没有裁出的引导失效/价格死局 alert）',
  '',
  '# 跨轮聚合（抹噪声：同簇多轮销量；判断"不破零"是稳定性质还是噪声毛刺）',
  JSON.stringify(aggregation, null, 2),
  '',
  '# 裁剩的 demand 空间 ——每个簇的分群销量（攻"用户群匹配"的直接依据；谁在买、谁不买）',
  JSON.stringify(demandEvidence, null, 2),
  '',
  '# 改进点台账（最近一轮的待攻项 + 状态；看看上一轮说修什么、这轮有没有验证）',
  JSON.stringify(ledger, null, 2),
  '',
  '# 业务本体与关系（业务背景常识：这门生意里有什么、谁影响谁；归因沿这些关系走）',
  businessRelations(),
  '',
  `# 大单品：${heroItem.item_id}；配件簇清单（各轮候选并集）`,
  JSON.stringify(clusters),
  '',
  '# 三份市场数据（与选品研判环节看到的同一份，同为业务可见；仅在要写"怎么读数据/什么值得推"的经验时参考）',
  '## 站内销售（我们平台，群×簇×周；有流量没订单=有兴趣没供给）',
  JSON.stringify(onSiteSales),
  '## 站外销售（竞对平台，簇×国家×周；含竞对价格带 price_band）',
  JSON.stringify(offSiteSales),
  '## 站外需求（社媒/搜索/痛点帖，簇×国家×周）',
  JSON.stringify(offSiteDemand),
  '',
  '# 当前生效的参数包',
  '## 研判经验（现行版）',
  curExperience,
  '## 激励口径（现行版）',
  curIncentive,
  '',
  '# 上一轮参数改动记录',
  prevChangelog,
  '',
  '# 你的任务',
  `1. 按裁据表给的分段归属复盘：哪些判断对、哪些错。证据用 裁据表里的字段 + demand 证据 + 跨轮聚合（别只对着一个破零数字猜）。`,
  '2. 修订两个参数文件：主项抬破零率；率相同时多推多破（覆盖更多真机会），别收缩到只剩最稳的几个保率。',
  '3. 每块改动都写成"这段是针对哪里的（demand/pricing/pricing_dead/merchant_not_publish）+ 改了什么 + 为什么（拿哪轮哪簇哪个裁据作证据）"。',
  '',
  '# 复盘纪律',
  '- 只依据下面给你的数据归纳，不要臆测你看不到的东西（消费者的具体画像、商家的内心想法、真值都看不到——现实里你也看不到）',
  '- 复盘结论分点写，每点就说一件事、一两句大白话说清，不要用分号把一堆事拼成长句，不要堆术语，<=3 点',
  '- 所有输出写给不懂技术的业务同学看：句子里不要夹英文字段名（说"信心"不说 confidence、说"补贴"不说 subsidy）；簇名可以用中文叫法，后面括号带英文 id；引用经验条目用 E 编号没问题',
  '- 改动清单按两块分开写：选品研判经验的改动、价格激励口径的改动',
  '- 经验条目保持 E1/E2/... 编号，条目只写"怎么判断"，写大白话',
  '- 选品经验的依据只能用研判时看得到的数据：三份市场数据、簇价位带、竞对价格带。补贴金额、补贴上限这类激励环节的数字不要写进选品经验',
  '- **经验条目总数不超过 8 条**：每轮先把现有条目全部审一遍——说的是同一件事的合并成一条，被证伪的、用不上的删掉，然后才考虑新增；合并和删除也要写进 changes',
  '- 场景限定：3C 消费电子 - 大单品配件，出海电商，不要写超出这个场景的经验',
  '',
  '# 输出要求（固定格式，不许改）',
  '只输出 JSON，不要其他文字；JSON 字符串值里不要出现英文双引号（引用条目名/词语用中文引号「」或不加引号），不然 JSON 解析会失败。格式：',
  '{"analysis_points":["复盘结论点1（一两句大白话）","..."],"selection_changes":["选品研判经验改动1：这段是针对 demand 的+改了什么+为什么","..."],"incentive_changes":["价格激励口径改动1：这段是针对 pricing/pricing_dead 的+改了什么+为什么","..."],"judgment_experience_md":"新版研判经验完整 markdown 全文","incentive_prompt_md":"新版激励口径完整 markdown 全文"}',
  '（某一块没改动就给空数组，但两块不能都空）',
].join('\n');

// ---------- 调 LLM + 校验 + 写下一轮参数包 ----------

const logFile = join(APP_DIR, 'runs', round, 'logs', 'iterate.log');

const out = await callLLMJson(prompt, {
  label: `iterate_${round}`,
  logFile,
  validate: (o) => {
    if (!Array.isArray(o.analysis_points) || o.analysis_points.length === 0) throw new Error('缺 analysis_points（分点复盘结论）');
    if (!Array.isArray(o.selection_changes) || !Array.isArray(o.incentive_changes)) throw new Error('缺 selection_changes / incentive_changes（选品、激励改动分开写）');
    if (o.selection_changes.length === 0 && o.incentive_changes.length === 0) throw new Error('两块改动不能都为空');
    if (typeof o.judgment_experience_md !== 'string' || !/E\d/.test(o.judgment_experience_md)) throw new Error('judgment_experience_md 缺失或没有 E 编号条目');
    const entryCount = (o.judgment_experience_md.match(/\|\s*E\d+\s*\|/g) ?? []).length;
    if (entryCount > 8) throw new Error(`经验条目 ${entryCount} 条，超过上限 8 条，先合并/删除再新增`);
    if (typeof o.incentive_prompt_md !== 'string' || o.incentive_prompt_md.trim().length < 50) throw new Error('incentive_prompt_md 缺失或过短');
  },
});

const nextDir = join(APP_DIR, 'opt_points', nextRound);
mkdirSync(nextDir, { recursive: true });
writeFileSync(join(nextDir, 'judgment_experience.md'), out.judgment_experience_md);
writeFileSync(join(nextDir, 'incentive_prompt.md'), out.incentive_prompt_md);
writeFileSync(join(nextDir, 'ledger.json'), JSON.stringify(ledger, null, 2)); // 改进点台账随参数包走
writeFileSync(join(nextDir, 'changelog.md'), [
  `# ${nextRound} 参数包改动记录（${bjNow()}，由自迭代基于 ${attrs.map((a) => a.round).join('/')} 复盘生成）`,
  '',
  '## 复盘结论',
  ...out.analysis_points.map((p) => `- ${p}`),
  '',
  '## 归因裁据摘要（DFS 剪枝：每簇裁到哪段）',
  ...ledger.map((l) => `- ${l.cluster_id}：多数轮次裁到 ${PRUNE_LABEL[l.pruned_at]}（出现 ${l.appearances} 轮），台账状态 ${l.status}${l.residual ? `；${l.residual}` : ''}`),
  '',
  '## 改动清单 · 选品研判经验',
  ...(out.selection_changes.length ? out.selection_changes.map((c, i) => `${i + 1}. ${c}`) : ['（本轮未改）']),
  '',
  '## 改动清单 · 价格激励口径',
  ...(out.incentive_changes.length ? out.incentive_changes.map((c, i) => `${i + 1}. ${c}`) : ['（本轮未改）']),
  '',
].join('\n'));

// 写回当前轮 ledger 的"已处理"标记，交给下一轮追踪（台账主体已随参数包落盘 rN+1，这里只是把 rN 的引用更新）
writeLedger(round, ledger.map((l) => ({ ...l, status: out.selection_changes.length + out.incentive_changes.length ? 'patched' : l.status })));

console.log(`自迭代完成：opt_points/${nextRound}/ 已生成（含 ledger.json 台账）`);
console.log(`归因裁据：\n${ledger.map((l) => `  - ${l.cluster_id} → ${PRUNE_LABEL[l.pruned_at]}`).join('\n')}`);
console.log(`复盘结论：\n${out.analysis_points.map((p) => `  - ${p}`).join('\n')}`);
console.log(`选品改动：\n${(out.selection_changes.length ? out.selection_changes : ['（无）']).map((c, i) => `  ${i + 1}. ${c}`).join('\n')}`);
console.log(`激励改动：\n${(out.incentive_changes.length ? out.incentive_changes : ['（无）']).map((c, i) => `  ${i + 1}. ${c}`).join('\n')}`);