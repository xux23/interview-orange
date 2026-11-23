/**
 * Socket.IO 双通道（对齐 08 号文档）：
 *   root  namespace  → mock 面试出题 / AI 辅助回答 / STT 事件流
 *   /desktop namespace → 笔试解题（exam.session.start / exam.solve / reasoning / delta / end / quota）
 * 流式协议统一为 *_Start → 多次增量 → *_End。
 */
import fs from 'node:fs';
import path from 'node:path';
import { Server } from 'socket.io';
import { one, all, run } from './db.js';
import { cuid, chunkText, fromJson, toJson, nowIso } from './util.js';
import { config, isPro } from './config.js';
import { verifyToken } from './auth.js';
import { interviewStream, examSolveStream, mockNextQuestion, mockReaction, loadResume, loadGoal, loadMaterials, reportFor } from './ai/pipeline.js';
import { insertMessage, insertTranscript, sessionDto } from './trpc/session.js';
import { buildKnowledge } from './ai/prompts.js';
import { asrEnabled, pcmPeak, transcribe } from './ai/asr.js';
import { openaiComplete, providerName } from './ai/provider.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function authenticate(data) {
  const token = data?.token || '';
  const payload = verifyToken(token);
  if (!payload) return { error: 'UNAUTHORIZED', message: '登录已失效，请重新登录' };
  const user = one('SELECT * FROM users WHERE id=?', payload.userId);
  if (!user) return { error: 'NOT_FOUND', message: '用户不存在' };
  return { user };
}

/** 官方把 prisma 内部错误直接抛给客户端；这里保留同形态便于排错 */
const sessionMissingMessage =
  'Invalid `prisma.aiSession.findUnique()` invocation: Argument `id` is missing.\n' +
  'AiSession fields: id, userId, type, status, metadata, context, cost, tokenUsage, report, experience, ' +
  'goalId, resumeId, voiceId, audioSource, isTrial, createdAt, updatedAt, deletedAt, expiresAt, ' +
  'completedAt, realDuration, round, outcome, outcomeSource, outcomeAt, outcomeAskedAt, rating, ' +
  'ratingComment, ratedAt, ratingAskedAt';

async function streamTo(emit, startEvent, deltaEvent, endEvent, payload, generator) {
  emit(startEvent, payload.start ?? '');
  let acc = '';
  for await (const delta of generator) {
    acc += delta;
    emit(deltaEvent, delta);
  }
  emit(endEvent, payload.end ?? '');
  return acc;
}

