/**
 * Socket 事件矩阵验证（对照文档 08 + 23）
 * 区分方向：C→S 事件用「服务端应答事件」判定；S→C 事件直接判定收到。
 * 运行：node scripts/socket-events.mjs
 */
import { io } from 'socket.io-client';
import fs from 'node:fs';

const BASE = process.env.ML_BASE || 'http://127.0.0.1:8756';

async function call(name, kind, input, token) {
  const url = kind === 'query'
    ? `${BASE}/trpc/${name}?input=${encodeURIComponent(JSON.stringify({ json: input || {} }))}`
    : `${BASE}/trpc/${name}`;
  const res = await fetch(url, {
    method: kind === 'query' ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: kind === 'query' ? undefined : JSON.stringify({ json: input || {} }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`${name}: ${json.error.json?.message}`);
  return json.result.data.json;
}

// C→S 事件 → 期望的服务端应答事件
const PAIRS = [
  ['mock.join', 'mock.joined'],
  ['mock.start', 'mock.started'],
  ['mock.answer', 'mock.answerAccepted'],
  ['mock.toggleAssist', 'mock.assistChanged'],
  ['mock.end', 'mock.end'],
  ['ai.interrupt', 'ai.interrupted'],
  ['ai.mergePrev', 'ai.merged'],
  ['audio.requestPermission', 'audio.permission'],
  ['stt.start', 'stt.segment'],
  ['stt.end', 'stt.ended'],
  ['stt.data', 'stt.pending'],
  ['stt.speaker.correct', 'stt.corrected'],
  ['stt.inject', 'ai.messageEnd'],
  ['perf.ping', 'perf.pong'],
  ['exam.session.start', 'exam.session'],
  ['exam.solve', 'exam.start'],
  ['exam.followUp', 'exam.delta'],
  ['exam.answerNow', 'exam.answerNowAccepted'],
  ['exam.abort', 'exam.aborted'],
  ['exam.session.complete', 'exam.sessionCompleted'],
];

// 纯 S→C 事件
const SERVER_EVENTS = [
  'mock.questionStart', 'mock.question', 'mock.questionEnd',
  'ai.messageStart', 'ai.message', 'ai.messageEnd',
  'ai.prewarm', 'ai.turnKind', 'ai.onMsg', 'ai.webSearch',
  'stt.pending', 'stt.speaker', 'stt.changed', 'stt.segment', 'stt.turnEnd',
  'audio.permission',
  'exam.peers', 'exam.session', 'exam.start', 'exam.progress',
  'exam.reasoning', 'exam.delta', 'exam.end', 'exam.quota',
];

const seen = new Map();
const mark = (ev) => seen.set(ev, (seen.get(ev) || 0) + 1);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function attach(socket) {
  const all = new Set([...PAIRS.map((p) => p[1]), ...SERVER_EVENTS, 'exam.error']);
  for (const ev of all) socket.on(ev, () => mark(ev));
}

async function main() {
  const temp = await call('user.getTempToken', 'mutation', {});
  const token = (await call('user.loginByTempToken', 'mutation', { token: temp.token })).token;
  const resumes = await call('resume.getResumes', 'query', {}, token);
  const goals = await call('goal.getGoals', 'query', {}, token);
  const session = await call('session.createSession', 'mutation', {
    type: 'MOCK_INTERVIEW', resumeId: resumes[0].id, goalId: goals[0].id,
    metadata: { assistMode: true, difficulty: '3_5_YEARS', lang: 'zh-CN', webSearch: true },
  }, token);

  const s = io(BASE, { auth: { token, locale: 'zh', sessionId: session.id }, transports: ['websocket'], reconnection: false });
  attach(s);
  await wait(700);

  s.emit('audio.requestPermission', {});
  s.emit('mock.join', {});
  s.emit('mock.start', {});
  await wait(2600);
  s.emit('perf.ping', { sentAt: Date.now() });
  s.emit('ai.mergePrev', { keepAssistant: true });
  s.emit('ai.interrupt', { reason: 'user' });
  s.emit('mock.toggleAssist', { assistMode: true });
  s.emit('mock.answer', { answer: '我在电商做订单链路，P99 110ms，用 MySQL 和 Redis。' });
  await wait(2400);
  // 用 stt.inject 带技术名词，触发 ai.webSearch + 完整 assistant 流
  s.emit('stt.inject', { text: 'MySQL 的索引为什么用 B+ 树？什么时候回表？' });
  await wait(2600);

  // STT：真实 ASR（healthz.asr）→ 流式送 16k PCM 实测转写；本地替身 → 沿用 8KB 规则
  const health = await (await fetch(`${BASE}/healthz`)).json();
  const realAsr = health.asr && health.asr !== 'mock';
  if (realAsr) {
    const wav = fs.readFileSync(new URL('./fixtures/asr-zh.wav', import.meta.url));
    let off = 12, dataOff = -1, dataLen = 0;
    while (off + 8 < wav.length) {
      const id = wav.toString('ascii', off, off + 4);
      const sz = wav.readUInt32LE(off + 4);
      if (id === 'data') { dataOff = off + 8; dataLen = sz; break; }
      off += 8 + sz + (sz % 2);
    }
    const pcm = wav.subarray(dataOff, dataOff + dataLen);
    let transcript = '';
    s.on('stt.segment', (seg) => { if (seg?.completed && seg.text) transcript = seg.text; });
    s.emit('stt.start', { silenceGateMs: 600 });
    for (let pos = 0; pos < pcm.length; pos += 6400) {
      s.emit('stt.data', { data: pcm.subarray(pos, pos + 6400).toString('base64'), speakerId: 'Guest-1' });
      await wait(50);
    }
    const silence = Buffer.alloc(6400);
    for (let i = 0; i < 10; i++) { s.emit('stt.data', { data: silence.toString('base64'), speakerId: 'Guest-1' }); await wait(80); }
    await wait(2600);
    console.log(`  [asr] 实测转写（${health.asr}）：「${transcript}」`);
    if (!transcript) console.log('  [asr] ⚠ 未收到转写文本');
  } else {
    // STT 分片累积到 8KB 触发切句
    const chunk = 'A'.repeat(4096);
    for (let i = 0; i < 3; i++) {
      s.emit('stt.data', { data: chunk, speakerId: 'Guest-1' });
      await wait(220);
    }
    await wait(2200);
    s.emit('stt.start', { silenceGateMs: 300 });
    await wait(1400);
  }
  s.emit('stt.speaker.correct', { utteranceId: 'x', speakerId: 'self' });
  s.emit('stt.end', {});

  const d = io(`${BASE}/desktop`, { auth: { token, locale: 'zh' }, transports: ['websocket'], reconnection: false });
  attach(d);
  await wait(700);
  const start = await new Promise((res) => d.emit('exam.session.start', { title: '事件矩阵', mode: 'quick', customization: { preset: 'reverse-linked-list' } }, res));
  await wait(300);
  d.emit('exam.followUp', { reqId: 'r1', intent: 'message', message: '再解释一下' }, () => {});
  d.emit('exam.answerNow', { reqId: 'r1' });
  d.emit('exam.abort', { reqId: 'r1' });
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  d.emit('exam.solve', { screenshot: png, sessionId: start?.data?.sessionId, mode: 'quick', customization: {}, questionText: '反转链表' }, () => {});
  // 真实模型解题（长答案生成）可达数十秒：锚定 solve 流程最后一个事件 exam.quota，上限 60s
  const quotaBefore = seen.get('exam.quota') || 0;
  for (let i = 0; i < 120 && (seen.get('exam.quota') || 0) <= quotaBefore; i++) await wait(500);
  d.emit('exam.session.complete', { sessionId: start?.data?.sessionId }, () => {});
  await wait(600);
  s.emit('mock.end', {});
  await wait(500);
  s.disconnect();
  d.disconnect();

  const rows = [];
  for (const [c2s, reply] of PAIRS) rows.push([c2s, reply, seen.has(reply)]);
  for (const ev of SERVER_EVENTS) rows.push(['(server)', ev, seen.has(ev)]);

  const fail = rows.filter((r) => !r[2]);
  console.log('\n=== Socket 事件矩阵（文档 08+23）===');
  for (const [c2s, ev, ok] of rows) {
    console.log(`[${ok ? 'PASS' : 'MISS'}] ${c2s} → ${ev}${seen.has(ev) ? ` ×${seen.get(ev)}` : ''}`);
  }
  console.log(`\n合计 ${rows.length} 项，通过 ${rows.length - fail.length}，缺失 ${fail.length}`);
  if (fail.length) process.exitCode = 1;
}

main().catch((e) => { console.error('[events] 失败：', e); process.exitCode = 1; });
