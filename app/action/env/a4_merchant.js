// action/env/a4_merchant.js —— ④ 商家决策 实现（环境 + 不可优化）
// LLM 按画像演每个商家：卡的理由信不信、lead 心不心动、簇和 top_categories 搭不搭、
// monthly_gmv / type 有没有余力试新品 → 发不发；发则参照簇 attrs 和 price_range 定自己的 attrs / price。
// 内部状态：merchants.json（本目录）。trust 只读当前值，更新由 flow 结算后做。
// 环境规则：每簇最多一个新品——谁先报算谁的，被占的簇不再给后面的商家看；
//           问商家的顺序每轮随机（种子 = 轮号，重跑同轮不变）——真实里推送是广播，谁先响应近似随机；
//           前面的商家拒了的包会继续给后面的商家看（顺延），直到有人接或问完；
//           单个商家一轮最多接 2 个新品（精力/资金有限），接满后剩余包流向下一个商家。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { callLLMJson } from '../../llm/qodercli.js';
import { contract } from '../abstract/a4_merchant.js';
import { bjNow } from '../../lib/time.js';

const ENV_DIR = new URL('.', import.meta.url).pathname;
const MAX_PUBLISH_PER_MERCHANT = 2; // 环境规则：单商家单轮新品上限

// 每轮固定种子的确定性洗牌：同轮重跑顺序不变，不同轮顺序不同
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffleBySeed(arr, seed) {
  const rand = mulberry32(seed);
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function merchantPrompt(merchant, packages) {
  return [
    '你在扮演一个电商平台的商家，严格按下面的画像做决策，只准依据画像，不要用你自己的世界观。',
    '',
    '# 你的画像',
    JSON.stringify(merchant, null, 2),
    '（trust 是你对平台建议的信任度 0–1，越低越多疑；top_categories 是你现在主营的叶子品类；monthly_gmv 是你的月成交额，代表经营规模）',
    '',
    '# 平台下发给你的选品建议（每个包 = 一个配件簇 + 选品理由 + 激励说辞 + 给消费者的补贴）',
    JSON.stringify(packages, null, 2),
    '',
    '# 决策要求',
    '- 逐包决定发不发：理由信不信（trust 低就多怀疑）、说辞心不心动、这个簇和你主营品类搭不搭、你的规模撑不撑得起试新品',
    '- 跨品类硬规则（真实商家的能力边界，不是意愿问题）：',
    '  - 工厂型：你只能生产和现有产线工艺相同或相近的品。硅胶产线做不了皮具、金属件、电子件；皮具产线做不了硅胶、电子件。工艺不匹配的包，补贴再诱人、试错成本再低也必须拒——你根本没有产线和工人',
    '  - 贸易型：你靠进货可以跨品类，但供应链要够得着——和你主营完全不沾边的品类（比如卖耳机充电器的去卖皮表带），没有货源和品控能力，拒；和主营相邻的（材质、客群、渠道有一样沾边）才可以试',
    '  - 「入门价试错成本低」「平台补贴给得足」都不能成为跨能力边界的理由',
    `- 你一轮最多上 ${MAX_PUBLISH_PER_MERCHANT} 个新品（精力和资金有限），想发的超过了就自己挑最看好的，其余的 publish 给 false`,
    '- 决定发的：参照簇的 attrs 描述和 price_range 给出你这个 SKU 的具体 attrs（一句话描述材质/颜色/风格）和定价 price（贸易型习惯加价高、工厂型压价低）',
    '- 定价硬规则：price_range 下限就是这个簇的成本线，定价不能低于它（卖一单亏一单的事你不会干），也别超过上限的 1.3 倍',
    '- 不发的：price 和 attrs 给 null',
    '- why 用大白话写一句人话，不要术语',
    '',
    '# 输出要求（固定格式，不许改）',
    '只输出 JSON，不要其他文字，格式：',
    '{"decisions":[{"package_id":"...","publish":true,"price":15.9,"attrs":"具体SKU描述","why":"一句话决策原因"}]}',
  ].join('\n');
}

export async function run({ dispatch_packages }, { logFile, round = 'r1' }) {
  const { merchants } = JSON.parse(readFileSync(join(ENV_DIR, 'merchants.json'), 'utf8'));
  const seed = 977 + (parseInt(String(round).replace(/\D/g, ''), 10) || 0); // 种子 = 轮号，同轮可复现
  const ordered = shuffleBySeed(merchants, seed);
  const takenClusters = new Set(); // 每簇最多一个新品
  const merchant_decisions = [];
  const products = [];

  for (const m of ordered) { // 每轮随机顺序，谁先被问到谁先挑；拒了的包顺延给下一个商家
    const visible = dispatch_packages.filter((p) => !takenClusters.has(p.cluster.cluster_id));
    if (visible.length === 0) break;

    const out = await callLLMJson(merchantPrompt(m, visible), {
      label: `a4_merchant_${m.merchant_id}`,
      logFile,
      validate: (o) => {
        if (!Array.isArray(o.decisions)) throw new Error('decisions 应为数组');
        const ids = new Set(visible.map((p) => p.package_id));
        for (const d of o.decisions) {
          if (!ids.has(d.package_id)) throw new Error(`未知 package_id：${d.package_id}`);
          if (typeof d.publish !== 'boolean') throw new Error(`publish 应为布尔：${JSON.stringify(d)}`);
          if (d.publish && (typeof d.price !== 'number' || d.price <= 0)) throw new Error(`发布必须给正数 price：${JSON.stringify(d)}`);
          if (d.publish && (typeof d.attrs !== 'string' || !d.attrs.trim())) throw new Error(`发布必须给 attrs：${JSON.stringify(d)}`);
          if (d.publish) { // 定价合理性：不低于成本线（价位带下限），不高于上限 1.3 倍
            const pkg = visible.find((p) => p.package_id === d.package_id);
            const { min, max } = pkg.cluster.price_range;
            if (d.price < min || d.price > max * 1.3) throw new Error(`定价 ${d.price} 超出合理区间 [${min}, ${(max * 1.3).toFixed(1)}]（簇价位带 ${min}-${max}，下限是成本线）`);
          }
        }
        if (o.decisions.length !== visible.length) throw new Error(`应对 ${visible.length} 个包逐一决策，实际 ${o.decisions.length}`);
        const publishCount = o.decisions.filter((d) => d.publish).length;
        if (publishCount > MAX_PUBLISH_PER_MERCHANT) throw new Error(`单商家单轮最多发 ${MAX_PUBLISH_PER_MERCHANT} 个，实际想发 ${publishCount} 个`);
      },
    });

    for (const d of out.decisions) {
      merchant_decisions.push({ merchant_id: m.merchant_id, package_id: d.package_id, publish: d.publish, why: d.why ?? '' });
      if (!d.publish) continue;
      const pkg = visible.find((p) => p.package_id === d.package_id);
      takenClusters.add(pkg.cluster.cluster_id);
      products.push({
        product_id: `prod_${pkg.cluster.cluster_id}_${m.merchant_id}`,
        cluster_id: pkg.cluster.cluster_id,
        attrs: d.attrs,
        price: d.price,
        subsidy: pkg.subsidy, // 生效补贴来自激励方案
        merchant_id: m.merchant_id,
        gmt_create: bjNow(), // 北京时间
        sales_7d: null, // ⑤结算后回填
      });
    }
  }

  contract.validateOutput({ merchant_decisions, products });
  return { merchant_decisions, products };
}
