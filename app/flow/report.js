// flow/report.js —— 最终实验报告生成器（布局以验收稿 index.html 为准，接真实数据）
// 用法：node app/flow/report.js [--fresh]
//   默认复用 runs/report_analysis.json 里的 LLM 分析缓存；--fresh 重新调 qodercli 分析。
// 板块：01 总览（柱线图 + LLM 提醒）02 业务流程与环境构造（流程链 / 数据构造检查 / 商家 / 消费者）
//       03 自迭代（两条演化线时间线 + 完整原文抽屉）04 逐轮检查（每轮 alerts + 5 节点明细，节点数据按轮组织）
// 分工：强规则校验/数据检查 = checks.js（代码断言）；提醒/演化/节点分析 = analyze.js（qodercli，上帝视角）。
// 注意：报告是给实验主理人看的（上帝视角，含商家内心话与真值评卷），只出不进——绝不能作为自迭代的输入。

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bjNow } from '../lib/time.js';
import { ZERO_BREAK_THRESHOLD } from '../lib/consts.js';
import { runChecks, runDataChecks } from './checks.js';
import { analyze } from './analyze.js';

const APP_DIR = new URL('..', import.meta.url).pathname;
const RUNS_DIR = join(APP_DIR, 'runs');

function readJson(p) { return JSON.parse(readFileSync(p, 'utf8')); }

// ---------- 基础数据 ----------

const rounds = existsSync(RUNS_DIR)
  ? readdirSync(RUNS_DIR).filter((d) => /^r\d+$/.test(d) && existsSync(join(RUNS_DIR, d, 'snap_6_settle.json')))
    .sort((a, b) => +a.slice(1) - +b.slice(1))
  : [];
if (rounds.length === 0) { console.error('runs/ 下没有可用轮次，先跑 run_round'); process.exit(1); }

const heroItem = readJson(join(APP_DIR, 'data/hero_item.json'));
const clusters = readJson(join(APP_DIR, 'data/clusters.json'));
const merchants = readJson(join(APP_DIR, 'action/env/merchants.json')).merchants;
const consumerGroups = readJson(join(APP_DIR, 'action/env/consumer_groups.json')).consumer_groups;
const onSite = readJson(join(APP_DIR, 'data/on_site_sales.json'));
const offSales = readJson(join(APP_DIR, 'data/off_site_sales.json'));
const offDemand = readJson(join(APP_DIR, 'data/off_site_demand.json'));

// 簇中文名：attrs 冒号前的叫法
const cnName = Object.fromEntries(clusters.map((c) => [c.cluster_id, (c.attrs.split(/[：:]/)[0] || c.cluster_id).trim()]));
const label = (cid) => `${cnName[cid] ?? cid}（${cid}）`;

// 每轮快照与结算
const roundData = {};
for (const r of rounds) {
  const dir = join(RUNS_DIR, r);
  roundData[r] = {
    s0: readJson(join(dir, 'snap_0.json')),
    s1: readJson(join(dir, 'snap_1_a1_selection.json')),
    s2: readJson(join(dir, 'snap_2_a2_incentive.json')),
    s3: readJson(join(dir, 'snap_3_a3_dispatch.json')),
    s4: readJson(join(dir, 'snap_4_a4_merchant.json')),
    s5: readJson(join(dir, 'snap_5_a5_consumer.json')),
    s6: readJson(join(dir, 'snap_6_settle.json')),
    attr: existsSync(join(dir, 'attribution.json')) ? readJson(join(dir, 'attribution.json')) : null,
    pack: existsSync(join(APP_DIR, 'opt_points', r)) ? `${r} 参数包` : 'init 参数包',
  };
}

const summaries = rounds.map((r) => ({
  round: r,
  rate: roundData[r].s6.zero_break_rate,
  broke: roundData[r].s6.broke_zero,
  dispatched: roundData[r].s6.dispatched,
  published: roundData[r].s6.published,
}));

const checksByRound = Object.fromEntries(rounds.map((r) => [r, runChecks(r)]));
const dataChecks = runDataChecks();

// ---------- LLM 分析（缓存；--fresh 重跑） ----------

const cachePath = join(RUNS_DIR, 'report_analysis.json');
let analysis;
if (!process.argv.includes('--fresh') && existsSync(cachePath)) {
  analysis = readJson(cachePath);
  console.log('[report] 复用分析缓存 report_analysis.json（--fresh 可重新分析）');
} else {
  console.log('[report] 调 qodercli 做上帝视角分析…');
  analysis = await analyze(rounds, summaries, checksByRound);
  analysis.generated_at = bjNow();
  writeFileSync(cachePath, JSON.stringify(analysis, null, 2));
  console.log('[report] 分析完成，已缓存');
}

