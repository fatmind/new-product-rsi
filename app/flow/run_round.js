// flow/run_round.js —— 主链路编排：圈选候选 → ①→⑤ → 破零率结算 → trust 更新
// 用法：node app/flow/run_round.js r1 [--force]
// 约定：
//   - 参数包选择：有 opt_points/rN 用 rN（自迭代开始后才会生成）；没有则直接用 init，不自动生成 rN
//   - 每轮圈选候选：从 24 簇池按真值类型分层抽 8 个（推 3 / 模糊 2 / 不推 3，层内随机、种子 = 轮号）——
//     像真实运营每期从类目池圈一批候选；抽样在上帝侧完成，优化侧只看到"本轮候选 8 个"，不知道配比
//   - 每步实时落盘：snap_0 开跑先写（本轮候选 + 商家 trust 当前值），
//     每个动作执行完立即写增量快照（内容 = 动作输出），LLM 日志实时追加 runs/rN/logs/llm.log
//   - 结算后：破零率（分母 = 下发数）+ trust 就地更新（环境规则写死：发的品破零升、未破零降、没发不变）

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run as a1 } from '../action/business/a1_selection.js';
import { run as a2 } from '../action/system/a2_incentive.js';
import { run as a3 } from '../action/system/a3_dispatch.js';
import { run as a4 } from '../action/env/a4_merchant.js';
import { run as a5 } from '../action/env/a5_consumer.js';
import { bjNow } from '../lib/time.js';
import { ZERO_BREAK_THRESHOLD } from '../lib/consts.js';

const APP_DIR = new URL('..', import.meta.url).pathname;

// 分层抽样配比（上帝侧出卷规则：保证每轮"有题可做"，纯随机可能抽出一轮没真机会）
const CANDIDATE_QUOTA = { 推: 3, 模糊: 2, 不推: 3 };

// 固定种子伪随机（同轮重跑候选不变）
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function pickCandidates(roundNum) {
  const truth = JSON.parse(readFileSync(join(APP_DIR, 'data/_ground_truth.json'), 'utf8'));
  const rand = mulberry32(3517 + roundNum); // 种子 = 轮号（盐区别于商家顺序的种子）
  const byType = { 推: [], 模糊: [], 不推: [] };
  for (const t of truth) {
    const key = t.expect.startsWith('推') ? '推' : t.expect.startsWith('模糊') ? '模糊' : '不推';
    byType[key].push(t.cluster_id);
  }
  const picked = [];
  for (const [key, quota] of Object.entries(CANDIDATE_QUOTA)) {
    const pool = [...byType[key]];
    for (let i = 0; i < quota && pool.length > 0; i++) {
      picked.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
    }
  }
  return picked.sort(); // 排序去掉抽取顺序痕迹，优化侧看不出分层
}

// ---------- 轮次准备 ----------

const round = process.argv[2] || 'r1';
const force = process.argv.includes('--force');
if (!/^r\d+$/.test(round)) {
  console.error('轮号格式：r1 / r2 / ...');
  process.exit(1);
}

// 有 opt_points/rN 用 rN；没有（自迭代未开始）直接用 init，不生成 rN
const roundOptDir = join(APP_DIR, 'opt_points', round);
const optDir = existsSync(roundOptDir) ? roundOptDir : join(APP_DIR, 'opt_points', 'init');

const runDir = join(APP_DIR, 'runs', round);
const logsDir = join(runDir, 'logs');
const logFile = join(logsDir, 'llm.log');
const flowLog = join(logsDir, 'flow.log');

if (existsSync(runDir)) {
  if (!force) {
    console.error(`runs/${round} 已存在，重跑请加 --force（会清掉本轮旧产物重来）`);
    process.exit(1);
  }
  rmSync(runDir, { recursive: true, force: true });
}
mkdirSync(logsDir, { recursive: true });
console.log(`本轮参数包：${optDir.replace(APP_DIR, '')}`);

// ---------- 落盘工具（过程中实时记录，不攒到最后） ----------

// flow 日志：.log 文本，每行一条，北京时间
function flowEvent(step, note = '') {
  appendFileSync(flowLog, `[${bjNow()}] ${step}${note ? ` — ${note}` : ''}\n`);
  console.log(`[flow] ${step}${note ? ` — ${note}` : ''}`);
}

