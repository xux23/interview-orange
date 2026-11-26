/**
 * 端到端冒烟：tRPC（HTTP）→ 建会话 → Socket 面试流 → /desktop 笔试流 → 报告。
 * 运行：node scripts/smoke.mjs
 */
import { io } from 'socket.io-client';
import { trpcHeaders, socketAuth } from './lib/local-auth.mjs';

const BASE = process.env.ML_BASE || 'http://127.0.0.1:8756';
const results = [];
const ok = (name, extra = '') => results.push(['PASS', name, extra]);
const fail = (name, extra = '') => results.push(['FAIL', name, extra]);

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

const waitFor = (socket, ev, timeout = 15000) =>
  new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), timeout);
    socket.once(ev, (payload) => { clearTimeout(t); resolve(payload); });
  });

async function main() {
  // 1) 健康检查
  const health = await (await fetch(`${BASE}/healthz`)).json();
  ok('healthz', `procedures=${health.procedures}`);
  if (health.procedures < 90) fail('过程数量少于预期');

  // 2) 鉴权
  const temp = await call('user.getTempToken', 'mutation', {});
  const login = await call('user.loginByTempToken', 'mutation', { token: temp.token, client: 'desktop', version: 'desktop/0.3.25', platform: 'win32' });
  const token = login.token;
  const user = await call('user.getUserInfo', 'query', {}, token);
  ok('auth', `user=${user.phone} 面试额度=${user.asset.interviewTime}`);

  // 3) 资源 & 契约
  const resumes = await call('resume.getResumes', 'query', {}, token);
  const goals = await call('goal.getGoals', 'query', {}, token);
  ok('resources', `resume=${resumes.length} goal=${goals.length}`);
  const presets = await call('promptStudio.presets', 'query', { lang: 'zh-CN' }, token);
  ok('presets', `official=${presets.interview.official.length}字 examPresets=${presets.examPresets.length}`);
  const run = await call('promptStudio.run', 'mutation', { scene: 'interview', question: '请做自我介绍', resumeId: resumes[0].id, goalId: goals[0].id }, token);
  ok('runInterview', `systemPrompt=${run.systemPrompt.length}字 answer=${run.answer.length}字`);
  const bank = await call('questionBank.getOverview', 'query', {}, token);
  ok('questionBank', `${bank.questionCount} 题`);

  // 4) 建会话
  const session = await call('session.createSession', 'mutation', {
    type: 'MOCK_INTERVIEW', resumeId: resumes[0].id, goalId: goals[0].id,
    audioSource: 'MICROPHONE', round: 'FIRST', metadata: { assistMode: true, difficulty: '3_5_YEARS', lang: 'zh-CN' },
  }, token);
  ok('createSession', session.id);
  const localProfile = await call('session.getSessions', 'query', {}, '').catch((e) => e.message);
  if (typeof localProfile === 'object' && Number.isFinite(localProfile.total)) {
    ok('localProfile', `total=${localProfile.total}`);
  } else {
    fail('localProfile', String(localProfile));
  }

  // 5) 面试 socket（root namespace）
  const eventCounts = {};
  const socket = io(BASE, { auth: socketAuth({ token, locale: 'zh', sessionId: session.id }), transports: ['websocket'], reconnection: false });
  const question = [];
  const answer = [];
  socket.on('mock.question', (c) => question.push(c));
  socket.on('ai.message', (c) => answer.push(c));
  socket.on('mock.questionEnd', () => { eventCounts.qEnd = (eventCounts.qEnd || 0) + 1; });
  socket.on('ai.messageEnd', () => { eventCounts.aEnd = (eventCounts.aEnd || 0) + 1; });
  socket.on('audio.permission', () => { eventCounts.audio = (eventCounts.audio || 0) + 1; });

  await new Promise((r) => setTimeout(r, 800));
  const connected = socket.connected;
  if (!connected) fail('socket.connect', '连接超时');
  else ok('socket.connect');
  socket.emit('mock.start', {});
  await waitFor(socket, 'ai.messageEnd', 20000);
  ok('socket.stream', `question=${question.join('').length}字 answer=${answer.join('').length}字 audioPerm=${eventCounts.audio}`);
  if (!question.join('').length || !answer.join('').length) fail('socket.stream.content');

  socket.emit('mock.answer', { answer: '我在电商平台负责订单链路，P99 110ms。' });
  await waitFor(socket, 'ai.messageEnd', 20000);
  ok('socket.answerTurn');

  // 6) 结束 → 报告
  socket.emit('mock.end', {});
  socket.disconnect();
  const completed = await call('session.completeSession', 'mutation', { id: session.id }, token);
  const report = await call('session.getSessionReport', 'query', { id: session.id }, token);
  const summary = report?.interviewSummary || {};
  const dimensions = Array.isArray(summary.fiveDimensions) ? summary.fiveDimensions : [];
  const analysis = Array.isArray(report?.conversationAnalysis) ? report.conversationAnalysis : [];
  const reportOk = Number.isFinite(Number(report?.score))
    && dimensions.length === 5
    && Boolean(summary.interviewSummary)
    && analysis.length > 0;
  if (reportOk) {
    ok('report', `status=${completed.status} score=${report.score} dimensions=${dimensions.length} summary=${summary.interviewSummary.length}字 conversations=${analysis.length}`);
  } else {
    fail('report.schema', `score=${report?.score} dimensions=${dimensions.length} summary=${Boolean(summary.interviewSummary)} conversations=${analysis.length}`);
  }

  // 7) 笔试 socket（/desktop）
  const desk = io(`${BASE}/desktop`, { auth: socketAuth({ token, locale: 'zh' }), transports: ['websocket'], reconnection: false });
  await new Promise((r) => setTimeout(r, 800));
  const dconn = desk.connected;
  if (!dconn) fail('desktop.connect');
  else ok('desktop.connect');

  const startAck = await new Promise((resolve) => desk.emit('exam.session.start', { title: '冒烟-笔试', mode: 'quick', customization: { preset: 'reverse-linked-list' } }, resolve));
  ok('exam.session.start', `sessionId=${startAck?.data?.sessionId?.slice(0, 8)}… remaining=${startAck?.data?.remainingMinutes}`);

  const reasoning = [];
  const deltas = [];
  desk.on('exam.reasoning', ({ text }) => reasoning.push(text));
  desk.on('exam.delta', ({ text }) => deltas.push(text));
  let quota = null;
  desk.on('exam.quota', (q) => { quota = q; });

  // 1×1 PNG 假截图
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const solveAck = await new Promise((resolve) => desk.emit('exam.solve', { screenshot: png, sessionId: startAck.data.sessionId, mode: 'quick', customization: { preset: 'reverse-linked-list' }, questionText: '反转链表' }, resolve));
  ok('exam.solve.ack', `reqId=${solveAck?.data?.reqId?.slice(0, 6)}…`);
  const ended = await waitFor(desk, 'exam.end', 2000).catch(() => null);
  // exam.end 可能先于监听完成，用轮询等待 delta 收尾
  await new Promise((r) => setTimeout(r, 400));
  for (let i = 0; i < 60 && deltas.length === 0; i++) await new Promise((r) => setTimeout(r, 200));
  ok('exam.stream', `reasoning=${reasoning.join('').length}字 delta=${deltas.join('').length}字 quota=${quota?.remainingMinutes}`);
  if (!deltas.join('').includes('答案')) fail('exam.answer.format');
  desk.emit('exam.session.complete', { sessionId: startAck.data.sessionId });
  await new Promise((r) => setTimeout(r, 300));
  desk.disconnect();

  const examList = await call('examSession.list', 'query', { page: 1, pageSize: 5 }, token);
  ok('examSession.list', `${examList.total} 条记录`);

  const bad = results.filter((r) => r[0] === 'FAIL');
  console.log('');
  for (const [s, n, e] of results) console.log(`[${s}] ${n}${e ? ' — ' + e : ''}`);
  console.log(`\n合计 ${results.length} 项，失败 ${bad.length} 项`);
  if (bad.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error('[smoke] 失败：', e);
  process.exitCode = 1;
});