// ---------- 组装 DATA（注入前端） ----------

const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const cut = (s, n) => { const t = String(s ?? ''); return t.length > n ? `${t.slice(0, n)}…` : t; };
// side_note 规范化：新格式 {summary, points[]}；旧缓存是纯字符串，兼容成无分点
const normNote = (v) => (typeof v === 'string' ? { summary: v, points: [] } : { summary: v?.summary ?? '', points: v?.points ?? [] });

const NODE_META = [
  { key: 'a1', name: '选品研判', kind: '可优化', lead: '读三份数据，对每个配件簇出一张卡；推与不推都要写清理由和信心。' },
  { key: 'a2', name: '价格激励', kind: '可优化', lead: '只处理判为「推」的卡，给出补贴金额与给商家的说辞；补贴上限由代码硬校验。' },
  { key: 'a3', name: '下发商家', kind: '固定', lead: '把卡片理由、激励与簇信息打包广播给全部商家。无模型参与，不可优化。' },
  { key: 'a4', name: '商家决策', kind: '环境', lead: '商家按各自画像决定发不发、定什么价。它只能看到下发包，看不到研判过程。' },
  { key: 'a5', name: '消费者购买', kind: '环境', lead: '按人群画像与实付价推算 7 日销量，人群明细一并输出。' },
];

function nodeTables(r) {
  const d = roundData[r];
  const brokeChip = (n) => n >= ZERO_BREAK_THRESHOLD
    ? '<span class="chip chip-ok">破零</span>'
    : (n === ZERO_BREAK_THRESHOLD - 1 ? '<span class="chip chip-warn">差 1 单</span>' : '<span class="chip chip-warn">未破零</span>');
  const byGroup = d.s5.sales_by_group ?? {};
  return {
    a1: {
      head: ['配件簇', '判定', '信心', '一句话理由'],
      rows: d.s1.selection_cards.map((c) => [esc(label(c.cluster_id)),
        c.verdict === '推' ? '<b>推</b>' : '不推', String(c.confidence), esc(cut(c.reason, 90))]),
    },
    a2: {
      head: ['配件簇', '补贴', '说辞要点'],
      rows: d.s2.incentives.map((i) => [esc(label(i.cluster_id)), `$${i.subsidy}`, esc(cut(i.lead, 80))]),
    },
    a3: {
      head: ['下发包', '补贴', '携带内容', '去向'],
      rows: d.s3.dispatch_packages.map((p) => [esc(label(p.cluster.cluster_id ?? p.cluster_id)), `$${p.subsidy}`,
        '理由原文 + 说辞 + 簇属性', '全部商家']),
    },
    a4: {
      head: ['商家', '包', '发?', '内心话'],
      rows: d.s4.merchant_decisions.map((m) => [esc(m.merchant_id), esc(label(m.package_id.replace(/^pkg_/, ''))),
        m.publish ? '<span class="chip chip-ok">发</span>' : '<span class="chip">拒</span>', esc(cut(m.why, 80))]),
    },
    a5: {
      head: ['商品', '定价', '补贴', '各群销量', '7 日销量', '破零'],
      rows: d.s5.products_with_sales.map((p) => {
        const g = byGroup[p.product_id] ?? {};
        const detail = Object.entries(g).filter(([, v]) => v > 0).map(([k, v]) => `${k}:${v}`).join(' ') || '—';
        return [esc(label(p.cluster_id)), `$${p.price}`, `$${p.subsidy}`, esc(detail), String(p.sales_7d), brokeChip(p.sales_7d)];
      }),
    },
  };
}

function nodeRules(r) {
  const grouped = { a1: [], a2: [], a3: [], a4: [], a5: [], round: [] };
  for (const it of checksByRound[r].items) (grouped[it.node] ?? grouped.round).push(it);
  return grouped;
}

