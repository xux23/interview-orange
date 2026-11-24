/**
 * 线上面试实时辅助 · 整链路 E2E（对齐「真实面试辅助」页面 + 浮窗的完整数据流）：
 *   INTERVIEW 会话 → socket(root) → 真实 ASR 双路音频（fixtures wav）
 *   → 面试官路(Guest-1)：VAD 收句 → 转写 → 官方事件序列 → ai.message 流式 → 落库
 *   → 本人路(self)：转写 → USER 落库（真实面试不替面试官出题）
 * 运行：node scripts/live-assist-e2e.mjs   （需 .env 配 ML_ASR_API_KEY + 真实 AI 网关）
 */
import { io } from 'socket.io-client';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const BASE = process.env.ML_BASE || 'http://127.0.0.1:8756';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const ok = (name, extra = '') => results.push(['PASS', name, extra]);
const fail = (name, extra = '') => results.push(['FAIL', name, extra]);
const check = (cond, name, extra = '') => (cond ? ok : fail)(name, extra);

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

function pcmOf(file) {
  const wav = fs.readFileSync(new URL(file, import.meta.url));
  let off = 12, dataOff = -1, dataLen = 0;
  while (off + 8 < wav.length) {
    const id = wav.toString('ascii', off, off + 4);
    const sz = wav.readUInt32LE(off + 4);
    if (id === 'data') { dataOff = off + 8; dataLen = sz; break; }
    off += 8 + sz + (sz % 2);
  }
  return wav.subarray(dataOff, dataOff + dataLen);
}

const health = await (await fetch(`${BASE}/healthz`)).json();
if (health.asr === 'mock' || health.provider === 'mock') {
  console.log(`SKIP：需要真实 ASR 与真实 AI（当前 asr=${health.asr} provider=${health.provider}）`);
  process.exit(0);
}
ok('healthz', `provider=${health.provider}(${health.model}) asr=${health.asr}`);

const temp = await call('user.getTempToken', 'mutation', {});
const token = (await call('user.loginByTempToken', 'mutation', { token: temp.token })).token;
const resumes = await call('resume.getResumes', 'query', {}, token);
const goals = await call('goal.getGoals', 'query', {}, token);

/* 对齐 LiveAssist.start()：真实面试会话 */
const session = await call('session.createSession', 'mutation', {
  type: 'INTERVIEW', resumeId: resumes[0].id, goalId: goals[0].id,
  audioSource: 'SPEAKER', round: 'FIRST', isTrial: true,
  metadata: { assistMode: true, answerStyle: 'natural', lang: 'zh-CN' },
}, token);
ok('createSession(INTERVIEW)', session.id);

/* 浮窗同款连接：socket root namespace + 会话房间 */
const ev = { seq: [] }; // 官方事件序列（时间序）
const answer = { chunks: [], started: 0, ended: 0 };
const segs = { 'Guest-1': [], self: [] };
let aiErrors = [];
const s = io(BASE, { auth: { token, locale: 'zh', sessionId: session.id }, transports: ['websocket'], reconnection: false });
const seen = (name) => { ev.seq.push(name); };
s.on('audio.permission', (p) => { if (p.canSendAudio) seen('audio.permission.true'); });
s.on('stt.pending', (p) => { if (p.speakerId) seen(`stt.pending:${p.speakerId}`); });
s.on('stt.speaker', (p) => seen(`stt.speaker:${p.speakerId}`));
s.on('stt.segment', (p) => { if (p.completed && p.text) { segs[p.speakerId] = segs[p.speakerId] || []; segs[p.speakerId].push(p.text); seen(`stt.segment:${p.speakerId}`); } });
s.on('stt.changed', () => seen('stt.changed'));
s.on('stt.turnEnd', (p) => { if (p.text) seen(`stt.turnEnd:${p.text.length}字`); });
s.on('ai.onMsg', () => seen('ai.onMsg'));
s.on('ai.turnKind', (p) => { if (p.kind === 'answer') seen('ai.turnKind:answer'); });
s.on('ai.messageStart', () => { answer.started++; seen('ai.messageStart'); });
s.on('ai.message', (c) => answer.chunks.push(String(c || '')));
s.on('ai.messageEnd', () => { answer.ended++; seen('ai.messageEnd'); });
s.on('mock.questionStart', () => seen('UNEXPECTED:mock.questionStart'));
s.on('ai.error', (e) => aiErrors.push(e));
s.on('ai.webSearch', () => seen('ai.webSearch'));
await wait(600);
if (s.connected) ok('socket.connect', 'root namespace + 会话房间');

