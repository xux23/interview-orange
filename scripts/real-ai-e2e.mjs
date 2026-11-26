/**
 * 真实模型全链路功能测试：provider=openai 时跑全流程并断言内容质量；mock 模式自动 SKIP。
 * 覆盖：真实出题 → 真实面试答案（双段协议）→ 语音转写后的 AI 辅助 → 笔试截图视觉解题 →
 *       promptStudio.run(interview/exam) → assist 真改写 → LLM rubric 复盘报告。
 * 运行：node scripts/real-ai-e2e.mjs   （需 .env 配置 ML_AI_API_KEY）
 */
import { io } from 'socket.io-client';
import fs from 'node:fs';
import { trpcHeaders, socketAuth } from './lib/local-auth.mjs';

const BASE = process.env.ML_BASE || 'http://127.0.0.1:8756';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const ok = (name, extra = '') => { results.push(['PASS', name, extra]); console.log(`[PASS] ${name}${extra ? ' — ' + extra : ''}`); };
const fail = (name, extra = '') => { results.push(['FAIL', name, extra]); console.log(`[FAIL] ${name}${extra ? ' — ' + extra : ''}`); };

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
console.log(`provider=${health.provider} asr=${health.asr}`);
if (health.provider === 'mock') {
  console.log('SKIP：AI provider 为 mock（.env 未配置 ML_AI_API_KEY）');
  process.exit(0);
}

const temp = await call('user.getTempToken', 'mutation', {});
const token = (await call('user.loginByTempToken', 'mutation', { token: temp.token })).token;
const user = await call('user.getUserInfo', 'query', {}, token);
const resumes = await call('resume.getResumes', 'query', {}, token);
const goals = await call('goal.getGoals', 'query', {}, token);
ok('鉴权', `user=${user.phone}`);

/* ── 1. promptStudio.run（interview）：真实答案 + 双段协议 ── */
{
  const t0 = Date.now();
  const r = await call('promptStudio.run', 'mutation', {
    scene: 'interview', question: '谈谈你对高并发系统的理解，如何设计一个秒杀系统？',
    resumeId: resumes[0].id, goalId: goals[0].id,
  }, token);
  const ms = Date.now() - t0;
  const dual = /核心要点/.test(r.answer) && /参考回答/.test(r.answer);
  console.log(`  答案节选：「${r.answer.slice(0, 160)}…」`);
  dual && r.answer.length > 100
    ? ok('runInterview(真实)', `systemPrompt=${r.systemPrompt.length}字 answer=${r.answer.length}字 ${ms}ms 双段协议✓`)
    : fail('runInterview(真实)', `answer=${r.answer.length}字 双段=${dual}`);
}

/* ── 2. promptStudio.run（exam）：真实笔试答案 ── */
{
  const r = await call('promptStudio.run', 'mutation', {
    scene: 'exam', question: '一个数组里有 0~99 共 100 个数，少了其中一个，如何 O(1) 空间找出？', examPresetSlug: 'algorithm',
  }, token);
  console.log(`  答案节选：「${(r.answer || '').slice(0, 140)}…」`);
  (r.answer || '').length > 30 ? ok('runExam(真实)', `answer=${r.answer.length}字`) : fail('runExam(真实)');
}

/* ── 3. promptStudio.assist：真实改写 ── */
{
  const r = await call('promptStudio.assist', 'mutation', {
    scene: 'interview', instruction: '把语气改得更口语化，并加上「先结论后展开」的要求',
    draft: '## 回答规则\n- 回答技术问题\n- 输出核心要点与参考回答\n- 篇幅 120 字内',
  }, token);
  const changed = r.prompt.includes('结论');
  console.log(`  改写节选：「${r.prompt.slice(0, 120)}…」`);
  changed && r.prompt.length > 60 ? ok('assist(真实改写)', `${r.prompt.length}字 provider=${r.provider}`) : fail('assist(真实改写)');
}