// 全链路结局表：一行一簇，选品 → 激励 → 商家决策 → 破零 一眼看完整条链的结局
function roundOutcomes(r) {
  const d = roundData[r];
  const gradeMap = Object.fromEntries(checksByRound[r].matrix.map((m) => [m.cluster, m]));
  const incMap = Object.fromEntries(d.s2.incentives.map((i) => [i.cluster_id, i]));
  const prodMap = Object.fromEntries(d.s5.products_with_sales.map((p) => [p.cluster_id, p]));
  return d.s1.selection_cards
    .map((c) => {
      const g = gradeMap[c.cluster_id];
      const inc = incMap[c.cluster_id];
      const prod = prodMap[c.cluster_id];
      const pushed = c.verdict === '推';
      let merchant = '—';
      if (pushed) {
        if (prod) merchant = `${prod.merchant_id} 接单，定价 $${prod.price}`;
        else merchant = '无商家接单';
      }
      let broke = '—';
      if (prod) broke = `${prod.sales_7d} 件 · ${prod.sales_7d >= ZERO_BREAK_THRESHOLD ? '破零' : '未破零'}`;
      else if (pushed) broke = '未发布 · 计 0';
      return {
        cluster: label(c.cluster_id),
        pushed,
        selection: g ? g.grade : c.verdict, // grade 文案自足（含推/不推 + 真值角色），只进报告
        incentive: inc ? `补贴 $${inc.subsidy}` : '—',
        merchant,
        broke,
        brokeOk: prod ? prod.sales_7d >= ZERO_BREAK_THRESHOLD : false,
      };
    })
    .sort((a, b) => Number(b.pushed) - Number(a.pushed)); // 推的在前
}

function nodeRaw(r) {
  const d = roundData[r];
  return { a1: d.s1, a2: d.s2, a3: d.s3, a4: d.s4, a5: d.s5 };
}

// 归因裁据表（人类视图，只放业务可见字段；老轮无 attribution.json → null 显示"待补算"）
// 裁据定位是确定性判据，非答案：进带/未进带只是"价格不是凶手的代理"，不等于"该推"
const PRUNE_LABEL = {
  broke: '破零·无需归因',
  merchant_not_publish: '商家没接',
  pricing_dead: '价格死局',
  pricing: '价格/引导',
  demand: '需求/用户群',
};
function attributionTable(r) {
  const a = roundData[r].attr;
  if (!a || !Array.isArray(a.clusters)) return null;
  const rows = a.clusters.map((c) => [
    label(c.cluster_id),
    c.published ? '已发布' : '未发布',
    c.pay == null ? '—' : `$${c.pay}`,
    c.competitor_mid == null ? '—' : `$${c.competitor_mid}`,
    c.in_band == null ? '—' : (c.in_band ? '进带' : '未进带'),
    `${c.sales_7d}`,
    c.broke ? '<b>破零</b>' : '未破零',
    `<span class="chip ${c.pruned_at === 'demand' ? 'chip-warn' : c.pruned_at === 'broke' ? 'chip-ok' : 'chip-info'}">${esc(PRUNE_LABEL[c.pruned_at] ?? c.pruned_at)}</span>`,
    esc(cut(c.residual, 70)),
  ]);
  return { head: ['配件簇', '发布', '实付', '竞对中位', '进带?', '销量', '破零', '裁据定位', '一句话说明'], rows };
}

// 02 板块示例 sparkline：armband（真新星）三国/五群合计的 4 条周序列
function exampleSeries() {
  const cid = 'armband';
  const agg = (rows, field) => {
    const byWeek = {};
    for (const x of rows) if (x.cluster_id === cid) byWeek[x.week] = (byWeek[x.week] ?? 0) + x[field];
    return Object.keys(byWeek).sort((a, b) => a - b).map((k) => byWeek[k]);
  };
  return {
    cluster: label(cid),
    demand: agg(offDemand, 'search_trend'),
    compSales: agg(offSales, 'sales'),
    traffic: agg(onSite, 'traffic'),
    orders: agg(onSite, 'orders'),
  };
}

// 03 板块：优化点各版本 md 原文
function mdDocs() {
  const docs = {};
  const load = (ver, dir) => {
    const j = join(APP_DIR, 'opt_points', dir, 'judgment_experience.md');
    const i = join(APP_DIR, 'opt_points', dir, 'incentive_prompt.md');
    if (existsSync(j) && existsSync(i)) docs[ver] = { judgment: readFileSync(j, 'utf8'), incentive: readFileSync(i, 'utf8') };
  };
  load('init', 'init');
  for (const r of rounds) load(r, r);
  return docs;
}

