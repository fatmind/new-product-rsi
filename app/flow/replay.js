// flow/replay.js —— 字面重放诊断工具（god-view，只给人看，绝不进优化环）
//
// 用途：估"消费者决策层"某轮某簇销量有多大的噪声带宽——同一份商品、同一个群画像，多次重放，
//       看 sales_7d 落在哪、破零（≥5）的概率多高。这用来回答"kids 期望 3 单实际 4/2/1 是信号还是噪声"，
//       帮人类/上帝视角核对归因里的"需求 vs 运气"，而不是喂给自迭代学习（要用它定罪就得拿真值对答案=泄漏）。
//
// 用法：node app/flow/replay.js r5 kids_band 4
//       round ∈ r1..r5；cluster 可选（省略则重放本轮全部已发品）；第 3 参 = 重放次数（默认 3，上限 10）
// ⚠️ 输出禁入优化环：这是展示/诊断层，self_iterate.js 从不读这里产生的任何结果。
//
// 注意：a5 消费者层的随机性来自 LLM 打系数（每次真调、无缓存），所以"多次重放"会得到不同销量——
//       这正是我们要估的噪声来源。

import { mkdirSync, readFileSync, appendFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { run as a5 } from '../action/env/a5_consumer.js';
import { ZERO_BREAK_THRESHOLD } from '../lib/consts.js';

const APP_DIR = new URL('..', import.meta.url).pathname;
const round = process.argv[2] || 'r5';
const clusterId = process.argv[3] ?? null;
const K = Math.min(10, parseInt(process.argv[4] || '3', 10) || 3);

// 从本轮 snap_4 取已发布的品（价格/补贴/商家是确定性结果，重新过一遍消费者层）
const s4 = JSON.parse(readFileSync(join(APP_DIR, 'runs', round, 'snap_4_a4_merchant.json'), 'utf8'));
const products = (s4.products ?? []).filter((p) => clusterId ? p.cluster_id === clusterId : true);
if (products.length === 0) {
  console.error(`轮 ${round} 没有${clusterId ? `簇 ${clusterId} 的` : ''}已发布品`);
  process.exit(1);
}

const devLog = join(APP_DIR, 'runs', '_replay.log');
mkdirSync(join(APP_DIR, 'runs'), { recursive: true });
rmSync(devLog, { force: true });

console.log(`重放 ${round} 消费者层 ×${K} 次（${clusterId ?? '全部已发品'}）——⚠️ 仅诊断，今夜不供优化环使用\n`);

const dists = {}; // cluster_id -> sales[]
for (let k = 1; k <= K; k++) {
  const { products_with_sales } = await a5({ products }, { logFile: devLog });
  for (const p of products_with_sales) (dists[p.cluster_id] ??= []).push(p.sales_7d);
}

for (const [cid, sales] of Object.entries(dists)) {
  const min = Math.min(...sales), max = Math.max(...sales);
  const mean = +(sales.reduce((a, b) => a + b, 0) / sales.length).toFixed(2);
  const breakCount = sales.filter((s) => s >= ZERO_BREAK_THRESHOLD).length;
  console.log(`${cid}  ${sales.join(' / ')}   |  min=${min} max=${max} mean=${mean}  |  破零(${ZERO_BREAK_THRESHOLD}+) ${breakCount}/${K}`);
  if (max - min >= 2) console.log(`   → 噪声带宽 ≥ ${max - min} 单：单轮销量可能被噪声左右，归因时别把这${max >= ZERO_BREAK_THRESHOLD ? '几次过/不过的边界' : '波动'}当价格信号；看跨轮聚合`);
}
console.log('\n（跨轮聚合才是学习环内的"抹噪声"手段；本工具结果只作人类/上帝核对）');