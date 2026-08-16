// action/env/a5_consumer.js —— ⑤ 消费者购买 实现（环境 + 不可优化）
// 两层算销量，7 日窗口一次结算：
//   第一层 基准（脚本）：基准销量(群g, 品i) = cluster_pv_predict[g][簇] × base_cvr[g]
//   第二层 修正（LLM）：系数 = LLM(画像：taste / budget_range / price_sensitivity，品：attrs / 实付价)，
//                       围绕 1 浮动（契合 ~1.5，不相干 ~0.3），价格在这层一起判
//   sales_7d(品i) = Σ各群 round(基准 × 系数)，各群销量明细一起输出（sales_by_group）
// 内部状态：consumer_groups.json（本目录），5 群画像，实验执行时不更新。
// 环境规则：消费者会和竞对平台比价——同类品竞对卖得便宜很多时，实付价就算在预算内也不买。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { callLLMJson } from '../../llm/qodercli.js';
import { contract } from '../abstract/a5_consumer.js';

const ENV_DIR = new URL('.', import.meta.url).pathname;
const APP_DIR = new URL('../..', import.meta.url).pathname;

// 该簇竞对价格带中点的中位数（消费者心里的市场行情）；无竞对数据返回 null（没得比）
function competitorMid(offSiteSales, clusterId) {
  const mids = offSiteSales
    .filter((r) => r.cluster_id === clusterId)
    .map((r) => (r.price_band.min + r.price_band.max) / 2)
    .sort((a, b) => a - b);
  if (mids.length === 0) return null;
  const i = Math.floor(mids.length / 2);
  return mids.length % 2 ? mids[i] : (mids[i - 1] + mids[i]) / 2;
}

function coefPrompt(groups, product, payPrice, marketRef) {
  // 消费者能看到的：品本身（attrs / 实付价）+ 市场行情（竞对同类品卖多少钱，真实世界里会货比三家）
  const groupViews = groups.map((g) => ({
    group_id: g.group_id,
    taste: g.taste,
    budget_range: g.budget_range,
    price_sensitivity: g.price_sensitivity,
  }));
  return [
    '你在扮演电商平台的消费者群体，按下面每个群的画像，对一个新商品打"人货匹配修正系数"。',
    '只准依据画像判断，不要用你自己的世界观。',
    '',
    '# 消费者群画像',
    JSON.stringify(groupViews, null, 2),
    '',
    '# 新商品',
    JSON.stringify({ attrs: product.attrs, pay_price: payPrice, competitor_price_mid: marketRef }, null, 2),
    '（pay_price 是消费者实付价 = 定价 − 平台补贴；competitor_price_mid 是竞对平台同类品的中位价，null 表示市面上没同类品可比）',
    '',
    '# 打分要求',
    '- 系数围绕 1 浮动：品和这群人的喜好高度契合 ~1.5，一般 ~1.0，不相干 ~0.3，完全不可能买 0',
    '- 价格一起判：实付价落在 budget_range 内正常；超预算按该群 price_sensitivity 往下压系数',
    '- 消费者会比价：实付价明显高于 competitor_price_mid（比如贵 50% 以上），同样的东西隔壁便宜一半，就算在预算内也不买——系数压到 0.3 以下；和竞对价差不多，正常判',
    '- 便宜同样有吸引力（捡便宜效应）：品对这群人口味、且实付价明显低于 competitor_price_mid（比如便宜 30% 以上），会吸引更多人下单——系数可以给到 2~3；便宜得越狠、买的人越多，价格是有弹性的',
    '',
    '# 输出要求（固定格式，不许改）',
    '只输出 JSON，不要其他文字，每个群一个系数（0 到 3 的数字），格式：',
    `{"coefficients":{${groups.map((g) => `"${g.group_id}":1.0`).join(',')}}}`,
  ].join('\n');
}

export async function run({ products }, { logFile }) {
  const { consumer_groups } = JSON.parse(readFileSync(join(ENV_DIR, 'consumer_groups.json'), 'utf8'));
  const offSiteSales = JSON.parse(readFileSync(join(APP_DIR, 'data/off_site_sales.json'), 'utf8')); // 市场行情（比价用）
  const products_with_sales = [];
  const sales_by_group = {}; // { product_id: { group_id: 销量 } }

  for (const p of products) {
    const payPrice = +(p.price - p.subsidy).toFixed(2);
    const marketRef = competitorMid(offSiteSales, p.cluster_id);
    const out = await callLLMJson(coefPrompt(consumer_groups, p, payPrice, marketRef), {
      label: `a5_consumer_${p.product_id}`,
      logFile,
      validate: (o) => {
        if (typeof o.coefficients !== 'object' || o.coefficients === null) throw new Error('缺 coefficients 对象');
        for (const g of consumer_groups) {
          const v = o.coefficients[g.group_id];
          if (typeof v !== 'number' || v < 0 || v > 3) throw new Error(`群 ${g.group_id} 系数非法：${v}`);
        }
      },
    });

    // 第一层基准 × 第二层系数：各群先取整，总销量 = 各群之和（总分一致）
    const detail = {};
    let total = 0;
    for (const g of consumer_groups) {
      const pv = g.cluster_pv_predict[p.cluster_id] ?? 0;
      const n = Math.round(pv * g.base_cvr * out.coefficients[g.group_id]);
      detail[g.group_id] = n;
      total += n;
    }
    sales_by_group[p.product_id] = detail;
    products_with_sales.push({ ...p, sales_7d: total });
  }

  contract.validateOutput({ products_with_sales, sales_by_group });
  return { products_with_sales, sales_by_group };
}