/* 双路真实音频并发（面试官=达摩院句 / 本人=跑步句），40ms/帧 推 PCM */
const zh = pcmOf('./fixtures/asr-zh.wav');
const zh2 = pcmOf('./fixtures/asr-zh2.wav');
s.emit('stt.start', { silenceGateMs: 800 });
const stream = (pcm, speakerId, frameMs = 40) => new Promise((done) => {
  let pos = 0;
  const iv = setInterval(() => {
    if (pos >= pcm.length) { clearInterval(iv); done(); return; }
    const fr = pcm.subarray(pos, pos + 3200); pos += fr.length;
    s.emit('stt.data', { data: fr.toString('base64'), speakerId });
  }, frameMs);
});
await Promise.all([stream(zh, 'Guest-1'), stream(zh2, 'self')]);
const silence = Buffer.alloc(3200);
for (let i = 0; i < 14; i++) {
  s.emit('stt.data', { data: silence.toString('base64'), speakerId: 'Guest-1' });
  s.emit('stt.data', { data: silence.toString('base64'), speakerId: 'self' });
  await wait(80);
}
/* 等转写 + AI 流式收尾（真模型出完整答案可能要十几秒） */
for (let i = 0; i < 90 && answer.ended === 0; i++) await wait(1000);
await wait(600);

const guestText = (segs['Guest-1'] || [])[0] || '';
const selfText = (segs['self'] || [])[0] || '';
const answerText = answer.chunks.join('');

check(/达摩院|语音识别/.test(guestText), '面试官路转写正确', `「${guestText}」`);
check(/跑步|身体健康/.test(selfText), '本人路转写正确', `「${selfText}」`);

/* 官方事件序列（浮窗依赖的完整链路） */
const need = ['stt.pending:Guest-1', 'stt.speaker:Guest-1', 'stt.segment:Guest-1', 'stt.changed', 'ai.onMsg', 'ai.turnKind:answer', 'ai.messageStart', 'ai.messageEnd'];
const missing = need.filter((n) => !ev.seq.includes(n));
check(missing.length === 0, '官方事件序列完整', missing.length ? `缺 ${missing.join(' ')}` : need.join(' → '));
check(answer.started >= 1 && answer.ended >= 1, '流式起止配对', `start=${answer.started} end=${answer.ended}`);
check(answer.chunks.length > 5, '流式增量足够（浮窗逐字渲染）', `${answer.chunks.length} 段`);
check(/\*{0,2}核心要点/.test(answerText) && /\*{0,2}参考回答/.test(answerText), '答案符合双段协议', `${answerText.length} 字`);
check(!ev.seq.some((x) => x.startsWith('UNEXPECTED')), '真实面试不替面试官出题', '无 mock.questionStart');
check(aiErrors.length === 0, '无 ai.error', aiErrors[0]?.message || '');

/* 落库断言：转写、AI 答案、本人语音作答都进 messages/transcripts */
const detail = await call('session.getSession', 'query', { id: session.id }, token);
const roles = (detail.messages || []).map((m) => m.role);
check(roles.includes('INTERVIEWER') && roles.includes('ASSISTANT') && roles.includes('USER'),
  '三方消息落库', roles.join(','));
try {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(fileURLToPath(new URL('../data/app.db', import.meta.url)), { readOnly: true });
  const rows = db.prepare('SELECT speaker_id, text FROM transcripts WHERE session_id=?').all(session.id);
  db.close();
  check(rows.length >= 3, '转写落库(transcripts)', `${rows.length} 条：${rows.map((r) => r.speaker_id).join(',')}`);
} catch (e) {
  fail('转写落库(transcripts)', e.message);
}

console.log('');
for (const [st, n, e] of results) console.log(`[${st}] ${n}${e ? ' — ' + e : ''}`);
const bad = results.filter((r) => r[0] === 'FAIL');
console.log(`\n事件时间线：${ev.seq.join(' | ')}`);
console.log(`合计 ${results.length} 项，失败 ${bad.length} 项`);
s.emit('mock.end', {});
s.disconnect();
process.exit(bad.length ? 1 : 0);
