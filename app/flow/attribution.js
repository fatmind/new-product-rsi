// flow/attribution.js —— 归因裁据层（DFS 剪枝的"裁据"来源）
//
// 定位：把"整条长链猜凶手"改成"每段一个便宜、独立、当场可复核的判据，先裁掉能裁的分支"。
// 对一个下发过的簇，按确定性子程序（不调 LLM）依次排它地定位问题归属：
//   裁据是代理指标，不是"这个簇该不该推"的答案（那在上帝真值里，这里永远不读）。
//   本文件只依赖业务可见字段：下发包、商家发布的品（价格/补贴）、7日销量、分群销量、竞对价格带。
//   不读：_ground_truth.json、消费者/商家画像、trust、商家内心 why、上帝侧 alerts。

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ZERO_BREAK_THRESHOLD } from '../lib/consts.js';
import { competitorMid, competitorBandMax } from '../lib/market.js';

const APP_DIR = new URL('..', import.meta.url).pathname;

function readJson(p) { return JSON.parse(readFileSync(p, 'utf8')); }

// ---------- 单一轮次的裁据表 ----------
// roundData: { round, dispatchPackages(s3), productsWithSales(s5), salesByGroup(s5) }
export function attribute({ round, dispatchPackages, productsWithSales, salesByGroup, offSiteSales, clusters }) {
  const clusterMap = Object.fromEntries(clusters.map((c) => [c.cluster_id, c]));
  const brokeSet = new Set(productsWithSales.filter((p) => p.sales_7d >= ZERO_BREAK_THRESHOLD).map((p) => p.cluster_id));
  const byCluster = Object.fromEntries(productsWithSales.map((p) => [p.cluster_id, p]));

  const clustersOut = dispatchPackages.map((pkg) => {
    const clusterId = pkg.cluster.cluster_id; // 下发包把簇完整内容挂在 pkg.cluster 下（自迭代可见）
    const cluster = clusterMap[clusterId];
    const prod = byCluster[clusterId] ?? null;
    const priceRaw = prod?.price ?? null;
    const subsidy = pkg.subsidy;
    const pay = priceRaw == null ? null : +(+priceRaw - subsidy).toFixed(2);
    const mid = competitorMid(offSiteSales, clusterId); // 无竞对数据 → null（市场行情未知）
    const costFloor = cluster.price_range.min;
    const bandMax = competitorBandMax(offSiteSales, clusterId); // 无竞对数据 → null
    const priceDead = bandMax != null && costFloor > bandMax;
    const inBand = pay != null && mid != null ? pay <= mid : null;
    const sales = prod?.sales_7d ?? 0;
    const broke = brokeSet.has(clusterId);

    // DFS 排它裁据：命中第一格即止
    let prunedAt;
    if (broke) prunedAt = 'broke'; // 破零了，无需归因
    else if (!prod) prunedAt = 'merchant_not_publish'; // 商家没接→引导说服力/采纳
    else if (priceDead) prunedAt = 'pricing_dead'; // 成本线下不去竞对卖价→价格死局
    else if (inBand === false) prunedAt = 'pricing'; // 实付没进竞对带→引导/定价问题
    else prunedAt = 'demand'; // 价对还卖不动→需求/用户群匹配（剩下的硬空间）

    const residual = {
      broke: '破零，无需归因',
      merchant_not_publish: `${clusterId} 下发了但商家没接：问题在引导说服力（lead）或商家采纳`,
      pricing: `实付 ¥${pay} 高于竞对中位 ¥${mid}，商家没把实付拉进竞对带 → 引导/定价问题（改 lead：给死目标价+留上浮余量）`,
      demand: `实付 ¥${pay} 已压进竞对带（≤竞对中位 ¥${mid}）仍只卖 ${sales} 单（<${ZERO_BREAK_THRESHOLD}），价格不是凶手——问题在需求/用户群匹配，留给选品研判攻`,
    }[prunedAt];

    return {
      cluster_id: clusterId,
      published: !!prod,
      merchant_id: prod?.merchant_id ?? null,
      price: priceRaw,
      subsidy,
      pay,
      competitor_mid: mid,
      cost_floor: costFloor,
      band_max: bandMax,
      in_band: inBand,
      sales_7d: sales,
      broke,
      price_dead: priceDead,
      pruned_at: prunedAt,
      residual,
      evidence: prod && salesByGroup && salesByGroup[prod.product_id]
        ? salesByGroup[prod.product_id] : null, // 分群销量（业务可见），攻需求空间时的依据
    };
  });

  // 优化侧确定性 alerts（替代上帝侧 alerts 进学习——这里的每一条都能从数据当场各归其位，不读真值）
  const alerts = [];
  for (const c of clustersOut) {
    if (c.pruned_at === 'pricing') {
      alerts.push(`引导失效：${c.cluster_id} 商家上架后实付 ¥${c.pay} 仍高于竞对中位 ¥${c.competitor_mid}，lead 没把实付目标拉到场；本轮未破零（${c.sales_7d} 单）`);
    } else if (c.pruned_at === 'pricing_dead') {
      alerts.push(`价格死局：${c.cluster_id} 平台成本线 ¥${c.cost_floor} 已高于竞对最高卖价 ¥${c.band_max}，信号全对也破不了零`);
    }
  }

  return {
    round,
    dispatched: dispatchPackages.length,
    published: productsWithSales.length,
    clusters: clustersOut,
    alerts, // 优化侧确定性 alerts（进学习环的信号，与上帝侧 alerts 严格分开）
  };
}

