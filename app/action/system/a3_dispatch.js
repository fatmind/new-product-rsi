// action/system/a3_dispatch.js —— ③ 下发 实现（系统动作 + 不可优化）
// 纯代码打包：推的卡 + 对应激励 + 簇完整内容 → dispatch_package，广播给全部商家。
// 无 LLM、无可调项。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { contract } from '../abstract/a3_dispatch.js';

const APP_DIR = new URL('../..', import.meta.url).pathname;

export function run({ selection_cards, incentives }) {
  const clusters = JSON.parse(readFileSync(join(APP_DIR, 'data/clusters.json'), 'utf8'));
  const clusterMap = Object.fromEntries(clusters.map((c) => [c.cluster_id, c]));
  const cardMap = Object.fromEntries(selection_cards.map((c) => [c.card_id, c]));

  const dispatch_packages = incentives.map((inc) => {
    const card = cardMap[inc.card_id];
    if (!card) throw new Error(`激励 ${inc.card_id} 找不到对应选品卡`);
    return {
      package_id: `pkg_${inc.cluster_id}`,
      card_id: inc.card_id,
      cluster: clusterMap[inc.cluster_id], // 配件簇完整内容
      reason: card.reason, // 选品理由，给商家看
      lead: inc.lead,
      subsidy: inc.subsidy,
    };
  });

  contract.validateOutput({ dispatch_packages });
  return { dispatch_packages };
}