// 演化线 hops：从 opt_points/*/changelog.md 实时重建，不用 LLM 分析缓存（那会过期）。
// 每跳 = 自迭代自己写的「复盘结论 + 改动清单」原文转述，from = 上一跳的 to（或 init）。
// 解析约定见 changelog：## 复盘结论（首条 bullet 作 case）、## 改动清单 · 选品研判经验 / · 价格激励口径（逐条原文作 changes）
function evolutionFromChangelogs() {
  const hops = { selection: [], incentive: [] };
  let lastVer = 'init';
  for (const r of rounds) {
    const clFile = join(APP_DIR, 'opt_points', r, 'changelog.md');
    if (!existsSync(clFile)) continue; // 该轮无 changelog（如 r1 用 init 跑），from 保持上一版本
    const md = readFileSync(clFile, 'utf8');
    // case：## 复盘结论 下的第一条列表项
    const conclMatch = md.match(/^## 复盘结论\s*\n\n?[-*]\s*([^\n]+)/m);
    const case_ = conclMatch ? conclMatch[1].trim() : '';
    // changes：两个「## 改动清单 · X」段，各自续的行级列表项
    for (const [key, label] of [['selection', '选品研判经验'], ['incentive', '价格激励口径']]) {
      const changes = [];
      const segMatch = md.match(new RegExp(`^## 改动清单 · ${label}\\s*\\n(.*?)(?=\\n## |\\n##|\\n##$|$)`, 'm'));
      if (segMatch) {
        for (const ln of segMatch[1].split('\n')) {
          const t = ln.trim();
          if (!t) continue;
          // 条目行：数字编号（1. 2. 3.）或 bullet（- *）
          const m = t.match(/^(?:[-*]|\d+[.、)])\s+(.+)$/);
          if (m) changes.push(m[1]);
          // 续行（非条目开头）：附着到上一条末尾
          else if (changes.length) changes[changes.length - 1] += t;
        }
      }
      if (changes.length) hops[key].push({ from: lastVer, to: r, case: case_, changes });
    }
    lastVer = r;
  }
  return hops;
}

const DATA = {
  meta: {
    hero: heroItem.item_id,
    rounds: rounds.map((r) => r.toUpperCase()),
    threshold: ZERO_BREAK_THRESHOLD,
    generated: bjNow(),
  },
  overview: {
    series: summaries.map((s) => ({ round: s.round.toUpperCase(), pack: roundData[s.round].pack,
      dispatched: s.dispatched, broke: s.broke, rate: s.rate })),
    sideNote: {
      selfIterating: normNote(analysis.side_note?.self_iterating),
      toImprove: normNote(analysis.side_note?.to_improve),
    },
  },
  env: {
    dataChecks,
    example: exampleSeries(),
    merchants: {
      count: merchants.length,
      types: [...new Set(merchants.map((m) => m.type))].join(' / '),
      cats: [...new Set(merchants.flatMap((m) => m.top_categories))].slice(0, 4).join(' / '),
      gmv: `${Math.min(...merchants.map((m) => m.monthly_gmv)) / 10000} 万 – ${Math.max(...merchants.map((m) => m.monthly_gmv)) / 10000} 万`,
    },
    consumers: {
      count: consumerGroups.length,
      countries: [...new Set(consumerGroups.map((g) => g.country))].join(' / '),
      cvr: `${Math.min(...consumerGroups.map((g) => g.base_cvr))} – ${Math.max(...consumerGroups.map((g) => g.base_cvr))}`,
    },
  },
  evolution: {
    // 用 changelog 实时重建的 hops，不读 analysis 缓存（缓存只到 r5，会过期）
    ...evolutionFromChangelogs(),
    docs: mdDocs(),
  },
  rounds: rounds.map((r) => ({
    id: r.toUpperCase(),
    key: r,
    pack: roundData[r].pack,
    attribution: attributionTable(r),
    candidates: roundData[r].s0.candidates ?? [],
    poolSize: clusters.length,
    alerts: analysis.rounds[r]?.alerts ?? [],
    outcomes: roundOutcomes(r),
    nodes: NODE_META.map((n) => ({
      ...n,
      table: nodeTables(r)[n.key],
      rules: nodeRules(r)[n.key].map((it) => [it.pass ? 'ok' : 'warn', it.name + (it.note ? `（${it.note}）` : '')]),
      // a3 是纯代码传导，强规则校验足够，不做 LLM 分析；其余节点为逐角度数组
      llm: n.key === 'a3' ? [] : (analysis.rounds[r]?.nodes?.[n.key] ?? []),
      raw: JSON.stringify(nodeRaw(r)[n.key], null, 2),
    })),
  })),
};

// ---------- SVG 生成（Node 侧，真数据） ----------

