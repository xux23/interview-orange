import { z } from 'zod';
import { one, all, run } from '../db.js';
import { fromJson, toJson, nowIso } from '../util.js';
import { cuid } from '../util.js';
import { TRPCError } from './errors.js';
import { reportFor, buildContext } from '../ai/pipeline.js';
import { defaultExamCustomization } from './user.js';

const TYPES = ['INTERVIEW', 'MOCK_INTERVIEW', 'JOB_SELECTION', 'RESUME_REVIEW'];
const ROUNDS = ['FIRST', 'SECOND', 'THIRD', 'HR', 'OTHER'];
const AUDIO = ['MICROPHONE', 'SPEAKER', 'PHONE'];
const pass = z.object({}).passthrough();

/* P1-7：同会话并发收尾（socket mock.end 与 tRPC completeSession 同时到达）只跑一次 */
const finalizing = new Set();
/* P1-11：报告生成单飞表（getSessionReport 与 finalizeSession 共用同一会话的生成结果） */
const reportJobs = new Map();

function generateReportOnce(sessionId, row, ctx, { withMeta = false } = {}) {
  if (reportJobs.has(sessionId)) return reportJobs.get(sessionId);
  const job = (async () => {
    const messages = all('SELECT * FROM messages WHERE session_id=? ORDER BY created_at ASC', sessionId)
      .map((m) => ({ id: m.id, role: m.role, content: m.content, metadata: withMeta ? fromJson(m.metadata, null) : undefined, createdAt: m.created_at }));
    const report = await reportFor(row, messages, ctx);
    run('UPDATE sessions SET report=? WHERE id=?', toJson(report), sessionId);
    return report;
  })();
  reportJobs.set(sessionId, job);
  job.finally(() => reportJobs.delete(sessionId)).catch(() => {});
  return job;
}

/** 结束会话并生成报告（socket 的 mock.end 与 tRPC 的 completeSession 共用同一套逻辑）。
 *  幂等：已 COMPLETED（或正在收尾中等待完成）直接返回当前 DTO。 */
export async function finalizeSession(sessionId, userId) {
  const row = one('SELECT * FROM sessions WHERE id=? AND user_id=?', sessionId, userId);
  if (!row) return null;
  if (row.status === 'COMPLETED') return sessionDto(row);
  if (finalizing.has(sessionId)) {
    // 已在生成中：等它落库（成功 COMPLETED / 失败 FAILED 都算收尾完成）
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 300));
      const cur = one('SELECT * FROM sessions WHERE id=?', sessionId);
      if (cur?.status === 'COMPLETED' || cur?.status === 'FAILED') return sessionDto(cur);
    }
    return sessionDto(one('SELECT * FROM sessions WHERE id=?', sessionId));
  }
  finalizing.add(sessionId);
  try {
    const ctx = buildContext(userId, { resumeId: row.resume_id, goalId: row.goal_id, materialIds: fromJson(row.metadata, {})?.materialIds });
    // P1-11：与 getSessionReport 共用单飞生成（同一会话只跑一次模型）
    const report = await generateReportOnce(sessionId, row, ctx, { withMeta: true });
    const now = nowIso();
    const realDuration = Math.max(1, Math.round((Date.now() - Date.parse(row.created_at)) / 1000));
    run('UPDATE sessions SET status=?, updated_at=?, completed_at=?, real_duration=?, report=? WHERE id=?',
      'COMPLETED', now, now, realDuration, toJson(report), sessionId);
    if (row.type === 'MOCK_INTERVIEW') {
      run('UPDATE users SET mock_interview_count = MAX(0, mock_interview_count - 1) WHERE id=?', userId);
    }
    return sessionDto(one('SELECT * FROM sessions WHERE id=?', sessionId));
  } catch (e) {
    // P1-6：报告失败必须落明确终态（FAILED + report.error），不能静默留在 ACTIVE；
    // 保留 retry 路径（retrySessionReport 会重新调用本函数，成功后置 COMPLETED）
    const at = nowIso();
    run('UPDATE sessions SET status=?, updated_at=?, report=? WHERE id=?',
      'FAILED', at, toJson({ status: 'failed', error: { message: e?.message || String(e), at } }), sessionId);
    throw e;
  } finally {
    finalizing.delete(sessionId);
  }
}

