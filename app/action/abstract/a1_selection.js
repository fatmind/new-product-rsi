// action/abstract/a1_selection.js —— ① 选品研判 接口定义（业务动作 + 可优化）
// 就是这一个动作的输入→输出契约，不是基类。实现在 action/business/a1_selection.js。

import { validateList } from '../../ontology/schema.js';

export const contract = {
  id: 'a1_selection',
  name: '① 选品研判',
  type: '业务动作',
  optimizable: ['研判 prompt：经验条目 opt_points/rN/judgment_experience.md（自己读，flow 不注入）'],

  // 输入：三份数据 + 簇清单 + 大单品（LLM 研判的上下文）
  input: 'data/on_site_sales + data/off_site_sales + data/off_site_demand + data/clusters + data/hero_item',

  // 输出：selection_card × 每簇一张，推 / 不推都产出
  output: 'selection_cards',
  validateOutput: (out) => validateList('selection_card', out.selection_cards, 'selection_cards'),
};
