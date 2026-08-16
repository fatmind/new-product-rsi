// action/business/a1_selection.js —— ① 选品研判 实现（业务动作 + 可优化）
// LLM 读三份数据 + 研判经验（opt_points/rN，自己读），逐簇出选品卡，推/不推都出。
// 研判范围 = 本轮候选簇（flow 每期从类目池圈选一批，像真实运营的每期候选池）；三份数据按候选过滤。
// 可优化点：研判经验条目（judgment_experience.md）；输出格式写死在这里，改经验不许动格式。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { callLLMJson } from '../../llm/qodercli.js';
import { contract } from '../abstract/a1_selection.js';
import { businessRelations } from '../../lib/ontology_context.js';

const APP_DIR = new URL('../..', import.meta.url).pathname;

export async function run({ optDir, logFile, candidates }) {
  const heroItem = JSON.parse(readFileSync(join(APP_DIR, 'data/hero_item.json'), 'utf8'));
  const allClusters = JSON.parse(readFileSync(join(APP_DIR, 'data/clusters.json'), 'utf8'));
  const inSet = new Set(candidates ?? allClusters.map((c) => c.cluster_id)); // 未传候选 = 全量（兼容单测）
  const clusters = allClusters.filter((c) => inSet.has(c.cluster_id));
  const byCand = (rows) => rows.filter((r) => inSet.has(r.cluster_id));
  const onSiteSales = byCand(JSON.parse(readFileSync(join(APP_DIR, 'data/on_site_sales.json'), 'utf8')));
  const offSiteSales = byCand(JSON.parse(readFileSync(join(APP_DIR, 'data/off_site_sales.json'), 'utf8')));
  const offSiteDemand = byCand(JSON.parse(readFileSync(join(APP_DIR, 'data/off_site_demand.json'), 'utf8')));
  const experience = readFileSync(join(optDir, 'judgment_experience.md'), 'utf8');

  const prompt = [
    '你是出海电商平台的选品运营，场景：3C 消费电子 - 大单品配件。',
    `热点大单品：${heroItem.item_id}。平台本期从类目池圈选了 ${clusters.length} 个候选配件簇（每期候选不同），下面是候选清单和它们的三份市场数据，逐簇研判：这个簇未来是不是新星（值不值得推给商家发品）。`,
    '',
    '# 业务本体与关系（业务背景常识：这门生意里有什么、谁影响谁；不是可调参数）',
    businessRelations(),
    '',
    '# 研判经验（判断依据，严格参考）',
    experience,
    '',
    '# 配件簇清单',
    JSON.stringify(clusters, null, 2),
    '',
    '# 站内销售趋势 on_site_sales（我们平台，群×簇×周；有流量没订单 = 有兴趣没供给）',
    JSON.stringify(onSiteSales),
    '',
    '# 站外销售趋势 off_site_sales（竞对平台 SHEIN/Temu，簇×国家×周）',
    JSON.stringify(offSiteSales),
    '',
    '# 站外需求 off_site_demand（YouTube/本地论坛/Google Trends，簇×国家×周）',
    JSON.stringify(offSiteDemand),
    '',
    '# 输出要求（固定格式，不许改）',
    '每个簇一张选品卡，推/不推都要出，不推也写清为什么。confidence 是 0 到 1 的数字。',
    'reason 是写给商家看的：用大白话说清“为什么值得/不值得发这个品”，讲人话，不要出现 E1、三层对照这类内部术语和黑话。',
    '只输出 JSON，不要其他文字，格式：',
    '{"selection_cards":[{"card_id":"card_<cluster_id>","cluster_id":"<cluster_id>","verdict":"推" 或 "不推","reason":"研判理由（大白话）","confidence":0.8}]}',
  ].join('\n');

  const out = await callLLMJson(prompt, {
    label: 'a1_selection',
    logFile,
    validate: (o) => {
      contract.validateOutput(o);
      // 覆盖校验：每簇一张，不多不少
      const want = clusters.map((c) => c.cluster_id).sort().join(',');
      const got = [...new Set(o.selection_cards.map((c) => c.cluster_id))].sort().join(',');
      if (want !== got) throw new Error(`选品卡簇覆盖不对：期望 [${want}]，实际 [${got}]`);
    },
  });
  return out;
}
