/**
 * 双路并发分离验证（双中文，贴近真实问答场景）：
 * 同一 socket 上同时流「面试官(Guest-1, 样本一)」与「本人(self, 样本二)」两路中文 PCM，
 * 验证按说话人分离的 VAD —— 各自收句、转写、归属正确、互不混音。
 * 运行：node scripts/asr-separation.mjs   （需 .env 配置 ML_ASR_API_KEY）
 */
import { io } from 'socket.io-client';
import fs from 'node:fs';
import { trpcHeaders, socketAuth } from './lib/local-auth.mjs';

const BASE = process.env.ML_BASE || 'http://127.0.0.1:8756';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

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
if (!health.asr || health.asr === 'mock') {
  console.log('SKIP：healthz.asr 为 mock（未配置 ML_ASR_API_KEY）');
  process.exit(0);
}
console.log(`ASR: ${health.asr}`);

const temp = await call('user.getTempToken', 'mutation', {});
const token = (await call('user.loginByTempToken', 'mutation', { token: temp.token })).token;
const resumes = await call('resume.getResumes', 'query', {}, token);
const goals = await call('goal.getGoals', 'query', {}, token);
// 真实面试会话：self 只记录、Guest-1 触发辅助，断言面干净
const session = await call('session.createSession', 'mutation', {
  type: 'INTERVIEW', resumeId: resumes[0].id, goalId: goals[0].id,
  audioSource: 'SPEAKER', round: 'FIRST', metadata: { assistMode: true, lang: 'zh-CN' },
}, token);

const segments = [];
const s = io(BASE, { auth: socketAuth({ token, locale: 'zh', sessionId: session.id }), transports: ['websocket'], reconnection: false });
s.on('stt.segment', (seg) => { if (seg?.completed && seg.text) segments.push({ speakerId: seg.speakerId, text: seg.text }); });
await wait(600);

// 两路同时开流：两个不同的中文样本逐帧交错（面试官=达摩院句 / 本人=跑步句）
const zh = pcmOf('./fixtures/asr-zh.wav');   // 「欢迎大家来体验达摩院推出的语音识别模型。」
const zh2 = pcmOf('./fixtures/asr-zh2.wav'); // 「我认为跑步最重要的就是，给我带来了身体健康。」
s.emit('stt.start', { silenceGateMs: 800 });
const stream = (pcm, speakerId, frameMs = 40) => {
  let pos = 0;
  return new Promise((done) => {
    const iv = setInterval(() => {
      if (pos >= pcm.length) { clearInterval(iv); done(); return; }
      const fr = pcm.subarray(pos, pos + 3200); pos += fr.length;
      s.emit('stt.data', { data: fr.toString('base64'), speakerId });
    }, frameMs);
  });
};
const silence = Buffer.alloc(3200);
await Promise.all([
  stream(zh, 'Guest-1'),
  stream(zh2, 'self'),
]);
// 各路补静音帧推进收句
for (let i = 0; i < 12; i++) {
  s.emit('stt.data', { data: silence.toString('base64'), speakerId: 'Guest-1' });
  s.emit('stt.data', { data: silence.toString('base64'), speakerId: 'self' });
  await wait(80);
}
await wait(3500);

const guest = segments.filter((x) => x.speakerId === 'Guest-1');
const selfSegs = segments.filter((x) => x.speakerId === 'self');
console.log(`面试官(Guest-1) 转写 ×${guest.length}: ${guest.map((x) => `「${x.text}」`).join(' ')}`);
console.log(`本人(self)    转写 ×${selfSegs.length}: ${selfSegs.map((x) => `「${x.text}」`).join(' ')}`);

let pass = 1;
if (guest.length === 0) { console.log('FAIL: 面试官路无转写'); pass = 0; }
if (selfSegs.length === 0) { console.log('FAIL: 本人路无转写'); pass = 0; }
if (guest.length && selfSegs.length) {
  const gOk = /达摩院|语音识别/.test(guest[0].text) && !/跑步|身体健康/.test(guest[0].text);
  const sOk = /跑步|身体健康/.test(selfSegs[0].text) && !/达摩院|语音识别/.test(selfSegs[0].text);
  console.log(`归属与内容：面试官路「达摩院句」${gOk ? '✓' : '✗'} / 本人路「跑步句」${sOk ? '✓' : '✗'}（双中文无串路）`);
  if (!gOk || !sOk) pass = 0;
}
console.log(pass ? 'PASS：双路并发分离正确' : 'FAIL');
s.emit('mock.end', {});
s.disconnect();
process.exit(pass ? 0 : 1);
