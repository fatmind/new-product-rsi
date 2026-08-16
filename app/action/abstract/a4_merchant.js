// action/abstract/a4_merchant.js —— ④ 商家决策 接口定义（环境 + 不可优化）
// 实现在 action/env/a4_merchant.js。
// 内部状态：商家画像（action/env/merchants.json）——type / top_categories / monthly_gmv 定死；
// trust 是唯一轮间可变字段，flow 算完破零率后就地更新，本动作只读当前值。

import { validateList } from '../../ontology/schema.js';

export const contract = {
  id: 'a4_merchant',
  name: '④ 商家决策',
  type: '环境',
  optimizable: [], // 环境，不可优化

  // 输入：下发包（商家能看到的全部信息，影响商家的唯一通道）
  input: 'dispatch_package',

  // 输出：每包每商家 发/不发 的决策记录 + 发出的新商品（每簇最多一个，谁先报算谁的）
  output: 'merchant_decisions + products',
  validateOutput: (out) => {
    if (!Array.isArray(out.merchant_decisions)) throw new Error('merchant_decisions 应为数组');
    for (const d of out.merchant_decisions) {
      if (typeof d.merchant_id !== 'string' || typeof d.package_id !== 'string' || typeof d.publish !== 'boolean') {
        throw new Error(`merchant_decision 字段不齐：${JSON.stringify(d).slice(0, 120)}`);
      }
    }
    validateList('product', out.products, 'products');
  },
};
