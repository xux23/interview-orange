/**
 * 本地调用凭证（安全整改后 /trpc、/upload 与 Socket.IO 握手都必须携带）：
 *   - HTTP：头 `x-ml-token`（或 cookie `ml_token`）= data/.api-token 内容
 *   - Socket.IO：握手 `auth.socketToken` = data/.socket-token 内容
 * 两个文件都由服务启动时重新生成（见 server/index.js），脚本运行时按需读取最新值。
 * 路径相对本模块定位项目根（scripts/lib → 上两级），不依赖 process.cwd()。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dataDir = path.join(projectRoot, 'data');

/** 读取单个 token 文件；缺失/为空时抛带中文说明的错误 */
function readToken(file, label) {
  const full = path.join(dataDir, file);
  let value = '';
  try {
    value = fs.readFileSync(full, 'utf8').trim();
  } catch {
    throw new Error(`无法读取本地调用凭证 ${label}：文件不存在或不可读（${full}）。请先启动服务：node server/index.js`);
  }
  if (!value) {
    throw new Error(`本地调用凭证 ${label} 为空（${full}）。请先启动服务：node server/index.js`);
  }
  return value;
}

/** 读取服务当前生效的两个本地凭证：{ apiToken, socketToken } */
export function readLocalTokens() {
  return {
    apiToken: readToken('.api-token', 'apiToken'),
    socketToken: readToken('.socket-token', 'socketToken'),
  };
}

/** /trpc、/upload 等 HTTP 调用所需的请求头（可合并额外头） */
export function trpcHeaders(extra = {}) {
  return { 'x-ml-token': readToken('.api-token', 'apiToken'), ...extra };
}

/** socket.io-client 握手 auth（合并原有 token/sessionId/locale 等字段） */
export function socketAuth(extra = {}) {
  return { socketToken: readToken('.socket-token', 'socketToken'), ...extra };
}
