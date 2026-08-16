// ontology/schema.js —— 本体对象 schema 定义（声明式）+ 通用校验
// SCHEMAS 是主体：对象、字段、类型、含义，以 spec/ontology.md 为唯一出处，顺序 = 主干链路顺序。
// validate / validateList 是从定义派生的通用校验，不为单个对象手写校验逻辑。
//
// 字段类型约定（ontology.md 未细化的实现层补充）：
//   string    非空字符串
//   number    数字，可配 range: [min, max]
//   boolean   布尔
//   band      价位带 { min, max }（美元），min ≤ max
//   string[]  非空字符串数组
//   map_number  { key: number } 映射（如 cluster_pv_predict）
//   enum      枚举，配 values: [...]
//   nested    嵌套对象，配 schema: '<对象名>'
//   optional: true  允许 null / undefined（如 sales_7d 结算前为空）

export const SCHEMAS = {
  hero_item: {
    desc: '热点单品',
    fields: {
      item_id: { type: 'string', desc: '当前就一个：google fitbit air' },
    },
  },

  cluster: {
    desc: '配件簇（= SPU，选品和下发的对象）',
    fields: {
      cluster_id: { type: 'string', desc: '簇标识' },
      price_range: { type: 'band', desc: '这个簇的典型价位带' },
      attrs: { type: 'string', desc: '这个簇的品在 材质/颜色/风格 等描述' },
    },
  },

  on_site_sales: {
    desc: '站内销售趋势（我们平台，群 × 簇 × 周）',
    fields: {
      cluster_id: { type: 'string', desc: '哪个簇' },
      country: { type: 'string', desc: '哪个国家' },
      group_id: { type: 'string', desc: '哪个人群' },
      week: { type: 'number', range: [1, Infinity], desc: '哪周' },
      traffic: { type: 'number', range: [0, Infinity], desc: '流量' },
      orders: { type: 'number', range: [0, Infinity], desc: '订单' },
    },
  },

  off_site_sales: {
    desc: '站外销售趋势（竞对平台 SHEIN/Temu，簇 × 国家 × 周）',
    fields: {
      cluster_id: { type: 'string', desc: '哪个簇' },
      country: { type: 'string', desc: '哪个国家' },
      week: { type: 'number', range: [1, Infinity], desc: '哪周' },
      sales: { type: 'number', range: [0, Infinity], desc: '竞对销量' },
      price_band: { type: 'band', desc: '竞对售价带（定价和补贴的参照）' },
    },
  },

  off_site_demand: {
    desc: '站外需求（YouTube / 本地论坛 / Google Trends，簇 × 国家 × 周）',
    fields: {
      cluster_id: { type: 'string', desc: '哪个簇' },
      country: { type: 'string', desc: '哪个国家' },
      week: { type: 'number', range: [1, Infinity], desc: '哪周' },
      buzz: { type: 'number', range: [0, Infinity], desc: '社媒声量' },
      search_trend: { type: 'number', range: [0, Infinity], desc: '搜索趋势' },
      pain_posts: { type: 'number', range: [0, Infinity], desc: '痛点帖量' },
    },
  },

  selection_card: {
    desc: '选品卡（LLM 研判输出，固定字段）',
    fields: {
      card_id: { type: 'string', desc: '标识' },
      cluster_id: { type: 'string', desc: '评估哪个簇' },
      verdict: { type: 'enum', values: ['推', '不推'], desc: '结论：是不是未来新星' },
      reason: { type: 'string', desc: '理由（大白话，商家要能看懂）' },
      confidence: { type: 'number', range: [0, 1], desc: '信心' },
    },
  },

  incentive: {
    desc: '激励方案（跟着选品卡一起下发）',
    fields: {
      card_id: { type: 'string', desc: '标识' },
      cluster_id: { type: 'string', desc: '激励哪个簇' },
      lead: { type: 'string', desc: '给商家的引导说辞（不承诺死数字）' },
      subsidy: { type: 'number', range: [0, Infinity], desc: '给消费者的价格补贴（实付价 = price − subsidy）' },
    },
  },

  dispatch_package: {
    desc: '下发包（下发给商家的完整包）',
    fields: {
      package_id: { type: 'string', desc: '标识' },
      card_id: { type: 'string', desc: '关联的选品卡' },
      cluster: { type: 'nested', schema: 'cluster', desc: '配件簇完整内容' },
      reason: { type: 'string', desc: '选品理由（来自选品卡，给商家看）' },
      lead: { type: 'string', desc: '引导说辞（来自激励方案）' },
      subsidy: { type: 'number', range: [0, Infinity], desc: '补贴（来自激励方案）' },
    },
  },

  merchant: {
    desc: '商家（环境内部状态）',
    fields: {
      merchant_id: { type: 'string', desc: '标识' },
      type: { type: 'enum', values: ['贸易型', '工厂型'], desc: '类型' },
      top_categories: { type: 'string[]', desc: '当前 Top 商品集中在哪些叶子品类' },
      monthly_gmv: { type: 'number', range: [0, Infinity], desc: '每月成交 GMV' },
      trust_init: { type: 'number', range: [0, 1], desc: '初始信任度（定死，reset 时用它还原 trust）' },
      trust: { type: 'number', range: [0, 1], desc: '对平台信任度（唯一运行态可变，flow 结算后更新）' },
    },
  },

  product: {
    desc: '新商品（商家基于簇发出的 SKU）',
    fields: {
      product_id: { type: 'string', desc: '标识' },
      cluster_id: { type: 'string', desc: '基于哪个簇发的' },
      attrs: { type: 'string', desc: '材质 / 颜色 / 风格 等' },
      price: { type: 'number', range: [0, Infinity], desc: '定价（商家自定）' },
      subsidy: { type: 'number', range: [0, Infinity], desc: '生效补贴（来自激励方案）' },
      merchant_id: { type: 'string', desc: '哪个商家发的' },
      gmt_create: { type: 'string', desc: '发布时间（北京时间）' },
      sales_7d: { type: 'number', range: [0, Infinity], optional: true, desc: '发布后 7 日累加销量（⑤结算后回填）' },
    },
  },

  consumer_group: {
    desc: '消费者群（环境内部状态）',
    fields: {
      group_id: { type: 'string', desc: '群标识' },
      country: { type: 'string', desc: '国家' },
      base_cvr: { type: 'number', range: [0, 1], desc: '基准转化率（常规购买 CVR，如 0.001）' },
      taste: { type: 'string', desc: '喜欢什么样（偏好描述）' },
      budget_range: { type: 'band', desc: '心理价位带' },
      price_sensitivity: { type: 'string', desc: '超预算后购买意愿掉多快（描述）' },
      cluster_pv_predict: { type: 'map_number', desc: '每簇对该群的 7 日预计流量' },
    },
  },
};

