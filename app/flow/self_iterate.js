// flow/self_iterate.js —— 自迭代：复盘已跑轮次，产出下一轮参数包 opt_points/rN+1
// 用法：node app/flow/self_iterate.js r1   → 分析 runs/r1..（全部已跑轮）→ 生成 opt_points/r2/
//
// 可见性协议（判据：真实选品负责人能看到什么；硬编码在本文件，优化侧无其他入口）：
//   可见：大单品/簇清单/三份市场数据；各轮的 选品卡、激励方案、下发包、
//         商家发布行为（发/没发，剥掉内心理由 why）、发布的品与销量（含分群明细）、破零率
//   不可见：消费者画像、商家画像与 trust、LLM 决策/打分理由（logs）、data/_ground_truth.json
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

const APP_DIR = new URL('..', import.meta.url).pathname;

const round = process.argv[2];
if (!/^r\d+$/.test(round ?? '')) {
  console.error('用法：node app/flow/self_iterate.js rN（分析截至 rN 的全部轮次，产出 rN+1 参数包）');
  process.exit(1);
}
const n = Number(round.slice(1));
const nextRound = `r${n + 1}`;

// ---------- 构建可见视图 ----------

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

// 某一轮的可见结果（剥掉不可见字段）
function visibleRound(r) {
  const dir = join(APP_DIR, 'runs', r);
  if (!existsSync(dir)) return null;
  const s0 = readJson(join(dir, 'snap_0.json'));
  const s1 = readJson(join(dir, 'snap_1_a1_selection.json'));
  const s2 = readJson(join(dir, 'snap_2_a2_incentive.json'));
  const s3 = readJson(join(dir, 'snap_3_a3_dispatch.json'));
  const s4 = readJson(join(dir, 'snap_4_a4_merchant.json'));
  const s5 = readJson(join(dir, 'snap_5_a5_consumer.json'));
  const s6 = readJson(join(dir, 'snap_6_settle.json'));
  return {
    round: r,
    candidates: s0.candidates ?? [], // 该轮平台圈选的候选簇（业务可见）
    selection_cards: s1.selection_cards,
    incentives: s2.incentives,
    dispatched_packages: s3.dispatch_packages.map((p) => ({
      package_id: p.package_id, cluster_id: p.cluster.cluster_id, reason: p.reason, lead: p.lead, subsidy: p.subsidy,
    })),
    merchant_publish: s4.merchant_decisions.map((d) => ({
      merchant_id: d.merchant_id, package_id: d.package_id, publish: d.publish, // why 不可见
    })),
    products: s5.products_with_sales, // 发布的品是公开信息（价格/补贴/销量）
    sales_by_group: s5.sales_by_group, // 自家平台订单，可拆人群
    settle: { dispatched: s6.dispatched, published: s6.published, broke_zero: s6.broke_zero, zero_break_rate: s6.zero_break_rate }, // trust_updates 不可见
    changelog: existsSync(join(APP_DIR, 'opt_points', r, 'changelog.md'))
      ? readFileSync(join(APP_DIR, 'opt_points', r, 'changelog.md'), 'utf8')
      : '（本轮用初始参数包，无改动记录）',
  };
}

// 收集 r1..rN 全部已跑轮
const history = [];
for (let i = 1; i <= n; i++) {
  const v = visibleRound(`r${i}`);
  if (v) history.push(v);
}
if (history.length === 0) {
  console.error(`runs/ 下没有可分析的轮次（r1..${round}）`);
  process.exit(1);
}

// 当前参数包 = 本轮实际用的（有 opt_points/rN 用它，否则 init）
const curOptDir = existsSync(join(APP_DIR, 'opt_points', round))
  ? join(APP_DIR, 'opt_points', round)
  : join(APP_DIR, 'opt_points', 'init');
const curExperience = readFileSync(join(curOptDir, 'judgment_experience.md'), 'utf8');
const curIncentive = readFileSync(join(curOptDir, 'incentive_prompt.md'), 'utf8');

// 市场数据（和 ①选品研判 看到的完全同一份，不做二次加工）
// 只给历史各轮候选的并集——没进过候选的簇，研判从没见过，给了也是无关数据
const heroItem = readJson(join(APP_DIR, 'data/hero_item.json'));
const seenSet = new Set(history.flatMap((h) => h.candidates));
const allClusters = readJson(join(APP_DIR, 'data/clusters.json'));
const clusters = seenSet.size ? allClusters.filter((c) => seenSet.has(c.cluster_id)) : allClusters;
const bySeen = (rows) => (seenSet.size ? rows.filter((r) => seenSet.has(r.cluster_id)) : rows);
const onSiteSales = bySeen(readJson(join(APP_DIR, 'data/on_site_sales.json')));
const offSiteSales = bySeen(readJson(join(APP_DIR, 'data/off_site_sales.json')));
const offSiteDemand = bySeen(readJson(join(APP_DIR, 'data/off_site_demand.json')));

// ---------- 组 prompt ----------