// 01 总览柱线图：下发/破零品数柱 + 破零率折线
function overviewSvg() {
  const s = DATA.overview.series;
  const n = s.length;
  const maxBar = Math.max(4, ...s.map((x) => x.dispatched));
  const maxRate = Math.max(0.6, ...s.map((x) => x.rate));
  const x0 = 40, x1 = 520, yBase = 140, yTop = 20;
  const cx = (i) => x0 + (x1 - x0) * ((i + 0.5) / n);
  const barH = (v) => (v / maxBar) * (yBase - yTop);
  const rateY = (v) => yBase - (v / maxRate) * (yBase - yTop);
  const bars = s.map((x, i) => {
    const c = cx(i);
    return `<rect x="${c - 34}" y="${yBase - barH(x.dispatched)}" width="30" height="${barH(x.dispatched)}" rx="2" fill="var(--primary-soft)" stroke="color-mix(in srgb,var(--primary) 32%,var(--border))"></rect>` +
      `<rect x="${c + 4}" y="${yBase - barH(x.broke)}" width="30" height="${barH(x.broke)}" rx="2" fill="var(--ok)"></rect>`;
  }).join('');
  const pts = s.map((x, i) => `${cx(i)},${rateY(x.rate)}`).join(' ');
  const dots = s.map((x, i) => `<circle cx="${cx(i)}" cy="${rateY(x.rate)}" r="4"></circle>`).join('');
  const rateLabels = s.map((x, i) => `<text x="${cx(i)}" y="${rateY(x.rate) - 9}">${(x.rate * 100).toFixed(1)}%</text>`).join('');
  const xLabels = s.map((x, i) => `<text x="${cx(i)}" y="160">${x.round}</text>`).join('');
  const packLabels = s.map((x, i) => `<text x="${cx(i)}" y="175">${x.pack}</text>`).join('');
  const midBar = Math.round(maxBar / 2);
  return `<svg class="chart-svg" viewBox="0 0 560 190" role="img" aria-label="破零率随轮次的变化，以及每轮下发包数与破零品数">
    <g stroke="var(--border)">
      <line x1="40" y1="140" x2="520" y2="140"></line>
      <line x1="40" y1="80" x2="520" y2="80" stroke-dasharray="3 4"></line>
      <line x1="40" y1="20" x2="520" y2="20" stroke-dasharray="3 4"></line>
    </g>
    <g fill="var(--fg-3)" font-size="10">
      <text x="32" y="143" text-anchor="end">0</text>
      <text x="32" y="83" text-anchor="end">${midBar}</text>
      <text x="32" y="23" text-anchor="end">${maxBar}</text>
      <text x="528" y="143">0%</text>
      <text x="528" y="83">${Math.round(maxRate * 50)}%</text>
      <text x="528" y="23">${Math.round(maxRate * 100)}%</text>
    </g>
    <g>${bars}</g>
    <polyline points="${pts}" fill="none" stroke="var(--primary)" stroke-width="calc(2px * var(--seed-chart-emphasis))" stroke-linejoin="round"></polyline>
    <g fill="var(--surface)" stroke="var(--primary)" stroke-width="2">${dots}</g>
    <g fill="var(--primary-ink)" font-size="11" font-weight="600" text-anchor="middle">${rateLabels}</g>
    <g fill="var(--fg-2)" font-size="11" text-anchor="middle">${xLabels}</g>
    <g fill="var(--fg-3)" font-size="9.5" text-anchor="middle">${packLabels}</g>
  </svg>`;
}

