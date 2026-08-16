// action/abstract/a3_dispatch.js —— ③ 下发 接口定义（系统动作 + 不可优化）
// 实现在 action/system/a3_dispatch.js。纯代码打包，无 LLM。

import { validateList } from '../../ontology/schema.js';

export const contract = {
  id: 'a3_dispatch',
  name: '③ 下发',
  type: '系统动作',
  optimizable: [], // 不可优化

  // 输入：推的卡 + 对应激励 + 簇完整内容
  input: 'cluster + selection_card（verdict=推）+ incentive',

  // 输出：下发包（广播给全部商家；若多商家想发同一个簇，谁先报算谁的）
  output: 'dispatch_packages',
  validateOutput: (out) => validateList('dispatch_package', out.dispatch_packages, 'dispatch_packages'),
};
