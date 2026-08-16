// lib/time.js —— 北京时间工具（全项目时间统一用北京时间）

// 'YYYY-MM-DD HH:mm:ss'（北京时间 UTC+8）
export function bjNow() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
}
