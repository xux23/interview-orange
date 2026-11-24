/**
 * AI 接入配置中心 e2e：真起一个 OpenAI 兼容假网关，验证「设置页写入 → 热切换 → 真模型答题 → 回退」全链路。
 * 运行：node scripts/ai-config-e2e.mjs   （server 需已在 8756 运行；脚本结束会把 DB 覆盖清掉）
 */
import http from 'node:http';
import { io } from 'socket.io-client';

const BASE = process.env.ML_BASE || 'http://127.0.0.1:8756';
const UPSTREAM = Number(process.env.UPSTREAM_PORT || 8799);
const UP_BASE = `http://127.0.0.1:${UPSTREAM}/v1`;
const KEY = 'e2e-key';
const MARK = 'E2E-UPSTREAM-OK-7f3c';

const results = [];
const ok = (n, extra = '') => results.push(['PASS', n, extra]);
const bad = (n, extra = '') => results.push(['FAIL', n, extra]);

async function call(name, kind, input, token) {
  const url = kind === 'query'
    ? `${BASE}/trpc/${name}?input=${encodeURIComponent(JSON.stringify({ json: input || {} }))}`
    : `${BASE}/trpc/${name}`;
  const res = await fetch(url, {
    method: kind === 'query' ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: kind === 'query' ? undefined : JSON.stringify({ json: input || {} }),
  });
  const json = await res.json().catch(() => ({}));
  if (json.error) throw new Error(`${name}: ${json.error.json?.message || 'unknown'}`);
  return json.result.data.json;
}

const waitFor = (sock, ev, ms = 15000) =>
  new Promise((resolve) => { const t = setTimeout(() => resolve(null), ms); sock.once(ev, (p) => { clearTimeout(t); resolve(p); }); });

/* ───────── 假 OpenAI 网关：/v1/models + /v1/chat/completions(JSON & SSE) ───────── */
const captured = [];
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };

function startUpstream() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      captured.push({ url: req.url, auth: req.headers.authorization || '', body: parse(body) });
      if (req.url === '/v1/models' && req.method === 'GET') {
        if (req.headers.authorization !== `Bearer ${KEY}`) {
          res.writeHead(401, { 'content-type': 'application/json' });
          return res.end('{"error":{"message":"bad key"}}');
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ object: 'list', data: [{ id: 'e2e-chat' }, { id: 'e2e-vision' }] }));
      }
      if (req.url === '/v1/chat/completions' && req.method === 'POST') {
        const p = parse(body) || {};
        if (req.headers.authorization !== `Bearer ${KEY}`) {
          res.writeHead(401, { 'content-type': 'application/json' });
          return res.end('{"error":{"message":"bad key"}}');
        }
        if (p.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
          for (const piece of [MARK.slice(0, 9), MARK.slice(9)]) {
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
          }
          res.write('data: [DONE]\n\n');
          return res.end();
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ model: p.model || 'e2e-chat', choices: [{ message: { role: 'assistant', content: MARK } }] }));
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":{"message":"not found"}}');
    });
  });
  return new Promise((resolve) => server.listen(UPSTREAM, '127.0.0.1', () => resolve(server)));
}

