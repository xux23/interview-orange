import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
export const cuid = (len = 25) => {
  let s = 'c';
  const bytes = crypto.randomBytes(len - 1);
  for (let i = 0; i < bytes.length; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  return s;
};

export const nowIso = () => new Date().toISOString();
export const toJson = (v) => (v === undefined || v === null ? null : JSON.stringify(v));
export const fromJson = (v, fallback = null) => {
  if (v === null || v === undefined || v === '') return fallback;
  try {
    return JSON.parse(v);
  } catch {
    return fallback;
  }
};
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 把文本切成逐字流式片段（对齐官方「逐字」观测：2~4 字一包） */
export function chunkText(text, size = 3) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

/** 简单环形限流：key 每分钟最多 n 次 */
const hits = new Map();
export function rateLimit(key, perMinute) {
  const now = Date.now();
  const list = (hits.get(key) || []).filter((t) => now - t < 60_000);
  if (list.length >= perMinute) {
    hits.set(key, list);
    return false;
  }
  list.push(now);
  hits.set(key, list);
  return true;
}
export const resetRateLimits = () => hits.clear();

/** 目录滚动清理：按 mtime 只保留最近 keep 个文件（screenshots/uploads 防无限增长） */
export function pruneDir(dir, keep) {
  try {
    const entries = fs.readdirSync(dir)
      .map((f) => {
        const p = path.join(dir, f);
        try { const st = fs.statSync(p); return st.isFile() ? { p, mtime: st.mtimeMs } : null; } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime);
    for (const e of entries.slice(keep)) {
      try { fs.unlinkSync(e.p); } catch { /* 占用时忽略 */ }
    }
    return Math.max(0, entries.length - keep);
  } catch {
    return 0; // 目录不存在等
  }
}
