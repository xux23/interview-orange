import crypto from 'node:crypto';
import { z } from 'zod';
import { one, all, run } from '../db.js';
import { fromJson, toJson, nowIso } from '../util.js';
import { cuid, rateLimit } from '../util.js';
import { config } from '../config.js';
import { TRPCError } from './errors.js';
import { interviewRun, promptAssist } from '../ai/pipeline.js';
import { generatePalette, transcribeAudio } from '../ai/enrich.js';
import { loadPresets, LANGS } from '../ai/prompts.js';

const pass = z.object({}).passthrough();

function presetsPayload(lang = 'zh-CN') {
  const p = loadPresets(lang);
  return {
    lang: p.lang,
    maxLength: p.maxLength || 20000,
    interviewStyles: (p.interview?.styles || []).map((s) => s.value),
    examStyles: (p.exam?.styles || []).map((s) => s.value),
    examPresets: p.examPresets || [],
    hasSaved: Boolean(p.interview?.saved),
    interview: {
      styles: p.interview?.styles || [],
      current: p.interview?.current || p.interview?.official || '',
      saved: p.interview?.saved || '',
      official: p.interview?.official || '',
      officialStyle: p.interview?.officialStyle || 'natural',
      officialUpdated: Boolean(p.interview?.officialUpdated),
      answerStyle: p.interview?.answerStyle || 'natural',
      customAnswerStyle: p.interview?.customAnswerStyle || '',
    },
    exam: {
      styles: p.exam?.styles || [],
      current: p.exam?.current || p.exam?.official || '',
      saved: p.exam?.saved || '',
      official: p.exam?.official || '',
      officialStyle: p.exam?.officialStyle || 'standard',
      codeQuality: p.exam?.codeQuality || 'standard',
      customRequirements: p.exam?.customRequirements || '',
    },
  };
}

