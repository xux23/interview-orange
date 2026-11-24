/**
 * Socket.IO 双通道（对齐 08 号文档）：
 *   root  namespace  → mock 面试出题 / AI 辅助回答 / STT 事件流
 *   /desktop namespace → 笔试解题（exam.session.start / exam.solve / reasoning / delta / end / quota）
 * 流式协议统一为 *_Start → 多次增量 → *_End。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Server } from 'socket.io';
import { one, all, run } from './db.js';
import { cuid, chunkText, fromJson, toJson, nowIso, pruneDir } from './util.js';
import { config } from './config.js';
import { singleUser } from './auth.js';
import { interviewStream, examSolveStream, mockNextQuestion, mockReaction, loadResume, loadGoal, loadMaterials } from './ai/pipeline.js';
import { insertMessage, insertTranscript, finalizeSession } from './trpc/session.js';
import { buildKnowledge } from './ai/prompts.js';
import { asrEnabled, pcmPeak, transcribe } from './ai/asr.js';
import { openaiComplete, providerName } from './ai/provider.js';
import { sniffImage } from './ai/enrich.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 账号模块已移除：本地单一档案用户，免登录、免 token */
function authenticate() {
  const user = singleUser();
  if (!user) return { error: 'NOT_FOUND', message: '本地档案未初始化：请先运行 npm run seed' };
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

export function attachSocket(httpServer, { socketToken: tokenIn } = {}) {
  /* ── 高危3：收紧 Socket.IO 暴露面 ──
   * 1) CORS/握手 Origin 只允许本机服务自己的 origin（127.0.0.1:<port> / localhost:<port>）；
   * 2) token 由服务入口生成（写入数据目录 + 经 /healthz 下发给自家 UI），
   *    root 与 /desktop 两个 namespace 的握手 auth 都必须带对，否则任何网页都能直连驱动 exam.solve。 */
  const socketToken = tokenIn || crypto.randomBytes(24).toString('hex');
  const allowedOrigins = new Set([
    `http://127.0.0.1:${config.port}`,
    `http://localhost:${config.port}`,
    `http://${config.host}:${config.port}`,
  ]);
  const originOk = (origin) => !origin || allowedOrigins.has(origin);
  const tokenOk = (auth) => auth?.socketToken === socketToken;

  const io = new Server(httpServer, {
    path: '/socket.io',
    cors: {
      origin: (origin, cb) => (originOk(origin) ? cb(null, true) : cb(new Error('origin not allowed'))),
      credentials: false,
    },
    // websocket upgrade 不走 CORS 中间件：allowRequest 里再校验一次握手 Origin
    // （engine.io 回调是 error-first：(err, success)）
    allowRequest: (req, fn) => fn(null, originOk(req.headers.origin)),
    transports: ['websocket', 'polling'],
    // P1：大屏截图（base64）可能超过默认 1MB；显式放宽并在此上限处截断
    maxHttpBufferSize: 32 * 1024 * 1024,
  });

  /* ───────────────── 面试（root namespace） ───────────────── */
  io.of('/').use((socket, next) => {
    if (!tokenOk(socket.handshake.auth)) return next(new Error('未授权的 socket 连接（token 缺失或不匹配）'));
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

  // P1-7：会话级 mock.start 幂等表（sessionId → 首次开始时间）
  const mockStartedAt = new Map();

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
        // 真实出题：按岗位/简历/轮次生成，带已问列表防重复；失败直接报错（不再回退题库）
        socket.data.asked = socket.data.asked || [];
        const gen = new AbortController();
        socket.data.genCtrl = gen; // ai.interrupt 真打断
        try {
          const r = await openaiComplete({
            system:
              `你是「${c.goal?.name || '技术'}」岗位的资深面试官，正在面试候选人（简历：${c.resume?.title || '未提供'}）。` +
              `请直接给出一道新的中文面试题，只输出题目本身，不要编号、不要选项、不要解释、不要一次出多道。` +
              `当前是第 ${turn + 1} 轮，难度档位 ${metadata.difficulty || '3_5_YEARS'}。` +
              (socket.data.asked.length ? `已问过的问题（严禁重复或变体重复）：${socket.data.asked.join('；')}` : ''),
            messages: [{ role: 'USER', content: '请出下一道面试题。' }],
            maxTokens: 200,
            signal: gen.signal,
          });
          q = r.text.trim().replace(/^["'「\s]+|["'」\s]+$/g, '').split('\n')[0];
          if (!q) throw new Error('模型返回了空题目');
        } catch (e) {
          if (socket.data.genCtrl === gen) socket.data.genCtrl = null;
          if (e.aborted) return null; // 用户打断：ai.interrupted 已由事件处理器发出
          console.error('[ask] 真实出题失败:', e.message);
          push('ai.error', { turn, stage: 'question', message: `出题失败：${e.message}` });
          return null;
        }
        if (socket.data.genCtrl === gen) socket.data.genCtrl = null;
      } else {
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

    /** 多轮历史（对齐官方 05 号：我说出口的话包 <my_spoken_answer>；取最近几轮做上文）。
     *  本轮问题在 assist 前已落库，先去掉避免与 <USER_MESSAGE> 重复。 */
    function buildHistory(currentQuestion) {
      const rows = all('SELECT role, content FROM messages WHERE session_id=? AND role IN (?,?) ORDER BY created_at DESC LIMIT 8', sessionId, 'INTERVIEWER', 'USER').reverse();
      while (rows.length && rows[rows.length - 1].role === 'INTERVIEWER' && rows[rows.length - 1].content === currentQuestion) rows.pop();
      return rows.map((m) => (
        m.role === 'USER'
          ? { role: 'USER', content: `<my_spoken_answer>\n${m.content}\n</my_spoken_answer>` }
          : { role: 'USER', content: `<USER_MESSAGE>\n${m.content}\n</USER_MESSAGE>` }
      ));
    }

    async function assist(question, c) {
      push('ai.onMsg', { turn: socket.data.turn, role: 'ASSISTANT', ts: nowIso() });
      push('ai.turnKind', { turn: socket.data.turn, kind: 'answer' });
      // 注：messageStart 由 streamTo 统一发射，这里不再重复 push
      const gen = new AbortController();
      socket.data.genCtrl = gen; // ai.interrupt 真打断
      let text = '';
      try {
        text = await streamTo(
          (ev, p) => push(ev, p),
          'ai.messageStart', 'ai.message', 'ai.messageEnd',
          { start: '', end: '' },
          interviewStream({
            userId: session.user_id,
            question,
            lang: metadata.lang || 'zh-CN',
            styleValue: metadata.answerStyle || 'natural',
            customStyle: metadata.customAnswerStyle || metadata.instructionsPrompt || '',
            resumeId: session.resume_id,
            goalId: session.goal_id,
            materialIds: metadata.materialIds || [],
            history: buildHistory(question),
            signal: gen.signal,
          }),
        );
      } catch (e) {
        // 模型失败/超时：直接报错给前端；用户主动打断（e.aborted）只复位流式状态，不报错
        if (!e.aborted) {
          console.error('[assist] AI 生成失败:', e.message);
          push('ai.error', { turn: socket.data.turn, stage: 'answer', message: `AI 生成失败：${e.message}` });
        }
        push('ai.messageEnd', '');
        return null;
      } finally {
        if (socket.data.genCtrl === gen) socket.data.genCtrl = null;
      }
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
      // P1-7：按会话幂等——重连/重复 start 不重置轮次、不重新出第一题
      const startedAt = mockStartedAt.get(sessionId);
      if (startedAt && Date.now() - startedAt < 10 * 60 * 1000) {
        socket.emit('mock.started', { sessionId, resumed: true });
        return;
      }
      mockStartedAt.set(sessionId, Date.now());
      push('ai.prewarm', { sessionId, ts: nowIso() });
      socket.emit('mock.started', { sessionId });
      await ask(0);
      socket.data.turn = 1;
    });

    /* 文档 23：打断 / 合并上一轮 / 音频权限请求（interrupt 真掐断当前生成） */
    socket.on('ai.interrupt', (payload = {}) => {
      socket.data.genCtrl?.abort();
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
     *   其中 self 是本人语音，mock 下没有真实转写，直接丢弃，绝不伪造为面试官问题
     */
    const mockSttStates = new Map(); // speakerId → { pending, utteranceId, bytes }
    const mockSttOf = (speakerId) => {
      let st = mockSttStates.get(speakerId);
      if (!st) {
        st = { pending: false, utteranceId: null, bytes: 0 };
        mockSttStates.set(speakerId, st);
      }
      return st;
    };
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

    /** 音频帧解码：兼容二进制帧（Uint8Array/ArrayBuffer，省 33% 带宽）与旧 base64 字符串 */
    const toChunk = (raw) => {
      if (typeof raw === 'string') {
        if (!raw) return null;
        try { return Buffer.from(raw, 'base64'); } catch { return null; }
      }
      if (raw instanceof ArrayBuffer) return Buffer.from(new Uint8Array(raw));
      if (ArrayBuffer.isView(raw)) return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
      return null;
    };

    socket.on('stt.data', async (payload = {}) => {
      const chunk = toChunk(payload?.data);
      if (!chunk || !chunk.length) return;
      const speakerId = payload.speakerId || 'Guest-1';
      if (!asrEnabled()) {
        // ── 本地替身（无 ASR key）：按说话人沿用 8KB 切句规则；self 无真实转写，直接丢弃 ──
        if (speakerId === 'self') return;
        const st = mockSttOf(speakerId);
        st.bytes += chunk.length;
        if (!st.pending) {
          st.pending = true;
          st.utteranceId = cuid(12);
          push('stt.pending', { utteranceId: st.utteranceId, speakerId, bytes: st.bytes });
        }
        // 每累积 ~8KB 视为一句完成（真实实现按 VAD 切分）
        if (st.bytes >= 8192) {
          const text = mockNextQuestion({ goal: ctx().goal, round: session.round || 'FIRST', turn: socket.data.turn });
          push('stt.speaker', { utteranceId: st.utteranceId, speakerId, confidence: 0.93 });
          push('stt.segment', { speakerId, utteranceId: st.utteranceId, completed: true, text });
          push('stt.changed', { utteranceId: st.utteranceId, speakerId });
          push('stt.turnEnd', { utteranceId: st.utteranceId, text });
          insertMessage(sessionId, 'INTERVIEWER', text, { utteranceId: st.utteranceId });
          insertTranscript(sessionId, speakerId, text, { utteranceId: st.utteranceId });
          st.pending = false;
          st.bytes = 0;
          st.utteranceId = null;
          await assist(text, ctx());
          socket.data.turn += 1;
        }
        return;
      }
      // ── 真实 ASR：按说话人分离的能量 VAD 切句 ──
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

    socket.on('mock.end', async () => {
      // P1-7：先按 completeSession 同一逻辑收尾落库（status/报告/时长，幂等），再断开连接。
      // 生成报告是 async，必须 await——不 await 的话前端立刻查状态仍是 ACTIVE。
      try {
        await finalizeSession(sessionId, socket.data.user.id);
      } catch (e) {
        console.error('[mock.end] 会话收尾失败:', e.message);
      }
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
      const speakerId = payload.speakerId || 'Guest-1';
      if (speakerId === 'self') return;
      const st = mockSttOf(speakerId);
      st.pending = false;
      st.bytes = 0;
      st.utteranceId = null;
      const utteranceId = cuid(12);
      await sleep(gate);
      const c = ctx();
      const text = mockNextQuestion({ goal: c.goal, round: session.round || 'FIRST', turn: socket.data.turn });
      push('stt.segment', { speakerId, utteranceId, completed: false, text });
      await sleep(80);
      push('stt.segment', { speakerId, utteranceId, completed: true, text });
      insertMessage(sessionId, 'INTERVIEWER', text, { speakerId, utteranceId });
      insertTranscript(sessionId, speakerId, text, { utteranceId });
      await assist(text, c);
      socket.data.turn += 1;
    });

    socket.on('stt.inject', async (payload = {}) => {
      const text = String(payload.text || '').trim();
      if (!text) return;
      const utteranceId = cuid(12);
      const speakerId = payload.speakerId || 'Guest-1';
      push('stt.segment', { speakerId, utteranceId, completed: true, text });
      if (speakerId === 'self') {
        // 本人发言：与 VAD 收句一致，记录为作答，而不是当成面试官问题
        await handleUserAnswer(text, { voice: true, utteranceId });
      } else {
        insertMessage(sessionId, 'INTERVIEWER', text, { injected: true, utteranceId });
        insertTranscript(sessionId, speakerId, text, { injected: true, utteranceId });
        await assist(text, ctx());
        socket.data.turn += 1;
      }
    });

    socket.on('stt.end', async (payload = {}) => {
      if (asrEnabled()) {
        // 结束即冲刷未收句的语音；带 speakerId 时只结束该路，避免截断另一路采集
        for (const [sid, st] of vadStates) {
          if (payload.speakerId && sid !== payload.speakerId) continue;
          if (st.utteranceId) await finalizeUtterance(st, sid);
        }
      } else if (payload.speakerId) {
        mockSttStates.delete(payload.speakerId);
      } else {
        mockSttStates.clear();
      }
      socket.emit('stt.ended', { utteranceId: payload.utteranceId || null });
    });
    socket.on('stt.speaker.correct', (payload = {}) => socket.emit('stt.corrected', payload));
    socket.on('perf.client', () => {});
  });

  /* ───────────────── 笔试（/desktop namespace） ───────────────── */
  const desktop = io.of('/desktop');

  desktop.use((socket, next) => {
    // 高危3：/desktop 能驱动 exam.solve（模型调用/写库），同样必须带对启动 token
    if (!tokenOk(socket.handshake.auth)) return next(new Error('未授权的 socket 连接（token 缺失或不匹配）'));
    const auth = authenticate(socket.handshake.auth || {});
    if (auth.error) return next(new Error(auth.message));
    socket.data.user = auth.user;
    next();
  });

  desktop.on('connection', (socket) => {
    const user = socket.data.user;
    const peers = new Set(desktop.sockets.keys());
    desktop.emit('exam.peers', { secondaries: [...peers].filter((id) => id !== socket.id).slice(0, 3), primaries: [socket.id] });

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
      // 账号/计费模块已移除：isPro/remainingMinutes 仅为 /legacy 原版前端显示兼容
      const data = { sessionId: id, isPro: true, remainingMinutes: 9999, customization };
      if (typeof ack === 'function') ack({ success: true, data });
      socket.emit('exam.session', data);
      socket.emit('exam.sessionStarted', data);
    });

    socket.on('exam.solve', async (payload = {}, ack) => {
      const reqId = cuid(16);
      const examSessionId = payload.sessionId || socket.data.examSessionId || null;
      if (typeof ack === 'function') ack({ success: true, data: { reqId } });
      socket.data.examGens = socket.data.examGens || new Map(); // reqId → AbortController（exam.abort 真打断）
      const gen = new AbortController();
      socket.data.examGens.set(reqId, gen);

      // 截图落盘 + 滚动清理（保留最近 200 张，防止目录无限增长）
      let screenshotPath = null;
      const shot = payload.screenshot || (payload.screenshots || [])[0];
      if (shot && typeof shot === 'string') {
        const base64 = shot.includes(',') ? shot.split(',').pop() : shot;
        try {
          const buf = Buffer.from(base64, 'base64');
          const ext = sniffImage(buf)?.ext || 'png';
          screenshotPath = path.join(config.screenshotsDir, `${reqId}.${ext}`);
          fs.writeFileSync(screenshotPath, buf);
          pruneDir(config.screenshotsDir, 200);
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
      try {
        for await (const item of examSolveStream({
          userId: user.id, questionText, screenshotPath, presetSlug,
          mode: payload.mode || 'quick', customization, lang: customization.lang || 'zh-CN',
          signal: gen.signal,
        })) {
          if (item.type === 'reasoning') {
            reasoning += item.text;
            socket.emit('exam.reasoning', { reqId, text: item.text });
          } else {
            answer += item.text;
            socket.emit('exam.delta', { reqId, text: item.text });
          }
        }
      } catch (e) {
        socket.data.examGens.delete(reqId);
        if (e.aborted) {
          socket.emit('exam.aborted', { reqId }); // 用户主动中止：非错误
        } else {
          // 真实模型失败/超时：直接报错（不扣费、不记录）
          console.error('[exam] 解题失败:', e.message);
          socket.emit('exam.error', { reqId, code: 'AI_ERROR', message: `解题失败：${e.message}` });
        }
        return;
      }
      socket.data.examGens.delete(reqId);

      // 小项7：0 增量且没抛错时先报错返回——不发 exam.end（避免「先 end 后 error」把前端状态机带偏）
      if (!answer) {
        socket.emit('exam.error', { reqId, code: 'EMPTY_ANSWER', message: '未生成答案' });
        return;
      }
      socket.emit('exam.end', { reqId });

      // 文档 23：错误统一走 exam.error
      socket.emit('exam.quota', { isPro: true, remainingMinutes: 9999, pendingCardHint: false });

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
    socket.on('exam.abort', (payload = {}) => {
      // 真打断：掐掉对应 reqId 的解题流（已吐出的部分答案保留）
      socket.data.examGens?.get(payload.reqId || '')?.abort();
      socket.emit('exam.aborted', { reqId: payload.reqId });
    });

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

export { buildKnowledge };