// 动作执行完立即写：内容 = 该动作的输出对象（增量），不做 diff 检测
function writeSnap(name, data) {
  writeFileSync(join(runDir, `${name}.json`), JSON.stringify(data, null, 2));
  flowEvent(`snap:${name}`);
}

// ---------- snap_0：本轮候选圈选 + 会被改的运行态（商家 trust 当前值） ----------
// data / opt_points 跑动中不会被改、磁盘上本来就有；trust_init 是定死的初始值定义，不进快照

const candidates = pickCandidates(parseInt(round.slice(1), 10));
flowEvent('candidates:picked', `本轮候选 ${candidates.length} 个：${candidates.join('、')}`);

const merchantsNow = JSON.parse(readFileSync(join(APP_DIR, 'action/env/merchants.json'), 'utf8')).merchants;
writeSnap('snap_0', {
  candidates, // 本轮圈选的候选簇（业务可见：平台每期圈一批品类做研判）
  merchants: merchantsNow.map((m) => ({ merchant_id: m.merchant_id, trust: m.trust })),
});

// ---------- ①→⑤，每步执行完立即落盘 ----------

const ctx = { optDir, logFile, round, candidates }; // round 给 ④ 做随机顺序种子；candidates 给 ① 圈定研判范围

flowEvent('a1_selection:start', '① 选品研判');
const s1 = await a1(ctx);
writeSnap('snap_1_a1_selection', s1);

flowEvent('a2_incentive:start', '② 价格激励');
const s2 = await a2(s1, ctx);
writeSnap('snap_2_a2_incentive', s2);

flowEvent('a3_dispatch:start', '③ 下发');
const s3 = a3({ ...s1, ...s2 });
writeSnap('snap_3_a3_dispatch', s3);

flowEvent('a4_merchant:start', '④ 商家决策');
const s4 = await a4(s3, ctx);
writeSnap('snap_4_a4_merchant', s4);

flowEvent('a5_consumer:start', '⑤ 消费者购买');
const s5 = await a5(s4, ctx);
writeSnap('snap_5_a5_consumer', s5);

// ---------- 结算：破零率 + trust 就地更新 ----------

flowEvent('settle:start', '破零率结算 + trust 更新');

const dispatched = s3.dispatch_packages.length; // 分母 = 下发数（商家不发 = 直接计零）
const broke = s5.products_with_sales.filter((p) => p.sales_7d >= ZERO_BREAK_THRESHOLD);
const zeroBreakRate = dispatched === 0 ? 0 : +(broke.length / dispatched).toFixed(4);

// trust 环境规则（写死）：发的品破零 +0.1、未破零 −0.1、没发不变；夹在 [0, 1]
const merchantsPath = join(APP_DIR, 'action/env/merchants.json');
const envData = JSON.parse(readFileSync(merchantsPath, 'utf8'));
const trust_updates = [];
for (const m of envData.merchants) {
  const mine = s5.products_with_sales.filter((p) => p.merchant_id === m.merchant_id);
  if (mine.length === 0) continue;
  const didBreak = mine.some((p) => p.sales_7d >= ZERO_BREAK_THRESHOLD);
  const before = m.trust;
  m.trust = +Math.min(1, Math.max(0, before + (didBreak ? 0.1 : -0.1))).toFixed(2);
  trust_updates.push({ merchant_id: m.merchant_id, before, after: m.trust, why: didBreak ? '发的品破零' : '发的品未破零' });
}
writeFileSync(merchantsPath, JSON.stringify(envData, null, 2));

writeSnap('snap_6_settle', {
  round,
  dispatched,
  published: s5.products_with_sales.length,
  broke_zero: broke.length,
  zero_break_rate: zeroBreakRate,
  products: s5.products_with_sales.map((p) => ({
    product_id: p.product_id,
    cluster_id: p.cluster_id,
    merchant_id: p.merchant_id,
    price: p.price,
    subsidy: p.subsidy,
    sales_7d: p.sales_7d,
  })),
  trust_updates,
});

console.log(`\n=== ${round} 完成 ===`);
console.log(`下发 ${dispatched} 个包，发布 ${s5.products_with_sales.length} 个品，破零 ${broke.length} 个`);
console.log(`破零率 = ${zeroBreakRate}`);