export default {
  'promptStudio.presets': {
    kind: 'query',
    input: z.object({ lang: z.string().optional() }).passthrough().optional(),
    handler: (input = {}) => presetsPayload(LANGS.includes(input.lang) ? input.lang : 'zh-CN'),
  },

  'promptStudio.run': {
    kind: 'mutation',
    input: z.object({
      scene: z.enum(['interview', 'exam']),
      prompt: z.string().optional(),
      lang: z.string().optional(),
      question: z.string().optional(),
      resumeId: z.string().optional(),
      goalId: z.string().optional(),
      materialIds: z.array(z.string()).optional(),
      examPresetSlug: z.string().optional(),
      mode: z.string().optional(),
      answerStyle: z.string().optional(),
      customStyle: z.string().optional(),
    }).passthrough(),
    handler: async (input, { user }) => {
      if (!rateLimit(`run:${user.id}`, config.limits.interviewRunPerMinute)) {
        throw new TRPCError(`AI 试运行每分钟最多 ${config.limits.interviewRunPerMinute} 次，请稍后再试`, 'TOO_MANY_REQUESTS');
      }
      const provider = config.ai.provider;
      if (input.scene === 'exam') {
        const { examRun } = await import('../ai/pipeline.js');
        const res = await examRun({
          questionText: input.question || '',
          presetSlug: input.examPresetSlug,
          mode: input.mode,
          lang: input.lang || 'zh-CN',
        });
        return {
          scene: 'exam', systemPrompt: res.systemPrompt, answer: res.answer,
          ttftMs: 900, totalMs: 2600, error: null, answerLang: null,
          caseTitle: input.examPresetSlug || null, knowledge: null,
        };
      }
      const res = await interviewRun({
        userId: user.id,
        question: input.question || '请先做一个自我介绍',
        lang: input.lang || user.last_interview_lang || 'zh-CN',
        styleValue: input.answerStyle || 'natural',
        resumeId: input.resumeId,
        goalId: input.goalId,
        materialIds: input.materialIds,
        customStyle: input.customStyle,
      });
      return { ...res, provider };
    },
  },

  'promptStudio.assist': {
    kind: 'mutation',
    input: z.object({
      scene: z.enum(['interview', 'exam']).optional(),
      mode: z.enum(['sync', 'refine']).optional(),
      draft: z.string().optional(),
      lang: z.string().optional(),
      instruction: z.string().optional(),
    }).passthrough(),
    handler: async (input, { user }) => {
      if (!rateLimit(`assist:${user.id}`, config.limits.promptAssistPerMinute)) {
        throw new TRPCError(`AI 改写每分钟最多 ${config.limits.promptAssistPerMinute} 次，请稍后再试`, 'TOO_MANY_REQUESTS');
      }
      if (!input.instruction) throw new TRPCError('请先说明希望如何修改', 'BAD_REQUEST');
      return promptAssist({
        scene: input.scene || 'interview', mode: input.mode || 'refine',
        draft: input.draft || '', lang: input.lang || 'zh-CN', instruction: input.instruction,
      });
    },
  },

  'overlay.suggestPalette': {
    kind: 'mutation',
    input: z.object({ image: z.string(), mode: z.enum(['normal', 'dualCamera']).optional(), current: pass.optional() }).passthrough(),
    handler: async ({ image, mode = 'normal', current = {} }) => {
      // 真模型：视觉读壁纸 → 同色系底色 + 可读前景（文档 21 §2.6）
      const vision = await generatePalette({ image, mode, current }).catch((e) => {
        console.warn('[palette] 视觉配色失败，回退哈希采样:', e.message);
        return null;
      });
      if (vision) return vision;
      // 兜底：本地哈希采样（离线/视觉失败）
      const h = crypto.createHash('sha1').update(image.slice(0, 4096)).digest();
      const lum = (h[0] + h[1] + h[2]) / 765;
      const dark = lum < 0.5;
      return {
        theme: dark ? 'dark' : 'light',
        paletteBg: dark ? '#12161b' : '#f7f7f5',
        paletteFg: dark ? '#f2f4f6' : '#1a1c1e',
        textHalo: dark,
        bgOpacity: mode === 'dualCamera' ? 0.9 : 0.85,
        textOpacity: 1,
        mode,
        source: 'hash',
        sampled: { lum: Math.round(lum * 100) / 100, color: `#${h[0].toString(16).padStart(2, '0')}${h[1].toString(16).padStart(2, '0')}${h[2].toString(16).padStart(2, '0')}` },
        applied: { ...current },
      };
    },
  },

  'tools.stt.stt': {
    kind: 'mutation',
    input: z.object({ audioUrl: z.string().optional(), sessionId: z.string().optional(), audioBase64: z.string().optional() }).passthrough().optional(),
    handler: async (input = {}) => {
      // 真 ASR：audioBase64 / http(s) audioUrl → 转写（复用千问 ASR）
      const asr = await transcribeAudio({ audioBase64: input.audioBase64, audioUrl: input.audioUrl }).catch((e) => {
        console.warn('[tools.stt] 转写失败，回退替身:', e.message);
        return null;
      });
      if (asr) return { text: asr.text, confidence: 0.96, segmentCount: 1, model: asr.model, source: 'asr' };
      const samples = [
        '请先简单介绍一下你自己。',
        '你简历里提到的这个项目，你负责哪一块？',
        '这个接口的 P99 为什么这么高，你当时怎么排查的？',
        '你还有什么想问我的吗？',
      ];
      const seed = (input.audioUrl || input.sessionId || '').length;
      return { text: samples[seed % samples.length], confidence: 0.92, segmentCount: 1, source: 'stub' };
    },
  },

  'tools.tts.tts': {
    kind: 'mutation',
    input: z.object({ text: z.string(), sessionId: z.string().optional(), voice: z.string().optional() }).passthrough(),
    handler: ({ text }) => {
      // 生成 1 秒 8kHz 正弦 WAV（base64），前端可直接播放，替代云端 mp3
      const sr = 8000;
      const n = sr;
      const buf = Buffer.alloc(44 + n * 2);
      buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
      buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
      buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
      buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
      for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 180 * i) / sr) * 2000), 44 + i * 2);
      return { audio: buf.toString('base64'), mime: 'audio/wav', durationMs: 1000, text: String(text).slice(0, 4000) };
    },
  },

  'voiceprint.status': {
    kind: 'query', input: pass.optional(),
    handler: (_i, { user }) => {
      const v = one('SELECT * FROM voiceprints WHERE user_id=?', user.id);
      return { available: true, enrolled: Boolean(v?.enrolled), enrolledAt: v?.enrolled_at || null, status: 'available' };
    },
  },

  'voiceprint.enroll': {
    kind: 'mutation',
    input: z.object({ audioKey: z.string().optional() }).passthrough().optional(),
    handler: (_i, { user }) => {
      run(`INSERT INTO voiceprints(user_id,enrolled,enrolled_at,status) VALUES(?,1,?,?)
           ON CONFLICT(user_id) DO UPDATE SET enrolled=1, enrolled_at=excluded.enrolled_at, status='available'`,
        user.id, nowIso(), 'available');
      return { enrolled: true, enrolledAt: nowIso() };
    },
  },

  'voiceprint.verify': {
    kind: 'mutation',
    input: z.object({ audioKey: z.string().optional() }).passthrough().optional(),
    handler: () => ({ matched: true, score: 0.91 }),
  },

  'pay.createOrder': {
    kind: 'mutation',
    input: z.object({ id: z.string(), channel: z.enum(['wxpay', 'alipay_page', 'alipay_wap']), from: z.string().optional() }).passthrough(),
    handler: ({ id, channel, from = 'desktop' }, { user }) => {
      const sku = id || 'weekly';
      const orderId = cuid();
      const amount = ({ trial: 1000, standard: 4900, weekly: 2900, monthly: 9900, quarterly: 24900 }[sku] ?? 2900);
      run('INSERT INTO orders(id,user_id,sku,channel,status,amount,created_at) VALUES(?,?,?,?,?,?,?)',
        orderId, user.id, sku, channel, 'CREATED', amount, nowIso());
      return {
        orderNumber: `ML${Date.now()}${orderId.slice(-4)}`,
        checkoutUrl: `http://${config.host}:${config.port}/pay/mock?order=${orderId}&sku=${sku}&channel=${channel}&from=${from}`,
        amount, sku, channel,
      };
    },
  },

  'pay.mockConfirm': {
    kind: 'mutation',
    auth: false,
    input: z.object({ order: z.string(), sku: z.string().optional() }).passthrough(),
    handler: ({ order, sku = 'weekly' }) => {
      const row = one('SELECT * FROM orders WHERE id=?', order);
      if (!row) throw new TRPCError('订单不存在', 'NOT_FOUND');
      if (row.status === 'PAID') return { order, status: 'PAID', already: true };
      run("UPDATE orders SET status='PAID' WHERE id=?", order);
      // 生效权益：周卡 +60 分钟 / 月卡 +300 分钟（本地模拟）
      const addMinutes = { trial: 5, standard: 30, weekly: 60, monthly: 300, quarterly: 900 }[sku] ?? 60;
      const user = one('SELECT * FROM users WHERE id=?', row.user_id);
      if (user) {
        run('UPDATE users SET interview_time = interview_time + ? WHERE id=?', addMinutes, user.id);
      }
      return { order, status: 'PAID', sku, addedMinutes: addMinutes };
    },
  },

  'announcement.getActive': {
    kind: 'query', auth: false,
    input: z.object({ platform: z.enum(['windows', 'macos', 'linux']).optional() }).passthrough().optional(),
    handler: (input = {}) => {
      const row = one("SELECT * FROM announcements WHERE active=1 AND (platform IS NULL OR platform=? OR platform='') ORDER BY created_at DESC LIMIT 1", input.platform || 'windows');
      return row ? { id: row.id, title: row.title, content: row.content, platform: row.platform, createdAt: row.created_at } : null;
    },
  },

  'notice.getPendingNotice': {
    kind: 'query',
    input: z.object({ kinds: z.array(z.string()).optional() }).passthrough().optional(),
    handler: (input = {}, { user }) => {
      const kinds = input.kinds || ['usage-ack', 'compensation'];
      const row = one(`SELECT * FROM notices WHERE user_id=? AND ack=0 AND kind IN (${kinds.map(() => '?').join(',')}) ORDER BY created_at DESC LIMIT 1`, user.id, ...kinds);
      return row ? { id: row.id, kind: row.kind, payload: fromJson(row.payload, {}) } : null;
    },
  },

  'notice.ackNotice': {
    kind: 'mutation',
    input: z.object({ id: z.string() }).passthrough(),
    handler: ({ id }) => {
      run('UPDATE notices SET ack=1 WHERE id=?', id);
      return { id, ack: true };
    },
  },

  'desktopRelease.check': {
    kind: 'query', auth: false,
    input: z.object({ currentVersion: z.string().optional(), platform: z.enum(['win32', 'darwin', 'linux']).optional(), osVersion: z.string().optional() }).passthrough().optional(),
    handler: (input = {}) => ({
      hasUpdate: false,
      mustUpdate: false,
      latest: config.appVersion,
      currentVersion: input.currentVersion || config.appVersion,
      downloadUrl: null,
      releaseNotes: '本地独立环境版本：无外网更新通道。',
      hotpatch: null,
    }),
  },

  'desktopRelease.reportBootFailure': {
    kind: 'mutation',
    input: z.object({ hotpatchVersion: z.string().optional() }).passthrough().optional(),
    handler: (input = {}) => ({ received: true, quarantined: input.hotpatchVersion || null }),
  },

  'agentSession.list': {
    kind: 'query',
    input: z.object({ sessionId: z.string().optional(), agent: z.string().optional() }).passthrough().optional(),
    handler: (input = {}, { user }) => {
      const rows = input.sessionId
        ? all('SELECT * FROM agent_sessions WHERE session_id=? ORDER BY created_at ASC', input.sessionId)
        : all('SELECT a.* FROM agent_sessions a JOIN sessions s ON s.id=a.session_id WHERE s.user_id=? ORDER BY a.created_at DESC LIMIT 20', user.id);
      return rows.map((a) => ({ id: a.id, sessionId: a.session_id, agent: a.agent, status: a.status, data: fromJson(a.data, null), createdAt: a.created_at }));
    },
  },
};