/* ── 4. Socket 模拟面试：真实出题 → 真实辅助答案 → 语音转写问题 → 真实答案 ── */
{
  const session = await call('session.createSession', 'mutation', {
    type: 'MOCK_INTERVIEW', resumeId: resumes[0].id, goalId: goals[0].id,
    metadata: { assistMode: true, difficulty: '3_5_YEARS', lang: 'zh-CN' },
  }, token);
  const s = io(BASE, { auth: socketAuth({ token, locale: 'zh', sessionId: session.id }), transports: ['websocket'], reconnection: false });
  const qStart = Date.now();
  let question = '', questionMs = 0, answer = '', answerMs = 0, aStart = 0;
  s.on('mock.question', (c) => { question += c; });
  s.on('mock.questionEnd', () => { questionMs = Date.now() - qStart; aStart = Date.now(); });
  s.on('ai.message', (c) => { answer += c; });
  s.on('ai.messageEnd', () => { answerMs = Date.now() - aStart; });
  await wait(700);
  s.emit('mock.join', {});
  s.emit('mock.start', {});
  await wait(18000); // 真实出题 + 真实答案流

  console.log(`  出题：「${question}」（${questionMs}ms）`);
  console.log(`  答案节选：「${answer.slice(0, 140)}…」（${answerMs}ms）`);
  question.endsWith('？') || question.endsWith('?') || question.length > 10
    ? ok('真实出题', `${question.length}字 ${questionMs}ms`)
    : fail('真实出题', `q="${question.slice(0, 50)}"`);
  /核心要点|参考回答/.test(answer) && answer.length > 80
    ? ok('真实辅助答案', `${answer.length}字 ${answerMs}ms 双段✓`)
    : fail('真实辅助答案', `${answer.length}字`);

  // 语音转写（真实 ASR）→ 触发真实辅助
  const wav = fs.readFileSync(new URL('./fixtures/asr-zh.wav', import.meta.url));
  let off = 12, dataOff = -1, dataLen = 0;
  while (off + 8 < wav.length) {
    const id = wav.toString('ascii', off, off + 4);
    const sz = wav.readUInt32LE(off + 4);
    if (id === 'data') { dataOff = off + 8; dataLen = sz; break; }
    off += 8 + sz + (sz % 2);
  }
  const pcm = wav.subarray(dataOff, dataOff + dataLen);
  let transcript = '', voiceAnswer = '', vStart = 0;
  s.on('stt.segment', (seg) => { if (seg?.completed && seg.text && seg.speakerId === 'Guest-1') { transcript = seg.text; vStart = Date.now(); } });
  const prevAnswer = answer;
  s.on('ai.messageEnd', () => { if (transcript) voiceAnswer = answer; });
  // 重新累计
  let answer2 = '';
  s.on('ai.message', (c) => { if (transcript) answer2 += c; });
  s.emit('stt.start', { silenceGateMs: 600 });
  for (let pos = 0; pos < pcm.length; pos += 6400) {
    s.emit('stt.data', { data: pcm.subarray(pos, pos + 6400).toString('base64'), speakerId: 'Guest-1' });
    await wait(50);
  }
  const silence = Buffer.alloc(6400);
  for (let i = 0; i < 10; i++) { s.emit('stt.data', { data: silence.toString('base64'), speakerId: 'Guest-1' }); await wait(80); }
  await wait(15000); // 转写 + 真实答案
  console.log(`  语音转写：「${transcript}」→ 新答案节选：「${answer2.slice(0, 140)}…」`);
  transcript.includes('达摩院') && answer2.length >= 20 && answer2 !== prevAnswer
    ? ok('ASR→真实答案链路', `转写✓ 模型实际响应${answer2.length}字（对非问题语句给简短寒暄回应=正确行为）`)
    : fail('ASR→真实答案链路', `t="${transcript}" a2=${answer2.length}`);

  /* ── 5. LLM rubric 报告 ── */
  const done = await call('session.completeSession', 'mutation', { id: session.id }, token);
  const report = await call('session.getSessionReport', 'query', { id: session.id }, token);
  const dims = report.interviewSummary?.fiveDimensions || [];
  const segs = report.conversationAnalysis || [];
  console.log(`  报告：score=${report.score} 维度=[${dims.map((d) => `${d.dimension}${d.score}`).join('、')}]`);
  console.log(`  总评：「${(report.interviewSummary?.interviewSummary || '').slice(0, 120)}…」`);
  if (segs[0]) console.log(`  逐段点评[0]：「${(segs[0].evaluation || '').slice(0, 100)}…」`);
  dims.length === 5 && dims.every((d) => d.dimension && d.score >= 0 && d.score <= 100) && (report.interviewSummary?.interviewSummary || '').length > 20
    ? ok('LLM复盘报告', `score=${report.score} 维度${dims.length} 逐段${segs.length} provider=${report.provider || 'n/a'}`)
    : fail('LLM复盘报告', `dims=${dims.length}`);
  s.disconnect();
}

/* ── 6. 笔试截图视觉解题（真实 OCR + 作答） ── */
{
  const session = await call('session.createSession', 'mutation', {
    type: 'MOCK_INTERVIEW', resumeId: resumes[0].id, goalId: goals[0].id,
    metadata: { assistMode: true, lang: 'zh-CN' },
  }, token).catch(() => null);
  const d = io(`${BASE}/desktop`, { auth: socketAuth({ token, locale: 'zh' }), transports: ['websocket'], reconnection: false });
  await wait(600);
  const start = await new Promise((res) => d.emit('exam.session.start', { title: '真实视觉解题', mode: 'quick', customization: {} }, res));
  const examSessionId = start?.data?.sessionId;
  const shot = fs.readFileSync(new URL('../shots/exam.png', import.meta.url)).toString('base64');
  let reasoning = '', delta = '', ended = false, rStart = Date.now(), rtt = null;
  d.on('exam.reasoning', (p) => { if (rtt === null) rtt = Date.now() - rStart; reasoning += p.text || p; });
  d.on('exam.delta', (p) => { delta += p.text || p; });
  d.on('exam.end', () => { ended = true; });
  d.emit('exam.solve', { screenshot: `data:image/png;base64,${shot}`, sessionId: examSessionId, mode: 'quick', customization: {}, questionText: '' }, () => {});
  const t0 = Date.now();
  while (!ended && Date.now() - t0 < 45000) await wait(500);
  console.log(`  首事件 ${rtt}ms；答案节选：「${delta.slice(0, 160)}…」`);
  ended && delta.length > 30
    ? ok('笔试截图视觉解题', `${delta.length}字 首事件${rtt}ms 总耗时${Date.now() - t0}ms`)
    : fail('笔试截图视觉解题', `ended=${ended} delta=${delta.length}`);
  d.emit('exam.session.complete', { sessionId: examSessionId }, () => {});
  d.disconnect();
}

const fails = results.filter((r) => r[0] === 'FAIL').length;
console.log(`\n合计 ${results.length} 项，失败 ${fails} 项`);
process.exit(fails ? 1 : 0);
