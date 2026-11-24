import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { one, all, run } from '../db.js';
import { fromJson, toJson, nowIso } from '../util.js';
import { cuid } from '../util.js';
import { config } from '../config.js';
import { TRPCError } from './errors.js';
import { resumeFacts } from '../ai/mockBrain.js';
import { extractHotWords, generateMaterialEntries, suggestGoalsFromResume } from '../ai/enrich.js';

const pass = z.object({}).passthrough();

/** 极简文本抽取：txt/md 直读；pdf 扫 (…)Tj 字面量；docx 读 word/document.xml 文本 */
export function extractText(buf, fileName = '') {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === '.docx') {
    const xml = buf.toString('utf8');
    const texts = [...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('');
    if (texts) return texts.replace(/\s{2,}/g, ' ');
  }
  if (ext === '.pdf') {
    const raw = buf.toString('latin1');
    const chunks = [...raw.matchAll(/\(([^()\\]{2,200})\)\s*Tj/g)].map((m) => m[1]);
    if (chunks.length) return chunks.join(' ').replace(/\\([()\\])/g, '$1');
    return raw.replace(/[^\x20-\x7e\n]/g, ' ').replace(/\s{3,}/g, ' ');
  }
  const text = buf.toString('utf8');
  return text.replace(/\u0000/g, '');
}

const HOT_WORD_SEED = ['API', 'RESTful', 'gRPC', '微服务', '分布式系统', '高可用', '高并发', '数据库', 'MySQL', 'Redis', '消息队列', 'Kafka', '缓存', '负载均衡', '容器化', 'Docker', 'Kubernetes', '系统架构', '服务端', '中间件'];

function goalDto(g) {
  return {
    id: g.id, name: g.name, description: g.description, companyName: g.company_name,
    userId: g.user_id, createdAt: g.created_at, lastRound: g.last_round,
    result: g.result, resultAt: g.result_at, customHotWords: fromJson(g.custom_hot_words, []),
  };
}

