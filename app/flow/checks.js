// flow/checks.js —— 每轮执行过程的强规则校验（纯代码断言）+ 研判评卷（对照真值）+ 数据构造检查
// 被 report.js 调用。这些是"提前知道一定会执行/成立"的模拟合规项，机器查比人查可靠。
// 每个校验项带 node 归属（a1~a5 / round），报告按节点分组展示。
// 评卷用 _ground_truth.json（上帝侧），只进报告，不回流优化。

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ZERO_BREAK_THRESHOLD } from '../lib/consts.js';
import { competitorMid } from '../lib/market.js';

const APP_DIR = new URL('..', import.meta.url).pathname;

function readJson(p) { return JSON.parse(readFileSync(p, 'utf8')); }
// 无竞对数据时回退簇价位带中点（与 a2 同口径，用于重算 ROI 上限）
const clusterMidFallback = (cluster) => (cluster.price_range.min + cluster.price_range.max) / 2;

// 对一轮做全部强规则校验；返回 { items: [{name, pass, note}], matrix: [{cluster, verdict, expect, grade}] }
export function runChecks(round) {
  const dir = join(APP_DIR, 'runs', round);
  const items = [];
  const add = (node, name, pass, note = '') => items.push({ node, name, pass, note });

  // 0. 快照序列完整（轮级）
  const snapFiles = ['snap_0.json', 'snap_1_a1_selection.json', 'snap_2_a2_incentive.json',
    'snap_3_a3_dispatch.json', 'snap_4_a4_merchant.json', 'snap_5_a5_consumer.json', 'snap_6_settle.json'];
  const missing = snapFiles.filter((f) => !existsSync(join(dir, f)));
  add('round', '快照序列完整（snap_0~6 + logs）', missing.length === 0 && existsSync(join(dir, 'logs')),
    missing.length ? `缺 ${missing.join('、')}` : '');
  if (missing.length) return { items, matrix: [] }; // 快照不齐，后面没法查

  // 0.5 归因裁据表存在（advisory：老轮次改造前跑的无此文件不阻断，展示为"待补算"）
  add('round', '归因裁据表存在（attribution.json）', existsSync(join(dir, 'attribution.json')),
    existsSync(join(dir, 'attribution.json')) ? '' : '改造前跑的老轮无此文件，报告/自迭代会从快照现算');

  // 0.5b 归因产物无上帝字段泄漏（advisory：attribution.json / improvement_points.json 只许含业务可见字段）
  const attrFiles = ['attribution.json', 'improvement_points.json'].filter((f) => existsSync(join(dir, f)));
  const attrLeak = [];
  for (const f of attrFiles) {
    const raw = readFileSync(join(dir, f), 'utf8');
    if (/_ground_truth|"role"|"expect"/.test(raw)) attrLeak.push(`${f}: 疑似上帝真值`);
    if (/trust_updates|"trust"/.test(raw)) attrLeak.push(`${f}: trust 数值`);
    if (/"why"/.test(raw)) attrLeak.push(`${f}: 商家内心 why`);
    if (/base_cvr|cluster_pv_predict/.test(raw)) attrLeak.push(`${f}: 消费者画像`);
  }
  add('round', '归因产物不含上帝视角字段', attrLeak.length === 0, attrLeak.join('；'));

  const s0 = readJson(join(dir, 'snap_0.json'));
  const s1 = readJson(join(dir, 'snap_1_a1_selection.json'));
  const s2 = readJson(join(dir, 'snap_2_a2_incentive.json'));
  const s3 = readJson(join(dir, 'snap_3_a3_dispatch.json'));
  const s4 = readJson(join(dir, 'snap_4_a4_merchant.json'));
  const s5 = readJson(join(dir, 'snap_5_a5_consumer.json'));
  const s6 = readJson(join(dir, 'snap_6_settle.json'));
  const clusters = readJson(join(APP_DIR, 'data/clusters.json'));
  const offSiteSales = readJson(join(APP_DIR, 'data/off_site_sales.json'));
  const truth = readJson(join(APP_DIR, 'data/_ground_truth.json'));

  // 1. 每个候选簇一张选品卡（a1）——研判范围 = snap_0 圈选的候选（老快照无 candidates 则对照全量簇）
  const candidates = s0.candidates ?? clusters.map((c) => c.cluster_id);
  const want = [...candidates].sort().join(',');
  const got = [...new Set(s1.selection_cards.map((c) => c.cluster_id))].sort().join(',');
  add('a1', '每个候选簇一张选品卡，不多不少', want === got, want === got ? '' : `候选 [${want}]，实际 [${got}]`);

  // 2. 激励与推卡一一对应（a2）
  const pushedIds = s1.selection_cards.filter((c) => c.verdict === '推').map((c) => c.card_id).sort().join(',');
  const incIds = [...new Set(s2.incentives.map((i) => i.card_id))].sort().join(',');
  add('a2', '激励与"推"的卡一一对应', pushedIds === incIds, pushedIds === incIds ? '' : `推卡 [${pushedIds}] vs 激励 [${incIds}]`);

  // 3. ROI 硬上限真的守住了（重算，a2）
  const clusterMapForRoi = Object.fromEntries(clusters.map((c) => [c.cluster_id, c]));
  const roiBad = s2.incentives.filter((i) => i.subsidy > 0.3 * competitorMid(offSiteSales, i.cluster_id, clusterMidFallback(clusterMapForRoi[i.cluster_id])) + 1e-9);
  add('a2', '补贴 ROI 上限（≤0.3×竞对中位价）', roiBad.length === 0,
    roiBad.length ? roiBad.map((i) => `${i.cluster_id} 补 ${i.subsidy} 超线`).join('；') : '');

  // 3.5 下发包与激励一一对应、携带内容完整（a3）
  const pkgIds = [...new Set(s3.dispatch_packages.map((p) => p.card_id))].sort().join(',');
  const pkgWhole = s3.dispatch_packages.every((p) => p.cluster && p.reason && p.lead && typeof p.subsidy === 'number');
  add('a3', '下发包与激励一一对应，簇/理由/说辞/补贴齐全', pkgIds === incIds && pkgWhole,
    pkgIds !== incIds ? `激励 [${incIds}] vs 下发 [${pkgIds}]` : (pkgWhole ? '' : '有包缺字段'));

  // 4. 单商家单轮最多发 2 个（a4）
  const byMerchant = {};
  for (const d of s4.merchant_decisions) if (d.publish) byMerchant[d.merchant_id] = (byMerchant[d.merchant_id] ?? 0) + 1;
  const capBad = Object.entries(byMerchant).filter(([, n]) => n > 2);
  add('a4', '单商家一轮最多接 2 个新品', capBad.length === 0, capBad.map(([m, n]) => `${m} 发了 ${n} 个`).join('；'));

  // 5. 定价在合理区间 [成本线, 上限×1.3]（a4）
  const clusterMap = Object.fromEntries(clusters.map((c) => [c.cluster_id, c]));
  const priceBad = s5.products_with_sales.filter((p) => {
    const r = clusterMap[p.cluster_id].price_range;
    return p.price < r.min || p.price > r.max * 1.3;
  });
  add('a4', '商家定价在 [成本线, 上限×1.3] 内', priceBad.length === 0,
    priceBad.map((p) => `${p.cluster_id} 定价 ${p.price}`).join('；'));

  // 6. 每簇最多一个新品（a4）
  const clusterCnt = {};
  for (const p of s5.products_with_sales) clusterCnt[p.cluster_id] = (clusterCnt[p.cluster_id] ?? 0) + 1;
  const dupBad = Object.entries(clusterCnt).filter(([, n]) => n > 1);
  add('a4', '每簇最多一个新品', dupBad.length === 0, dupBad.map(([c, n]) => `${c} 有 ${n} 个品`).join('；'));

  // 7. 破零率结算正确（重算对照，a5）
  const broke = s5.products_with_sales.filter((p) => p.sales_7d >= ZERO_BREAK_THRESHOLD).length;
  const rate = s3.dispatch_packages.length === 0 ? 0 : +(broke / s3.dispatch_packages.length).toFixed(4);
  add('a5', '破零率结算正确（重算一致）', broke === s6.broke_zero && rate === s6.zero_break_rate,
    `重算 破${broke}/率${rate} vs 结算 破${s6.broke_zero}/率${s6.zero_break_rate}`);

  // 8. trust 更新规则执行正确（重算对照：发的品破零 +0.1 / 未破零 −0.1，夹 [0,1]）
  const trust0 = Object.fromEntries((s0.merchants ?? []).map((m) => [m.merchant_id, m.trust]));
  let trustOk = true; const trustNotes = [];
  for (const t of s6.trust_updates ?? []) {
    const mine = s5.products_with_sales.filter((p) => p.merchant_id === t.merchant_id);
    const didBreak = mine.some((p) => p.sales_7d >= ZERO_BREAK_THRESHOLD);
    const expect = +Math.min(1, Math.max(0, (trust0[t.merchant_id] ?? t.before) + (didBreak ? 0.1 : -0.1))).toFixed(2);
    if (expect !== t.after) { trustOk = false; trustNotes.push(`${t.merchant_id} 应为 ${expect} 实为 ${t.after}`); }
  }
  add('a5', 'trust 更新规则执行正确', trustOk, trustNotes.join('；'));

  // 9. 可见性无泄漏：扫本轮自迭代请求 prompt（若有），不应出现真值/商家内心/trust 数值
  const iterLog = join(dir, 'logs', 'iterate.log');
  if (existsSync(iterLog)) {
    const reqLines = readFileSync(iterLog, 'utf8').split('\n').filter((l) => l.includes('request:'));
    const leaks = [];
    for (const line of reqLines) {
      if (line.includes('_ground_truth') || line.includes('"role"') || line.includes('"expect"')) leaks.push('疑似真值内容');
      if (line.includes('"why"')) leaks.push('商家决策内心（why）');
      if (line.includes('"trust"') || line.includes('trust_updates')) leaks.push('trust 数值');
      if (line.includes('base_cvr') || line.includes('cluster_pv_predict')) leaks.push('消费者画像');
    }
    add('round', '可见性无泄漏（自迭代 prompt 扫描）', leaks.length === 0, [...new Set(leaks)].join('；'));
  } else {
    add('round', '可见性无泄漏（自迭代 prompt 扫描）', true, '本轮无自迭代调用（末轮或未迭代）');
  }

  // 研判评卷（对照真值；真值只进报告，不回流优化）
  // 计分逻辑：只罚漏推——推错（陷阱被骗推）会被破零率自然惩罚（推了不破零率就掉），评卷再罚是重复计分；
  //           漏推破零率看不见（没推不进分母），是唯一要真值出面查的盲区。
  //           模糊题没有标准答案，推不推都不计分；不推簇的对错只展示不计分。
  const truthMap = Object.fromEntries(truth.map((t) => [t.cluster_id, t]));
  const shortRole = (role) => (role ?? '').split(/[（(]/)[0].trim(); // "价格死局（…）" → "价格死局"
  const matrix = s1.selection_cards.map((c) => {
    const t = truthMap[c.cluster_id] ?? {};
    const expect = t.expect ?? '';
    const pushed = c.verdict === '推';
    let grade;
    if (expect.startsWith('推')) grade = pushed ? '✓ 推对' : '○ 漏推';
    else if (expect.startsWith('模糊')) grade = pushed ? '推 · 模糊题' : '不推 · 模糊题';
    else if (expect.startsWith('不推')) grade = pushed ? `✗ 推了 · ${shortRole(t.role)}` : `— 避开 · ${shortRole(t.role)}`;
    else grade = '?';
    return { cluster: c.cluster_id, verdict: c.verdict, grade };
  });
  const missed = matrix.filter((m) => m.grade === '○ 漏推').length;
  add('a1', '研判评卷（只罚漏推：推错由破零率惩罚，模糊题不计分）', missed === 0,
    `${matrix.filter((m) => m.grade === '✓ 推对').length} 推对 / ${missed} 漏推；模糊题 ${matrix.filter((m) => m.grade.includes('模糊题')).length} 个；不推簇避开 ${matrix.filter((m) => m.grade.startsWith('—')).length}、被推 ${matrix.filter((m) => m.grade.startsWith('✗')).length}（展示不计分）`);

  return { items, matrix };
}

// ---------- 数据构造检查（02 板块"数据造得像不像真的"） ----------
// 检查方向是实验设计定的（想考察什么就查什么），断言逻辑跟着当前数据格式走；数据一冻结结果就恒定。
// status: 'ok'=通过（符合设计且像真的） / 'warn'=存疑（已知的失真点，主理人要心里有数）
export function runDataChecks() {
  const clusters = readJson(join(APP_DIR, 'data/clusters.json'));
  const onSite = readJson(join(APP_DIR, 'data/on_site_sales.json'));
  const offSales = readJson(join(APP_DIR, 'data/off_site_sales.json'));
  const offDemand = readJson(join(APP_DIR, 'data/off_site_demand.json'));
  const truth = readJson(join(APP_DIR, 'data/_ground_truth.json'));
  const checks = [];
  const add = (status, title, note) => checks.push({ status, title, note });

  // 1. 三份数据簇口径一致、周次连续无缺
  const ids = clusters.map((c) => c.cluster_id).sort().join(',');
  const cover = (rows) => [...new Set(rows.map((r) => r.cluster_id))].sort().join(',');
  const weeks = (rows) => [...new Set(rows.map((r) => r.week))].sort((a, b) => a - b);
  const wOk = [onSite, offSales, offDemand].every((rows) => {
    const w = weeks(rows);
    return w[0] === 1 && w.length === w[w.length - 1];
  });
  const cOk = cover(onSite) === ids && cover(offSales) === ids && cover(offDemand) === ids;
  add(cOk && wOk ? 'ok' : 'warn', '各处数字对得上',
    cOk && wOk ? '站内、竞对、站外三份数据覆盖同一批品类、周次连续，都从同一个需求底表算出来，不会自相矛盾。'
      : '三份数据的品类或周次对不齐，需要检查生成脚本。');

  // 2. 陷阱数据已埋（从真值读设计角色：假爆款/伪需求/价格死局这类"看着行、实际不行"的坑）
  const roles = truth.map((t) => t.role).join('');
  const hasTraps = roles.includes('假爆款') && roles.includes('价格死局') && roles.includes('伪需求');
  add(hasTraps ? 'ok' : 'warn', '有陷阱数据',
    hasTraps ? '有围观客刷高流量的假爆款、营销吹出来的虚火、成本比竞对卖价还高的死局、官方标配挤掉的伪需求——现实选品里都会碰到。'
      : '真值里缺陷阱角色，实验考不出研判的分辨力。');

  // 2.5 边界数据已埋（真值 expect=模糊 的簇：没有标准答案的题，考"信号不清时的判断力"）
  const fuzzyCount = truth.filter((t) => (t.expect ?? '').startsWith('模糊')).length;
  add(fuzzyCount >= 3 ? 'ok' : 'warn', '有边界数据',
    fuzzyCount >= 3 ? `${fuzzyCount} 个模糊题簇（信号打架、波动看不清、量级压线、时机早半拍），推不推都说得过去——这类题不计对错，考的是判断过程像不像真人。`
      : '模糊题簇不足 3 个，考不出"没有标准答案时的判断力"。');

  // 3. 趋势不是一条直线（存在中段回撤 / 末段起跳的形状）
  const series = (rows, cid, field) => {
    const byWeek = {};
    for (const r of rows) if (r.cluster_id === cid) byWeek[r.week] = (byWeek[r.week] ?? 0) + r[field];
    return Object.keys(byWeek).sort((a, b) => a - b).map((k) => byWeek[k]);
  };
  const hasDip = (arr) => arr.some((v, i) => i > 1 && i < arr.length - 2 && v < arr[i - 1] * 0.95 && arr[arr.length - 1] > arr[i]);
  const anyDip = clusters.some((c) => hasDip(series(offDemand, c.cluster_id, 'search_trend')));
  const lateSurge = clusters.some((c) => {
    const s = series(offDemand, c.cluster_id, 'search_trend');
    const head = s.slice(0, Math.floor(s.length * 0.7));
    return Math.max(...head) * 1.8 < s[s.length - 1];
  });
  add(anyDip && lateSurge ? 'ok' : 'warn', '增长不是一条直线',
    anyDip && lateSurge ? '有的品类中段回撤再恢复、有的后期才起量，不是一眼看穿的匀速上升。'
      : '趋势形状偏单调，研判考不出"回撤是喘气还是衰退"的判断力。');

  // 4. 波动有大起大落（检测周环比 >1.5 或 <0.65 的事件周：脉冲/断崖）
  let eventSeries = 0;
  for (const c of clusters) {
    const byCountry = {};
    for (const r of offDemand) if (r.cluster_id === c.cluster_id) (byCountry[r.country] ??= []).push(r);
    for (const rows of Object.values(byCountry)) {
      const s = rows.sort((a, b) => a.week - b.week).map((r) => r.search_trend);
      if (s.some((v, i) => i > 0 && s[i - 1] > 0 && (v / s[i - 1] > 1.5 || v / s[i - 1] < 0.65))) eventSeries++;
    }
  }
  add(eventSeries >= 3 ? 'ok' : 'warn', '波动有大起大落',
    eventSeries >= 3 ? `除均匀小抖动外，${eventSeries} 条序列出现过脉冲或断崖（周环比 ±50%+）——像现实里的促销、断货、被视频带一波。`
      : '所有曲线只有均匀小抖动，没有现实里偶尔的大起大落（脉冲、断崖）。');

  // 5. 信号间不是固定倍数（检测 buzz/search 比值序列的 lag-1 自相关：有漂移则显著 >0，固定倍数+白噪声则≈0）
  const autocorr = (arr) => {
    const n = arr.length;
    const mean = arr.reduce((a, b) => a + b, 0) / n;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) { den += (arr[i] - mean) ** 2; if (i > 0) num += (arr[i] - mean) * (arr[i - 1] - mean); }
    return den === 0 ? 0 : num / den;
  };
  const acs = [];
  for (const c of clusters) {
    const byCountry = {};
    for (const r of offDemand) if (r.cluster_id === c.cluster_id) (byCountry[r.country] ??= []).push(r);
    for (const rows of Object.values(byCountry)) {
      const sorted = rows.sort((a, b) => a.week - b.week);
      const ratio = sorted.map((r) => (r.search_trend > 0 ? r.buzz / r.search_trend : 0));
      acs.push(autocorr(ratio));
    }
  }
  acs.sort((a, b) => a - b);
  const medianAc = acs[Math.floor(acs.length / 2)] ?? 0;
  add(medianAc > 0.25 ? 'ok' : 'warn', '数值是随机的',
    medianAc > 0.25 ? '热度、搜索、竞对销量跟着需求走但各自慢漂移、不完全同步——不是一个数乘出来的。'
      : '各信号按固定倍数跟着需求底表走，比真实市场更"听话"。');

  // 6. 长尾格局（簇数够多 + 头部集中 + 尾部零散：top5 占总需求一半以上、后一半簇合计不足 15%）
  const totals = clusters.map((c) => ({
    id: c.cluster_id,
    t: offDemand.filter((r) => r.cluster_id === c.cluster_id).reduce((a, r) => a + r.search_trend, 0),
  })).sort((a, b) => b.t - a.t);
  const grand = totals.reduce((a, x) => a + x.t, 0);
  const top5Share = grand ? totals.slice(0, 5).reduce((a, x) => a + x.t, 0) / grand : 0;
  const tailShare = grand ? totals.slice(Math.floor(totals.length / 2)).reduce((a, x) => a + x.t, 0) / grand : 1;
  const longtailOk = clusters.length >= 15 && top5Share >= 0.5 && tailShare <= 0.15;
  add(longtailOk ? 'ok' : 'warn', `${clusters.length} 个品类呈长尾分布`,
    longtailOk
      ? `头部 5 个品类占总需求的 ${Math.round(top5Share * 100)}%，后一半品类合计只占 ${Math.round(tailShare * 100)}%——接近现实里"少数爆款占大头"的格局。`
      : '品类少或需求分布平均，没有长尾格局。');

  return checks;
}