export function attachSocket(httpServer) {
  const io = new Server(httpServer, {
    path: '/socket.io',
    cors: { origin: true, credentials: false },
    transports: ['websocket', 'polling'],
  });

  /* ───────────────── 面试（root namespace） ───────────────── */
  io.of('/').use((socket, next) => {
    const auth = authenticate(socket.handshake.auth || {});
    if (auth.error) return next(new Error(auth.message));
    const sessionId = socket.handshake.auth?.sessionId;
    if (!sessionId) return next(new Error(sessionMissingMessage));
    const session = one('SELECT * FROM sessions WHERE id=? AND user_id=?', sessionId, auth.user.id);
    if (!session) return next(new Error(sessionMissingMessage));
    socket.data.user = auth.user;
    socket.data.session = session;
    socket.data.sessionId = sessionId;
    socket.data.locale = socket.handshake.auth?.locale || 'zh';
    socket.data.turn = 0;
    next();
  });

  io.of('/').on('connection', (socket) => {
    const session = socket.data.session;
    const sessionId = socket.data.sessionId;
    const metadata = fromJson(session.metadata, {}) || {};
    socket.join(sessionId);
    // 房间广播：主窗与浮窗各自连 socket，同一会话的流式增量要同时到达
    const push = (ev, payload) => io.of('/').to(sessionId).emit(ev, payload);

    // 官方连上即推两条 audio.permission（先 false/isPrimary=false，再 true/true）
    socket.emit('audio.permission', { canSendAudio: false, isPrimary: false });
    setTimeout(() => socket.emit('audio.permission', { canSendAudio: true, isPrimary: true }), 120);

    const ctx = () => ({
      resume: loadResume(session.user_id, session.resume_id),
      goal: loadGoal(session.user_id, session.goal_id),
      materials: loadMaterials(session.user_id, metadata.materialIds || []),
    });

    async function ask(turn) {
      const c = ctx();
      let q = '';
      if (providerName() === 'openai') {
        // 真实出题：按岗位/简历/轮次生成，带已问列表防重复；失败回退题库
        try {
          socket.data.asked = socket.data.asked || [];
          const r = await openaiComplete({
            system:
              `你是「${c.goal?.name || '技术'}」岗位的资深面试官，正在面试候选人（简历：${c.resume?.title || '未提供'}）。` +
              `请直接给出一道新的中文面试题，只输出题目本身，不要编号、不要选项、不要解释、不要一次出多道。` +
              `当前是第 ${turn + 1} 轮，难度档位 ${metadata.difficulty || '3_5_YEARS'}。` +
              (socket.data.asked.length ? `已问过的问题（严禁重复或变体重复）：${socket.data.asked.join('；')}` : ''),
            messages: [{ role: 'USER', content: '请出下一道面试题。' }],
            maxTokens: 200,
          });
          q = r.text.trim().replace(/^["'「\s]+|["'」\s]+$/g, '').split('\n')[0];
        } catch (e) {
          console.warn('[ask] 真实出题失败，回退题库:', e.message);
        }
      }
      if (!q) {
        q = mockNextQuestion({
          goal: c.goal,
          round: session.round || 'FIRST',
          turn,
          difficulty: metadata.difficulty || '3_5_YEARS',
          basicsRatio: metadata.basicsRatio ?? 0.4,
        });
      }
      socket.data.asked = [...(socket.data.asked || []), q];
      // 文档 23：每轮先声明轮次类型，前端据此决定卡片形态
      push('ai.turnKind', { turn, kind: 'question' });
      push('mock.questionStart', '');
      const text = await streamTo(
        (ev, p) => push(ev, p),
        'mock.questionStart', 'mock.question', 'mock.questionEnd',
        { start: '', end: '' },
        (async function* () { for (const ck of chunkText(q, 3)) { yield ck; await sleep(18); } })(),
      );
      insertMessage(sessionId, 'INTERVIEWER', text, { turn });
      insertTranscript(sessionId, 'Guest-1', text, { utteranceId: `q-${turn}` });
      if (metadata.assistMode !== false) await assist(text, c);
      return text;
    }

    async function assist(question, c) {
      push('ai.onMsg', { turn: socket.data.turn, role: 'ASSISTANT', ts: nowIso() });
      // 文档 20：遇到说不清的技术名词先搜（前端据此显示检索状态）
      const tech = /(MySQL|Redis|Kafka|Kubernetes|Flink|gRPC|HTTP\/2|B\+ ?树|MVCC|RocketMQ|Elasticsearch)/.exec(String(question));
      if (tech && metadata.webSearch !== false) {
        push('ai.webSearch', { turn: socket.data.turn, query: tech[1], status: 'start' });
        await sleep(160);
        push('ai.webSearch', { turn: socket.data.turn, query: tech[1], status: 'done', results: 3 });
      }
      push('ai.turnKind', { turn: socket.data.turn, kind: 'answer' });
      push('ai.messageStart', '');
      const text = await streamTo(
        (ev, p) => push(ev, p),
        'ai.messageStart', 'ai.message', 'ai.messageEnd',
        { start: '', end: '' },
        interviewStream({
          userId: session.user_id,
          question,
          lang: metadata.lang || 'zh-CN',
          styleValue: metadata.answerStyle || 'natural',
          resumeId: session.resume_id,
          goalId: session.goal_id,
          materialIds: metadata.materialIds || [],
          history: [],
        }),
      );
      insertMessage(sessionId, 'ASSISTANT', text, { turn: socket.data.turn });
      insertTranscript(sessionId, 'self', text, { utteranceId: `a-${socket.data.turn}` });
      run('UPDATE sessions SET updated_at=? WHERE id=?', nowIso(), sessionId);
      return text;
    }

    /* 文档 17：押题结果流式订阅（prediction.item → prediction.end） */
    socket.on('prediction.subscribe', async (payload = {}) => {
      const pid = String(payload.id || '');
      if (!pid) return;
      const row = one('SELECT * FROM predictions WHERE id=? AND user_id=?', pid, session.user_id);
      if (!row) {
        push('prediction.error', { id: pid, message: '押题不存在' });
        return;
      }
      push('prediction.start', { id: pid, title: row.title });
      const items = fromJson(row.items, []) || [];
      for (let i = 0; i < items.length; i++) {
        await sleep(90);
        push('prediction.item', { id: pid, index: i, item: items[i] });
      }
      push('prediction.end', { id: pid, count: items.length });
    });
    socket.on('prediction.cancel', (payload = {}) => push('prediction.canceled', { id: payload.id }));

    socket.on('mock.join', () => socket.emit('mock.joined', { sessionId }));
    socket.on('mock.start', async () => {
      push('ai.prewarm', { sessionId, ts: nowIso() });
      socket.emit('mock.started', { sessionId });
      await ask(0);
      socket.data.turn = 1;
    });

    /* 文档 23：打断 / 合并上一轮 / 音频权限请求 */
    socket.data.interrupted = false;
    socket.on('ai.interrupt', (payload = {}) => {
      socket.data.interrupted = true;
      push('ai.interrupted', { turn: socket.data.turn, reason: payload.reason || 'user' });
    });
    socket.on('ai.mergePrev', (payload = {}) => {
      push('ai.merged', { turn: socket.data.turn, keepAssistant: payload.keepAssistant !== false });
    });
    socket.on('audio.requestPermission', () => {
      push('audio.permission', { canSendAudio: true, isPrimary: true, requested: true });
    });
    /* 性能采样往返 */
    socket.on('perf.ping', (payload = {}, ack) => {
      const rtt = payload.sentAt ? Date.now() - Number(payload.sentAt) : null;
      push('perf.pong', { rtt, at: nowIso() });
      if (typeof ack === 'function') ack({ ok: true, rtt });
    });

    /* 文档 23：STT 原始音频分片（PCM16k base64）→ 分段/挂起/说话人/换人/轮次结束
     * ASR 启用（.env 配 ML_ASR_API_KEY）：能量 VAD 切句 → ai/asr.js 整句转写 → 事件流 + 落库
     *   speakerId='self' → 用户语音作答；其他（Guest-1 等）→ 面试官问题，触发 AI 辅助
     * ASR 未启用：本地替身保留（stt.start 定时出题 / stt.data 攒 8KB 出题 / stt.inject 注文本）
     */
    const sttState = { pending: false, utteranceId: null, bytes: 0 };
    const SPEECH_PEAK = 0.02; // 归一化峰值阈值 ≈ -34dBFS
    // 按说话人分离的 VAD 状态：面试官（Guest-1，系统共享音频）与本人（self，麦克风）
    // 两路采集各自独立缓冲/收句，同时说话也互不混音、不串说话人
    let sttGateMs = config.asr.silenceGateMs;
    const vadStates = new Map(); // speakerId → { gateMs, chunks, bytes, utteranceId, lastSpeechAt, closing }
    const vadOf = (speakerId) => {
      let st = vadStates.get(speakerId);
      if (!st) {
        st = { gateMs: sttGateMs, chunks: [], bytes: 0, utteranceId: null, lastSpeechAt: 0, closing: false };
        vadStates.set(speakerId, st);
      }
      return st;
    };
    const minUtteranceBytes = Math.round(config.asr.sampleRate * 2 * 0.24);
    const maxUtteranceBytes = Math.round(config.asr.sampleRate * 2 * (config.asr.maxUtteranceMs / 1000));

    /** 用户回答（语音 'self' 与 mock.answer 共用）。MOCK 会话触发追问，真实会话只记录 */
    async function handleUserAnswer(answer, { voice = false, utteranceId } = {}) {
      insertMessage(sessionId, 'USER', answer, { turn: socket.data.turn, bytes: answer.length, voice });
      if (voice) insertTranscript(sessionId, 'self', answer, { utteranceId: utteranceId || undefined });
      run('UPDATE sessions SET updated_at=? WHERE id=?', nowIso(), sessionId);
      const emitAck = voice ? push : ((ev, p) => socket.emit(ev, p));
      emitAck('mock.answerAccepted', { turn: socket.data.turn });
      if ((session.type || 'MOCK_INTERVIEW') !== 'MOCK_INTERVIEW') return; // 真实面试：不替面试官出题
      const reaction = mockReaction(answer);
      push('mock.questionStart', '');
      await streamTo((ev, p) => push(ev, p), 'mock.questionStart', 'mock.question', 'mock.questionEnd', { start: '', end: '' },
        (async function* () { for (const ck of chunkText(reaction, 4)) { yield ck; await sleep(20); } })());
      await sleep(120);
      await ask(socket.data.turn);
      socket.data.turn += 1;
    }

    /** VAD 收句：整段 PCM 交给 ASR，按官方事件序列广播 */
    async function finalizeUtterance(st, speakerId) {
      if (st.closing) return;
      st.closing = true;
      const utteranceId = st.utteranceId;
      const pcm = st.chunks.length ? Buffer.concat(st.chunks) : Buffer.alloc(0);
      st.chunks = []; st.bytes = 0; st.utteranceId = null; st.lastSpeechAt = 0;
      try {
        if (!utteranceId || pcm.length < minUtteranceBytes) return; // 过短：视为噪声丢弃
        let text = '';
        try {
          const r = await transcribe({ pcm, sampleRate: config.asr.sampleRate });
          text = r.text;
          console.info(`[stt] ${speakerId} ${(pcm.length / 1024).toFixed(0)}KB ${r.ms}ms 「${text}」`);
        } catch (e) {
          console.warn('[stt] 转写失败:', e.message);
          push('stt.segment', { speakerId, utteranceId, completed: true, text: '', error: 'asr_failed' });
          push('stt.turnEnd', { utteranceId, text: '' });
          return;
        }
        if (!text) return; // 无人声（纯噪声/静音）
        push('stt.speaker', { utteranceId, speakerId, confidence: 0.95 });
        push('stt.segment', { speakerId, utteranceId, completed: true, text });
        push('stt.changed', { utteranceId, speakerId });
        push('stt.turnEnd', { utteranceId, text });
        if (speakerId === 'self') {
          await handleUserAnswer(text, { voice: true, utteranceId });
        } else {
          insertMessage(sessionId, 'INTERVIEWER', text, { utteranceId });
          insertTranscript(sessionId, speakerId, text, { utteranceId });
          await assist(text, ctx());
          socket.data.turn += 1;
        }
      } finally {
        st.closing = false;
      }
    }

    socket.on('stt.data', async (payload = {}) => {
      const data = String(payload.data || '');
      if (!data) return;
      if (!asrEnabled()) {
        // ── 本地替身（无 ASR key）：沿用 8KB 切句规则 ──
        sttState.bytes += Math.floor((data.length * 3) / 4);
        if (!sttState.pending) {
          sttState.pending = true;
          sttState.utteranceId = cuid(12);
          push('stt.pending', { utteranceId: sttState.utteranceId, bytes: sttState.bytes });
        }
        // 每累积 ~8KB 视为一句完成（真实实现按 VAD 切分）
        if (sttState.bytes >= 8192) {
          const text = mockNextQuestion({ goal: ctx().goal, round: session.round || 'FIRST', turn: socket.data.turn });
          push('stt.speaker', { utteranceId: sttState.utteranceId, speakerId: payload.speakerId || 'Guest-1', confidence: 0.93 });
          push('stt.segment', { speakerId: payload.speakerId || 'Guest-1', utteranceId: sttState.utteranceId, completed: true, text });
          push('stt.changed', { utteranceId: sttState.utteranceId, speakerId: payload.speakerId || 'Guest-1' });
          push('stt.turnEnd', { utteranceId: sttState.utteranceId, text });
          insertMessage(sessionId, 'INTERVIEWER', text, { utteranceId: sttState.utteranceId });
          insertTranscript(sessionId, payload.speakerId || 'Guest-1', text, { utteranceId: sttState.utteranceId });
          sttState.pending = false;
          sttState.bytes = 0;
          await assist(text, ctx());
          socket.data.turn += 1;
        }
        return;
      }
      // ── 真实 ASR：按说话人分离的能量 VAD 切句 ──
      let chunk;
      try { chunk = Buffer.from(data, 'base64'); } catch { return; }
      if (!chunk.length) return;
      const speakerId = payload.speakerId || 'Guest-1';
      const st = vadOf(speakerId);
      const now = Date.now();
      const speech = pcmPeak(chunk) >= SPEECH_PEAK;
      if (speech && !st.utteranceId) {
        st.utteranceId = cuid(12);
        st.chunks = []; st.bytes = 0; st.lastSpeechAt = now;
        push('stt.pending', { utteranceId: st.utteranceId, speakerId, bytes: 0 });
      }
      if (!st.utteranceId) return; // 语音前的静音不进缓冲
      st.chunks.push(chunk);
      st.bytes += chunk.length;
      if (speech) st.lastSpeechAt = now;
      const silenceMs = now - (st.lastSpeechAt || now);
      if (silenceMs >= st.gateMs || st.bytes >= maxUtteranceBytes) await finalizeUtterance(st, speakerId);
    });

    socket.on('mock.answer', async (payload = {}) => {
      const answer = String(payload.answer ?? '');
      if (!answer) return;
      await handleUserAnswer(answer);
    });

    socket.on('mock.toggleAssist', (payload = {}) => {
      const on = payload.assistMode !== false;
      const md = { ...(fromJson(session.metadata, {}) || {}), assistMode: on };
      run('UPDATE sessions SET metadata=? WHERE id=?', toJson(md), sessionId);
      socket.emit('mock.assistChanged', { assistMode: on });
    });

    socket.on('mock.end', () => {
      socket.emit('mock.end', { sessionId });
      socket.disconnect(true);
    });

    /* STT：客户端只送音频帧。ASR 启用时设置静音门限并复位各说话人状态；未启用时保留本地替身行为 */
    socket.on('stt.start', async (payload = {}) => {
      const gate = Math.min(6000, Math.max(200, payload.silenceGateMs ?? config.asr.silenceGateMs));
      if (asrEnabled()) {
        sttGateMs = gate;
        for (const st of vadStates.values()) st.gateMs = gate;
        return;
      }
      const utteranceId = cuid(12);
      await sleep(gate);
      const c = ctx();
      const text = mockNextQuestion({ goal: c.goal, round: session.round || 'FIRST', turn: socket.data.turn });
      push('stt.segment', { speakerId: 'Guest-1', utteranceId, completed: false, text });
      await sleep(80);
      push('stt.segment', { speakerId: 'Guest-1', utteranceId, completed: true, text });
      insertMessage(sessionId, 'INTERVIEWER', text, { speakerId: 'Guest-1', utteranceId });
      await assist(text, c);
      socket.data.turn += 1;
    });

    socket.on('stt.inject', async (payload = {}) => {
      const text = String(payload.text || '').trim();
      if (!text) return;
      const utteranceId = cuid(12);
      push('stt.segment', { speakerId: payload.speakerId || 'Guest-1', utteranceId, completed: true, text });
      insertMessage(sessionId, payload.speakerId === 'self' ? 'USER' : 'INTERVIEWER', text, { injected: true });
      await assist(text, ctx());
    });

    socket.on('stt.end', async (payload = {}) => {
      if (asrEnabled()) {
        // 结束即冲刷所有说话人未收句的语音
        for (const [sid, st] of vadStates) {
          if (st.utteranceId) await finalizeUtterance(st, sid);
        }
      }
      socket.emit('stt.ended', { utteranceId: payload.utteranceId || null });
    });
    socket.on('stt.speaker.correct', (payload = {}) => socket.emit('stt.corrected', payload));
    socket.on('perf.client', () => {});
  });

  /* ───────────────── 笔试（/desktop namespace） ───────────────── */
  const desktop = io.of('/desktop');

  desktop.use((socket, next) => {
    const auth = authenticate(socket.handshake.auth || {});
    if (auth.error) return next(new Error(auth.message));
    socket.data.user = auth.user;
    next();
  });

  desktop.on('connection', (socket) => {
    const user = socket.data.user;
    const peers = new Set(desktop.sockets.keys());
    desktop.emit('exam.peers', { secondaries: [...peers].filter((id) => id !== socket.id).slice(0, 3), primaries: [socket.id] });

    const remaining = () => one('SELECT interview_time FROM users WHERE id=?', user.id)?.interview_time ?? 0;
    const pro = () => isPro(one('SELECT * FROM users WHERE id=?', user.id));

    socket.on('exam.session.start', (payload = {}, ack) => {
      const customization = payload.customization || {};
      const id = cuid();
      run(
        `INSERT INTO exam_sessions(id,user_id,title,goal_id,status,platform,mode,question_count,cost_minutes,questions,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
        id, user.id, payload.title || '笔试答题', payload.goalId || null, 'ACTIVE',
        payload.platform || 'win32', payload.mode || 'quick', 0, 0, toJson([]), nowIso(), nowIso(),
      );
      socket.data.examSessionId = id;
      const data = { sessionId: id, isPro: pro(), remainingMinutes: remaining(), customization };
      if (typeof ack === 'function') ack({ success: true, data });
      socket.emit('exam.session', data);
      socket.emit('exam.sessionStarted', data);
    });

    socket.on('exam.solve', async (payload = {}, ack) => {
      const reqId = cuid(16);
      const examSessionId = payload.sessionId || socket.data.examSessionId || null;
      if (typeof ack === 'function') ack({ success: true, data: { reqId } });

      // 截图落盘（独立目录），并保留最近 N 张便于复查
      let screenshotPath = null;
      const shot = payload.screenshot || (payload.screenshots || [])[0];
      if (shot && typeof shot === 'string') {
        const base64 = shot.includes(',') ? shot.split(',').pop() : shot;
        try {
          screenshotPath = path.join(config.screenshotsDir, `${reqId}.png`);
          fs.writeFileSync(screenshotPath, Buffer.from(base64, 'base64'));
        } catch {
          screenshotPath = null;
        }
      }

      const customization = payload.customization || {};
      const presetSlug = customization.preset || customization.examPresetSlug || '';
      const questionText = payload.questionText || customization.questionText || '';

      socket.emit('exam.start', { reqId });
      socket.emit('exam.progress', { reqId, stage: 'analyzing', message: 'AI 识别题目中…' });

      let reasoning = '';
      let answer = '';
      for await (const item of examSolveStream({
        userId: user.id, questionText, screenshotPath, presetSlug,
        mode: payload.mode || 'quick', customization, lang: customization.lang || 'zh-CN',
      })) {
        if (item.type === 'reasoning') {
          reasoning += item.text;
          socket.emit('exam.reasoning', { reqId, text: item.text });
        } else {
          answer += item.text;
          socket.emit('exam.delta', { reqId, text: item.text });
        }
      }
      socket.emit('exam.end', { reqId });

      // 文档 23：错误统一走 exam.error
      if (!answer) socket.emit('exam.error', { reqId, code: 'EMPTY_ANSWER', message: '未生成答案' });

      // 计费：每次截屏答题扣 2 分钟（对齐实测 30 → 28）
      const cur = remaining();
      const next = Math.max(0, cur - config.limits.examMinutesPerSolve);
      run('UPDATE users SET interview_time=? WHERE id=?', next, user.id);
      socket.emit('exam.quota', { isPro: pro(), remainingMinutes: next, pendingCardHint: next < 4 });

      if (examSessionId) {
        const row = one('SELECT * FROM exam_sessions WHERE id=?', examSessionId);
        if (row) {
          const questions = fromJson(row.questions, []) || [];
          questions.push({
            reqId, questionText: questionText || '（截图题）', answer, reasoning,
            screenshot: screenshotPath ? path.basename(screenshotPath) : null, solvedAt: nowIso(),
          });
          run('UPDATE exam_sessions SET question_count=?, cost_minutes=?, questions=?, updated_at=? WHERE id=?',
            questions.length, (row.cost_minutes || 0) + config.limits.examMinutesPerSolve, toJson(questions), nowIso(), examSessionId);
        }
      }
    });

    socket.on('exam.followUp', async (payload = {}, ack) => {
      const reqId = payload.reqId || cuid(16);
      const intent = payload.intent || 'message';
      const promptExtra = {
        nr: '请给出代码审查意见：可读性、边界、复杂度。',
        Tn: `只提示部分思路（level=${payload.level ?? 2}），不要给完整答案。`,
        br: '给一个暴力解法，并说明复杂度。',
        $r: '把答案再简化成三行以内。',
        message: String(payload.message || '解释一下上一题的关键点。'),
      }[intent] || String(payload.message || '');
      if (typeof ack === 'function') ack({ success: true, data: { reqId } });
      socket.emit('exam.start', { reqId });
      socket.emit('exam.progress', { reqId, stage: 'analyzing', message: 'AI 追问中…' });
      const text = `**答案：**\n\n${promptExtra}\n\n[[FOLLOWUP: 展开细节 | 换解法 | 校验边界]]`;
      for (const ck of chunkText(text, 4)) {
        socket.emit('exam.delta', { reqId, text: ck });
        await sleep(14);
      }
      socket.emit('exam.end', { reqId });
    });

    socket.on('exam.answerNow', (payload = {}) => socket.emit('exam.answerNowAccepted', { reqId: payload.reqId }));
    socket.on('exam.resume', (payload = {}) => socket.emit('exam.resumed', { reqId: payload.reqId }));
    socket.on('exam.abort', (payload = {}) => socket.emit('exam.aborted', { reqId: payload.reqId }));

    socket.on('exam.session.complete', async (payload = {}, ack) => {
      const id = payload.sessionId || socket.data.examSessionId;
      if (id) {
        const row = one('SELECT * FROM exam_sessions WHERE id=? AND user_id=?', id, user.id);
        if (row) run('UPDATE exam_sessions SET status=?, updated_at=? WHERE id=?', 'COMPLETED', nowIso(), id);
      }
      if (typeof ack === 'function') ack({ success: true, data: { sessionId: id } });
      socket.emit('exam.sessionCompleted', { sessionId: id });
    });

    socket.on('exam.snapshot', (payload = {}) => socket.emit('exam.snapshotSaved', { reqId: payload.reqId }));
    socket.on('exam.toPrimary', (payload = {}) => desktop.emit('exam.toPrimary', payload));
    socket.on('camera.zones', (payload = {}) => socket.emit('camera.zonesApplied', payload));
    socket.on('solver.readScreen', (payload = {}) => socket.emit('solver.readScreenResult', { ...payload, text: '（本地环境）已读取窗口文本' }));
  });

  return io;
}

/** 结束会话并生成报告（socket 场景复用；openai 模式为 LLM rubric） */
export async function finalizeSession(sessionId, userId) {
  const row = one('SELECT * FROM sessions WHERE id=? AND user_id=?', sessionId, userId);
  if (!row || row.status === 'COMPLETED') return sessionDto(row);
  const messages = all('SELECT * FROM messages WHERE session_id=? ORDER BY created_at ASC', sessionId)
    .map((m) => ({ id: m.id, role: m.role, content: m.content, createdAt: m.created_at }));
  const report = await reportFor(row, messages, { goal: loadGoal(userId, row.goal_id), resume: loadResume(userId, row.resume_id) });
  const now = nowIso();
  const realDuration = Math.max(1, Math.round((Date.now() - Date.parse(row.created_at)) / 1000));
  run('UPDATE sessions SET status=?, completed_at=?, updated_at=?, real_duration=?, report=? WHERE id=?',
    'COMPLETED', now, now, realDuration, toJson(report), sessionId);
  return sessionDto(one('SELECT * FROM sessions WHERE id=?', sessionId));
}

export { buildKnowledge };