export default {
  'resume.getResumes': {
    kind: 'query', input: pass.optional(),
    handler: (_i, { user }) =>
      all('SELECT * FROM resumes WHERE user_id=? ORDER BY created_at DESC', user.id)
        .map((r) => ({ id: r.id, title: r.title, content: r.content, isSample: Boolean(r.is_sample), createdAt: r.created_at })),
  },

  'resume.uploadResume': {
    kind: 'mutation',
    input: z.object({ fileBase64: z.string().optional(), fileName: z.string().optional(), content: z.string().optional(), title: z.string().optional() }).passthrough(),
    handler: ({ fileBase64, fileName = 'resume.txt', content, title }, { user }) => {
      let text = content || '';
      if (!text && fileBase64) {
        const base64 = fileBase64.includes(',') ? fileBase64.split(',').pop() : fileBase64;
        text = extractText(Buffer.from(base64, 'base64'), fileName);
      }
      if (!text || text.trim().length < 20) throw new TRPCError('简历内容过短，无法解析', 'BAD_REQUEST');
      const id = cuid();
      run('INSERT INTO resumes(id,user_id,title,content,is_sample,created_at) VALUES(?,?,?,?,?,?)',
        id, user.id, title || path.basename(fileName.replace(/\.(pdf|docx?|txt|md)$/i, '')), text.slice(0, 60000), 0, nowIso());
      const r = one('SELECT * FROM resumes WHERE id=?', id);
      return { id: r.id, title: r.title, content: r.content, isSample: false, createdAt: r.created_at };
    },
  },

  'resume.deleteResume': {
    kind: 'mutation',
    input: z.object({ id: z.string().optional() }).passthrough().optional(),
    handler: (input = {}, { user }) => {
      if (input.id) run('DELETE FROM resumes WHERE id=? AND user_id=? AND is_sample=0', input.id, user.id);
      else run('DELETE FROM resumes WHERE user_id=? AND is_sample=0', user.id);
      return { deleted: true };
    },
  },

  'goal.getGoals': {
    kind: 'query', input: pass.optional(),
    handler: (_i, { user }) => all('SELECT * FROM goals WHERE user_id=? ORDER BY created_at DESC', user.id).map(goalDto),
  },

  'goal.saveGoal': {
    kind: 'mutation',
    input: z.object({ id: z.string().optional(), name: z.string().min(1), description: z.string().optional(), companyName: z.string().optional() }).passthrough(),
    handler: ({ id, name, description = '', companyName = '' }, { user }) => {
      if (id) {
        const row = one('SELECT * FROM goals WHERE id=? AND user_id=?', id, user.id);
        if (!row) throw new TRPCError('岗位不存在', 'NOT_FOUND');
        run('UPDATE goals SET name=?, description=?, company_name=? WHERE id=?', name, description, companyName, id);
        return goalDto(one('SELECT * FROM goals WHERE id=?', id));
      }
      const gid = cuid();
      run('INSERT INTO goals(id,user_id,name,company_name,description,custom_hot_words,created_at) VALUES(?,?,?,?,?,?,?)',
        gid, user.id, name, companyName, description, toJson(HOT_WORD_SEED.slice(0, 12)), nowIso());
      return goalDto(one('SELECT * FROM goals WHERE id=?', gid));
    },
  },

  'goal.deleteGoal': {
    kind: 'mutation',
    input: z.object({ id: z.string().optional() }).passthrough().optional(),
    handler: (input = {}, { user }) => {
      if (input.id) run('DELETE FROM goals WHERE id=? AND user_id=?', input.id, user.id);
      else run('DELETE FROM goals WHERE user_id=?', user.id);
      return { deleted: true };
    },
  },

  'goal.suggestFromResume': {
    kind: 'mutation',
    input: z.object({ resumeId: z.string() }).passthrough(),
    handler: async ({ resumeId }, { user }) => {
      const resume = one('SELECT * FROM resumes WHERE id=? AND user_id=?', resumeId, user.id);
      if (!resume) throw new TRPCError('简历不存在', 'NOT_FOUND');
      const f = resumeFacts(resume);
      // 真模型：简历 → 3 个匹配岗位；失败直接报错
      let llm = null;
      try {
        llm = await suggestGoalsFromResume({ resume, facts: f });
      } catch (e) {
        throw new TRPCError(`岗位推荐失败：${e.message}`, 'INTERNAL_SERVER_ERROR');
      }
      if (llm?.length) return { resumeId, suggestions: llm, source: 'model' };
      // mock 模式替身：本地规则推荐
      const suggestions = [
        { name: `${f.role}工程师（${f.techs[0]}）`, companyName: '字节跳动', description: `负责${f.techs.slice(0, 3).join('、')}相关系统研发，要求 3 年以上，熟悉高并发与分布式。` },
        { name: `${f.role}工程师（${f.techs[1] || f.techs[0]}）`, companyName: '美团', description: `业务系统研发，${f.techs.slice(0, 2).join('、')}，重视稳定性与性能优化。` },
        { name: `高级${f.role}工程师`, companyName: '小红书', description: `核心链路研发，${f.techs[0]} 为主，要求有线上故障排查经验。` },
      ];
      return { resumeId, suggestions, source: 'rule' };
    },
  },

  'hotWords.ensureGoalHotWords': {
    kind: 'mutation',
    input: z.object({ goalId: z.string() }).passthrough(),
    handler: async ({ goalId }, { user }) => {
      const goal = one('SELECT * FROM goals WHERE id=? AND user_id=?', goalId, user.id);
      if (!goal) throw new TRPCError('岗位不存在', 'NOT_FOUND');
      let words = fromJson(goal.custom_hot_words, []);
      let source = 'cached';
      if (!words?.length) {
        // 真模型：从 JD + 简历抽术语（文档 21 §2.4）；失败直接报错
        const resume = goal.resume_id
          ? one('SELECT * FROM resumes WHERE id=?', goal.resume_id)
          : one('SELECT * FROM resumes WHERE user_id=? ORDER BY created_at DESC', user.id);
        let llm = null;
        try {
          llm = await extractHotWords({ goal, resume });
        } catch (e) {
          throw new TRPCError(`热词抽取失败：${e.message}`, 'INTERNAL_SERVER_ERROR');
        }
        if (llm?.customHotWords?.length) {
          words = llm.customHotWords;
          source = 'model';
          run('UPDATE goals SET custom_hot_words=? WHERE id=?', toJson(words), goalId);
          return { goalId, hotWords: llm.hotWords, customHotWords: words, source };
        }
        // mock 模式替身：种子热词
        words = HOT_WORD_SEED.slice(0, 12);
        source = 'seed';
        run('UPDATE goals SET custom_hot_words=? WHERE id=?', toJson(words), goalId);
      }
      return { goalId, customHotWords: words, source };
    },
  },

  'hotWords.updateGoalHotWords': {
    kind: 'mutation',
    input: z.object({ goalId: z.string(), hotWordIds: z.array(z.string()).optional(), customHotWords: z.array(z.string()).optional() }).passthrough(),
    handler: ({ goalId, hotWordIds = [], customHotWords = [] }, { user }) => {
      const merged = [...new Set([...hotWordIds, ...customHotWords])].slice(0, 40);
      run('UPDATE goals SET custom_hot_words=? WHERE id=? AND user_id=?', toJson(merged), goalId, user.id);
      return { goalId, customHotWords: merged };
    },
  },

  'material.getMaterials': {
    kind: 'query', input: pass.optional(),
    handler: (_i, { user }) => {
      const rows = all('SELECT * FROM materials WHERE user_id=? ORDER BY created_at DESC', user.id);
      return rows.map((m) => ({
        id: m.id, name: m.name, content: m.content, createdAt: m.created_at,
        entryCount: one('SELECT COUNT(*) AS n FROM material_entries WHERE material_id=?', m.id).n,
      }));
    },
  },

  'material.getMaterial': {
    kind: 'query',
    input: z.object({ root: z.string() }).passthrough(),
    handler: ({ root }, { user }) => {
      const m = one('SELECT * FROM materials WHERE id=? AND user_id=?', root, user.id);
      if (!m) throw new TRPCError('资料不存在', 'NOT_FOUND');
      const entries = all('SELECT * FROM material_entries WHERE material_id=? ORDER BY created_at ASC', m.id)
        .map((e) => ({ id: e.id, materialId: e.material_id, question: e.question, answer: e.answer, source: e.source, createdAt: e.created_at }));
      return { id: m.id, name: m.name, content: m.content, createdAt: m.created_at, entries };
    },
  },

  'material.saveMaterial': {
    kind: 'mutation',
    input: z.object({ id: z.string().optional(), name: z.string().min(1), content: z.string().optional() }).passthrough(),
    handler: ({ id, name, content = '' }, { user }) => {
      if (id) {
        run('UPDATE materials SET name=?, content=? WHERE id=? AND user_id=?', name, content, id, user.id);
        return { id, name, content };
      }
      const mid = cuid();
      run('INSERT INTO materials(id,user_id,name,content,created_at) VALUES(?,?,?,?,?)', mid, user.id, name, content, nowIso());
      return { id: mid, name, content };
    },
  },

  'material.saveEntry': {
    kind: 'mutation',
    input: z.object({ materialId: z.string(), id: z.string().optional(), question: z.string().min(1), answer: z.string().optional() }).passthrough(),
    handler: ({ materialId, id, question, answer = '' }, { user }) => {
      const m = one('SELECT * FROM materials WHERE id=? AND user_id=?', materialId, user.id);
      if (!m) throw new TRPCError('资料不存在', 'NOT_FOUND');
      if (id) {
        run('UPDATE material_entries SET question=?, answer=? WHERE id=?', question, answer, id);
        return { id, materialId, question, answer };
      }
      const eid = cuid();
      run('INSERT INTO material_entries(id,material_id,question,answer,source,created_at) VALUES(?,?,?,?,?,?)',
        eid, materialId, question, answer, 'manual', nowIso());
      return { id: eid, materialId, question, answer };
    },
  },

  'material.deleteEntry': {
    kind: 'mutation',
    input: z.object({ id: z.string() }).passthrough(),
    handler: ({ id }) => {
      run('DELETE FROM material_entries WHERE id=?', id);
      return { id, deleted: true };
    },
  },

  'material.deleteMaterial': {
    kind: 'mutation',
    input: z.object({ id: z.string() }).passthrough(),
    handler: ({ id }, { user }) => {
      run('DELETE FROM material_entries WHERE material_id IN (SELECT id FROM materials WHERE id=? AND user_id=?)', id, user.id);
      run('DELETE FROM materials WHERE id=? AND user_id=?', id, user.id);
      return { id, deleted: true };
    },
  },

  'material.generateEntries': {
    kind: 'mutation',
    input: z.object({ materialId: z.string() }).passthrough(),
    handler: async ({ materialId }, { user }) => {
      const m = one('SELECT * FROM materials WHERE id=? AND user_id=?', materialId, user.id);
      if (!m) throw new TRPCError('资料不存在', 'NOT_FOUND');
      // 真模型：资料 → 问答对；失败直接报错
      let llm = null;
      try {
        llm = await generateMaterialEntries({ material: m, max: 5 });
      } catch (e) {
        throw new TRPCError(`问答对生成失败：${e.message}`, 'INTERNAL_SERVER_ERROR');
      }
      let pairs = llm;
      let source = 'model';
      if (!pairs) {
        // mock 模式替身：本地规则拆分
        source = 'rule';
        const facts = String(m.content || m.name).split(/[。\n]/).map((s) => s.trim()).filter((s) => s.length > 8).slice(0, 5);
        pairs = (facts.length ? facts : [`关于「${m.name}」的核心背景`]).map((fact) => ({
          question: `请介绍${m.name}相关的：${fact.slice(0, 24)}`,
          answer: `${fact}。这块我负责的是核心链路，落地时按「口径先对齐 → 方案取舍 → 灰度验证」三步走。`,
        }));
      }
      const created = [];
      for (const p of pairs) {
        const eid = cuid();
        run('INSERT INTO material_entries(id,material_id,question,answer,source,created_at) VALUES(?,?,?,?,?,?)',
          eid, materialId, p.question, p.answer, source === 'model' ? 'generated' : 'rule', nowIso());
        created.push({ id: eid, materialId, question: p.question, answer: p.answer, source: source === 'model' ? 'generated' : 'rule' });
      }
      return { materialId, entries: created, source };
    },
  },

  'material.importEntries': {
    kind: 'mutation',
    input: z.object({ materialId: z.string(), entries: z.array(z.object({ question: z.string(), answer: z.string().optional() }).passthrough()).default([]) }).passthrough(),
    handler: ({ materialId, entries }, { user }) => {
      const m = one('SELECT * FROM materials WHERE id=? AND user_id=?', materialId, user.id);
      if (!m) throw new TRPCError('资料不存在', 'NOT_FOUND');
      const out = [];
      for (const e of entries.slice(0, 200)) {
        const eid = cuid();
        run('INSERT INTO material_entries(id,material_id,question,answer,source,created_at) VALUES(?,?,?,?,?,?)',
          eid, materialId, e.question, e.answer || '', 'imported', nowIso());
        out.push({ id: eid, question: e.question, answer: e.answer || '' });
      }
      return { materialId, imported: out.length, entries: out };
    },
  },

  'material.uploadMaterialFile': {
    kind: 'mutation',
    input: z.object({ fileKey: z.string(), fileName: z.string().optional() }).passthrough(),
    handler: ({ fileKey, fileName = 'material.txt' }, { user }) => {
      const up = one('SELECT * FROM uploads WHERE key=?', fileKey);
      if (!up) throw new TRPCError('上传文件不存在', 'NOT_FOUND');
      const buf = fs.readFileSync(up.file_path);
      const text = extractText(buf, fileName || up.name || '');
      if (!text || text.trim().length < 10) {
        throw new TRPCError('文件内容无法解析为文本（图片类暂不支持转为资料）', 'BAD_REQUEST');
      }
      const mid = cuid();
      run('INSERT INTO materials(id,user_id,name,content,created_at) VALUES(?,?,?,?,?)',
        mid, user.id, fileName.replace(/\.\w+$/, ''), text.slice(0, 60000), nowIso());
      return { id: mid, name: fileName, contentChars: text.length };
    },
  },

  'material.listOfficialLibraries': {
    kind: 'query', input: pass.optional(),
    handler: () => all('SELECT * FROM official_libraries ORDER BY id ASC')
      .map((l) => ({ id: l.id, name: l.name, description: l.description, category: l.category, entryCount: l.entry_count, createdAt: l.created_at })),
  },

  'material.getOfficialLibrary': {
    kind: 'query',
    input: z.object({ root: z.string() }).passthrough(),
    handler: ({ root }) => {
      const lib = one('SELECT * FROM official_libraries WHERE id=?', root);
      if (!lib) throw new TRPCError('官方资料库不存在', 'NOT_FOUND');
      const entries = all('SELECT * FROM official_library_entries WHERE library_id=? ORDER BY rowid ASC LIMIT 200', root)
        .map((e) => ({ id: e.id, question: e.question, answer: e.answer }));
      return { id: lib.id, name: lib.name, description: lib.description, entryCount: lib.entry_count, entries };
    },
  },

  'upload.getPostObjectSignature': {
    kind: 'mutation', input: pass.optional(),
    handler: () => ({
      success: true,
      key: `local/${cuid(18)}`,
      data: {
        // 原版 OSS 直传契约：m = `${uploadPrefix}${f}_${p}`，随后 POST 到 endpoint
        uploadPrefix: 'local/',
        endpoint: '/upload',
        uploadEndpoint: '/upload',
        policy: 'local-dev',
        accessKeyId: 'LOCAL',
        signature: 'local-dev-signature',
        host: '',
        maxFileSize: 20 * 1024 * 1024,
      },
    }),
  },
};
