/**
 * 服务入口：独立端口（默认 8756）+ 独立数据目录（./data）。
 * 同时提供：tRPC HTTP 兼容层 / Socket.IO 双 namespace / 本地上传 / 前端静态资源。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import { config, root as projectRoot } from './config.js';
import { migrate, one, all as dbAll, run as dbRun } from './db.js';
import { seed } from './seed.js';
import { attachSocket } from './socket.js';
import { asrName } from './ai/asr.js';
import { TRPCError, invoke, parseInput, procedures, unwrapEnvelope } from './trpc/index.js';
import { aiSnapshot, asrSnapshot, bootSettings } from './settings.js';
import { pruneDir } from './util.js';

// 保险丝：上游模型/网络故障只降级记录，不允许掀翻整个本地服务
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e?.stack || e));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e?.stack || e));

const app = express();
app.disable('x-powered-by');
const jsonParser = express.json({ limit: '30mb' });
app.use((req, res, next) => {
  // 原版上传是 multipart/form-data；先保留原始 body，交给 /upload 手工解析
  if (req.method === 'POST' && req.path === '/upload'
    && String(req.headers['content-type'] || '').startsWith('multipart/form-data')) return next();
  return jsonParser(req, res, next);
});
// 调试：ML_HTTPLOG=1 时打印每个请求（含静态资源），用于排查 webview 加载
if (process.env.ML_HTTPLOG === '1') {
  app.use((req, _res, next) => { console.log(`[http] ${req.method} ${req.url}`); next(); });
}
app.use((req, _res, next) => {
  req.headers.locale = req.headers.locale || 'zh-CN';
  next();
});

const trpcErrorBody = (err) => {
  const e = err instanceof TRPCError ? err : new TRPCError(err.message || 'Internal Server Error', 'INTERNAL_SERVER_ERROR');
  return {
    error: {
      json: {
        message: e.message,
        code: e.code === 'BAD_REQUEST' ? -32600
          : e.code === 'UNAUTHORIZED' ? -32001
          : e.code === 'NOT_FOUND' ? -32004
          : e.code === 'TOO_MANY_REQUESTS' ? -32029
          : -32603,
        data: { code: e.code, httpStatus: e.httpStatus, path: null },
      },
    },
  };
};

const sendError = (res, err) => {
  const e = err instanceof TRPCError ? err : new TRPCError(err.message || 'Internal Server Error', 'INTERNAL_SERVER_ERROR');
  res.status(e.httpStatus).json(trpcErrorBody(err));
};

// 高危3：每次启动生成的随机 socket 握手 token（写入数据目录，经页面注入下发给自家 UI；/healthz 不再返回）
const socketToken = crypto.randomBytes(24).toString('hex');
try {
  fs.writeFileSync(path.join(config.dataDir, '.socket-token'), socketToken, { mode: 0o600 });
} catch (e) {
  console.warn('[boot] socket token 文件写入失败:', e.message);
}

/* ── P0-3：tRPC / 上传的本地调用凭证 ──
 * 账号体系已移除（单用户本地档案），但任何本机网页/进程都不该能直接读写 API：
 * 启动生成随机 apiToken，写入数据目录 + 注入自家页面（window.__ML_ENV__）+ SameSite=Strict
 * HttpOnly cookie；/trpc 与 /upload 必须携带（header 或 cookie），否则 401。 */
const apiToken = crypto.randomBytes(32).toString('hex');
try {
  fs.writeFileSync(path.join(config.dataDir, '.api-token'), apiToken, { mode: 0o600 });
} catch (e) {
  console.warn('[boot] api token 文件写入失败:', e.message);
}

const TOKEN_COOKIE = 'ml_token';
function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
const reqToken = (req) => String(req.headers['x-ml-token'] || parseCookies(req.headers.cookie)[TOKEN_COOKIE] || '');
const tokenOk = (req) => reqToken(req) === apiToken;
function requireToken(req, res, next) {
  if (tokenOk(req)) return next();
  res.status(401).json({ error: { json: { message: '未授权的本地调用（token 缺失或不匹配）', code: -32001, data: { code: 'UNAUTHORIZED', httpStatus: 401 } } } });
}

