// flow/reset.js —— 开发期一键重置实验状态（调整环境/数据后重新跑实验用）
// 用法：node app/flow/reset.js
// 做三件事：
//   1. 清空 runs/ 下所有轮次产物（含 _smoke）
//   2. 删掉 opt_points/ 下所有 rN 参数包（保留 init/，那是初始值）
//   3. 商家 trust 从 trust_init 还原（trust 是唯一运行态可变字段）
// 注意：data/ 不动——数据重造是 generate.js 的事，两件事分开。

import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const APP_DIR = new URL('..', import.meta.url).pathname;
const cleaned = [];

// 1. 清 runs/
const runsDir = join(APP_DIR, 'runs');
if (existsSync(runsDir)) {
  for (const entry of readdirSync(runsDir)) {
    rmSync(join(runsDir, entry), { recursive: true, force: true });
    cleaned.push(`runs/${entry}`);
  }
}

// 2. 清 opt_points/rN（保留 init）
const optDir = join(APP_DIR, 'opt_points');
if (existsSync(optDir)) {
  for (const entry of readdirSync(optDir)) {
    if (/^r\d+$/.test(entry)) {
      rmSync(join(optDir, entry), { recursive: true, force: true });
      cleaned.push(`opt_points/${entry}`);
    }
  }
}

// 3. trust 还原 trust_init
const merchantsPath = join(APP_DIR, 'action/env/merchants.json');
const envData = JSON.parse(readFileSync(merchantsPath, 'utf8'));
const restored = [];
for (const m of envData.merchants) {
  if (m.trust !== m.trust_init) {
    restored.push(`${m.merchant_id}: ${m.trust} → ${m.trust_init}`);
    m.trust = m.trust_init;
  }
}
writeFileSync(merchantsPath, JSON.stringify(envData, null, 2));

console.log(`已清理：${cleaned.length ? cleaned.join('、') : '（runs / opt_points 本来就是空的）'}`);
console.log(`trust 还原：${restored.length ? restored.join('；') : '（全部已是初始值）'}`);
console.log('重置完成。数据要重造的话另跑：node app/data/generate.js');