export function sessionDto(row, { withMessages = true } = {}) {
  if (!row) return null;
  const goal = row.goal_id ? one('SELECT * FROM goals WHERE id=?', row.goal_id) : null;
  const resume = row.resume_id ? one('SELECT * FROM resumes WHERE id=?', row.resume_id) : null;
  const out = {
    id: row.id,
    userId: row.user_id,
    type: row.type,
    status: row.status,
    metadata: fromJson(row.metadata, {}),
    context: fromJson(row.context, null),
    cost: fromJson(row.cost, null),
    tokenUsage: fromJson(row.token_usage, null),
    report: (() => { const r = fromJson(row.report, null); return r ? { status: r.status || 'success' } : (row.status === 'COMPLETED' ? { status: 'pending' } : null); })(),
    reportReady: (() => { const r = fromJson(row.report, null); return !!r && (r.status === 'success' || r.status === 'READY'); })(),
    reportError: (() => { const r = fromJson(row.report, null); return r?.error || null; })(),
    experience: fromJson(row.experience, null),
    goalId: row.goal_id,
    resumeId: row.resume_id,
    voiceId: row.voice_id,
    audioSource: row.audio_source,
    isTrial: Boolean(row.is_trial),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    expiresAt: row.expires_at,
    completedAt: row.completed_at,
    realDuration: row.real_duration,
    round: row.round,
    outcome: row.outcome,
    outcomeSource: row.outcome_source,
    outcomeAt: row.outcome_at,
    outcomeAskedAt: row.outcome_asked_at,
    rating: row.rating,
    ratingComment: row.rating_comment,
    ratedAt: row.rated_at,
    ratingAskedAt: row.rating_asked_at,
    goal: goal ? { id: goal.id, name: goal.name, companyName: goal.company_name, description: goal.description, customHotWords: fromJson(goal.custom_hot_words, []) } : null,
    resume: resume ? { id: resume.id, title: resume.title, content: resume.content, isSample: Boolean(resume.is_sample) } : null,
    voice: null,
    agentSessions: all('SELECT * FROM agent_sessions WHERE session_id=?', row.id).map((a) => ({ id: a.id, agent: a.agent, status: a.status, createdAt: a.created_at })),
  };
  if (withMessages) {
    out.messages = all('SELECT * FROM messages WHERE session_id=? ORDER BY created_at ASC', row.id).map((m) => ({
      id: m.id, sessionId: m.session_id, role: m.role, content: m.content, metadata: fromJson(m.metadata, null), createdAt: m.created_at,
    }));
  }
  return out;
}

export function insertMessage(sessionId, role, content, metadata = null) {
  const id = cuid();
  run('INSERT INTO messages(id, session_id, role, content, metadata, created_at) VALUES(?,?,?,?,?,?)',
    id, sessionId, role, content, toJson(metadata), nowIso());
  return id;
}

/** 转写落库（对齐 09 号文档 InterviewTranscript 关联） */
export function insertTranscript(sessionId, speakerId, text, { utteranceId = null, completed = true } = {}) {
  const id = cuid();
  run(
    'INSERT INTO transcripts(id, session_id, speaker_id, utterance_id, completed, text, created_at) VALUES(?,?,?,?,?,?,?)',
    id, sessionId, speakerId, utteranceId || cuid(12), completed ? 1 : 0, text, nowIso(),
  );
  return id;
}