/* 页面安全头：注入凭证 cookie + 收窄 CSP（脚本只允许自家与注入的内联脚本） */
const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' ws: wss: http://127.0.0.1:* http://localhost:*",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');
function pageHeaders(res) {
  res.setHeader('Set-Cookie', `${TOKEN_COOKIE}=${apiToken}; Path=/; SameSite=Strict; HttpOnly`);
  res.setHeader('Content-Security-Policy', PAGE_CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
}
const envScript = `<script>window.__ML_ENV__=${JSON.stringify({ socketToken, apiToken })};</script>`;

/** 读取并注入凭证的前端 index.html（SPA 的所有窗口/路由共用同一份） */
function serveIndexHtml(res) {
  const index = path.join(config.publicDir, 'index.html');
  if (!fs.existsSync(index)) return res.status(503).type('text/plain').send('前端尚未构建：先运行 npm run build');
  const raw = fs.readFileSync(index, 'utf8');
  pageHeaders(res);
  res.type('html').send(raw.includes('</head>') ? raw.replace('</head>', `${envScript}</head>`) : envScript + raw);
}

app.get(['/', '/index.html'], (_req, res) => serveIndexHtml(res));
app.use('/trpc', requireToken);
app.use('/upload', requireToken);

// /healthz：保持公开（启动器用它探活），但不携带任何 token/密钥
app.get('/healthz', (_req, res) => {
  const ai = aiSnapshot();
  const asr = asrSnapshot();
  res.json({
    ok: true,
    version: config.version,
    provider: config.ai.provider,
    model: config.ai.provider === 'openai' ? config.ai.model : null,
    visionModel: config.ai.visionModel,
    providerSource: ai.source,
    hasKey: ai.hasKey,
    asr: asrName(),
    asrSource: asr.source,
    asrHasKey: asr.hasKey,
    procedures: procedures().length,
    auth: 'required',
  });
});
app.get('/trpc/procedures', (_req, res) => res.json({ procedures: procedures() }));

/**
 * tRPC v11 httpBatchStreamLink 的 JSONL 惰性协议（对官方抓包逐字节还原）：
 *   行1  {"json":{"0":[[0],[null,0,<d0>]],"1":[[0],[null,0,<d1>]],…}}
 *   成功 {"json":[<d>,0,[[{"result":0}],["result",0,<e>]]]}
 *        {"json":[<e>,0,[[{"data":0}],["data",0,<f>]]]}
 *        {"json":[<f>,0,[[<返回值>]]]}
 *   失败 {"json":[<d>,2,{"message":…,"code":<数字码>,"data":{"code":…,"httpStatus":…}}]}
 * 每行以 \n 结尾；deferred id 顺序：header 0..N-1 → 各过程链依次递增。
 */
function jsonlBatch(results) {
  const lines = [];
  const n = results.length;
  let next = n;
  const header = {};
  for (let i = 0; i < n; i++) {
    const r = results[i];
    if (r.ok) {
      header[String(i)] = [[0], [null, 0, i]];
    } else {
      // 错误走内联信封（对应 U_ 的 'error' in e.json 分支）
      const err = r.err;
      header[String(i)] = [[{
        error: {
          message: err.message,
          code: err.code === 'BAD_REQUEST' ? -32600
            : err.code === 'UNAUTHORIZED' ? -32001
            : err.code === 'NOT_FOUND' ? -32004
            : err.code === 'TOO_MANY_REQUESTS' ? -32029
            : -32603,
          data: { code: err.code, httpStatus: err.httpStatus, path: null },
        },
      }]];
    }
  }
  lines.push({ json: header });
  for (let i = 0; i < n; i++) {
    const r = results[i];
    if (!r.ok) continue;
    const e = next++;
    const f = next++;
    lines.push({ json: [i, 0, [[{ result: 0 }], ['result', 0, e]]] });
    lines.push({ json: [e, 0, [[{ data: 0 }], ['data', 0, f]]] });
    lines.push({ json: [f, 0, [[r.data === undefined ? null : r.data]]] });
  }
  return lines.map((l) => JSON.stringify(l) + '\n').join('');
}

const numericCode = (e) =>
  e.code === 'BAD_REQUEST' ? -32600
    : e.code === 'UNAUTHORIZED' ? -32001
    : e.code === 'NOT_FOUND' ? -32004
    : e.code === 'TOO_MANY_REQUESTS' ? -32029
    : -32603;

/**
 * tRPC 统一入口：支持单请求与 httpBatchLink/httpBatchStreamLink 批量。
 * - 无 trpc-accept: application/jsonl → 响应普通 JSON 数组（自研 UI 用）
 * - 有该头（原版客户端恒发）→ 响应 JSONL 惰性流
 */
async function handleTrpc(req, res, rawName) {
  const kind = req.method === 'GET' ? 'query' : 'mutation';
  const names = String(rawName).split(',').map((s) => s.trim()).filter(Boolean);
  const isBatch = req.query.batch === '1' || names.length > 1;
  const wantsJsonl = String(req.headers['trpc-accept'] || '').includes('application/jsonl');

  if (!isBatch) {
    const input = parseInput(req.method === 'GET' ? req.query.input : req.body);
    const data = await invoke(names[0], { kind, input, req });
    return res.json({ result: { data: { json: data } } });
  }

  let indexed = null;
  if (req.method === 'GET') {
    indexed = parseInput(req.query.input);
  } else {
    indexed = parseInput(req.body);
  }
  const pick = (i) => {
    if (indexed && typeof indexed === 'object' && String(i) in indexed) {
      return unwrapEnvelope(indexed[String(i)]);
    }
    return indexed && typeof indexed === 'object' && !('json' in indexed) ? indexed : {};
  };

  const results = await Promise.all(names.map(async (name, i) => {
    try {
      const data = await invoke(name, { kind, input: pick(i), req });
      return { ok: true, data };
    } catch (e) {
      const err = e instanceof TRPCError ? e : new TRPCError(e.message || 'Internal Server Error', 'INTERNAL_SERVER_ERROR');
      return { ok: false, err };
    }
  }));

  if (wantsJsonl) {
    // 官方形态：application/json + chunked + 逐行 \n
    res.status(200);
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-cache');
    res.write(jsonlBatch(results));
    res.end();
    return;
  }

  const out = results.map((r) => (r.ok ? { result: { data: { json: r.data } } } : trpcErrorBody(r.err)));
  res.status(results.some((r) => !r.ok) ? 207 : 200).json(out);
}

app.get('/trpc/:name', async (req, res) => {
  try {
    await handleTrpc(req, res, req.params.name);
  } catch (e) {
    sendError(res, e);
  }
});

app.post('/trpc/:name', async (req, res) => {
  try {
    await handleTrpc(req, res, req.params.name);
  } catch (e) {
    sendError(res, e);
  }
});

/* ───────── 本地对象存储替身（兼容原版 OSS 直传 + 自研 JSON 上传）───────── */
const uploadRoot = path.join(config.dataDir, 'uploads');

function safeUploadPath(key) {
  const bare = String(key || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const full = path.resolve(uploadRoot, bare);
  return full === uploadRoot || full.startsWith(uploadRoot + path.sep) ? full : null;
}

const cuidish = () => crypto.randomBytes(9).toString('hex');

/* P0-4：上传目录不能成为同源脚本攻击面——拒绝可被浏览器当页面/脚本渲染的类型与内容，
 * 并由读取端强制 attachment + nosniff + CSP sandbox。 */
const BLOCKED_EXT = /\.(html?|xhtml|svg|xml|xsl|xslt|js|mjs|cjs|jsx|ts|tsx|wasm|hta|vbs|wsf|ps1|bat|cmd|exe|dll|scr|com|pif|jar|swf|php|asp|aspx|jsp)$/i;
function looksActive(buf) {
  const head = buf.subarray(0, 512).toString('latin1').replace(/^\uFEFF/, '').trimStart().toLowerCase();
  return /^<!doctype\s+html|^<html|^<svg|^<\?xml|^<script|^<%\s|^<meta|^<iframe|^<object|^<embed/.test(head);
}
function assertSafeUpload(key, name, buf) {
  if (BLOCKED_EXT.test(String(key || '')) || BLOCKED_EXT.test(String(name || ''))) {
    throw Object.assign(new Error('出于安全考虑，不允许上传可执行/可渲染脚本的文件类型（html/svg/js/xml 等）'), { status: 415 });
  }
  if (looksActive(buf)) {
    throw Object.assign(new Error('上传内容疑似 HTML/SVG/XML 等可执行标记，已拒绝'), { status: 415 });
  }
}

function saveUpload({ key, name, buf }) {
  if (!buf?.length) throw new Error('文件内容为空');
  assertSafeUpload(key, name, buf);
  const safeKey = String(key || `local/${cuidish()}-${path.basename(name || 'file.bin')}`)
    .replace(/\\/g, '/').replace(/^\/+/, '');
  const filePath = safeUploadPath(safeKey);
  if (!filePath) throw new Error('非法上传 key');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, buf);
  dbRun('INSERT INTO uploads(key,user_id,file_path,name,size,created_at) VALUES(?,?,?,?,?,?) ' +
    'ON CONFLICT(key) DO UPDATE SET file_path=excluded.file_path,name=excluded.name,size=excluded.size',
  safeKey, null, filePath, String(name || path.basename(safeKey)), buf.length, new Date().toISOString());
  return { key: safeKey, size: buf.length, filePath };
}

/** 上传体积上限（高危2）：multipart 与 base64 两条路径统一限制，可经 ML_UPLOAD_LIMIT 调整（非法值回落默认） */
const UPLOAD_LIMIT = (() => {
  const n = Number(process.env.ML_UPLOAD_LIMIT || 0);
  return Number.isFinite(n) && n >= 1024 ? n : 32 * 1024 * 1024;
})();

/** 极简 multipart 解析：只为 OSS 直传的 key + file 两个字段，零额外依赖。
 *  高危2：边读边累计字节数，超限立即 destroy 连接抛 413，不做全量缓冲。 */
async function readMultipart(req) {
  const type = String(req.headers['content-type'] || '');
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(type);
  if (!m) throw new Error('multipart 缺少 boundary');
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > UPLOAD_LIMIT) {
    throw Object.assign(new Error(`上传内容超过上限 ${Math.round(UPLOAD_LIMIT / 1024 / 1024)}MB`), { status: 413 });
  }
  const marker = Buffer.from(`--${m[1] || m[2]}`, 'latin1');
  const chunks = [];
  let received = 0;
  for await (const c of req) {
    received += c.length;
    if (received > UPLOAD_LIMIT) {
      req.destroy();
      throw Object.assign(new Error(`上传内容超过上限 ${Math.round(UPLOAD_LIMIT / 1024 / 1024)}MB`), { status: 413 });
    }
    chunks.push(c);
  }
  const body = Buffer.concat(chunks);
  const out = {};
  const pieces = [];
  let from = 0;
  for (;;) {
    const at = body.indexOf(marker, from);
    if (at < 0) break;
    const next = body.indexOf(marker, at + marker.length);
    if (next < 0) break;
    const part = body.subarray(at + marker.length, next);
    pieces.push(part[0] === 0x0d && part[1] === 0x0a ? part.subarray(2) : part);
    from = next;
  }
  for (const piece of pieces) {
    const start = piece.indexOf('\r\n\r\n');
    if (start < 0) continue;
    const head = piece.subarray(0, start).toString('latin1');
    const nameMatch = /name="([^"]*)"/i.exec(head);
    if (!nameMatch) continue;
    let value = piece.subarray(start + 4);
    if (value.length >= 2 && value[value.length - 2] === 0x0d && value[value.length - 1] === 0x0a) {
      value = value.subarray(0, value.length - 2);
    }
    if (/filename="/i.test(head)) {
      const fn = /filename="([^"]*)"/i.exec(head)?.[1] || '';
      out[nameMatch[1]] = { filename: fn, data: value };
    } else {
      out[nameMatch[1]] = value.toString('utf8');
    }
  }
  return out;
}

