// llm/smoke.js —— 任务 1 验收：真调一次 qodercli，拿到合法 JSON
// 用法：node app/llm/smoke.js

import { callLLMJson } from './qodercli.js';

const prompt = '只输出一个 JSON 对象，格式：{"ok": true, "echo": "<把 fitbit air 这个词原样放这>"}。不要输出任何其他文字。';

const obj = await callLLMJson(prompt, {
  label: 'smoke',
  logFile: new URL('../runs/_smoke/llm.log', import.meta.url).pathname,
  validate: (o) => {
    if (o.ok !== true) throw new Error('缺 ok=true');
    if (typeof o.echo !== 'string') throw new Error('缺 echo 字符串');
  },
});

console.log('smoke 通过:', JSON.stringify(obj));
