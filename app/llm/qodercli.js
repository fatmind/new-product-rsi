// llm/qodercli.js —— 全部 LLM 调用的唯一出口
// 每次直接起 claude code 子进程，无 session、无缓存，每次真调：
//   claude -p "<prompt>" --output-format stream-json --verbose --dangerously-skip-permissions
// 解析 stream-json 事件流，取 type=result 事件的 result 文本（claude/ qodercli 同一事件格式）。
// 日志实时追加 .log 文本文件：每行一条（北京时间），过程中记录，不攒到最后。
// 注：bin 用 claude code 取代 qodercli（本机未装 qodercli）；文件保留原名，改的是内部实现。

import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { bjNow } from '../lib/time.js';

const BIN = 'claude';
const BASE_ARGS = ['--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'];
const TIMEOUT_MS = 10 * 60 * 1000; // 单次调用超时

// 实时追加一行日志（换行压成 \n，保证每行一条）；logFile 为空则不落
function logLine(logFile, label, kind, content) {
  if (!logFile) return;
  mkdirSync(dirname(logFile), { recursive: true });
  const oneLine = String(content).replace(/\r?\n/g, '\\n');
  appendFileSync(logFile, `[${bjNow()}] [${label}] ${kind}: ${oneLine}\n`);
}

// 调一次 claude，返回 result 文本；拿不到 result 事件 / 非 success 直接抛错
export function callLLM(prompt, { logFile = null, label = 'llm' } = {}) {
  return new Promise((resolve, reject) => {
    logLine(logFile, label, 'request', prompt);
    // prompt 经 stdin 传给 claude -p（作为命令行 -p "<prompt>" 参数会超长：self_iterate 上下文很大）
    const child = spawn(BIN, ['-p', ...BASE_ARGS], { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.write(prompt);
    child.stdin.end();

    let buf = '';
    let stderr = '';
    let result = null;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      const err = new Error(`${label}: ${BIN} 超时（${TIMEOUT_MS}ms）`);
      logLine(logFile, label, 'error', err);
      reject(err);
    }, TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let event;
        try { event = JSON.parse(line); } catch { continue; } // 非 JSON 行忽略
        logLine(logFile, label, 'event', line);
        if (event.type === 'result') result = event;
      }
    });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', (err) => { // 二进制不存在等
      clearTimeout(timer);
      logLine(logFile, label, 'error', err);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (!result) {
        const err = new Error(`${label}: 未收到 result 事件（exit=${code}）stderr=${stderr.slice(0, 500)}`);
        logLine(logFile, label, 'error', err);
        return reject(err);
      }
      if (result.subtype !== 'success') {
        const err = new Error(`${label}: result.subtype=${result.subtype}`);
        logLine(logFile, label, 'error', err);
        return reject(err);
      }
      resolve(result.result);
    });
  });
}

// 从 LLM 返回文本里抠出 JSON：优先剥 ``` 围栏，再按首个 {/[ 到末个 }/] 定位
export function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.search(/[[{]/);
  const end = Math.max(raw.lastIndexOf('}'), raw.lastIndexOf(']'));
  if (start < 0 || end <= start) throw new Error(`文本中找不到 JSON：${text.slice(0, 200)}`);
  const sliced = raw.slice(start, end + 1);
  // 直接 parse 失败时做一次裸引号修复：LLM 常在字符串值里写未转义的英文引号（如 E4"主机传导"），
  // 启发式：字符串内遇到的引号，若后面首个非空白字符不是 , } ] :（不像字符串结束），则转义为 \"
  try { return JSON.parse(sliced); } catch { return JSON.parse(repairBareQuotes(sliced)); }
}

function repairBareQuotes(s) {
  let out = '';
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (!inStr) {
      if (ch === '"') inStr = true;
      out += ch;
      continue;
    }
    if (ch === '\\') { out += ch + (s[i + 1] ?? ''); i++; continue; } // 已转义序列原样过
    if (ch === '"') {
      const rest = s.slice(i + 1).match(/^\s*(.)/); // 引号后首个非空白字符
      const next = rest ? rest[1] : '';
      if (next === ',' || next === '}' || next === ']' || next === ':' || next === '') {
        inStr = false; out += ch; // 真结束
      } else {
        out += '\\"'; // 字符串内部裸引号，转义
      }
      continue;
    }
    out += ch;
  }
  return out;
}

// 结构化调用：调 LLM → 抠 JSON → validate 校验；失败重试（每次都是真调），最多 retries 次
export async function callLLMJson(prompt, { logFile = null, label = 'llm', validate = null, retries = 3 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const text = await callLLM(prompt, { logFile, label: `${label}#${attempt}` });
      const obj = extractJson(text);
      if (validate) validate(obj); // 校验不过就抛错，走重试
      return obj;
    } catch (err) {
      lastErr = err;
      logLine(logFile, label, 'retry', `attempt=${attempt} ${err}`);
    }
  }
  throw new Error(`${label}: 重试 ${retries} 次仍失败，最后错误：${lastErr}`);
}