app.post('/upload', async (req, res) => {
  try {
    const isMultipart = String(req.headers['content-type'] || '').startsWith('multipart/form-data');
    let key;
    let name;
    let buf;
    if (isMultipart) {
      const form = await readMultipart(req);
      if (!form.file?.data?.length) return res.status(400).json({ error: 'file required' });
      key = form.key || `local/${cuidish()}-${path.basename(form.file.filename || 'file.bin')}`;
      name = form.file.filename || path.basename(key);
      buf = form.file.data;
    } else {
      const b = req.body || {};
      name = b.name || 'file.bin';
      if (!b.dataBase64) return res.status(400).json({ error: 'dataBase64 required' });
      buf = Buffer.from(b.dataBase64.includes(',') ? b.dataBase64.split(',').pop() : b.dataBase64, 'base64');
      // 高危2：base64 分支同样校验解码后大小
      if (buf.length > UPLOAD_LIMIT) {
        return res.status(413).json({ error: `上传内容超过上限 ${Math.round(UPLOAD_LIMIT / 1024 / 1024)}MB` });
      }
      key = b.key;
    }
    const saved = saveUpload({ key, name, buf });
    res.json({ key: saved.key, url: `/upload/${saved.key}`, size: saved.size });
  } catch (e) {
    if (e?.status === 413) return res.status(413).json({ error: e.message });
    if (e?.status === 415) return res.status(415).json({ error: e.message });
    res.status(400).json({ error: e.message || 'upload failed' });
  }
});