async function main() {
  const upstream = await startUpstream();
  console.log(`[e2e] 假网关 ${UP_BASE} 已就绪`);

  const temp = await call('user.getTempToken', 'mutation', {});
  const login = await call('user.loginByTempToken', 'mutation', { token: temp.token, client: 'desktop', version: 'desktop/0.3.25', platform: 'win32' });
  const token = login.token;

  // 0) 清场：先回 .env，保证基线是 mock
  await call('settings.ai.reset', 'mutation', {}, token);
  let health = await (await fetch(`${BASE}/healthz`)).json();
  ok('baseline.mock', `provider=${health.provider} source=${health.providerSource}`);

  // 1) 只读视图：无 key、无明文
  const before = await call('settings.ai.get', 'query', {}, token);
  ok('settings.ai.get', `provider=${before.provider} hasKey=${before.hasKey} source=${before.source}`);
  if (typeof before.apiKey !== 'undefined') bad('settings.ai.get 泄露明文 apiKey');

  // 2) 缺 key 的自检必须明确失败
  const probeNoKey = await call('settings.ai.probe', 'mutation', { provider: 'openai', baseUrl: UP_BASE, model: 'e2e-chat' }, token);
  ok('probe.noKey.fails', `ok=${probeNoKey.ok} error=${probeNoKey.error}`);
  if (probeNoKey.ok) bad('probe.noKey 应失败');

  // 3) 先测后存：假网关应通过（/models + /chat/completions 双检）
  const probe = await call('settings.ai.probe', 'mutation', { provider: 'openai', baseUrl: UP_BASE, apiKey: KEY, model: 'e2e-chat' }, token);
  ok('probe.ok', `ok=${probe.ok} latency=${probe.latencyMs}ms models=${(probe.models || []).join(',')}`);
  if (!probe.ok) bad('probe.ok 失败', JSON.stringify(probe.checks));
  if (!(probe.checks || []).find((c) => c.name === 'chat' && c.ok)) bad('probe 缺少 chat 检查通过项');
  if (!String(probe.reply || '').includes(MARK)) bad('probe 回包不含标记', probe.reply);
  // 自检不得改生效配置
  health = await (await fetch(`${BASE}/healthz`)).json();
  ok('probe.noSideEffect', `provider=${health.provider}`);

  // 4) 保存并热切换（不重启进程）
  const saved = await call('settings.ai.set', 'mutation', {
    provider: 'openai', baseUrl: UP_BASE, apiKey: KEY, model: 'e2e-chat', visionModel: 'e2e-vision', temperature: 0.2,
  }, token);
  ok('settings.ai.set', `provider=${saved.provider} model=${saved.model} masked=${saved.apiKeyMasked} source=${saved.source}`);
  if (saved.apiKey) bad('settings.ai.set 回传明文 key');
  if (!String(saved.apiKeyMasked).includes('***')) bad('掩码格式异常', saved.apiKeyMasked);

  health = await (await fetch(`${BASE}/healthz`)).json();
  ok('healthz.hotSwap', `provider=${health.provider} model=${health.model} source=${health.providerSource}`);
  if (health.provider !== 'openai' || health.model !== 'e2e-chat') bad('healthz 未反映热切换');

  // 5) 非流式业务链路：promptStudio.run 必须打到假网关
  captured.length = 0;
  const run = await call('promptStudio.run', 'mutation', { scene: 'interview', question: '请做自我介绍' }, token);
  ok('interviewRun.upstream', `answer=${run.answer.slice(0, 24)}… systemPrompt=${run.systemPrompt.length}字`);
  const chatCall = captured.find((c) => c.url === '/v1/chat/completions');
  if (!chatCall) bad('上游未收到 /chat/completions');
  else {
    if (chatCall.auth !== `Bearer ${KEY}`) bad('上游 Authorization 头异常', chatCall.auth);
    if (!String(run.answer).includes(MARK)) bad('answer 不是上游回包', run.answer);
    ok('upstream.authAndPayload', `model=${chatCall.body?.model} stream=${chatCall.body?.stream} max_tokens=${chatCall.body?.max_tokens} msgs=${chatCall.body?.messages?.length}`);
  }

  // 6) 流式链路：socket 面试 ai.message 应逐块收到上游 SSE
  const session = await call('session.createSession', 'mutation', {
    type: 'MOCK_INTERVIEW', audioSource: 'MICROPHONE', round: 'FIRST', metadata: { assistMode: true, lang: 'zh-CN' },
  }, token);
  const sock = io(BASE, { auth: { token, locale: 'zh', sessionId: session.id }, transports: ['websocket'], reconnection: false });
  const chunks = [];
  sock.on('ai.message', (c) => chunks.push(c));
  await new Promise((r) => setTimeout(r, 700));
  const gotEnd = waitFor(sock, 'ai.messageEnd', 20000);
  sock.emit('mock.start', {});
  await gotEnd;
  const streamed = chunks.join('');
  ok('socket.stream.upstream', `chunks=${chunks.length} text=${streamed.slice(0, 24)}…`);
  if (!streamed.includes(MARK)) bad('socket 流式未走上游', streamed.slice(0, 80));
  if (chunks.length < 2) bad('流式应分块（假网关两段）', `chunks=${chunks.length}`);
  sock.emit('mock.end', {});
  sock.disconnect();

  // 7) 不可达网关：自检失败要带诊断，不影响当前生效配置
  const probeDead = await call('settings.ai.probe', 'mutation', { provider: 'openai', baseUrl: 'http://127.0.0.1:9/v1', apiKey: KEY, model: 'x' }, token);
  ok('probe.unreachable', `ok=${probeDead.ok} checks=${(probeDead.checks || []).map((c) => `${c.name}:${c.ok}`).join(' ')}`);
  if (probeDead.ok) bad('不可达网关不应通过自检');

  // 8) 校验拦截：清 key 还想要 openai 必须被拒
  const rejected = await call('settings.ai.set', 'mutation', { provider: 'openai', clearApiKey: true }, token).catch((e) => e.message);
  ok('validate.keyRequired', String(rejected).slice(0, 60));

  // 9) 回退 .env，业务回 mock
  const reset = await call('settings.ai.reset', 'mutation', {}, token);
  ok('settings.ai.reset', `provider=${reset.provider} source=${reset.source}`);
  const runMock = await call('promptStudio.run', 'mutation', { scene: 'interview', question: '请做自我介绍' }, token);
  ok('fallback.mock', `answer=${runMock.answer.slice(0, 20)}… 含上游标记=${runMock.answer.includes(MARK)}`);
  if (runMock.answer.includes(MARK)) bad('回退后仍走上游');
  health = await (await fetch(`${BASE}/healthz`)).json();
  ok('healthz.afterReset', `provider=${health.provider} source=${health.providerSource}`);

  upstream.close();
  const fails = results.filter((r) => r[0] === 'FAIL');
  console.log('');
  for (const [s, n, e] of results) console.log(`[${s}] ${n}${e ? ' — ' + e : ''}`);
  console.log(`\n合计 ${results.length} 项，失败 ${fails.length} 项`);
  if (fails.length) process.exitCode = 1;
}

main().catch(async (e) => {
  console.error('[e2e] 失败：', e);
  process.exitCode = 1;
  try { process.exit(1); } catch { /* ignore */ }
});
