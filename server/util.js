import crypto from 'node:crypto';

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
