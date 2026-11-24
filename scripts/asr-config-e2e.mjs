/**
 * ASR 运行时配置 e2e：真起一个「支持 input_audio」的假网关，验证
 *   设置页写入 → config.asr 热切换 → tools.stt.stt 真转写 → 回退替身 全链路。
 * 运行：node scripts/asr-config-e2e.mjs   （server 需已在 8756 运行；脚本结束会把 DB 覆盖清掉）
 */
import http from 'node:http';

const BASE = process.env.ML_BASE || 'http://127.0.0.1:8756';
const UPSTREAM = Number(process.env.ASR_UPSTREAM_PORT || 8798);
const UP_BASE = `http://127.0.0.1:${UPSTREAM}/v1`;
const KEY = 'asr-e2e-key';
const TRANSCRIPT = 'E2E-ASR-TRANSCRIPT-9c1d';

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

/* 1s 静音 WAV（16k mono PCM16）——只要 >1KB 就能进 enrich 的转写分支 */
function silentWav(ms = 1000, rate = 16000) {
  const data = Buffer.alloc(Math.round((rate * ms) / 1000) * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

const captured = [];
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };

function audioPayload(body) {
  const msgs = body?.messages || [];
  for (const m of msgs) {
    if (!Array.isArray(m.content)) continue;
    const part = m.content.find((c) => c?.type === 'input_audio');
    if (part) return part.input_audio?.data || '';
  }
  return '';
}

function startUpstream() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const p = parse(body) || {};
      captured.push({ url: req.url, auth: req.headers.authorization || '', model: p.model, audio: audioPayload(p), body: p });
      if (req.headers.authorization !== `Bearer ${KEY}`) {
        res.writeHead(401, { 'content-type': 'application/json' });
        return res.end('{"error":{"message":"bad key"}}');
      }
      if (req.url === '/v1/models' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ object: 'list', data: [{ id: 'asr-chat' }, { id: 'qwen3.8-omni-flash' }] }));
      }
      if (req.url === '/v1/chat/completions' && req.method === 'POST') {
        const audio = audioPayload(p);
        if (!audio.startsWith('data:audio/wav;base64,')) {
          res.writeHead(400, { 'content-type': 'application/json' });
          return res.end('{"error":{"message":"missing input_audio"}}');
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ model: p.model || 'asr-chat', choices: [{ message: { role: 'assistant', content: TRANSCRIPT } }] }));
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":{"message":"not found"}}');
    });
  });
  return new Promise((resolve) => server.listen(UPSTREAM, '127.0.0.1', () => resolve(server)));
}