const prompt = [
  '你是出海电商平台"大单品配件选品"业务的负责人，正在做一轮实验复盘。',
  `破零率 = 破零品数 ÷ 下发包数（新品发布后 7 日销量 ≥ ${ZERO_BREAK_THRESHOLD} = 破零；下发了但商家不发 = 直接计 0）。`,
  '目标看两项：主项是破零率一轮比一轮高；率相同时比破零品数——3 推破 1 和 6 推破 2 同率，但后者更好。少推保率不是本事，多推多破才是。',
  '候选机制：平台每期从大类目池里圈选一批候选品类给选品研判，**每轮候选不同**（上轮推过的簇这轮可能不在候选里）。所以经验要写成对任何品类组合都适用的判断方法，不要绑死在某几个具体簇上。',
  '',
  '# 你能调什么（只有这两处，其他都动不了）',
  '1. 研判经验条目：给"选品研判"环节的判断知识（怎么解读三份数据、什么值得推）',
  '2. 激励权衡口径：给"价格激励"环节的补贴权衡方式（补多深、说辞口径）',
  '硬约束（代码写死，不用你管也改不了）：输出格式固定；补贴 ROI 上限 = 0.3 × 竞对价格带中位数，超线自动打回。',
  '',
  '# 复盘纪律',
  '- 只依据下面给你的数据归纳，不要臆测你看不到的东西（消费者的具体画像、商家的内心想法都看不到——现实里你也看不到）',
  '- 复盘结论分点写，每点就说一件事、一两句大白话说清，不要用分号把一堆事拼成长句，不要堆术语，<=3 点',
  '- 所有输出写给不懂技术的业务同学看：句子里不要夹英文字段名（说"信心"不说 confidence、说"理由"不说 reason、说"补贴"不说 subsidy）；簇名可以用中文叫法（如"臂带"），后面括号带英文 id；引用经验条目用 E 编号没问题',
  '- 改动清单按两块分开写：选品研判经验的改动、价格激励口径的改动；每条说清"改了什么 + 为什么（拿哪轮哪个品的结果作证据）"',
  '- 经验条目保持 E1/E2/... 编号，条目只写"怎么判断"，写大白话',
  '- 选品经验的依据只能用研判时看得到的数据：三份市场数据、簇价位带、竞对价格带。补贴金额、补贴上限这类激励环节的数字不要写进选品经验——价格问题用「我们价位带远超竞对价格带」这类表述；补贴怎么权衡写进激励口径那份文件',
  '- **经验条目总数不超过 8 条**：每轮先把现有条目全部审一遍——说的是同一件事的合并成一条，被证伪的、用不上的删掉，然后才考虑新增；合并和删除也要写进 changes（删了哪条、并到哪条、为什么）',
  '- 场景限定：3C 消费电子 - 大单品配件，出海电商，不要写超出这个场景的经验',
  '',
  '# 业务本体与关系（业务背景常识：这门生意里有什么、谁影响谁；归因沿这些关系走）',
  businessRelations(),
  '',
  `# 大单品：${heroItem.item_id}；配件簇清单`,
  JSON.stringify(clusters),
  '',
  '# 三份市场数据（与选品研判环节看到的同一份）',
  '## 站内销售（我们平台，群×簇×周；有流量没订单=有兴趣没供给）',
  JSON.stringify(onSiteSales),
  '## 站外销售（竞对平台，簇×国家×周）',
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
  '# 各轮运行结果（按轮次先后）',
  ...history.map((h) => [
    `## ${h.round}（破零率 ${h.settle.zero_break_rate}，破零品数 ${h.settle.broke_zero}：下发 ${h.settle.dispatched}，发布 ${h.settle.published}）`,
    `本轮候选池（平台本期圈选）：${h.candidates.join('、') || '（全量）'}`,
    `本轮参数改动记录：${h.changelog}`,
    `选品卡：${JSON.stringify(h.selection_cards)}`,
    `激励：${JSON.stringify(h.incentives)}`,
    `商家发布行为：${JSON.stringify(h.merchant_publish)}`,
    `发布的品与 7 日销量：${JSON.stringify(h.products)}`,
    `分群销量：${JSON.stringify(h.sales_by_group)}`,
  ].join('\n')),
  '',
  '# 你的任务',
  '1. 复盘：哪些判断对了、哪些错了（推了没人买？该推没推？商家不接？补贴没起作用？），证据是什么',
  '2. 修订两个参数文件：主项抬破零率；率相同时想办法多推多破（覆盖更多真机会），别收缩到只剩最稳的几个保率',
  '',
  '# 输出要求（固定格式，不许改）',
  '只输出 JSON，不要其他文字；JSON 字符串值里不要出现英文双引号（引用条目名/词语用中文引号「」或不加引号），不然 JSON 解析会失败。格式：',
  '{"analysis_points":["复盘结论点1（一两句大白话）","..."],"selection_changes":["选品研判经验改动1：改了什么+为什么","..."],"incentive_changes":["价格激励口径改动1：改了什么+为什么","..."],"judgment_experience_md":"新版研判经验完整 markdown 全文","incentive_prompt_md":"新版激励口径完整 markdown 全文"}',
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
writeFileSync(join(nextDir, 'changelog.md'), [
  `# ${nextRound} 参数包改动记录（${bjNow()}，由自迭代基于 ${history.map((h) => h.round).join('/')} 复盘生成）`,
  '',
  '## 复盘结论',
  ...out.analysis_points.map((p) => `- ${p}`),
  '',
  '## 改动清单 · 选品研判经验',
  ...(out.selection_changes.length ? out.selection_changes.map((c, i) => `${i + 1}. ${c}`) : ['（本轮未改）']),
  '',
  '## 改动清单 · 价格激励口径',
  ...(out.incentive_changes.length ? out.incentive_changes.map((c, i) => `${i + 1}. ${c}`) : ['（本轮未改）']),
  '',
].join('\n'));

console.log(`自迭代完成：opt_points/${nextRound}/ 已生成`);
console.log(`复盘结论：\n${out.analysis_points.map((p) => `  - ${p}`).join('\n')}`);
console.log(`选品改动：\n${(out.selection_changes.length ? out.selection_changes : ['（无）']).map((c, i) => `  ${i + 1}. ${c}`).join('\n')}`);
console.log(`激励改动：\n${(out.incentive_changes.length ? out.incentive_changes : ['（无）']).map((c, i) => `  ${i + 1}. ${c}`).join('\n')}`);
