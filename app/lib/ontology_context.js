// lib/ontology_context.js —— 从 spec/ontology.md 提取业务关系节，喂给选品研判和自迭代当背景
// 只取「## 2. 关系」节（主干链路 + 业务影响关系）：这是纯业务视角、无敏感字段字面量，
// 可安全进优化侧 prompt（可见性扫描不会命中）。字段表（第 1 节）不喂——数据自带字段，且含画像字段名。
// 实验内部设计在 spec/ontology_god.md，永远不进这里。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const APP_DIR = new URL('..', import.meta.url).pathname;

export function businessRelations() {
  const md = readFileSync(join(APP_DIR, '../spec/ontology.md'), 'utf8');
  const start = md.indexOf('## 2. 关系');
  const end = md.indexOf('## 3. 规则');
  if (start < 0 || end <= start) throw new Error('spec/ontology.md 缺「## 2. 关系」/「## 3. 规则」节标记');
  return md.slice(start, end).trim();
}
