/**
 * 服务入口：独立端口（默认 8756）+ 独立数据目录（./data）。
 * 同时提供：tRPC HTTP 兼容层 / Socket.IO 双 namespace / 本地上传 / 前端静态资源。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { config, root as projectRoot } from './config.js';
import { migrate, one, run as dbRun } from './db.js';
import { seed } from './seed.js';
import { attachSocket } from './socket.js';
import { asrName } from './ai/asr.js';
import { TRPCError, invoke, parseInput, procedures, unwrapEnvelope } from './trpc/index.js';

// 保险丝：上游模型/网络故障只降级记录，不允许掀翻整个本地服务
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e?.stack || e));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e?.stack || e));

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '30mb' }));
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

app.get('/healthz', (_req, res) => res.json({ ok: true, version: config.version, provider: config.ai.provider, model: config.ai.provider === 'openai' ? config.ai.model : null, asr: asrName(), procedures: procedures().length }));
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

  const results = [];
  for (let i = 0; i < names.length; i++) {
    try {
      const data = await invoke(names[i], { kind, input: pick(i), req });
      results.push({ ok: true, data });
    } catch (e) {
      const err = e instanceof TRPCError ? e : new TRPCError(e.message || 'Internal Server Error', 'INTERNAL_SERVER_ERROR');
      results.push({ ok: false, err });
    }
  }

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

/** 本地对象存储替身：POST /upload {name, dataBase64} → {key, url} */
app.post('/upload', (req, res) => {
  const { name = 'file.bin', dataBase64 = '' } = req.body || {};
  if (!dataBase64) return res.status(400).json({ error: 'dataBase64 required' });
  const key = `local/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${path.basename(name)}`;
  const dir = path.join(config.dataDir, 'uploads');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, key.replace(/^local\//, ''));
  const buf = Buffer.from(dataBase64.includes(',') ? dataBase64.split(',').pop() : dataBase64, 'base64');
  fs.writeFileSync(filePath, buf);
  dbRun('INSERT INTO uploads(key,user_id,file_path,name,size,created_at) VALUES(?,?,?,?,?,?)',
    key, null, filePath, name, buf.length, new Date().toISOString());
  res.json({ key, url: `/upload/${encodeURIComponent(key)}`, size: buf.length });
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

app.get('/session/interview/waiting', (_req, res) => res.type('html').send(secondaryPage('interview')));
app.get('/session/exam/secondary', (_req, res) => res.type('html').send(secondaryPage('exam')));
/** 模拟收银台（pay.createOrder 返回的 checkoutUrl 落在这里） */
app.get('/pay/mock', (req, res) => {
  const { order = '', sku = 'weekly', channel = 'wxpay', amount = '2900' } = req.query;
  const yuan = (Number(amount) / 100).toFixed(2);
  res.type('html').send(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>面试橙 · 收银台（模拟）</title>
<style>body{font-family:system-ui,"Microsoft YaHei";background:#f5f6f8;display:grid;place-items:center;height:100vh;margin:0}
.card{background:#fff;border-radius:14px;padding:28px 32px;box-shadow:0 10px 40px rgba(0,0,0,.12);width:360px}
h2{margin:0 0 16px;font-size:18px}.row{display:flex;justify-content:space-between;margin:8px 0;color:#555;font-size:14px}
.amount{font-size:26px;font-weight:700;color:#111;margin:14px 0}
button{width:100%;padding:11px;border:0;border-radius:10px;background:#4f46e5;color:#fff;font-size:15px;cursor:pointer}
button:disabled{opacity:.6}.ok{color:#16a34a;margin-top:12px;font-size:13px}</style></head>
<body><div class="card"><h2>面试橙 · 收银台（本地模拟）</h2>
<div class="row"><span>订单号</span><span>${order}</span></div>
<div class="row"><span>商品</span><span>${sku}</span></div>
<div class="row"><span>渠道</span><span>${channel}</span></div>
<div class="amount">¥ ${yuan}</div>
<button id="pay">确认支付（模拟）</button><div class="ok" id="msg"></div></div>
<script>
document.getElementById('pay').onclick = async function(){
  this.disabled = true; this.textContent = '支付中…';
  try {
    const r = await fetch('/trpc/pay.mockConfirm', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({json:{order:'${order}', sku:'${sku}'}})});
    const j = await r.json();
    if (j.error) throw new Error(j.error.json.message);
    document.getElementById('msg').textContent = '支付成功：' + JSON.stringify(j.result.data.json);
    this.textContent = '已支付';
  } catch(e) { document.getElementById('msg').textContent = '失败：' + e.message; this.disabled = false; this.textContent = '重试'; }
};
</script></body></html>`);
});
/** ───────── 原版前端挂载（/legacy）─────────
 * 直接伺服 reverse-engineered/www 的原版 UI，注入 Tauri 桩 + apiBase 改写，
 * 使原版界面跑在本项目后端上（原 serve.js 思路的服务端重实现）。
 */
const legacyDir = path.resolve(projectRoot, '..', 'reverse-engineered', 'www');
const legacyShim = path.join(projectRoot, 'server', 'legacy-shim.js');

function legacyIndexHtml() {
  const raw = fs.readFileSync(path.join(legacyDir, 'index.html'), 'utf8');
  return raw
    .replace(/(src|href)="\/assets\//g, '$1="/legacy/assets/')
    .replace('<head>', '<head>\n    <script src="/legacy/shim.js"></script>');
}

app.get('/legacy/shim.js', (_req, res) => res.type('application/javascript').sendFile(legacyShim));
app.use('/legacy/assets', express.static(path.join(legacyDir, 'assets')));
app.get(['/legacy', '/legacy/'], (_req, res) => {
  try {
    res.type('html').send(legacyIndexHtml());
  } catch {
    res.status(503).type('text/plain').send('原版前端目录不存在：reverse-engineered/www');
  }
});
app.get('/legacy/*', (req, res) => {
  // SPA 回退：/legacy/desktop/mock-interview 等路径全部回原版 index
  try {
    res.type('html').send(legacyIndexHtml());
  } catch {
    res.status(503).type('text/plain').send('原版前端目录不存在：reverse-engineered/www');
  }
});

/** 静态前端 + 透明浮窗页（SPA 回退） */
app.use(express.static(config.publicDir, { index: 'index.html', extensions: ['html'] }));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/trpc/') || req.path.startsWith('/socket.io')) return next();
  const index = path.join(config.publicDir, 'index.html');
  if (fs.existsSync(index)) return res.sendFile(index);
  res.status(503).type('text/plain').send('前端尚未构建：先运行 npm run build');
});

migrate();
if (!one('SELECT 1 FROM users LIMIT 1')) {
  console.log('[boot] 空库 → 自动 seed');
  seed();
}

const server = http.createServer(app);
attachSocket(server);

server.listen(config.port, config.host, () => {
  const base = `http://${config.host}:${config.port}`;
  console.log(`\n面试橙（独立环境）已启动`);
  console.log(`  主工作台 : ${base}/#main`);
  console.log(`  浮窗     : ${base}/#overlay`);
  console.log(`  会话房间 : ${base}/#mock`);
  console.log(`  笔试     : ${base}/#mock-exam`);
  console.log(`  tRPC     : ${base}/trpc/<procedure>   （${procedures().length} 个过程）`);
  console.log(`  AI provider: ${config.ai.provider}${config.ai.provider === 'mock' ? '（离线确定性大脑）' : `（${config.ai.model}）`}`);
  console.log(`  数据目录 : ${config.dataDir}\n`);
});
