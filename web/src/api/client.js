/**
 * tRPC 客户端（前端侧）：区分 query(GET) / mutation(POST)，统一解包 result.data.json。
 * 鉴权：token 存 localStorage（对齐官方的 token / token_<region> 约定）。
 */
const REGION = localStorage.getItem('region') || 'china';
const TOKEN_KEY = REGION === 'china' ? 'token' : `token_${REGION}`;
const CLIENT_VERSION = 'desktop/0.3.25';

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
    credentials: 'omit',
  });
  const json = await res.json().catch(() => ({}));
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

let cachedUser = null;

export async function bootstrapAuth() {
  if (!getToken()) {
    // 临时令牌 → 登录（对齐 user.getTempToken / loginByTempToken 两步）
    const t = await request('user.getTempToken', 'mutation', {});
    const login = await request('user.loginByTempToken', 'mutation', {
      token: t.token, client: 'desktop', version: CLIENT_VERSION, platform: 'win32',
    });
    setToken(login.token);
  }
  cachedUser = await api.query('user.getUserInfo');
  try { window.orangeNative?.bootOk?.(); } catch { /* 原生壳缺失时忽略 */ }
  startTokenRefresh();
  return cachedUser;
}

/** 文档 06 §2：每 1h 轮询 refreshToken（JWT 超 1 天则续期） */
let refreshTimer = null;
function startTokenRefresh() {
  if (refreshTimer) return;
  const tick = async () => {
    try {
      const r = await request('user.refreshToken', 'mutation', {});
      if (r?.token) setToken(r.token);
    } catch (e) {
      if (String(e.message || '').includes('需要登录')) clearToken();
    }
  };
  refreshTimer = setInterval(tick, 60 * 60 * 1000);
  setTimeout(tick, 45 * 1000);
}

export const currentUser = () => cachedUser;
export const refreshUser = async () => {
  cachedUser = await api.query('user.getUserInfo');
  try { window.orangeNative?.bootOk?.(); } catch { /* 原生壳缺失时忽略 */ }
  startTokenRefresh();
  return cachedUser;
};
export const apiBase = () => `${location.protocol}//${location.host}`;