/** 读取上传文件（原版签名返回 fileUrl = endpoint/key，前端会直接展示）。
 *  P0-4：强制附件下载 + nosniff + CSP sandbox——即使历史遗留的 HTML 也不会同源执行。 */
app.get('/upload/*', (req, res) => {
  const key = req.params[0] || ''; // Express 已对路由参数做过一次解码
  const filePath = safeUploadPath(key);
  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return res.status(404).type('text/plain').send('Not Found');
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(filePath))}`);
  res.sendFile(filePath);
});

/** 副屏页（文档 02 §4：/session/interview/waiting 与 /session/exam/secondary） */
function secondaryPage(kind) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>面试橙 · ${kind === 'exam' ? '笔试副屏' : '面试等待'}</title>
<style>body{font-family:system-ui,"Microsoft YaHei";background:#0e1014;color:#e6e8ee;display:grid;place-items:center;height:100vh;margin:0}
.card{text-align:center;max-width:520px;padding:32px}h1{font-size:20px;margin:0 0 10px}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#22c55e;margin-right:6px}
small{opacity:.6}</style></head><body><div class="card">
<h1><span class="dot" id="dot"></span>${kind === 'exam' ? '笔试副屏已就绪' : '正在等待面试开始'}</h1>
<div id="msg">保持此窗口打开，主设备开始后会自动同步。</div><small id="sid"></small></div>
<script>
const token = new URLSearchParams(location.search).get('token') || '';
const sid = new URLSearchParams(location.search).get('sessionId') || '';
document.getElementById('sid').textContent = sid ? ('session: ' + sid) : '';
async function tick(){
  if (!token || !sid) return;
  try {
    const r = await fetch('/trpc/session.sessionStatus?input=' + encodeURIComponent(JSON.stringify({json:{id:sid}})), {headers:{authorization:'Bearer '+token}});
    const j = await r.json();
    const st = j.result?.data?.json?.status;
    document.getElementById('msg').textContent = st === 'ACTIVE' ? '会话进行中，请保持连接。' : st === 'COMPLETED' ? '会话已结束，可以关闭此窗口。' : '等待中…';
    document.getElementById('dot').style.background = st === 'ACTIVE' ? '#22c55e' : st === 'COMPLETED' ? '#6b7280' : '#eab308';
  } catch (e) { /* ignore */ }
}
tick(); setInterval(tick, 3000);
</script></body></html>`;
}

