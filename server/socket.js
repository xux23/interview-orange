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

async function streamTo(emit, startEvent, deltaEvent, endEvent, payload, generator, shouldStop) {
  emit(startEvent, payload.start ?? '');
  let acc = '';
  for await (const delta of generator) {
    // P1-3：会话终止后立刻停止广播（mock 流不可 abort，只能靠逐块检查）；
    // 仍然发出 end 事件，保证 start/end 配平，前端状态机不会停在半截。
    if (shouldStop && shouldStop()) break;
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
    next();
  });

  /* ── P1-2/P1-4/P1-5：会话级运行时 ──
   * 同一 session 的所有 socket 共享 turn / asked / genCtrl / 元数据，避免多窗口各持一份状态；
   * 串行策略：同一会话同一时刻只允许一个生成任务，新任务到达时打断旧任务（abort 旧 genCtrl），
   * 并用 Promise 队列兜底——mock 流式不可 abort，只靠 abort 会让两条流交错。 */
  const runtimes = new Map(); // sessionId → runtime
  function runtimeOf(sessionId) {
    let rt = runtimes.get(sessionId);
    if (!rt) {
      rt = { turn: 0, asked: [], genCtrl: null, sockets: new Set(), meta: {}, queue: Promise.resolve(), dead: false, updatedAt: Date.now() };
      runtimes.set(sessionId, rt);
    }
    rt.updatedAt = Date.now();
    return rt;
  }
  function releaseRuntime(sessionId) {
    const rt = runtimes.get(sessionId);
    if (!rt) return;
    rt.dead = true;
    try { rt.genCtrl?.abort(); } catch { /* ignore */ }
    runtimes.delete(sessionId);
  }
  // 状态表清理：会话结束（releaseRuntime）之外，兜底清理 30 分钟无连接的僵尸项
  const runtimeSweep = setInterval(() => {
    const now = Date.now();
    for (const [sid, rt] of runtimes) {
      if (rt.sockets.size === 0 && now - rt.updatedAt > 30 * 60 * 1000) releaseRuntime(sid);
    }
  }, 5 * 60 * 1000);
  runtimeSweep.unref?.();

  /** P1-5：按 DB 重建 turn（INTERVIEWER 消息的 MAX(turn)+1，回退角色计数）与 asked */
  function rebuildTurnAsked(sessionId) {
    const rows = all("SELECT content, metadata FROM messages WHERE session_id=? AND role='INTERVIEWER' ORDER BY created_at ASC", sessionId);
    let maxTurn = -1;
    for (const r of rows) {
      const t = fromJson(r.metadata, {})?.turn;
      if (Number.isInteger(t)) maxTurn = Math.max(maxTurn, t);
    }
    const turn = rows.length ? Math.max(maxTurn + 1, rows.length) : 0;
    return { turn, asked: rows.map((r) => r.content).filter(Boolean).slice(-50) };
  }

  /** P1-3：写入门禁——会话已非 ACTIVE 时所有写入/生成一律拒绝 */
  const sessionActive = (sessionId) => one('SELECT status FROM sessions WHERE id=?', sessionId)?.status === 'ACTIVE';

  io.of('/').on('connection', (socket) => {
    const session = socket.data.session;
    const sessionId = socket.data.sessionId;
    socket.join(sessionId);
    // 房间广播：主窗与浮窗各自连 socket，同一会话的流式增量要同时到达
    const push = (ev, payload) => io.of('/').to(sessionId).emit(ev, payload);

    const rt = runtimeOf(sessionId);
    rt.sockets.add(socket.id);
    if (rt.sockets.size === 1 && !rt.turn && !rt.asked.length) {
      const rebuilt = rebuildTurnAsked(sessionId);
      rt.turn = rebuilt.turn;
      rt.asked = rebuilt.asked;
    }
    // P1-2：辅助开关按会话维度实时读库（不再用连接期快照）
    const currentMeta = () => {
      const m = fromJson(one('SELECT metadata FROM sessions WHERE id=?', sessionId)?.metadata, {}) || {};
      rt.meta = m;
      return m;
    };
    // P1-4：串行生成队列（新任务打断旧任务；队列保证 mock 流不会交错）
    function withLock(fn) {
      if (rt.dead) return Promise.resolve(null);
      const prev = rt.queue.catch(() => {});
      let release;
      rt.queue = new Promise((r) => { release = r; });
      return prev.then(() => (rt.dead ? null : fn())).finally(() => release());
    }
    function beginGen() {
      if (rt.genCtrl) { try { rt.genCtrl.abort(); } catch { /* ignore */ } }
      const gen = new AbortController();
      rt.genCtrl = gen;
      return gen;
    }
    function endGen(gen) {
      if (rt.genCtrl === gen) rt.genCtrl = null;
    }
    const rejectWrite = (stage) => socket.emit('ai.error', { stage, message: '会话已结束，操作被拒绝' });

    // 官方连上即推两条 audio.permission（先 false/isPrimary=false，再 true/true）
    socket.emit('audio.permission', { canSendAudio: false, isPrimary: false });
    setTimeout(() => socket.emit('audio.permission', { canSendAudio: true, isPrimary: true }), 120);

    const ctx = () => ({
      resume: loadResume(session.user_id, session.resume_id),
      goal: loadGoal(session.user_id, session.goal_id),
      materials: loadMaterials(session.user_id, currentMeta().materialIds || []),
    });

    async function ask(turn) {
      const md = currentMeta();
      const c = ctx();
      // P1-4：出题全程注册 genCtrl（mock 分支同样可被打断）；
      // endGen 有 rt.genCtrl === gen 守卫，assist() 接管后不会误清
      const gen = beginGen();
      let q = '';
      try {
        if (providerName() === 'openai') {
          // 真实出题：按岗位/简历/轮次生成，带已问列表防重复；失败直接报错（不再回退题库）
          try {
            const r = await openaiComplete({
              system:
                `你是「${c.goal?.name || '技术'}」岗位的资深面试官，正在面试候选人（简历：${c.resume?.title || '未提供'}）。` +
                `请直接给出一道新的中文面试题，只输出题目本身，不要编号、不要选项、不要解释、不要一次出多道。` +
                `当前是第 ${turn + 1} 轮，难度档位 ${md.difficulty || '3_5_YEARS'}。` +
                (rt.asked.length ? `已问过的问题（严禁重复或变体重复）：${rt.asked.join('；')}` : ''),
              messages: [{ role: 'USER', content: '请出下一道面试题。' }],
              maxTokens: 200,
              signal: gen.signal,
            });
            q = r.text.trim().replace(/^["'「\s]+|["'」\s]+$/g, '').split('\n')[0];
            if (!q) throw new Error('模型返回了空题目');
          } catch (e) {
            if (e.aborted) return null; // 用户打断：ai.interrupted 已由事件处理器发出
            console.error('[ask] 真实出题失败:', e.message);
            push('ai.error', { turn, stage: 'question', message: `出题失败：${e.message}` });
            return null;
          }
        } else {
          q = mockNextQuestion({
            goal: c.goal,
            round: session.round || 'FIRST',
            turn,
            difficulty: md.difficulty || '3_5_YEARS',
            basicsRatio: md.basicsRatio ?? 0.4,
          });
        }
        rt.asked = [...rt.asked, q].slice(-50);
        // 文档 23：每轮先声明轮次类型，前端据此决定卡片形态
        push('ai.turnKind', { turn, kind: 'question' });
        const text = await streamTo(
          (ev, p) => push(ev, p),
          'mock.questionStart', 'mock.question', 'mock.questionEnd',
          { start: '', end: '' },
          (async function* () { for (const ck of chunkText(q, 3)) { yield ck; await sleep(18); } })(),
          () => rt.dead || gen.signal.aborted || !sessionActive(sessionId),
        );
        // P1-3：终态/打断后，已开始的流不再落库（对齐真实模式 abort 语义）
        if (rt.dead || gen.signal.aborted || !sessionActive(sessionId)) return null;
        insertMessage(sessionId, 'INTERVIEWER', text, { turn });
        insertTranscript(sessionId, 'Guest-1', text, { utteranceId: `q-${turn}` });
        // P1-2：辅助开关按请求时的实时元数据判定（关闭后不再生成答案）
        if (currentMeta().assistMode !== false) await assist(text, c);
        return text;
      } finally {
        endGen(gen);
      }
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
      const md = currentMeta();
      push('ai.onMsg', { turn: rt.turn, role: 'ASSISTANT', ts: nowIso() });
      push('ai.turnKind', { turn: rt.turn, kind: 'answer' });
      // 注：messageStart 由 streamTo 统一发射，这里不再重复 push
      const gen = beginGen();
      let text = '';
      try {
        text = await streamTo(
          (ev, p) => push(ev, p),
          'ai.messageStart', 'ai.message', 'ai.messageEnd',
          { start: '', end: '' },
          interviewStream({
            userId: session.user_id,
            question,
            lang: md.lang || 'zh-CN',
            styleValue: md.answerStyle || 'natural',
            customStyle: md.customAnswerStyle || md.instructionsPrompt || '',
            resumeId: session.resume_id,
            goalId: session.goal_id,
            materialIds: md.materialIds || [],
            history: buildHistory(question),
            signal: gen.signal,
          }),
          () => rt.dead || gen.signal.aborted || !sessionActive(sessionId),
        );
      } catch (e) {
        // 模型失败/超时：直接报错给前端；用户主动打断（e.aborted）只复位流式状态，不报错
        if (!e.aborted) {
          console.error('[assist] AI 生成失败:', e.message);
          push('ai.error', { turn: rt.turn, stage: 'answer', message: `AI 生成失败：${e.message}` });
        }
        push('ai.messageEnd', '');
        return null;
      } finally {
        endGen(gen);
      }
      // P1-3：终态/打断后不落库（用户打断产生的半截答案不落库，与真实路径 interviewStream 抛 aborted 后 return null 一致）
      if (rt.dead || gen.signal.aborted || !sessionActive(sessionId)) return null;
      insertMessage(sessionId, 'ASSISTANT', text, { turn: rt.turn });
      insertTranscript(sessionId, 'self', text, { utteranceId: `a-${rt.turn}` });
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
      // P1-5：幂等标记持久化在 sessions.metadata（重启服务/重连不重出第一题），
      // 旧会话没有标记但已有提问时也按「已开始」处理
      const md0 = fromJson(one('SELECT metadata FROM sessions WHERE id=?', sessionId)?.metadata, {}) || {};
      if (md0.mockStartedAt || rt.turn > 0 || rt.asked.length > 0) {
        socket.emit('mock.started', { sessionId, resumed: true });
        return;
      }
      const md1 = { ...md0, mockStartedAt: nowIso() };
      run('UPDATE sessions SET metadata=? WHERE id=?', toJson(md1), sessionId);
      push('ai.prewarm', { sessionId, ts: nowIso() });
      socket.emit('mock.started', { sessionId });
      await withLock(() => ask(0));
      rt.turn = Math.max(rt.turn, 1);
    });

    /* 文档 23：打断 / 合并上一轮 / 音频权限请求（interrupt 真掐断当前生成） */
    socket.on('ai.interrupt', (payload = {}) => {
      // P1-4：只打断本会话当前生成（其它窗口共享同一 genCtrl）；没有在途任务时不重复广播
      const gen = rt.genCtrl;
      if (gen) {
        rt.genCtrl = null;
        try { gen.abort(); } catch { /* ignore */ }
        push('ai.interrupted', { turn: rt.turn, reason: payload.reason || 'user' });
      }
    });
    socket.on('ai.mergePrev', (payload = {}) => {
      push('ai.merged', { turn: rt.turn, keepAssistant: payload.keepAssistant !== false });
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
      // P1-3：会话已结束（非 ACTIVE）时拒绝写入与生成
      if (!sessionActive(sessionId)) { rejectWrite('session'); return null; }
      insertMessage(sessionId, 'USER', answer, { turn: rt.turn, bytes: answer.length, voice });
      if (voice) insertTranscript(sessionId, 'self', answer, { utteranceId: utteranceId || undefined });
      run('UPDATE sessions SET updated_at=? WHERE id=?', nowIso(), sessionId);
      const emitAck = voice ? push : ((ev, p) => socket.emit(ev, p));
      emitAck('mock.answerAccepted', { turn: rt.turn });
      if ((session.type || 'MOCK_INTERVIEW') !== 'MOCK_INTERVIEW') return null; // 真实面试：不替面试官出题
      const reaction = mockReaction(answer);
      await streamTo((ev, p) => push(ev, p), 'mock.questionStart', 'mock.question', 'mock.questionEnd', { start: '', end: '' },
        (async function* () { for (const ck of chunkText(reaction, 4)) { yield ck; await sleep(20); } })(),
        () => rt.dead || !sessionActive(sessionId));
      await sleep(120);
      await ask(rt.turn);
      rt.turn += 1;
      return null;
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
          // P1-3：会话结束后不再落库/生成
          if (!sessionActive(sessionId)) { rejectWrite('session'); return; }
          insertMessage(sessionId, 'INTERVIEWER', text, { utteranceId });
          insertTranscript(sessionId, speakerId, text, { utteranceId });
          await assist(text, ctx());
          rt.turn += 1;
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
      // P1-3：会话结束后丢弃音频帧；每连接只提示一次，避免高频刷屏
      if (!sessionActive(sessionId)) {
        if (!socket.data.wroteAfterEnd) { socket.data.wroteAfterEnd = true; rejectWrite('session'); }
        return;
      }
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
          const utteranceId = st.utteranceId;
          const text = mockNextQuestion({ goal: ctx().goal, round: session.round || 'FIRST', turn: rt.turn });
          st.pending = false;
          st.bytes = 0;
          st.utteranceId = null;
          // P1-4：生成任务串行（同一会话同一时刻只有一个流）
          await withLock(async () => {
            if (rt.dead || !sessionActive(sessionId)) return;
            push('stt.speaker', { utteranceId, speakerId, confidence: 0.93 });
            push('stt.segment', { speakerId, utteranceId, completed: true, text });
            push('stt.changed', { utteranceId, speakerId });
            push('stt.turnEnd', { utteranceId, text });
            insertMessage(sessionId, 'INTERVIEWER', text, { utteranceId });
            insertTranscript(sessionId, speakerId, text, { utteranceId });
            await assist(text, ctx());
            rt.turn += 1;
          });
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
      if (silenceMs >= st.gateMs || st.bytes >= maxUtteranceBytes) await withLock(() => finalizeUtterance(st, speakerId));
    });

    socket.on('mock.answer', async (payload = {}) => {
      if (!sessionActive(sessionId)) { rejectWrite('session'); return; }
      const answer = String(payload.answer ?? '');
      if (!answer) return;
      await withLock(() => handleUserAnswer(answer));
    });

    socket.on('mock.toggleAssist', (payload = {}) => {
      // P1-2：辅助开关写库 + 更新会话级缓存 + 房间广播（同会话其它窗口同步收到）
      if (!sessionActive(sessionId)) { rejectWrite('session'); return; }
      const on = payload.assistMode !== false;
      const md = { ...currentMeta(), assistMode: on };
      run('UPDATE sessions SET metadata=? WHERE id=?', toJson(md), sessionId);
      rt.meta = md;
      push('mock.assistChanged', { assistMode: on });
    });

    socket.on('mock.end', async () => {
      // P1-3：先落终态 → finalizeSession → 房间广播 → 最后断开；重复 end 幂等（非 ACTIVE 不再跑收尾）。
      // 先置 dead 并中断在途生成：已开始的流不得在终态之后继续落库/广播答案。
      rt.dead = true;
      try { rt.genCtrl?.abort(); } catch { /* ignore */ }
      let failure = null;
      if (sessionActive(sessionId)) {
        try {
          await finalizeSession(sessionId, socket.data.user.id);
        } catch (e) {
          // P1-6：失败已落 FAILED 终态，这里显式通知前端（不静默）
          failure = e?.message || String(e);
          console.error('[mock.end] 会话收尾失败:', failure);
        }
      }
      releaseRuntime(sessionId);
      push('mock.end', failure ? { sessionId, error: { message: failure } } : { sessionId });
      if (failure) push('ai.error', { stage: 'finalize', message: `会话收尾失败：${failure}` });
      socket.disconnect(true);
    });

    /* STT：客户端只送音频帧。ASR 启用时设置静音门限并复位各说话人状态；未启用时保留本地替身行为 */
    socket.on('stt.start', async (payload = {}) => {
      if (!sessionActive(sessionId)) { rejectWrite('session'); return; }
      const gate = Math.min(6000, Math.max(200, payload.silenceGateMs ?? config.asr.silenceGateMs));
      if (asrEnabled()) {
        sttGateMs = gate;
        for (const st of vadStates.values()) st.gateMs = gate;
        // P2-A：开启采集时清空 VAD 缓冲，避免上一轮残留音频拼进新一句
        const only = payload.speakerId;
        for (const [sid, st] of vadStates) {
          if (only && sid !== only) continue;
          st.chunks = [];
          st.bytes = 0;
          st.utteranceId = null;
          st.lastSpeechAt = 0;
          st.closing = false;
        }
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
      const text = mockNextQuestion({ goal: c.goal, round: session.round || 'FIRST', turn: rt.turn });
      push('stt.segment', { speakerId, utteranceId, completed: false, text });
      await sleep(80);
      await withLock(async () => {
        if (rt.dead || !sessionActive(sessionId)) return;
        push('stt.segment', { speakerId, utteranceId, completed: true, text });
        insertMessage(sessionId, 'INTERVIEWER', text, { speakerId, utteranceId });
        insertTranscript(sessionId, speakerId, text, { utteranceId });
        await assist(text, c);
        rt.turn += 1;
      });
    });

    socket.on('stt.inject', async (payload = {}) => {
      if (!sessionActive(sessionId)) { rejectWrite('session'); return; }
      const text = String(payload.text || '').trim();
      if (!text) return;
      const utteranceId = cuid(12);
      const speakerId = payload.speakerId || 'Guest-1';
      push('stt.segment', { speakerId, utteranceId, completed: true, text });
      if (speakerId === 'self') {
        // 本人发言：与 VAD 收句一致，记录为作答，而不是当成面试官问题
        await withLock(() => handleUserAnswer(text, { voice: true, utteranceId }));
      } else {
        await withLock(async () => {
          if (rt.dead || !sessionActive(sessionId)) return;
          insertMessage(sessionId, 'INTERVIEWER', text, { injected: true, utteranceId });
          insertTranscript(sessionId, speakerId, text, { injected: true, utteranceId });
          await assist(text, ctx());
          rt.turn += 1;
        });
      }
    });

    socket.on('stt.end', async (payload = {}) => {
      if (asrEnabled()) {
        // 结束即冲刷未收句的语音；带 speakerId 时只结束该路，避免截断另一路采集
        for (const [sid, st] of vadStates) {
          if (payload.speakerId && sid !== payload.speakerId) continue;
          if (st.utteranceId) await withLock(() => finalizeUtterance(st, sid));
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

    socket.on('disconnect', () => {
      // P1-4：最后一个连接断开才清理会话级状态（重连时按 DB 重建 turn/asked）
      rt.sockets.delete(socket.id);
      if (rt.sockets.size === 0) releaseRuntime(sessionId);
    });
  });

  /* ───────────────── 笔试（/desktop namespace） ───────────────── */
  const desktop = io.of('/desktop');
  // P1-9：同一 exam session 只允许一个在途 reqId（策略=拒绝新请求，前端有单飞锁，这里是服务端兜底）
  const examBusy = new Map(); // examSessionId → reqId
  // P1-10：启动时收尾长时间残留的 ACTIVE 笔试会话（进程崩溃/断电留下的孤儿行）
  try {
    const staleBefore = new Date(Date.now() - 12 * 3600 * 1000).toISOString();
    const n = run("UPDATE exam_sessions SET status='COMPLETED', updated_at=? WHERE status='ACTIVE' AND created_at < ?", nowIso(), staleBefore);
    if (n?.changes) console.log(`[exam] 启动收尾陈旧 ACTIVE 会话 ${n.changes} 个`);
  } catch (e) {
    console.warn('[exam] 陈旧会话收尾失败:', e.message);
  }

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
      // P1-10：重连/重复 start 幂等——客户端带回 sessionId 且该行仍 ACTIVE 时直接复用
      const reuseId = payload.sessionId || socket.data.examSessionId || null;
      if (reuseId) {
        const row = one('SELECT * FROM exam_sessions WHERE id=? AND user_id=?', reuseId, user.id);
        if (row && row.status === 'ACTIVE') {
          socket.data.examSessionId = reuseId;
          const data = { sessionId: reuseId, isPro: true, remainingMinutes: 9999, customization, resumed: true };
          if (typeof ack === 'function') ack({ success: true, data });
          socket.emit('exam.session', data);
          socket.emit('exam.sessionStarted', data);
          return;
        }
      }
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
      // P1-3：笔试会话已结束（非 ACTIVE）时拒绝写入与生成
      if (examSessionId) {
        const st = one('SELECT status FROM exam_sessions WHERE id=? AND user_id=?', examSessionId, user.id);
        if (!st || st.status !== 'ACTIVE') {
          if (typeof ack === 'function') ack({ success: false, error: { code: 'SESSION_CLOSED', message: '笔试会话已结束' } });
          socket.emit('exam.error', { reqId, code: 'SESSION_CLOSED', message: '笔试会话已结束，拒绝解题' });
          return;
        }
      }
      // P1-9：同一 exam session 只允许一个在途解题（拒绝而非打断，前端会提示并解锁）
      const busyKey = examSessionId || `socket:${socket.id}`;
      if (examBusy.has(busyKey)) {
        if (typeof ack === 'function') ack({ success: false, error: { code: 'BUSY', message: '上一题仍在解题中，请等待完成或先中止' } });
        socket.emit('exam.error', { reqId, code: 'BUSY', message: '上一题仍在解题中，请等待完成或先中止' });
        return;
      }
      examBusy.set(busyKey, reqId);
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
        if (examBusy.get(busyKey) === reqId) examBusy.delete(busyKey);
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
      if (examBusy.get(busyKey) === reqId) examBusy.delete(busyKey);

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
      // P2-A：追问必须基于 reqId 对应的题面/答案（此前是静态模板，与题目无关）
      const findExamQuestion = () => {
        const esid = payload.sessionId || socket.data.examSessionId || null;
        const rows = esid
          ? [one('SELECT questions FROM exam_sessions WHERE id=? AND user_id=?', esid, user.id)].filter(Boolean)
          : all('SELECT questions FROM exam_sessions WHERE user_id=? ORDER BY created_at DESC LIMIT 20', user.id);
        for (const row of rows) {
          const qs = fromJson(row.questions, []) || [];
          const hit = qs.find((q) => q.reqId === reqId);
          if (hit) return hit;
        }
        return null;
      };
      const qa = findExamQuestion();
      if (!qa) {
        if (typeof ack === 'function') ack({ success: false, error: { code: 'NOT_FOUND', message: '未找到该题记录，无法追问' } });
        socket.emit('exam.error', { reqId, code: 'NOT_FOUND', message: '未找到该题记录，无法追问' });
        return;
      }
      if (typeof ack === 'function') ack({ success: true, data: { reqId } });
      socket.emit('exam.start', { reqId });
      socket.emit('exam.progress', { reqId, stage: 'analyzing', message: 'AI 追问中…' });
      let text = '';
      if (providerName() === 'openai') {
        try {
          const r = await openaiComplete({
            system: '你是笔试辅导老师。基于用户已经给出的答案回答追问，只输出补充内容，必要时给代码块，不要重复整份原答案。',
            messages: [{ role: 'USER', content: `题目：${qa.questionText}\n已有答案：${String(qa.answer || '').slice(0, 4000)}\n追问要求：${promptExtra}` }],
            maxTokens: 700,
          });
          text = r.text;
        } catch (e) {
          // P2-A：模型失败显式报错（不落库、不发 end）
          console.error('[exam.followUp] 失败:', e.message);
          socket.emit('exam.error', { reqId, code: 'AI_ERROR', message: `追问失败：${e.message}` });
          return;
        }
      } else {
        // mock 模式：不是静态模板——把本题题面/答案摘要拼进结果，离线也能对上题目
        text = `**答案：**\n\n${promptExtra}\n\n（基于本题：${String(qa.questionText || '（截图题）').slice(0, 80)}；原答案摘要：${String(qa.answer || '').slice(0, 120)}…）\n\n[[FOLLOWUP: 展开细节 | 换解法 | 校验边界]]`;
      }
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
        // P1-9：会话结束后释放在途锁，避免流入的请求被永久判忙
        socket.data.examGens?.forEach((g) => { try { g.abort(); } catch { /* ignore */ } });
        socket.data.examGens?.clear?.();
        examBusy.delete(id);
      }
      if (typeof ack === 'function') ack({ success: true, data: { sessionId: id } });
      socket.emit('exam.sessionCompleted', { sessionId: id });
    });

    socket.on('exam.snapshot', (payload = {}) => socket.emit('exam.snapshotSaved', { reqId: payload.reqId }));
    socket.on('exam.toPrimary', (payload = {}) => desktop.emit('exam.toPrimary', payload));
    socket.on('camera.zones', (payload = {}) => socket.emit('camera.zonesApplied', payload));
    socket.on('solver.readScreen', (payload = {}) => socket.emit('solver.readScreenResult', { ...payload, text: '（本地环境）已读取窗口文本' }));

    socket.on('disconnect', () => {
      // P1-9：断开时释放本连接持有的在途锁
      const reqs = new Set(socket.data.examGens?.keys?.() || []);
      socket.data.examGens?.clear?.();
      for (const [k, v] of examBusy) if (reqs.has(v)) examBusy.delete(k);
      socket.data.examGens = null;
    });
  });

  return io;
}

export { buildKnowledge };