export default {
  'session.createSession': {
    kind: 'mutation',
    input: z.object({
      goalId: z.string().optional(),
      resumeId: z.string().optional(),
      type: z.enum(TYPES),
      audioSource: z.enum(AUDIO).optional(),
      isTrial: z.boolean().optional(),
      round: z.enum(ROUNDS).optional(),
      metadata: z.record(z.any()).optional(),
    }).passthrough(),
    handler: (input, { user }) => {
      if (input.goalId && !one('SELECT 1 FROM goals WHERE id=? AND user_id=?', input.goalId, user.id)) throw new TRPCError('岗位不存在', 'NOT_FOUND');
      if (input.resumeId && !one('SELECT 1 FROM resumes WHERE id=? AND user_id=?', input.resumeId, user.id)) throw new TRPCError('简历不存在', 'NOT_FOUND');
      const goal = input.goalId ? one('SELECT * FROM goals WHERE id=?', input.goalId) : null;
      const now = nowIso();
      const metadata = {
        lang: user.last_interview_lang || 'zh-CN',
        title: `${goal?.name || '模拟面试'}·${input.metadata?.difficulty || 'auto'}`,
        assistMode: true,
        materialIds: input.metadata?.materialIds || [],
        knowledgeChars: 0,
        ...input.metadata,
      };
      const id = cuid();
      run(
        `INSERT INTO sessions(id, user_id, type, status, metadata, goal_id, resume_id, audio_source, is_trial,
           created_at, updated_at, expires_at, round)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        id, user.id, input.type, 'ACTIVE', toJson(metadata), input.goalId || null, input.resumeId || null,
        input.audioSource || 'MICROPHONE', input.isTrial ? 1 : 0, now, now,
        new Date(Date.now() + 2 * 3600 * 1000).toISOString(), input.round || null,
      );
      insertMessage(id, 'SYSTEM', `会话已创建：${metadata.title}`, { kind: 'session.created' });
      return sessionDto(one('SELECT * FROM sessions WHERE id=?', id));
    },
  },

  'session.getActiveSession': {
    kind: 'query',
    input: z.object({ type: z.enum(TYPES) }).passthrough().optional(),
    handler: (input, { user }) => {
      // P1-7：ACTIVE 但已过 expires_at（createSession 写 now+2h）的会话不再返回
      const now = nowIso();
      const row = input?.type
        ? one('SELECT * FROM sessions WHERE user_id=? AND type=? AND status=? AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at DESC LIMIT 1', user.id, input.type, 'ACTIVE', now)
        : one('SELECT * FROM sessions WHERE user_id=? AND status=? AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at DESC LIMIT 1', user.id, 'ACTIVE', now);
      return sessionDto(row);
    },
  },

  'session.getSession': {
    kind: 'query',
    input: z.object({ id: z.string() }).passthrough(),
    handler: ({ id }, { user }) => {
      const row = one('SELECT * FROM sessions WHERE id=? AND user_id=?', id, user.id);
      if (!row) throw new TRPCError('会话不存在', 'NOT_FOUND');
      return sessionDto(row);
    },
  },

  'session.getSessions': {
    kind: 'query',
    input: z.object({ page: z.number().optional(), pageSize: z.number().optional(), type: z.enum(TYPES).optional() }).passthrough().optional(),
    handler: (input = {}, { user }) => {
      const page = Math.max(1, input.page || 1);
      const pageSize = Math.min(50, input.pageSize || 20);
      const where = input.type
        ? one('SELECT COUNT(*) AS n FROM sessions WHERE user_id=? AND type=? AND deleted_at IS NULL', user.id, input.type).n
        : one('SELECT COUNT(*) AS n FROM sessions WHERE user_id=? AND deleted_at IS NULL', user.id).n;
      const sql = input.type
        ? 'SELECT * FROM sessions WHERE user_id=? AND type=? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT ? OFFSET ?'
        : 'SELECT * FROM sessions WHERE user_id=? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT ? OFFSET ?';
      const rows = input.type
        ? all(sql, user.id, input.type, pageSize, (page - 1) * pageSize)
        : all(sql, user.id, pageSize, (page - 1) * pageSize);
      // 双形状：自研 UI 用 items/total；原版前端用 sessions + pagination（bootstrap:40614/45635 实测）
      const items = rows.map((r) => sessionDto(r, { withMessages: false }));
      const totalPages = Math.max(1, Math.ceil(where / pageSize));
      return { items, total: where, page, pageSize, sessions: items, pagination: { total: where, totalPages, page, pageSize } };
    },
  },

  'session.sessionStatus': {
    kind: 'query',
    input: z.object({ id: z.string() }).passthrough(),
    handler: ({ id }, { user }) => {
      const row = one('SELECT id,status,updated_at,completed_at FROM sessions WHERE id=? AND user_id=?', id, user.id);
      if (!row) throw new TRPCError('会话不存在', 'NOT_FOUND');
      return { id: row.id, status: row.status, updatedAt: row.updated_at, completedAt: row.completed_at };
    },
  },

  'session.completeSession': {
    kind: 'mutation',
    input: z.object({ id: z.string() }).passthrough(),
    handler: async ({ id }, { user }) => {
      // P1-7：与 socket mock.end 共用 finalizeSession（幂等，逻辑单一来源）
      const dto = await finalizeSession(id, user.id);
      if (!dto) throw new TRPCError('会话不存在', 'NOT_FOUND');
      return dto;
    },
  },

  'session.renameSession': {
    kind: 'mutation',
    input: z.object({ id: z.string(), title: z.string().min(1) }).passthrough(),
    handler: ({ id, title }, { user }) => {
      const row = one('SELECT * FROM sessions WHERE id=? AND user_id=?', id, user.id);
      if (!row) throw new TRPCError('会话不存在', 'NOT_FOUND');
      const metadata = { ...(fromJson(row.metadata, {}) || {}), title };
      run('UPDATE sessions SET metadata=?, updated_at=? WHERE id=?', toJson(metadata), nowIso(), id);
      return sessionDto(one('SELECT * FROM sessions WHERE id=?', id), { withMessages: false });
    },
  },

  'session.deleteSession': {
    kind: 'mutation',
    input: z.object({ id: z.string() }).passthrough(),
    handler: ({ id }, { user }) => {
      run('UPDATE sessions SET deleted_at=?, status=? WHERE id=? AND user_id=?', nowIso(), 'COMPLETED', id, user.id);
      return { id, deleted: true };
    },
  },

  'session.uploadUserAnswer': {
    kind: 'mutation',
    input: z.object({ id: z.string(), answerSlotId: z.string().optional(), answer: z.string(), audioUrl: z.string().optional() }).passthrough(),
    handler: ({ id, answerSlotId, answer, audioUrl }, { user }) => {
      const row = one('SELECT * FROM sessions WHERE id=? AND user_id=?', id, user.id);
      if (!row) throw new TRPCError('会话不存在', 'NOT_FOUND');
      const messageId = insertMessage(id, 'USER', answer, { answerSlotId, audioUrl });
      run('UPDATE sessions SET updated_at=? WHERE id=?', nowIso(), id);
      return { id: messageId, sessionId: id, answerSlotId, accepted: true };
    },
  },

  'session.reportAnswerDrop': {
    kind: 'mutation',
    input: z.object({ id: z.string(), reason: z.string(), turnId: z.string().optional(), durationSec: z.number().optional() }).passthrough(),
    handler: ({ id, reason, turnId, durationSec }) => ({ id, reason, turnId, durationSec, recorded: true }),
  },

  'session.getAnswerStyleSources': {
    kind: 'query',
    input: z.object({ limit: z.number().optional() }).passthrough().optional(),
    handler: (input = {}, { user }) => {
      const rows = all(
        `SELECT s.id, s.metadata, s.created_at FROM sessions s WHERE s.user_id=? AND s.status='COMPLETED' AND s.type='MOCK_INTERVIEW'
         ORDER BY s.created_at DESC LIMIT ?`, user.id, Math.min(50, input.limit || 10),
      );
      return rows.map((r) => ({ id: r.id, title: fromJson(r.metadata, {})?.title || '模拟面试', createdAt: r.created_at }));
    },
  },

  'session.learnAnswerStyle': {
    kind: 'mutation',
    input: z.object({ id: z.string() }).passthrough(),
    handler: ({ id }, { user }) => {
      const row = one('SELECT * FROM sessions WHERE id=? AND user_id=?', id, user.id);
      if (!row) throw new TRPCError('会话不存在', 'NOT_FOUND');
      const learned = { sourceSessionId: id, style: 'natural', learnedAt: nowIso(), sampleChars: 1200 };
      return learned;
    },
  },

  'session.getSessionReport': {
    kind: 'query',
    input: z.object({ id: z.string() }).passthrough(),
    handler: async ({ id }, { user }) => {
      const row = one('SELECT * FROM sessions WHERE id=? AND user_id=?', id, user.id);
      if (!row) throw new TRPCError('会话不存在', 'NOT_FOUND');
      let report = fromJson(row.report, null);
      if (!report) {
        if (row.status !== 'COMPLETED') return { status: 'pending', sessionId: id };
        // P2-A：与 finalizeSession 保持一致，资料也参与报告生成的上下文
        const ctx = buildContext(user.id, { resumeId: row.resume_id, goalId: row.goal_id, materialIds: fromJson(row.metadata, {})?.materialIds });
        // P1-11：走单飞生成，避免与 finalizeSession/并发请求重复调用模型
        report = await generateReportOnce(id, row, ctx);
      }
      return report;
    },
  },

  'session.retrySessionReport': {
    kind: 'mutation',
    input: z.object({ id: z.string() }).passthrough(),
    handler: async ({ id }, { user }) => {
      const row = one('SELECT * FROM sessions WHERE id=? AND user_id=?', id, user.id);
      if (!row) throw new TRPCError('会话不存在', 'NOT_FOUND');
      // P1-6：重试 = 清掉旧报告后重跑 finalizeSession（成功后置 COMPLETED），失败显式报错
      run('UPDATE sessions SET report=NULL WHERE id=?', id);
      try {
        const dto = await finalizeSession(id, user.id);
        return { id, queued: true, status: dto?.status || null, reportReady: Boolean(dto?.reportReady) };
      } catch (e) {
        throw new TRPCError(`报告重试失败：${e.message}`, 'INTERNAL_SERVER_ERROR');
      }
    },
  },

  /* ───────── 笔试记录层 ───────── */
  'examSession.list': {
    kind: 'query',
    input: z.object({ page: z.number().optional(), pageSize: z.number().optional() }).passthrough().optional(),
    handler: (input = {}, { user }) => {
      const page = Math.max(1, input.page || 1);
      const pageSize = Math.min(50, input.pageSize || 20);
      const total = one('SELECT COUNT(*) AS n FROM exam_sessions WHERE user_id=?', user.id).n;
      const rows = all('SELECT * FROM exam_sessions WHERE user_id=? ORDER BY created_at DESC LIMIT ? OFFSET ?', user.id, pageSize, (page - 1) * pageSize);
      // 双形状：自研 UI 用 items；原版前端用 examSessions + total（bootstrap:54589 实测 r.total）
      const items = rows.map((r) => ({
        id: r.id, title: r.title, status: r.status, questionCount: r.question_count,
        costMinutes: r.cost_minutes, outcome: r.outcome, platform: r.platform, createdAt: r.created_at,
      }));
      return { items, total, page, pageSize, examSessions: items };
    },
  },

  'examSession.detail': {
    kind: 'query',
    input: z.object({ id: z.string() }).passthrough(),
    handler: ({ id }, { user }) => {
      const row = one('SELECT * FROM exam_sessions WHERE id=? AND user_id=?', id, user.id);
      if (!row) throw new TRPCError('笔试记录不存在', 'NOT_FOUND');
      return {
        id: row.id, title: row.title, status: row.status, platform: row.platform, mode: row.mode,
        questionCount: row.question_count, costMinutes: row.cost_minutes, outcome: row.outcome,
        questions: fromJson(row.questions, []), createdAt: row.created_at,
      };
    },
  },

  'examSession.update': {
    kind: 'mutation',
    input: z.object({ id: z.string(), title: z.string() }).passthrough(),
    handler: ({ id, title }, { user }) => {
      run('UPDATE exam_sessions SET title=?, updated_at=? WHERE id=? AND user_id=?', title, nowIso(), id, user.id);
      return { id, title };
    },
  },

  'examSession.remove': {
    kind: 'mutation',
    input: z.object({ id: z.string() }).passthrough(),
    handler: ({ id }, { user }) => {
      run('DELETE FROM exam_sessions WHERE id=? AND user_id=?', id, user.id);
      return { id, removed: true };
    },
  },

  'examSession.customization': {
    kind: 'query',
    input: pass.optional(),
    handler: (_i, { user }) => ({ ...defaultExamCustomization(), ...(fromJson(user.exam_customization, {}) || {}) }),
  },
};