// 从 runs/rN 快照 + 市场数据现算裁据（run_round 当场算，以及老轮次/自迭代兜底都走这）
export function attributeFromSnaps(round) {
  const dir = join(APP_DIR, 'runs', round);
  const s3 = readJson(join(dir, 'snap_3_a3_dispatch.json'));
  const s5 = readJson(join(dir, 'snap_5_a5_consumer.json'));
  const offSiteSales = readJson(join(APP_DIR, 'data/off_site_sales.json'));
  const clusters = readJson(join(APP_DIR, 'data/clusters.json'));
  return attribute({
    round,
    dispatchPackages: s3.dispatch_packages,
    productsWithSales: s5.products_with_sales,
    salesByGroup: s5.sales_by_group,
    offSiteSales,
    clusters,
  });
}

// 跨轮聚合抹噪声（学习环内唯一"抹噪声"手段，只用观察销量，不含答案）
// 对每个在 ≥2 轮出现过的簇，汇总销量/实付，判断"不破零"是稳定性质还是噪声毛刺：
//   稳定不破零（多次出现、最大销量 < 破零线）→ 需求/用户群受限，不是价格或噪声问题
//   稳定破零（多次出现、每次都破零）→ 保留继续推
//   噪声候选（多次出现、销量大起大落跨过/险些跨过破零线）→ 别把单轮波动当成价格信号
export function aggregateAcrossRounds(attributions) {
  const byCluster = {};
  for (const attr of attributions) {
    for (const c of attr.clusters) {
      if (!c.published) continue;
      (byCluster[c.cluster_id] ??= []).push({
        round: attr.round,
        pay: c.pay,
        in_band: c.in_band,
        sales: c.sales_7d,
        broke: c.broke,
        pruned_at: c.pruned_at,
      });
    }
  }
  const out = [];
  for (const [cluster_id, rows] of Object.entries(byCluster)) {
    if (rows.length < 2) continue; // 只聚合跨轮出现过的
    const maxSales = Math.max(...rows.map((r) => r.sales));
    const salesList = rows.map((r) => r.sales);
    const stableNonBreaker = maxSales < ZERO_BREAK_THRESHOLD;
    const stableBreaker = rows.every((r) => r.broke);
    const noisy = salesList.some((v) => Math.abs(v - ZERO_BREAK_THRESHOLD) <= 1) && !stableBreaker;
    const verdict = stableNonBreaker
      ? '稳定不破零（跨轮最大销量仍 < 破零线）→ 裁到需求段，不是价格/噪声问题'
      : stableBreaker
        ? '稳定破零（跨轮每次都破零）→ 保留继续推'
        : noisy
          ? `噪声候选（跨轮销量 ${salesList.join('/')} 起伏，贴近破零线）→ 别拿单轮波动当价格信号，值得重测观察`
          : `跨轮不一致（销量 ${salesList.join('/')}）→ 结合各轮裁据看归属`;
    out.push({
      cluster_id,
      appearances: rows.length,
      sales_series: salesList.map((r, i) => `${rows[i].round}:${r}`).join(' / '),
      stable_non_breaker: stableNonBreaker,
      stable_breaker: stableBreaker,
      noisy,
      verdict,
    });
  }
  return out;
}

// 是否需要从磁盘补算 attribution.json（老轮次没有、或自迭代/报告想现算时）
export function ensureAttribution(round) {
  const p = join(APP_DIR, 'runs', round, 'attribution.json');
  if (existsSync(p)) return readJson(p);
  const attr = attributeFromSnaps(round);
  return attr;
}