export const VERDICT = { PUSH: '推', SKIP: '不推' };

// ---------- 通用校验（从 SCHEMAS 定义派生） ----------

function fail(ctx, msg) {
  throw new Error(`schema 校验失败 [${ctx}] ${msg}`);
}

function checkField(value, spec, ctx) {
  if (value === null || value === undefined) {
    if (spec.optional) return;
    fail(ctx, '缺字段');
  }
  switch (spec.type) {
    case 'string':
      if (typeof value !== 'string' || value.trim() === '') fail(ctx, `应为非空字符串，实际 ${JSON.stringify(value)}`);
      break;
    case 'number': {
      if (typeof value !== 'number' || Number.isNaN(value)) fail(ctx, `应为数字，实际 ${JSON.stringify(value)}`);
      const [min, max] = spec.range ?? [-Infinity, Infinity];
      if (value < min || value > max) fail(ctx, `应在 [${min}, ${max}]，实际 ${value}`);
      break;
    }
    case 'boolean':
      if (typeof value !== 'boolean') fail(ctx, `应为布尔，实际 ${JSON.stringify(value)}`);
      break;
    case 'band':
      if (typeof value !== 'object' || value === null) fail(ctx, '应为 { min, max }');
      checkField(value.min, { type: 'number', range: [0, Infinity] }, `${ctx}.min`);
      checkField(value.max, { type: 'number', range: [0, Infinity] }, `${ctx}.max`);
      if (value.min > value.max) fail(ctx, `min(${value.min}) > max(${value.max})`);
      break;
    case 'string[]':
      if (!Array.isArray(value) || value.length === 0) fail(ctx, '应为非空字符串数组');
      value.forEach((v, i) => checkField(v, { type: 'string' }, `${ctx}[${i}]`));
      break;
    case 'map_number':
      if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(ctx, '应为 { key: number } 映射');
      for (const [k, v] of Object.entries(value)) checkField(v, { type: 'number', range: [0, Infinity] }, `${ctx}[${k}]`);
      break;
    case 'enum':
      if (!spec.values.includes(value)) fail(ctx, `应为 ${spec.values.join('/')} 之一，实际 ${JSON.stringify(value)}`);
      break;
    case 'nested':
      validate(spec.schema, value, ctx);
      break;
    default:
      fail(ctx, `schema 定义错误：未知类型 ${spec.type}`);
  }
}

// 按 SCHEMAS 里的定义校验一个对象；非法直接 throw，合法返回原对象
export function validate(schemaName, obj, ctx = schemaName) {
  const schema = SCHEMAS[schemaName];
  if (!schema) throw new Error(`未定义的本体对象：${schemaName}`);
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) fail(ctx, `应为对象，实际 ${JSON.stringify(obj)?.slice(0, 80)}`);
  for (const [field, spec] of Object.entries(schema.fields)) {
    checkField(obj[field], spec, `${ctx}.${field}`);
  }
  return obj;
}

export function validateList(schemaName, list, ctx = schemaName) {
  if (!Array.isArray(list)) fail(ctx, '应为数组');
  list.forEach((item, i) => validate(schemaName, item, `${ctx}[${i}]`));
  return list;
}
