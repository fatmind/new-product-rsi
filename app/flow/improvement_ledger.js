// flow/improvement_ledger.js —— 改进点台账（对标 team3 experience/decision 协议）
//
// 把归因裁据层裁出来的每个"待攻节点"沉淀成一条结构化改进点，跨轮追踪状态：
//   问题不是散落在长链自由文本里，而是可定位（cluster + 裁段）、可验证（上一轮说修、这轮看效果）。
// 只从业务可见的 attribution 生成，不读真值/画像/trust/商家 why（与 attribution.js 同一防火墙）。
// 落盘：opt_points/<round>/ledger.json（自迭代 rN 时生成 rN+1 的参数包里带上）。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const APP_DIR = new URL('..', import.meta.url).pathname;

function readJson(p) { return JSON.parse(readFileSync(p, 'utf8')); }

// 从一轮归因表抽"待攻改进点"（下发了但没破零的，才是要修的）
export function issuesFromRound(attr) {
  const out = [];
  for (const c of attr.clusters) {
    if (c.broke) continue; // 破零了不归因
    out.push({
      cluster_id: c.cluster_id,
      pruned_at: c.pruned_at, // broke|merchant_not_publish|pricing_dead|pricing|demand
      residual: c.residual,
      evidence: {
        pay: c.pay,
        competitor_mid: c.competitor_mid,
        in_band: c.in_band,
        sales: c.sales_7d,
        sales_by_group: c.evidence,
      },
      round: attr.round,
    });
  }
  return out;
}

// 合并多轮 + 上一轮台账，产出累计台账（带状态流转）
// prevLedger: 上轮 opt_points 里的 ledger.json（或 null）
// 状态：open（新出现，待修） / carried（沿续未处理） / patched（上轮已针对改过，这轮看效果）
//   不在当前"待攻集"里的簇（破零了/没再推/没再下发）自然从本期台账消失 = 隐式 resolved。
export function buildLedger(attributions, prevLedger) {
  const prevMap = Object.fromEntries((prevLedger ?? []).map((x) => [x.cluster_id, x]));
  const current = {};
  for (const attr of attributions) {
    for (const it of issuesFromRound(attr)) {
      const prev = current[it.cluster_id];
      if (prev) {
        prev.last_round = attr.round;
        prev.appearances += 1;
        prev.locations.push({ round: attr.round, pruned_at: it.pruned_at });
      } else {
        current[it.cluster_id] = {
          cluster_id: it.cluster_id,
          first_round: attr.round,
          last_round: attr.round,
          appearances: 1,
          pruned_at: it.pruned_at,
          residual: it.residual,
          evidence: it.evidence,
          locations: [{ round: attr.round, pruned_at: it.pruned_at }],
        };
      }
    }
  }
  return Object.values(current).map((it) => {
    const prev = prevMap[it.cluster_id];
    const status = prev ? (prev.status === 'resolved' ? 'carried' : prev.status) : 'open';
    return { ...it, status };
  });
}

// 读上轮 ledger（不存在返回 []）
export function readLedger(round) {
  const p = join(APP_DIR, 'opt_points', round, 'ledger.json');
  return existsSync(p) ? readJson(p) : [];
}

// 写 ledger 到 opt_points/<round>/ledger.json
export function writeLedger(round, ledger) {
  const dir = join(APP_DIR, 'opt_points', round);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'ledger.json'), JSON.stringify(ledger, null, 2));
}

// 从 runs/rN 现算归因（供自迭代用；老轮无 attribution.json 也能跑）
export { ensureAttribution, attributeFromSnaps } from './attribution.js';