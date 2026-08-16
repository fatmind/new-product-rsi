// action/abstract/a2_incentive.js —— ② 价格激励 接口定义（系统动作 + 可优化）
// 实现在 action/system/a2_incentive.js。

import { validateList } from '../../ontology/schema.js';

export const contract = {
  id: 'a2_incentive',
  name: '② 价格激励',
  type: '系统动作',
  optimizable: ['激励 prompt：权衡口径 opt_points/rN/incentive_prompt.md（自己读，flow 不注入）'],

  // 输入：只收 verdict=推 的卡（reason / confidence / cluster_id）+ 簇价位带 + 竞对价格带
  input: 'selection_card.reason / .confidence / .cluster_id（verdict=推）+ cluster.price_range + off_site_sales.price_band',

  // 输出：每张推的卡一个激励方案；ROI 硬校验写死在实现代码（subsidy ≤ 0.3 × 竞对 price_band 中位数）
  output: 'incentives',
  validateOutput: (out) => validateList('incentive', out.incentives, 'incentives'),
};
