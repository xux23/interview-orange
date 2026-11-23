/**
 * 鉴权：无第三方依赖的 HMAC 令牌（形态对齐实测 JWT payload {userId,type,iat,exp}）。
 * 客户端从 localStorage 取 token，走 authorization: Bearer <token>。
 */
import crypto from 'node:crypto';
import { config } from './config.js';
import { one } from './db.js';
import { cuid, nowIso } from './util.js';

const b64 = (buf) => Buffer.from(buf).toString('base64url');
const sign = (payload) =>
  crypto.createHmac('sha256', config.secret).update(payload).digest('base64url');

export function issueToken(userId, type = 'access') {
  const now = Date.now();
  const body = b64(JSON.stringify({ userId, type, iat: Math.floor(now / 1000), exp: Math.floor((now + config.tokenTtlMs) / 1000) }));
  return `${body}.${sign(body)}`;
}

export function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expect = sign(body);
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload?.userId || payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export function bearer(req) {
  const h = req.headers?.authorization || '';
  let t = '';
  if (h.startsWith('Bearer ')) t = h.slice(7).trim();
  else if (h.startsWith('bearer ')) t = h.slice(7).trim();
  // 容错：原版前端在某些路径会把 token JSON.stringify 多层后回存，逐层解开
  for (let i = 0; i < 6 && t.startsWith('"') && t.endsWith('"') && t.length > 1; i++) {
    try {
      const parsed = JSON.parse(t);
      if (typeof parsed === 'string') t = parsed;
      else break;
    } catch {
      t = t.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
  }
  return t;
}

/** 取当前用户；未登录返回 null（不抛错，便于 visitor 接口） */
export function currentUser(req) {
  const payload = verifyToken(bearer(req));
  if (!payload) return null;
  const user = one('SELECT * FROM users WHERE id=?', payload.userId);
  return user || null;
}

export const hashPassword = (pwd) => crypto.scryptSync(pwd || '', config.secret, 32).toString('hex');
export const newUserId = () => cuid();
export const createdAt = () => nowIso();
