// action/abstract/a5_consumer.js —— ⑤ 消费者购买 接口定义（环境 + 不可优化）
// 实现在 action/env/a5_consumer.js。
// 内部状态：5 个消费者群画像（action/env/consumer_groups.json），提前确定，实验执行时不更新。
// 两层算销量：基准（脚本：cluster_pv_predict × base_cvr）× 匹配修正（LLM 按画像打系数，价格一起判）。

import { validateList } from '../../ontology/schema.js';

export const contract = {
  id: 'a5_consumer',
  name: '⑤ 消费者购买',
  type: '环境',
  optimizable: [], // 环境，不可优化

  // 输入：新商品（attrs / price / subsidy → 实付价 = price − subsidy），影响消费者的唯一通道
  input: 'product.attrs / product.price / product.subsidy',

  // 输出：回填 sales_7d 的商品列表 + 各消费者群的销量明细（7 日窗口一次结算）
  output: 'products_with_sales + sales_by_group',
  validateOutput: (out) => {
    validateList('product', out.products_with_sales, 'products_with_sales');
    if (typeof out.sales_by_group !== 'object' || out.sales_by_group === null) throw new Error('缺 sales_by_group（各群销量明细）');
    for (const p of out.products_with_sales) {
      if (typeof p.sales_7d !== 'number') throw new Error(`product ${p.product_id} 未回填 sales_7d`);
      const detail = out.sales_by_group[p.product_id];
      if (typeof detail !== 'object' || detail === null) throw new Error(`product ${p.product_id} 缺各群销量明细`);
    }
  },
};