// 02 示例品类 sparkline：站外热度 / 竞对销量 / 站内流量上行，站内成交贴地
function exampleSvg() {
  const ex = DATA.env.example;
  const W = 960, H = 120, xL = 12, xR = 948, yB = 100, yT = 12;
  const line = (arr, maxV) => arr.map((v, i) =>
    `${(xL + (xR - xL) * (i / (arr.length - 1))).toFixed(0)},${(yB - (v / maxV) * (yB - yT)).toFixed(0)}`).join(' ');
  const mx = (a) => Math.max(...a, 1);
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" role="img" style="width:100%;height:auto;margin-top:calc(var(--u)*1.6)"
       aria-label="示例品类：站外热度、竞对销量、站内流量上行，站内成交贴近零">
    <line x1="${xL}" y1="${yB}" x2="${xR}" y2="${yB}" stroke="var(--border)"></line>
    <polyline points="${line(ex.demand, mx(ex.demand))}" fill="none" stroke="var(--primary)" stroke-width="calc(2px * var(--seed-chart-emphasis))" stroke-linejoin="round"></polyline>
    <polyline points="${line(ex.compSales, mx(ex.compSales))}" fill="none" stroke="var(--warn)" stroke-width="calc(1.7px * var(--seed-chart-emphasis))" stroke-linejoin="round"></polyline>
    <polyline points="${line(ex.traffic, mx(ex.traffic))}" fill="none" stroke="var(--ok)" stroke-width="calc(1.6px * var(--seed-chart-emphasis))" stroke-linejoin="round"></polyline>
    <polyline points="${line(ex.orders.map((v) => v), Math.max(mx(ex.orders) * 8, 10))}" fill="none" stroke="var(--fg-3)" stroke-width="1.4" stroke-dasharray="5 4"></polyline>
    <g font-size="12" text-anchor="end">
      <text x="${xR}" y="10" fill="var(--primary-ink)">站外搜索</text>
      <text x="${xR}" y="27" fill="var(--warn)">竞对销量</text>
      <text x="${xR}" y="45" fill="var(--ok)">站内流量</text>
    </g>
    <text x="20" y="92" font-size="12" fill="var(--fg-3)">站内成交 ≈ 0（缺货）</text>
  </svg>`;
}

// ---------- HTML ----------

const CSS = readFileSync(new URL('./report_style.css', import.meta.url), 'utf8');

const dataCheckHtml = DATA.env.dataChecks.map((c) =>
  `<div class="dc-item"><span class="chip ${c.status === 'ok' ? 'chip-ok' : 'chip-warn'}">${c.status === 'ok' ? '通过' : '存疑'}</span><div><b>${esc(c.title)}</b><span>${esc(c.note)}</span></div></div>`).join('\n');

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>自迭代实验报告 · 选品世界模型</title>
<style>
${CSS}
</style>
</head>
<body>

<header class="masthead" data-component="report-head">
  <div class="wrap head-inner">
    <div>
      <p class="kicker">选品世界模型 · 自迭代实验</p>
      <h1>实验报告</h1>
      <p class="head-meta">
        <span>大单品 <b class="mono">${esc(DATA.meta.hero)}</b></span>
        <span>轮次 <b>${DATA.meta.rounds[0]} – ${DATA.meta.rounds[DATA.meta.rounds.length - 1]}</b></span>
        <span>奖励 <b>7 日破零率（主）+ 破零品数（次）</b></span>
        <span>破零线 <b>单品 7 日 ≥ ${DATA.meta.threshold} 单</b></span>
      </p>
    </div>
    <span class="stamp">生成于 ${DATA.meta.generated}（北京） · 上帝视角</span>
  </div>
</header>

<div class="wrap">
<main data-component="report-body">

  <!-- 01 总览 -->
  <section data-component="overview">
    <div class="sec-head">
      <span class="sec-no">01</span>
      <h2>总览</h2>
      <span class="goal">看清自迭代的变化趋势</span>
    </div>
    <div class="card pad">
      <div class="overview">
        <div>
          <p class="label">破零率与下发规模</p>
          ${overviewSvg()}
          <div class="chart-legend">
            <span><i class="swatch" style="background:var(--primary-soft);border:1px solid color-mix(in srgb,var(--primary) 32%,var(--border))"></i>下发品数</span>
            <span><i class="swatch" style="background:var(--ok)"></i>破零品数（卖过 ${DATA.meta.threshold} 单的）</span>
            <span><i class="swatch-line"></i>破零率</span>
          </div>
        </div>
        <aside class="side-note">
          <span class="chip chip-info">实验总结</span>
          <p><b>1、有没有在自迭代：</b>${esc(DATA.overview.sideNote.selfIterating.summary)}</p>
          ${DATA.overview.sideNote.selfIterating.points.map((x, i) => `<p style="padding-left:calc(var(--u)*1.5);margin-top:calc(var(--u)*0.5)">${i + 1}、${esc(x)}</p>`).join('\n          ')}
          <p style="margin-top:calc(var(--u)*1.8)"><b>2、实验还要补什么：</b>${esc(DATA.overview.sideNote.toImprove.summary)}</p>
          ${DATA.overview.sideNote.toImprove.points.map((x, i) => `<p style="padding-left:calc(var(--u)*1.5);margin-top:calc(var(--u)*0.5)">${i + 1}、${esc(x)}</p>`).join('\n          ')}
        </aside>
      </div>
    </div>
  </section>

  <!-- 02 业务流程与环境构造 -->
  <section data-component="world-env">
    <div class="sec-head">
      <span class="sec-no">02</span>
      <h2>业务流程与环境构造</h2>
      <span class="goal">看懂每一步在干嘛，判断这套模拟像不像真实生意</span>
    </div>

    <div class="card pad">
      <p class="label">业务流程 <span>一轮从选品到破零，预留两处能被自迭代改动</span></p>
      <div class="flow" style="margin-top:calc(var(--u)*1.4)">
        <div class="node k-pre"><p class="nk">输入</p><p class="nn">大单品</p></div>
        <span class="arrow" aria-hidden="true">→</span>
        <div class="node k-pre"><p class="nk">前置</p><p class="nn">配件商品簇</p></div>
        <span class="arrow" aria-hidden="true">→</span>
        <div class="node k-pre"><p class="nk">前置</p><p class="nn">三方数据</p></div>
        <span class="arrow" aria-hidden="true">→</span>
        <div class="node k-opt"><p class="nk">可优化</p><p class="nn">选品研判</p></div>
        <span class="arrow" aria-hidden="true">→</span>
        <div class="node k-opt"><p class="nk">可优化</p><p class="nn">价格激励</p></div>
        <span class="arrow" aria-hidden="true">→</span>
        <div class="node"><p class="nk">固定</p><p class="nn">下发商家</p></div>
        <span class="arrow" aria-hidden="true">→</span>
        <div class="node k-env"><p class="nk">环境</p><p class="nn">商家决策</p></div>
        <span class="arrow" aria-hidden="true">→</span>
        <div class="node k-env"><p class="nk">环境</p><p class="nn">消费者购买</p></div>
        <span class="arrow" aria-hidden="true">→</span>
        <div class="node k-pre"><p class="nk">结算</p><p class="nn">破零率</p></div>
      </div>
      <div class="legend">
        <span><i style="background:var(--primary-soft);border-color:color-mix(in srgb,var(--primary) 28%,var(--border))"></i>可优化：自迭代唯一能动的两处</span>
        <span><i style="background:var(--surface-2)"></i>固定传导</span>
        <span><i style="background:var(--surface-3);border-color:var(--border-strong)"></i>环境：一轮内定死，只能整体模拟</span>
      </div>
      <div class="node-desc">
        <div><i style="background:var(--surface-2)"></i><span><b>大单品</b>　实验主角，一台主机（${esc(DATA.meta.hero)}），所有配件都围着它转。</span></div>
        <div><i style="background:var(--surface-2)"></i><span><b>配件商品簇</b>　和主机相关的一批配件商品簇，后续以它作为基础。</span></div>
        <div><i style="background:var(--surface-2)"></i><span><b>三方数据</b>　每个品类每周的站内流量成交、竞对销量、站外热度（抓取 youtube、google trend、论坛等）。</span></div>
        <div><i style="background:var(--primary-soft);border-color:color-mix(in srgb,var(--primary) 28%,var(--border))"></i><span><b>选品研判</b>　和选品专家一样，分析数据决定每个品类推还是不推，并说明理由和把握。</span></div>
        <div><i style="background:var(--primary-soft);border-color:color-mix(in srgb,var(--primary) 28%,var(--border))"></i><span><b>价格激励</b>　给要推的品类定补贴金额，写一段给商家的话，吸引商家发品。</span></div>
        <div><i style="background:var(--surface-2)"></i><span><b>下发商家</b>　把结果打包发给商家，纯流程、不做判断。</span></div>
        <div><i style="background:var(--surface-3);border-color:var(--border-strong)"></i><span><b>商家决策</b>　商家看到推荐选品后，决定上不上架、定多少钱。</span></div>
        <div><i style="background:var(--surface-3);border-color:var(--border-strong)"></i><span><b>消费者购买</b>　按消费者人群的喜好和到手价，算出这 7 天能卖多少。</span></div>
        <div><i style="background:var(--surface-2)"></i><span><b>破零率</b>　7 天卖到 ${DATA.meta.threshold} 单算"破零"，破零商品数 ÷ 下发商品数，就是本轮成绩。</span></div>
      </div>
    </div>

    <div class="card pad">
      <p class="label">数据是不是造得像真的 <span>检查方向按实验设计定，代码断言</span></p>
      <p class="env-lead">这套数据是用一张"上帝视角"的底表造出来的：站外需求热度、竞对销量、站内流量，都是拿同一个"需求"乘系数、加随机波动算出来的。下面的检查项说明它为什么算"相对真实"，也把不够真的地方一并标出。</p>
      ${exampleSvg()}
      <p class="hint" style="margin-top:6px">如图真实示例（${esc(DATA.env.example.cluster)}）：外面有需求、竞对在卖、站内也有搜索流量，成交却贴着地——前三条一起往上走、成交为零，是新品机会。</p>
      <div class="datacheck">
${dataCheckHtml}
      </div>
    </div>

    <div class="card pad">
      <p class="label">环境 · 商家 <span>商家看到推荐选品后自己决定上不上架、定多少钱</span></p>
      <div class="env-two">
        <div>
          <div class="kv"><span>商家数量</span><b>${DATA.env.merchants.count} 个（${esc(DATA.env.merchants.types)}）</b></div>
          <div class="kv"><span>主营类目</span><b>${esc(DATA.env.merchants.cats)} 等</b></div>
          <div class="kv"><span>月成交额</span><b>${esc(DATA.env.merchants.gmv)}</b></div>
          <div class="kv"><span>商家对平台信任度</span><b>信任分（每轮结束后 ±0.1）</b></div>
        </div>
        <div>
          <div class="kv"><span>怎么决策</span><b>LLM 模拟商家，按自己的定位判断上不上、定多少钱</b></div>
          <div class="kv"><span>能看到什么</span><b>只看得到推荐选品，看不到买家和答案</b></div>
          <div class="kv"><span>硬规则（代码卡死）</span><b>一个商家一轮最多上 2 个新品</b></div>
          <div class="kv"><span></span><b>同一个品类最多 1 家上新</b></div>
          <div class="kv"><span></span><b>定价不能低于成本、也不能超簇价上限的 1.3 倍</b></div>
        </div>
      </div>
    </div>

    <div class="card pad">
      <p class="label">环境 · 消费者 <span>按人群喜好和到手价算出这 7 天能卖多少</span></p>
      <div class="env-two">
        <div>
          <div class="kv"><span>人群数量</span><b>${DATA.env.consumers.count} 群（${esc(DATA.env.consumers.countries)}）</b></div>
          <div class="kv"><span>各群购买率</span><b>${esc(DATA.env.consumers.cvr)}</b></div>
          <div class="kv"><span>人群特征</span><b>喜好 / 预算范围 / 价格敏感度</b></div>
          <div class="kv"><span>怎么决策</span><b>流量 * 群体历史购买率 * LLM 模拟消费者得到购买系数</b></div>
        </div>
        <div>
          <p class="formula">7 天总销量 = ${DATA.env.consumers.count} 个人群各自销量相加
每群销量 = 预测流量 × 该群历史购买率 × <em>购买系数</em>
          └──── 脚本按数据算死 ────┘  └ AI 打 0–3 分 ┘
很想买≈1.5 · 一般≈1.0 · 不太相关≈0.3 · 不买=0</p>
          <p class="mini-note">注：如果到手价明显比竞对贵（贵一半以上），无论是否喜欢，系数都会压到 0.3 以下</p>
        </div>
      </div>
    </div>
  </section>

  <!-- 03 自迭代 -->
  <section data-component="evolution">
    <div class="sec-head">
      <span class="sec-no">03</span>
      <h2>自迭代</h2>
      <span class="goal">看清每一步为什么这么改，你能不能判断它改得对</span>
    </div>
    <div class="card pad">
      <p class="hint" style="margin-bottom:calc(var(--u)*2)">系统能自己动的只有两处：选品研判和价格激励。分开看，每处从上往下按轮次排——这一轮它改了什么、因为遇到哪种情况（转述它自己的复盘，不带上帝视角评判）。每一版都能点开看完整原文。</p>
      <div class="tabs" id="evoTabs" role="tablist" aria-label="优化点"></div>
      <div class="timeline" id="evoMount" style="margin-top:calc(var(--u)*2)"></div>
    </div>
  </section>

  <!-- 04 逐轮 -->
  <section data-component="round-inspector">
    <div class="sec-head">
      <span class="sec-no">04</span>
      <h2>逐轮检查</h2>
      <span class="goal">本轮是否符合预期的模拟过程，问题在哪一步</span>
    </div>
    <div id="roundMount"></div>
  </section>

</main>
</div>

<footer data-component="report-footer">
  <div class="wrap">
    <p>报告随每轮实验自动生成。真值仅用于本报告评卷，不回流给优化侧；环境与三份数据在一轮实验内保持不动。</p>
  </div>
</footer>

<div class="drawer-mask" id="mdMask" hidden>
  <aside class="drawer" role="dialog" aria-modal="true" aria-labelledby="mdTitle">
    <div class="drawer-top">
      <div>
        <h3 id="mdTitle">完整条目</h3>
        <p class="hint" id="mdSub">优化点原文（Markdown 渲染）</p>
      </div>
      <button class="drawer-close" type="button" id="mdClose" aria-label="关闭">×</button>
    </div>
    <div class="drawer-tabs" id="mdTabs"></div>
    <div class="drawer-body"><div class="md" id="mdBody"></div></div>
  </aside>
</div>

<script>
window.__DATA__ = ${JSON.stringify({ rounds: DATA.rounds, evolution: DATA.evolution }).replace(/</g, '\\u003c')};
</script>
<script>
${readFileSync(new URL('./report_client.js', import.meta.url), 'utf8')}
</script>
</body>
</html>
`;

// 输出文件名：去掉脚本自身后第一个非 - 开头位置参数可指定（默认 report.html），如 node app/flow/report.js --fresh report_v2.html
const outName = process.argv.slice(2).find((a) => a && !a.startsWith('-'));

writeFileSync(join(RUNS_DIR, outName ?? 'report.html'), html);
console.log(`[report] 已生成 ${join(RUNS_DIR, outName ?? 'report.html')}（${rounds.length} 轮）`);