app.get('/session/interview/waiting', (_req, res) => { pageHeaders(res); res.type('html').send(secondaryPage('interview')); });
app.get('/session/exam/secondary', (_req, res) => { pageHeaders(res); res.type('html').send(secondaryPage('exam')); });
/** 模拟收银台已随账号/计费模块移除（2026-11-23） */
/** ───────── 原版前端挂载（/legacy）─────────
 * 优先伺服包内 legacy/（绿色版自带），否则回退到同级 reverse-engineered/www，
 * 注入 Tauri 桩 + apiBase 改写，使原版界面跑在本项目后端上。
 */
const legacyLocal = path.join(projectRoot, 'legacy');
const legacyDir = fs.existsSync(path.join(legacyLocal, 'index.html'))
  ? legacyLocal
  : path.resolve(projectRoot, '..', 'reverse-engineered', 'www');
const legacyShim = path.join(projectRoot, 'server', 'legacy-shim.js');

function legacyIndexHtml() {
  const raw = fs.readFileSync(path.join(legacyDir, 'index.html'), 'utf8');
  return raw
    .replace(/(src|href)="\/assets\//g, '$1="/legacy/assets/')
    .replace('<head>', `<head>\n    <script src="/legacy/shim.js"></script>\n    ${envScript}`);
}

app.get('/legacy/shim.js', (_req, res) => res.type('application/javascript').sendFile(legacyShim));
app.use('/legacy/assets', express.static(path.join(legacyDir, 'assets')));
app.get(['/legacy', '/legacy/'], (_req, res) => {
  try {
    pageHeaders(res);
    res.type('html').send(legacyIndexHtml());
  } catch {
    res.status(503).type('text/plain').send('原版前端目录不存在：reverse-engineered/www');
  }
});
app.get('/legacy/*', (req, res) => {
  // SPA 回退：/legacy/desktop/mock-interview 等路径全部回原版 index
  try {
    pageHeaders(res);
    res.type('html').send(legacyIndexHtml());
  } catch {
    res.status(503).type('text/plain').send('原版前端目录不存在：reverse-engineered/www');
  }
});

/** 静态前端 + 透明浮窗页（SPA 回退；index.html 一律走注入版以带上调用凭证） */
app.use(express.static(config.publicDir, { index: false, extensions: ['html'] }));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/trpc/') || req.path.startsWith('/socket.io')) return next();
  return serveIndexHtml(res);
});

