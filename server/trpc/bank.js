import { z } from 'zod';
import { one, all, run } from '../db.js';
import { fromJson, toJson, nowIso } from '../util.js';
import { cuid } from '../util.js';
import { TRPCError } from './errors.js';
import { generatePredictionItems } from '../ai/enrich.js';

const pass = z.object({}).passthrough();

const qDto = (row, state) => ({
  id: row.id, questionText: row.question_text, answer: row.answer, company: row.company,
  options: fromJson(row.options, []), tags: fromJson(row.tags, []), difficulty: row.difficulty,
  locked: Boolean(row.locked), hot: Boolean(row.hot), askedCount: row.asked_count,
  favorited: Boolean(state?.favorited), met: Boolean(state?.met),
});

const stateOf = (userId, questionId) =>
  one('SELECT * FROM user_question_state WHERE user_id=? AND question_id=?', userId, questionId);

function ensureState(userId, questionId) {
  run('INSERT INTO user_question_state(user_id,question_id,favorited,met,updated_at) VALUES(?,?,0,0,?) ON CONFLICT(user_id,question_id) DO NOTHING',
    userId, questionId, nowIso());
  return stateOf(userId, questionId);
}

export default {
  'questionBank.getOverview': {
    kind: 'query', input: pass.optional(),
    handler: (_i, { user }) => {
      const count = one('SELECT COUNT(*) AS n FROM questions').n;
      const occ = one('SELECT COALESCE(SUM(asked_count),0) AS n FROM questions').n;
      const fav = one('SELECT COUNT(*) AS n FROM user_question_state WHERE user_id=? AND favorited=1', user.id).n;
      const met = one('SELECT COUNT(*) AS n FROM user_question_state WHERE user_id=? AND met=1', user.id).n;
      return {
        questionCount: count, occurrenceCount: occ, favoritedCount: fav, metCount: met,
        updatedAt: nowIso(), latestAskedAt: nowIso(),
        topShareSize: Math.round(occ * 0.06), topSharePercent: 6,
      };
    },
  },

  'questionBank.listHot': {
    kind: 'query',
    input: z.object({ page: z.number().optional(), pageSize: z.number().optional(), sort: z.enum(['hot', 'recent']).optional() }).passthrough().optional(),
    handler: (input = {}, { user }) => {
      const page = Math.max(1, input.page || 1);
      const pageSize = Math.min(50, input.pageSize || 20);
      const order = input.sort === 'recent' ? 'rowid DESC' : 'asked_count DESC';
      const total = one('SELECT COUNT(*) AS n FROM questions').n;
      const rows = all(`SELECT * FROM questions ORDER BY ${order} LIMIT ? OFFSET ?`, pageSize, (page - 1) * pageSize);
      return { items: rows.map((r) => qDto(r, stateOf(user.id, r.id))), total, page, pageSize };
    },
  },

  'questionBank.listCompanies': {
    kind: 'query',
    input: z.object({ page: z.number().optional(), pageSize: z.number().optional() }).passthrough().optional(),
    handler: (input = {}) => {
      const rows = all('SELECT company, COUNT(*) AS n FROM questions WHERE company IS NOT NULL GROUP BY company ORDER BY n DESC');
      const page = Math.max(1, input.page || 1);
      const pageSize = Math.min(50, input.pageSize || 20);
      return {
        items: rows.slice((page - 1) * pageSize, page * pageSize).map((r) => ({ name: r.company, questionCount: r.n })),
        total: rows.length, page, pageSize,
      };
    },
  },

  'questionBank.getQuestion': {
    kind: 'query',
    input: z.object({ id: z.string() }).passthrough(),
    handler: ({ id }, { user }) => {
      const row = one('SELECT * FROM questions WHERE id=?', id);
      if (!row) throw new TRPCError('题目不存在', 'NOT_FOUND');
      return qDto(row, stateOf(user.id, row.id));
    },
  },

  'questionBank.toggleFavorite': {
    kind: 'mutation',
    input: z.object({ id: z.string() }).passthrough(),
    handler: ({ id }, { user }) => {
      const st = ensureState(user.id, id);
      const next = st.favorited ? 0 : 1;
      run('UPDATE user_question_state SET favorited=?, updated_at=? WHERE user_id=? AND question_id=?', next, nowIso(), user.id, id);
      return { id, favorited: Boolean(next) };
    },
  },

  'questionBank.toggleMet': {
    kind: 'mutation',
    input: z.object({ id: z.string() }).passthrough(),
    handler: ({ id }, { user }) => {
      const st = ensureState(user.id, id);
      const next = st.met ? 0 : 1;
      run('UPDATE user_question_state SET met=?, updated_at=? WHERE user_id=? AND question_id=?', next, nowIso(), user.id, id);
      return { id, met: Boolean(next) };
    },
  },

  'questionBank.saveToMaterial': {
    kind: 'mutation',
    input: z.object({ ids: z.array(z.string()).default([]) }).passthrough(),
    handler: ({ ids }, { user }) => {
      const rows = ids.length ? all(`SELECT * FROM questions WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids) : [];
      if (!rows.length) throw new TRPCError('没有可保存的题目', 'BAD_REQUEST');
      let material = one("SELECT * FROM materials WHERE user_id=? AND name='题库收藏'", user.id);
      if (!material) {
        const mid = cuid();
        run('INSERT INTO materials(id,user_id,name,content,created_at) VALUES(?,?,?,?,?)', mid, user.id, '题库收藏', '来自题库的收藏题目', nowIso());
        material = one('SELECT * FROM materials WHERE id=?', mid);
      }
      for (const r of rows) {
        const eid = cuid();
        run('INSERT INTO material_entries(id,material_id,question,answer,source,created_at) VALUES(?,?,?,?,?,?)',
          eid, material.id, r.question_text, r.answer, 'bank', nowIso());
      }
      return { materialId: material.id, saved: rows.length };
    },
  },

  /* ───── 押题 ───── */
  'questionPrediction.list': {
    kind: 'query', input: pass.optional(),
    handler: (_i, { user }) => all('SELECT * FROM predictions WHERE user_id=? ORDER BY created_at DESC', user.id)
      .map((p) => ({ id: p.id, title: p.title, goalId: p.goal_id, status: p.status, createdAt: p.created_at, itemCount: fromJson(p.items, []).length })),
  },

  'questionPrediction.get': {
    kind: 'query',
    input: z.object({ root: z.string() }).passthrough(),
    handler: ({ root }, { user }) => {
      const p = one('SELECT * FROM predictions WHERE id=? AND user_id=?', root, user.id);
      if (!p) throw new TRPCError('押题不存在', 'NOT_FOUND');
      return { id: p.id, title: p.title, status: p.status, createdAt: p.created_at, items: fromJson(p.items, []) };
    },
  },

  'questionPrediction.startCustom': {
    kind: 'mutation',
    input: z.object({ goalId: z.string().optional(), resumeId: z.string().optional(), experience: z.string().optional() }).passthrough(),
    handler: ({ goalId, resumeId, experience = '' }, { user }) => {
      const goal = goalId ? one('SELECT * FROM goals WHERE id=? AND user_id=?', goalId, user.id) : null;
      const words = fromJson(goal?.custom_hot_words, []) || [];
      const banks = all('SELECT * FROM questions ORDER BY asked_count DESC LIMIT 12');
      const items = banks.map((q, i) => ({
        id: cuid(12),
        title: q.question_text,
        category: (fromJson(q.tags, []) || [])[0] || '通用',
        probability: Math.max(0.25, 0.92 - i * 0.05),
        company: q.company,
        hotWords: words.slice(0, 3),
        reference: q.answer,
      }));
      const id = cuid();
      run('INSERT INTO predictions(id,user_id,goal_id,title,status,items,created_at) VALUES(?,?,?,?,?,?,?)',
        id, user.id, goalId || null, `${goal?.name || '通用岗位'} · 押题`, 'READY', toJson(items), nowIso());
      return { id, status: 'READY', items };
    },
  },

  /* P0：押题生成（文档 19：简历+JD → 题库检索 → 写解析） */
  'questionPrediction.generate': {
    kind: 'mutation',
    input: z.object({
      goalId: z.string().optional(),
      resumeId: z.string().optional(),
      experience: z.string().optional(),
      count: z.number().int().min(1).max(20).optional(),
    }).passthrough(),
    handler: async ({ goalId, resumeId, experience = '', count = 8 }, { user }) => {
      const goal = goalId ? one('SELECT * FROM goals WHERE id=? AND user_id=?', goalId, user.id) : null;
      const resume = resumeId
        ? one('SELECT * FROM resumes WHERE id=? AND user_id=?', resumeId, user.id)
        : one('SELECT * FROM resumes WHERE user_id=? ORDER BY created_at DESC', user.id);
      // 题库检索：按热词/公司粗排后交给模型改写，避免照抄
      const words = (fromJson(goal?.custom_hot_words, []) || []).map((w) => String(w).toLowerCase());
      const bank = all('SELECT * FROM questions ORDER BY asked_count DESC LIMIT 60');
      const scored = bank
        .map((q) => {
          const text = `${q.question_text} ${q.company || ''}`.toLowerCase();
          return { q, hit: words.filter((w) => w && text.includes(w)).length };
        })
        .sort((a, b) => b.hit - a.hit || (b.q.asked_count || 0) - (a.q.asked_count || 0))
        .slice(0, 40)
        .map((x) => x.q);

      let items = null;
      let source = 'model';
      try {
        items = await generatePredictionItems({ goal, resume, bankRows: scored, experience, count });
      } catch (e) {
        console.warn('[prediction] 模型押题失败，回退题库:', e.message);
      }
      if (!items) {
        source = 'bank';
        items = scored.slice(0, count).map((q, i) => ({
          id: cuid(12),
          title: q.question_text,
          category: (fromJson(q.tags, []) || [])[0] || '通用',
          probability: Math.max(0.25, 0.92 - i * 0.05),
          difficulty: '中等',
          hotWords: words.slice(0, 3),
          reference: q.answer,
        }));
      }
      const id = cuid();
      run('INSERT INTO predictions(id,user_id,goal_id,title,status,items,created_at) VALUES(?,?,?,?,?,?,?)',
        id, user.id, goalId || null, `${goal?.name || '通用岗位'} · 押题`, 'READY', toJson(items), nowIso());
      return { id, status: 'READY', items, source, count: items.length };
    },
  },

  'questionPrediction.subscribe': {
    kind: 'mutation',
    input: z.object({ id: z.string() }).passthrough(),
    handler: ({ id }) => ({ id, subscribed: true, channel: `prediction:${id}` }),
  },

  'questionPrediction.saveToMaterial': {
    kind: 'mutation',
    input: z.object({ id: z.string().optional(), root: z.string().optional() }).passthrough().optional(),
    handler: (input = {}, { user }) => {
      const id = input.id || input.root;
      const p = one('SELECT * FROM predictions WHERE id=? AND user_id=?', id, user.id);
      if (!p) throw new TRPCError('押题不存在', 'NOT_FOUND');
      const mid = cuid();
      run('INSERT INTO materials(id,user_id,name,content,created_at) VALUES(?,?,?,?,?)',
        mid, user.id, `${p.title}（押题）`, '押题结果', nowIso());
      for (const item of fromJson(p.items, [])) {
        run('INSERT INTO material_entries(id,material_id,question,answer,source,created_at) VALUES(?,?,?,?,?,?)',
          cuid(), mid, item.title, item.reference || '', 'prediction', nowIso());
      }
      return { materialId: mid, saved: fromJson(p.items, []).length };
    },
  },

  /* ───── 求职进度 ───── */
  'jobProgress.startGoals': {
    kind: 'query', input: pass.optional(),
    // 原版消费形态：直接是 Goal[]（面试设置面板 l.find(e=>e.id===goalId).lastRound）
    handler: (_i, { user }) => all('SELECT * FROM goals WHERE user_id=? ORDER BY created_at DESC', user.id).map((g) => ({
      id: g.id, name: g.name, companyName: g.company_name, description: g.description,
      lastRound: g.last_round, customHotWords: fromJson(g.custom_hot_words, []),
      rounds: one("SELECT COUNT(*) AS n FROM sessions WHERE user_id=? AND goal_id=? AND type='INTERVIEW'", user.id, g.id).n,
      result: g.result, createdAt: g.created_at,
    })),
  },

  'jobProgress.followUp': {
    kind: 'query', input: pass.optional(),
    handler: (_i, { user }) => ({
      items: [
        { id: 'fu-1', kind: 'followup', text: '上周的模拟面试还有一场没复盘，建议先看报告', action: '/dashboard' },
        { id: 'fu-2', kind: 'reminder', text: '今天还没打卡，做一场 15 分钟模拟面试即可', action: '/desktop/mock-interview' },
      ],
      updatedAt: nowIso(),
    }),
  },

  'jobProgress.ensureGoal': {
    kind: 'mutation',
    input: z.object({ name: z.string().optional(), goalId: z.string().optional() }).passthrough().optional(),
    handler: (input = {}, { user }) => {
      if (input.goalId) {
        const g = one('SELECT * FROM goals WHERE id=? AND user_id=?', input.goalId, user.id);
        if (g) return { goalId: g.id, name: g.name, reused: true };
      }
      const existing = all('SELECT * FROM goals WHERE user_id=? ORDER BY created_at DESC LIMIT 1', user.id)[0];
      if (existing && !input.name) return { goalId: existing.id, name: existing.name, reused: true };
      const gid = cuid();
      run('INSERT INTO goals(id,user_id,name,company_name,description,custom_hot_words,created_at) VALUES(?,?,?,?,?,?,?)',
        gid, user.id, input.name || '目标岗位', '', '', toJson([]), nowIso());
      return { goalId: gid, name: input.name || '目标岗位', reused: false };
    },
  },

  'jobProgress.submitCheckin': {
    kind: 'mutation', input: pass.optional(),
    handler: () => ({ checkinAt: nowIso(), streak: 1, recorded: true }),
  },

  'jobProgress.markOutcome': {
    kind: 'mutation',
    input: z.object({
      kind: z.enum(['interview', 'exam']),
      id: z.string(),
      mark: z.enum(['PASSED', 'FAILED', 'WAITING', 'OC', 'OFFER', 'CLEAR']),
    }).passthrough(),
    handler: ({ kind, id, mark }, { user }) => {
      const table = kind === 'exam' ? 'exam_sessions' : 'sessions';
      run(`UPDATE ${table} SET outcome=?, updated_at=? WHERE id=? AND user_id=?`, mark, nowIso(), id, user.id);
      return { kind, id, mark, recorded: true };
    },
  },

  /* ───── 评分 / 反馈 ───── */
  'sessionRating.pending': {
    kind: 'query', input: pass.optional(),
    handler: (_i, { user }) => {
      const rows = all(
        "SELECT * FROM sessions WHERE user_id=? AND status='COMPLETED' AND rating IS NULL AND deleted_at IS NULL ORDER BY completed_at DESC LIMIT 5",
        user.id,
      );
      return rows.map((r) => ({ kind: 'interview', id: r.id, title: fromJson(r.metadata, {})?.title || '面试会话', completedAt: r.completed_at, askedAt: r.rating_asked_at }));
    },
  },

  'sessionRating.markAsked': {
    kind: 'mutation',
    input: z.object({ kind: z.enum(['interview', 'exam']), id: z.string() }).passthrough(),
    handler: ({ kind, id }, { user }) => {
      run('UPDATE sessions SET rating_asked_at=? WHERE id=? AND user_id=?', nowIso(), id, user.id);
      return { kind, id, asked: true };
    },
  },

  'sessionRating.submit': {
    kind: 'mutation',
    input: z.object({ kind: z.enum(['interview', 'exam']), id: z.string(), rating: z.number().min(1).max(5), comment: z.string().optional() }).passthrough(),
    handler: ({ kind, id, rating, comment = '' }, { user }) => {
      const table = kind === 'exam' ? 'exam_sessions' : 'sessions';
      run(`UPDATE ${table} SET rating=?, rating_comment=? , rated_at=? WHERE id=? AND user_id=?`, rating, comment, nowIso(), id, user.id);
      return { kind, id, rating, comment, ratedAt: nowIso() };
    },
  },

  'feedback.submitFeedback': {
    kind: 'mutation',
    input: z.object({ message: z.string().min(3) }).passthrough(),
    handler: ({ message }, { user }) => {
      const id = cuid();
      run('INSERT INTO feedbacks(id,user_id,message,status,created_at,updated_at) VALUES(?,?,?,?,?,?)',
        id, user.id, message, 'PENDING', nowIso(), nowIso());
      return { id, status: 'PENDING' };
    },
  },

  'feedback.listMyFeedbacks': {
    kind: 'query',
    input: z.object({ page: z.number().optional(), pageSize: z.number().optional() }).passthrough().optional(),
    handler: (input = {}, { user }) => {
      const page = Math.max(1, input.page || 1);
      const pageSize = Math.min(50, input.pageSize || 20);
      const rows = all('SELECT * FROM feedbacks WHERE user_id=? ORDER BY created_at DESC LIMIT ? OFFSET ?', user.id, pageSize, (page - 1) * pageSize);
      const total = one('SELECT COUNT(*) AS n FROM feedbacks WHERE user_id=?', user.id).n;
      const items = rows.map((f) => ({
        id: f.id, message: f.message, status: f.status, createdAt: f.created_at,
        replies: all('SELECT * FROM feedback_replies WHERE feedback_id=?', f.id)
          .map((r) => ({ id: r.id, content: r.content, role: r.role, createdAt: r.created_at })),
      }));
      return { items, total, page, pageSize };
    },
  },

  'feedback.getMyFeedback': {
    kind: 'query',
    input: z.object({ id: z.string() }).passthrough(),
    handler: ({ id }, { user }) => {
      const f = one('SELECT * FROM feedbacks WHERE id=? AND user_id=?', id, user.id);
      if (!f) throw new TRPCError('反馈不存在', 'NOT_FOUND');
      return { id: f.id, message: f.message, status: f.status, createdAt: f.created_at };
    },
  },

  'feedback.myUnreadCount': {
    kind: 'query', input: pass.optional(),
    handler: (_i, { user }) => ({
      count: all("SELECT * FROM feedbacks WHERE user_id=? AND status IN ('TRIAGING','FIXING')", user.id).length,
    }),
  },

  'feedback.replyToMyFeedback': {
    kind: 'mutation',
    input: z.object({ id: z.string(), content: z.string().min(1) }).passthrough(),
    handler: ({ id, content }, { user }) => {
      const rid = cuid();
      run('INSERT INTO feedback_replies(id,feedback_id,content,role,created_at) VALUES(?,?,?,?,?)', rid, id, content, 'USER', nowIso());
      return { id: rid, feedbackId: id, content };
    },
  },
};
