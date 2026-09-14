// lib/market.js —— 市场行情的单一实现（跨模块共享，避免多处分叉漂移）
// 之前 competitorMid 在 a2_incentive / a5_consumer / checks 三处各自实现一份，
// 归因裁据层（attribution）需要第 4 个消费者时会再复制一份——收成这里一个函数。
// 语义跟原三处逐一对齐（同一口径）：
//   - a2_incentive / checks 无竞对数据时回退某种中点；a5_consumer 无竞对数据返回 null（没得比）。
//   - 归一：fallbackMid 有值且无竞对数据则回退它；fallbackMid 为 null（或不传）且无数据则返回 null。

// 该簇竞对价格带中点的中位数（"消费者心里的市场行情"）；无竞对数据时按 fallbackMid 回退
export function competitorMid(offSiteSales, clusterId, fallbackMid = null) {
  const mids = offSiteSales
    .filter((r) => r.cluster_id === clusterId)
    .map((r) => (r.price_band.min + r.price_band.max) / 2)
    .sort((a, b) => a - b);
  if (mids.length === 0) return fallbackMid;
  const i = Math.floor(mids.length / 2);
  return mids.length % 2 ? mids[i] : (mids[i - 1] + mids[i]) / 2;
}

// 该簇竞对价格带的上沿（最高卖价）；无竞对数据返回 null。用于判"价格死局"（平台成本线压不过竞对卖价）
export function competitorBandMax(offSiteSales, clusterId) {
  const maxs = offSiteSales.filter((r) => r.cluster_id === clusterId).map((r) => r.price_band.max);
  return maxs.length ? Math.max(...maxs) : null;
}