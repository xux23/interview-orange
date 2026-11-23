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
      const row = input?.type
        ? one('SELECT * FROM sessions WHERE user_id=? AND type=? AND status=? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1', user.id, input.type, 'ACTIVE')
        : one('SELECT * FROM sessions WHERE user_id=? AND status=? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1', user.id, 'ACTIVE');
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
      const row = one('SELECT * FROM sessions WHERE id=? AND user_id=?', id, user.id);
      if (!row) throw new TRPCError('会话不存在', 'NOT_FOUND');
      if (row.status === 'COMPLETED') return sessionDto(row);
      const startedAt = Date.parse(row.created_at);
      const realDuration = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
      const ctx = buildContext(user.id, { resumeId: row.resume_id, goalId: row.goal_id, materialIds: fromJson(row.metadata, {})?.materialIds });
      const messages = all('SELECT * FROM messages WHERE session_id=? ORDER BY created_at ASC', id)
        .map((m) => ({ id: m.id, role: m.role, content: m.content, metadata: fromJson(m.metadata, null), createdAt: m.created_at }));
      const report = await reportFor(row, messages, ctx);
      const now = nowIso();
      run('UPDATE sessions SET status=?, updated_at=?, completed_at=?, real_duration=?, report=? WHERE id=?',
        'COMPLETED', now, now, realDuration, toJson(report), id);
      if (row.type === 'MOCK_INTERVIEW') {
        run('UPDATE users SET mock_interview_count = MAX(0, mock_interview_count - 1) WHERE id=?', user.id);
      }
      return sessionDto(one('SELECT * FROM sessions WHERE id=?', id));
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
        const ctx = buildContext(user.id, { resumeId: row.resume_id, goalId: row.goal_id });
        report = await reportFor(row, all('SELECT * FROM messages WHERE session_id=? ORDER BY created_at ASC', id).map((m) => ({ role: m.role, content: m.content })), ctx);
        run('UPDATE sessions SET report=? WHERE id=?', toJson(report), id);
      }
      return report;
    },
  },

  'session.retrySessionReport': {
    kind: 'mutation',
    input: z.object({ id: z.string() }).passthrough(),
    handler: ({ id }, { user }) => {
      run('UPDATE sessions SET report=NULL WHERE id=? AND user_id=?', id, user.id);
      return { id, queued: true };
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