migrate();
bootSettings();
if (!one('SELECT 1 FROM users LIMIT 1')) {
  console.log('[boot] 空库 → 自动 seed');
  seed();
}
// 启动时滚动清理（screenshots 保留 200 张 / uploads 保留 500 个，防目录无限增长）
{
  const prunedShots = pruneDir(config.screenshotsDir, 200);
  const prunedUploads = pruneDir(path.join(config.dataDir, 'uploads'), 500);
  if (prunedShots || prunedUploads) {
    console.log(`[boot] 滚动清理：screenshots -${prunedShots}，uploads -${prunedUploads}`);
  }
  // P2：文件被清理后同步清掉失效的 uploads 记录，避免孤儿行
  try {
    const rows = dbAll('SELECT key, file_path FROM uploads');
    let stale = 0;
    for (const r of rows) {
      if (!r.file_path || !fs.existsSync(r.file_path)) {
        dbRun('DELETE FROM uploads WHERE key=?', r.key);
        stale += 1;
      }
    }
    if (stale) console.log(`[boot] 清理失效上传记录 ${stale} 条`);
  } catch (e) {
    console.warn('[boot] 上传记录清理失败:', e.message);
  }
}

const server = http.createServer(app);
attachSocket(server, { socketToken });

server.listen(config.port, config.host, () => {
  const base = `http://${config.host}:${config.port}`;
  console.log(`\n面试橙（独立环境）已启动`);
  console.log(`  主工作台 : ${base}/#main`);
  console.log(`  浮窗     : ${base}/#overlay`);
  console.log(`  会话房间 : ${base}/#mock`);
  console.log(`  笔试     : ${base}/#mock-exam`);
  console.log(`  tRPC     : ${base}/trpc/<procedure>   （${procedures().length} 个过程）`);
  console.log(`  AI provider: ${config.ai.provider}${config.ai.provider === 'mock' ? '（离线确定性大脑）' : `（${config.ai.model}）`} · 来源 ${aiSnapshot().source === 'settings' ? '设置页覆盖' : '.env/默认'}`);
  console.log(`  语音识别   : ${asrName()}${asrSnapshot().source === 'settings' ? '（设置页覆盖）' : ''}`);
  console.log(`  数据目录 : ${config.dataDir}\n`);
});
