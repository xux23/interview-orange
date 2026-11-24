/**
 * tRPC 客户端（前端侧）：区分 query(GET) / mutation(POST)，统一解包 result.data.json。
 * P0-3：本地服务要求调用凭证——服务端把 {socketToken, apiToken} 注入页面
 * （window.__ML_ENV__），这里带 x-ml-token 头（服务端同时接受 SameSite=Strict cookie）。
 */
const REGION = localStorage.getItem('region') || 'china';
const TOKEN_KEY = REGION === 'china' ? 'token' : `token_${REGION}`;
const CLIENT_VERSION = 'desktop/0.3.25';
const ML_ENV = (typeof window !== 'undefined' && window.__ML_ENV__) || {};

export const getToken = () => localStorage.getItem(TOKEN_KEY) || '';
export const setToken = (t) => localStorage.setItem(TOKEN_KEY, t || '');
export const clearToken = () => localStorage.removeItem(TOKEN_KEY);
export const locale = () => localStorage.getItem('desktop.locale') || 'zh-CN';

export class ApiError extends Error {
  constructor(message, code, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function headers() {
  const h = { 'content-type': 'application/json', region: REGION, locale: document.documentElement.lang || locale(), 'client-version': CLIENT_VERSION };
  if (ML_ENV.apiToken) h['x-ml-token'] = ML_ENV.apiToken;
  const t = getToken();
  if (t) h.authorization = `Bearer ${t}`;
  return h;
}

async function request(name, kind, input) {
  const url = kind === 'query'
    ? `/trpc/${name}?input=${encodeURIComponent(JSON.stringify({ json: input || {} }))}`
    : `/trpc/${name}`;
  const res = await fetch(url, {
    method: kind === 'query' ? 'GET' : 'POST',
    headers: headers(),
    body: kind === 'query' ? undefined : JSON.stringify({ json: input || {} }),
    credentials: 'same-origin',
  });
  const json = await res.json().catch(() => ({}));
  if (res.status === 401) throw new ApiError('本地服务调用凭证缺失（请刷新页面）', 'UNAUTHORIZED', 401);
  if (json.error) {
    const e = json.error.json || {};
    throw new ApiError(e.message || '请求失败', e.data?.code || 'ERROR', e.data?.httpStatus || res.status);
  }
  return json.result?.data?.json;
}

export const api = {
  query: (name, input) => request(name, 'query', input),
  mutate: (name, input) => request(name, 'mutation', input),
};

/* 高危3：socket 握手 token 由服务端注入页面（window.__ML_ENV__.socketToken），
 * 不再经未鉴权的 /healthz 暴露 */
export const getSocketToken = () => ML_ENV.socketToken || '';

let cachedUser = null;

/** 账号模块已移除：无登录流程，直接取本地档案（token 相关仅为 /legacy 兼容形状） */
export async function bootstrapAuth() {
  cachedUser = await api.query('user.getUserInfo');
  try { window.orangeNative?.bootOk?.(); } catch { /* 原生壳缺失时忽略 */ }
  return cachedUser;
}

export const currentUser = () => cachedUser;
export const refreshUser = async () => {
  cachedUser = await api.query('user.getUserInfo');
  try { window.orangeNative?.bootOk?.(); } catch { /* 原生壳缺失时忽略 */ }
  return cachedUser;
};
export const apiBase = () => `${location.protocol}//${location.host}`;