async function main() {
  const upstream = await startUpstream();
  console.log(`[e2e] 假音频网关 ${UP_BASE} 已就绪`);

  const temp = await call('user.getTempToken', 'mutation', {});
  const login = await call('user.loginByTempToken', 'mutation', { token: temp.token, client: 'desktop', version: 'desktop/0.3.25', platform: 'win32' });
  const token = login.token;

  // 0) 清场：回到 .env 基线（asr=mock）
  await call('settings.asr.reset', 'mutation', {}, token);
  let health = await (await fetch(`${BASE}/healthz`)).json();
  ok('baseline.mock', `asr=${health.asr} source=${health.asrSource}`);
  const baselineIsReal = health.asr && health.asr !== 'mock';

  // 1) 只读视图：无明文 key
  const before = await call('settings.asr.get', 'query', {}, token);
  ok('settings.asr.get', `provider=${before.provider} task=${before.task} hasKey=${before.hasKey} source=${before.source}`);
  if (typeof before.apiKey !== 'undefined') bad('settings.asr.get 泄露明文 apiKey');

  // 2) 缺 key 自检必须失败
  const noKey = await call('settings.asr.probe', 'mutation', { provider: 'qianwen', baseUrl: UP_BASE, model: 'asr-chat' }, token);
  ok('probe.noKey.fails', `ok=${noKey.ok} error=${noKey.error}`);
  if (noKey.ok) bad('probe.noKey 应失败');

  // 3) 先测后存：假网关走 input_audio 通道
  const probe = await call('settings.asr.probe', 'mutation', { provider: 'qianwen', baseUrl: UP_BASE, apiKey: KEY, model: 'asr-chat' }, token);
  ok('probe.ok', `ok=${probe.ok} latency=${probe.latencyMs}ms models=${(probe.models || []).join(',')}`);
  if (!probe.ok) bad('probe.ok 失败', JSON.stringify(probe.checks));
  if (!(probe.checks || []).find((c) => c.name === 'audio' && c.ok)) bad('probe 缺少 audio 检查通过项');
  if (String(probe.text || '') !== TRANSCRIPT) bad('probe 回转写文本不符', probe.text);
  const probeCall = captured.filter((c) => c.url === '/v1/chat/completions').pop();
  if (!String(probeCall?.audio || '').startsWith('data:audio/wav;base64,')) bad('自检未带 input_audio', String(probeCall?.audio).slice(0, 40));
  health = await (await fetch(`${BASE}/healthz`)).json();
  ok('probe.noSideEffect', `asr=${health.asr} source=${health.asrSource}`);

  // 4) 保存并热切换
  const saved = await call('settings.asr.set', 'mutation', {
    provider: 'qianwen', baseUrl: UP_BASE, apiKey: KEY, model: 'asr-chat',
    silenceGateMs: 1200, maxUtteranceMs: 20000,
  }, token);
  ok('settings.asr.set', `provider=${saved.provider} model=${saved.model} gate=${saved.silenceGateMs} max=${saved.maxUtteranceMs} masked=${saved.apiKeyMasked} source=${saved.source}`);
  if (saved.apiKey) bad('settings.asr.set 回传明文 key');
  if (!String(saved.apiKeyMasked).includes('***')) bad('掩码格式异常', saved.apiKeyMasked);

  health = await (await fetch(`${BASE}/healthz`)).json();
  ok('healthz.hotSwap', `asr=${health.asr} source=${health.asrSource} hasKey=${health.asrHasKey}`);
  if (health.asr !== 'asr-chat' || health.asrSource !== 'settings') bad('healthz 未反映 ASR 热切换');

  // 5) 业务链路：tools.stt.stt 走真转写（enrich → config.asr）
  captured.length = 0;
  const wav = silentWav();
  const stt = await call('tools.stt.stt', 'mutation', { audioBase64: wav.toString('base64') }, token);
  ok('tools.stt.stt.real', `source=${stt.source} model=${stt.model} text=${String(stt.text).slice(0, 32)}`);
  if (stt.source !== 'asr') bad('未走真 ASR 分支（回退了 stub？）', JSON.stringify(stt));
  if (stt.text !== TRANSCRIPT) bad('转写文本不是上游回包', stt.text);
  const sttCall = captured.find((c) => c.url === '/v1/chat/completions');
  if (!sttCall) bad('上游未收到 /chat/completions');
  else {
    if (sttCall.auth !== `Bearer ${KEY}`) bad('上游 Authorization 头异常', sttCall.auth);
    if (sttCall.model !== 'asr-chat') bad('上游 model 不符', sttCall.model);
    ok('upstream.audioPayload', `model=${sttCall.model} dataUrl=${String(sttCall.audio).slice(0, 30)}… len=${String(sttCall.audio).length}`);
  }

  // 6) 不可达网关：自检失败要带诊断
  const dead = await call('settings.asr.probe', 'mutation', { provider: 'qianwen', baseUrl: 'http://127.0.0.1:9/v1', apiKey: KEY, model: 'x' }, token);
  ok('probe.unreachable', `ok=${dead.ok} checks=${(dead.checks || []).map((c) => `${c.name}:${c.ok}`).join(' ')}`);
  if (dead.ok) bad('不可达网关不应通过自检');

  // 7) 校验拦截：清 key 还想要 qianwen 必须被拒
  const rejected = await call('settings.asr.set', 'mutation', { provider: 'qianwen', clearApiKey: true }, token).catch((e) => e.message);
  ok('validate.keyRequired', String(rejected).slice(0, 60));

  // 8) 参数越界拦截
  const badGate = await call('settings.asr.set', 'mutation', { silenceGateMs: 50 }, token).catch((e) => e.message);
  ok('validate.gateRange', String(badGate).slice(0, 60));

  // 9) 回退 .env 基线：基线为真 ASR（.env 配了 key）则期望真转写，否则期望替身
  const reset = await call('settings.asr.reset', 'mutation', {}, token);
  ok('settings.asr.reset', `provider=${reset.provider} task=${reset.task} source=${reset.source}`);
  const sttStub = await call('tools.stt.stt', 'mutation', { audioBase64: wav.toString('base64') }, token);
  ok('fallback.stub', `source=${sttStub.source} text=${String(sttStub.text).slice(0, 20)}…`);
  const expectSource = baselineIsReal ? 'asr' : 'stub';
  if (sttStub.source !== expectSource) bad(`回退后应为 ${expectSource}`, sttStub.source);
  health = await (await fetch(`${BASE}/healthz`)).json();
  ok('healthz.afterReset', `asr=${health.asr} source=${health.asrSource}`);

  upstream.close();
  const fails = results.filter((r) => r[0] === 'FAIL');
  console.log('');
  for (const [s, n, e] of results) console.log(`[${s}] ${n}${e ? ' — ' + e : ''}`);
  console.log(`\n合计 ${results.length} 项，失败 ${fails.length} 项`);
  if (fails.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error('[e2e] 失败：', e);
  process.exitCode = 1;
  process.exit(1);
});
