/**
 * 回答延迟基准：TTFT（首字）与总耗时，覆盖四条真实链路。
 *   A. 面试辅助答案（socket 流式，最关键）
 *   B. 笔试截图解题（socket /desktop）
 *   C. 语音转写（tools.stt.stt）
 *   D. 押题生成（questionPrediction.generate）
 * 对照文档 15：官方实测 2s 首字 / 3.5s 完成。
 * 运行：node scripts/latency-bench.mjs
 */
import { io } from 'socket.io-client';
import fs from 'node:fs';
import { trpcHeaders, socketAuth } from './lib/local-auth.mjs';

const BASE = process.env.ML_BASE || 'http://127.0.0.1:8756';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const stats = (arr) => {
  const a = [...arr].sort((x, y) => x - y);
  return { avg: Math.round(a.reduce((n, v) => n + v, 0) / a.length), min: a[0], max: a[a.length - 1], n: a.length };
};
const row = (label, s) => `  ${label.padEnd(22)} 平均 ${String(s.avg).padStart(6)}ms   最快 ${String(s.min).padStart(5)}ms   最慢 ${String(s.max).padStart(5)}ms   (n=${s.n})`;

async function call(name, kind, input, token) {
  const url = kind === 'query'
    ? `${BASE}/trpc/${name}?input=${encodeURIComponent(JSON.stringify({ json: input || {} }))}`
    : `${BASE}/trpc/${name}`;
  const res = await fetch(url, {
    method: kind === 'query' ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...trpcHeaders(), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: kind === 'query' ? undefined : JSON.stringify({ json: input || {} }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`${name}: ${json.error.json?.message}`);
  return json.result.data.json;
}

const health = await (await fetch(`${BASE}/healthz`)).json();
console.log(`provider=${health.provider} model=${health.model} asr=${health.asr}\n`);

const temp = await call('user.getTempToken', 'mutation', {});
const token = (await call('user.loginByTempToken', 'mutation', { token: temp.token })).token;
const resumes = await call('resume.getResumes', 'query', {}, token);
const goals = await call('goal.getGoals', 'query', {}, token);
const resumeId = resumes[0]?.id, goalId = goals[0]?.id;
const session = await call('session.createSession', 'mutation', {
  type: 'MOCK_INTERVIEW', resumeId, goalId, metadata: { assistMode: true, lang: 'zh-CN' },
}, token);

const s = io(BASE, { auth: socketAuth({ token, locale: 'zh', sessionId: session.id }), transports: ['websocket'], reconnection: false });
await wait(700);

/* ── A. 面试辅助答案：TTFT + 完成 ── */
const ttfts = [], totals = [], lens = [];
const QUESTIONS = [
  'MySQL 的索引为什么用 B+ 树？什么时候会回表？',
  'Redis 缓存和数据库怎么保证一致性？',
  '如何设计一个高并发秒杀系统？',
];
const askOne = (q) => new Promise((resolve) => {
  let ttft = null, text = '', t0 = Date.now();
  const onMsg = (c) => {
    if (ttft === null) ttft = Date.now() - t0; // 首个真实内容增量（不含服务端 start 事件）
    text += c;
  };
  const onEnd = () => {
    s.off('ai.message', onMsg); s.off('ai.messageEnd', onEnd);
    resolve({ ttft, total: Date.now() - t0, len: text.length, text });
  };
  s.on('ai.message', onMsg);
  s.on('ai.messageEnd', onEnd);
  s.emit('stt.inject', { text: q, speakerId: 'Guest-1' });
});
s.emit('mock.join', {});
for (const q of QUESTIONS) {
  const r = await askOne(q);
  if (r.ttft && r.len > 30) { ttfts.push(r.ttft); totals.push(r.total); lens.push(r.len); }
  await wait(400);
}
console.log('A. 面试辅助答案（socket 流式，官方口径 2s首字/3.5s完成）');
if (ttfts.length) {
  console.log(row('首字 TTFT', stats(ttfts)));
  console.log(row('整段完成', stats(totals)));
  console.log(`  平均长度 ${Math.round(lens.reduce((a, b) => a + b, 0) / lens.length)} 字`);
} else console.log('  SKIP（未收到答案流）');
s.disconnect();

/* ── B. 笔试解题：首事件 + 完成 ── */
const d = io(`${BASE}/desktop`, { auth: socketAuth({ token, locale: 'zh' }), transports: ['websocket'], reconnection: false });
await wait(600);
const startAck = await new Promise((res) => d.emit('exam.session.start', { title: '延迟基准', mode: 'quick', customization: {} }, res));
const shot = fs.readFileSync(new URL('../shots/exam.png', import.meta.url)).toString('base64');
const examOne = (questionText) => new Promise((resolve) => {
  const t0 = Date.now();
  let first = null, answer = '';
  const onDelta = (p) => {
    if (first === null) first = Date.now() - t0; // 首个真实答案增量（reasoning 是服务端占位，不计）
    answer += p.text || '';
  };
  const onEnd = () => {
    d.off('exam.delta', onDelta); d.off('exam.end', onEnd);
    resolve({ first, total: Date.now() - t0, len: answer.length });
  };
  d.on('exam.delta', onDelta); d.on('exam.end', onEnd);
  d.emit('exam.solve', { screenshot: `data:image/png;base64,${shot}`, sessionId: startAck?.data?.sessionId, mode: 'quick', customization: {}, questionText }, () => {});
});
const exFirst = [], exTotal = [];
for (const q of ['反转链表', '两数之和']) {
  const r = await examOne(q);
  if (r.len > 20) { exFirst.push(r.first); exTotal.push(r.total); }
  await wait(400);
}
console.log('\nB. 笔试截图解题（/desktop 流式，含视觉 OCR）');
if (exFirst.length) { console.log(row('首事件', stats(exFirst))); console.log(row('整段完成', stats(exTotal))); }
else console.log('  SKIP');
d.emit('exam.session.complete', { sessionId: startAck?.data?.sessionId }, () => {});
d.disconnect();

/* ── C. 语音转写 ── */
const wav = fs.readFileSync(new URL('./fixtures/asr-zh.wav', import.meta.url));
const asrMs = [];
for (let i = 0; i < 3; i++) {
  const t0 = Date.now();
  const r = await call('tools.stt.stt', 'mutation', { audioBase64: wav.toString('base64') }, token);
  if (r.text) asrMs.push(Date.now() - t0);
}
console.log('\nC. 语音转写（tools.stt.stt，10 秒音频整句）');
if (asrMs.length) console.log(row('端到端', stats(asrMs))); else console.log('  SKIP');

/* ── D. 押题生成 ── */
const t0p = Date.now();
const pred = await call('questionPrediction.generate', 'mutation', { goalId, resumeId, count: 6 }, token);
console.log('\nD. 押题生成（6 题，非流式）');
console.log(`  ${Date.now() - t0p}ms  → ${pred.items.length} 题（source=${pred.source}）`);

console.log('\n结论口径：首字 <2s 可用于真实面试；>3s 需要开预取/降 max_tokens。');
