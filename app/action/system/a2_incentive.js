// action/system/a2_incentive.js —— ② 价格激励 实现（系统动作 + 可优化）
// LLM 综合判断（reason / confidence / 竞对 price_band / 簇 price_range）给出 subsidy 和 lead。
// 可优化点：激励 prompt 权衡口径（incentive_prompt.md，opt_points/rN 自己读）。
// ROI 硬校验写死在本文件：subsidy ≤ ROI_CAP_RATIO × 竞对 price_band 中位数，超线报错重出（validate 触发重试）。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { callLLMJson } from '../../llm/qodercli.js';
import { contract } from '../abstract/a2_incentive.js';
import { VERDICT } from '../../ontology/schema.js';

const APP_DIR = new URL('../..', import.meta.url).pathname;
const ROI_CAP_RATIO = 0.3; // ROI 硬上限：写死在代码，改 prompt 动不了它

// 该簇竞对价格带中点的中位数；无竞对数据时退回簇价位带中点
function competitorMid(offSiteSales, cluster) {
  const mids = offSiteSales
    .filter((r) => r.cluster_id === cluster.cluster_id)
    .map((r) => (r.price_band.min + r.price_band.max) / 2)
    .sort((a, b) => a - b);
  if (mids.length === 0) return (cluster.price_range.min + cluster.price_range.max) / 2;
  const i = Math.floor(mids.length / 2);
  return mids.length % 2 ? mids[i] : (mids[i - 1] + mids[i]) / 2;
}

export async function run({ selection_cards }, { optDir, logFile }) {
  const pushed = selection_cards.filter((c) => c.verdict === VERDICT.PUSH);
  if (pushed.length === 0) return { incentives: [] }; // 没有推的簇，本轮无激励

  const clusters = JSON.parse(readFileSync(join(APP_DIR, 'data/clusters.json'), 'utf8'));
  const offSiteSales = JSON.parse(readFileSync(join(APP_DIR, 'data/off_site_sales.json'), 'utf8'));
  const guideline = readFileSync(join(optDir, 'incentive_prompt.md'), 'utf8');
  const clusterMap = Object.fromEntries(clusters.map((c) => [c.cluster_id, c]));

  // 每张推的卡的判断材料：卡的结构化字段 + reason 文本 + 价格参照 + ROI 上限
  const items = pushed.map((card) => {
    const cluster = clusterMap[card.cluster_id];
    const mid = competitorMid(offSiteSales, cluster);
    return {
      card_id: card.card_id,
      cluster_id: card.cluster_id,
      reason: card.reason,
      confidence: card.confidence,
      cluster_price_range: cluster.price_range,
      competitor_price_mid: mid,
      subsidy_hard_cap: +(ROI_CAP_RATIO * mid).toFixed(2), // 超过直接被代码打回
    };
  });
  const capMap = Object.fromEntries(items.map((it) => [it.card_id, it.subsidy_hard_cap]));

  const prompt = [
    '你是电商平台的补贴测算系统，为下面每张推荐的选品卡定一份激励方案（给消费者的补贴 subsidy + 给商家的引导说辞 lead）。',
    '',
    '# 权衡口径（严格按这个执行）',
    guideline,
    '',
    '# 待定激励的选品卡（含价格参照和补贴硬上限）',
    JSON.stringify(items, null, 2),
    '',
    '# 硬约束',
    '- 每张卡的 subsidy 不得超过它的 subsidy_hard_cap（ROI 上限，超了会被系统打回重出）',
    '- lead 的力度感必须和 subsidy 相称，不承诺死数字',
    '- lead 用大白话写，商家一眼能懂，不要内部术语和黑话',
    '',
    '# 输出要求（固定格式，不许改）',
    '只输出 JSON，不要其他文字，格式：',
    '{"incentives":[{"card_id":"...","cluster_id":"...","lead":"给商家的引导说辞","subsidy":2.5}]}',
  ].join('\n');

  const out = await callLLMJson(prompt, {
    label: 'a2_incentive',
    logFile,
    validate: (o) => {
      contract.validateOutput(o);
      // 一一对应：每张推的卡一个激励
      const want = pushed.map((c) => c.card_id).sort().join(',');
      const got = [...new Set(o.incentives.map((i) => i.card_id))].sort().join(',');
      if (want !== got) throw new Error(`激励与推卡不对应：期望 [${want}]，实际 [${got}]`);
      // ROI 硬校验：超线报错 → 触发重试（LLM 重出）
      for (const inc of o.incentives) {
        const cap = capMap[inc.card_id];
        if (inc.subsidy > cap) throw new Error(`ROI 超线：${inc.card_id} subsidy=${inc.subsidy} > cap=${cap}`);
      }
    },
  });
  return out;
}
