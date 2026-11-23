import { z } from 'zod';
import { one, run, all } from '../db.js';
import { fromJson, toJson, nowIso } from '../util.js';
import { hashPassword, issueToken, verifyToken, bearer } from '../auth.js';
import { cuid } from '../util.js';
import { config, isPro } from '../config.js';
import { TRPCError } from './errors.js';

const pass = z.object({}).passthrough();

export function defaultClientSettings() {
  return {
    locale: 'zh-CN',
    theme: 'light',
    uiScale: 1,
    fontSize: 14,
    solverEnabled: true,
    solverSide: 'right',
    silenceGateMs: 2000,
    panicHotkey: 'Esc+Esc',
    stealth: { hideFromTaskbar: false, disguiseTitle: '' },
    overlayStyle: {
      theme: 'light', examBgOpacity: 0.85, interviewBgOpacity: 0.85,
      examTextOpacity: 1, interviewTextOpacity: 1,
      examBorderOpacity: 0, interviewBorderOpacity: 0,
      textHalo: true, textBold: false, fontScale: 1, scrollSpeed: 1,
      hotkeyOpacityStep: 0.1, examSolveHoverMs: 1200,
      examWidth: 420, examHeight: 520, interviewWidth: 400, interviewHeight: 620,
      paletteBg: '', paletteFg: '',
    },
  };
}

export function defaultExamCustomization() {
  return {
    preset: '', codeQuality: 'standard', customRequirements: '',
    questionType: '', mode: 'quick', instructionsPrompt: '', lang: 'zh-CN',
    showReasoning: true, showCopyCodeButton: true,
    showHotkeyHints: true, dualCamera: false,
  };
}

export function defaultInterviewPreference() {
  return {
    answerStyle: 'natural', customAnswerStyle: '', instructionsPrompt: '', promptFocus: '',
    assistMode: true, turnCards: true, newestFirst: false, answerFirst: false,
    followStreaming: true, followNewRound: true, autoAnswer: false,
    turnBudget: 8, basicsRatio: 0.4, skipIntro: false,
    lang: 'zh-CN', altLangs: [], translateLang: '',
    dualLangAnswer: false, enableReplay: false, webSearch: false,
    showHotkeyHints: true,
  };
}

export function toUserInfo(user) {
  if (!user) return null;
  const clientSettings = { ...defaultClientSettings(), ...(fromJson(user.client_settings, {}) || {}) };
  return {
    id: user.id,
    phone: user.phone,
    createdAt: user.created_at,
    countryCode: user.country_code,
    lastInterviewLang: user.last_interview_lang,
    asset: {
      subLevel: user.sub_level || 'TRIAL',
      subExpireAt: user.sub_expire_at,
      interviewTime: user.interview_time ?? 0,
      mockInterviewCount: user.mock_interview_count ?? 0,
      questionPredictionCount: user.question_prediction_count ?? 0,
      credits: user.credits ?? 0,
      isPro: isPro(user),
    },
    interviewPreference: { ...defaultInterviewPreference(), ...(fromJson(user.interview_preference, {}) || {}) },
    examCustomization: { ...defaultExamCustomization(), ...(fromJson(user.exam_customization, {}) || {}) },
    clientSettings,
  };
}

export function demoUser() {
  const user = one("SELECT * FROM users ORDER BY created_at ASC LIMIT 1");
  if (!user) throw new TRPCError('数据库未初始化：请先运行 npm run seed', 'INTERNAL_SERVER_ERROR');
  return user;
}

export default {
  'user.getTempToken': {
    kind: 'mutation',
    auth: false,
    input: z.object({ phone: z.string().optional(), token: z.string().optional() }).passthrough().optional(),
    handler: (input) => {
      const phone = input?.phone;
      const user = phone ? one('SELECT * FROM users WHERE phone=?', phone) : demoUser();
      if (!user) throw new TRPCError('用户不存在', 'NOT_FOUND');
      return { token: issueToken(user.id, 'temp'), expiresIn: 300 };
    },
  },

  'user.loginByTempToken': {
    kind: 'mutation',
    auth: false,
    input: z.object({
      token: z.string(),
      client: z.enum(['desktop', 'web', 'apply', 'apply-ext']).optional(),
      version: z.string().optional(),
      platform: z.enum(['win32', 'darwin', 'linux']).optional(),
    }).passthrough(),
    handler: ({ token, client = 'desktop', version = config.version, platform = 'win32' }) => {
      const payload = verifyToken(token);
      if (!payload) throw new TRPCError('临时令牌无效或已过期', 'UNAUTHORIZED');
      const user = one('SELECT * FROM users WHERE id=?', payload.userId);
      if (!user) throw new TRPCError('用户不存在', 'NOT_FOUND');
      return { token: issueToken(user.id, 'access'), client, version, platform, user: toUserInfo(user) };
    },
  },

  'user.register': {
    kind: 'mutation',
    auth: false,
    input: z.object({ phone: z.string().min(4), password: z.string().min(4).optional() }).passthrough(),
    handler: ({ phone, password = '' }) => {
      const exists = one('SELECT * FROM users WHERE phone=?', phone);
      if (exists) throw new TRPCError('手机号已注册', 'CONFLICT');
      const id = cuid();
      run(
        `INSERT INTO users(id, phone, password_hash, country_code, sub_level, interview_time,
          mock_interview_count, question_prediction_count, credits, interview_preference,
          exam_customization, client_settings, created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        id, phone, hashPassword(password), 'CN', 'TRIAL', 3, 1, 1, 0,
        toJson(defaultInterviewPreference()), toJson(defaultExamCustomization()), toJson(defaultClientSettings()), nowIso(),
      );
      run('INSERT INTO voiceprints(user_id, enrolled, status) VALUES(?,0,?)', id, 'available');
      return { token: issueToken(id, 'access'), user: toUserInfo(one('SELECT * FROM users WHERE id=?', id)) };
    },
  },

  'user.login': {
    kind: 'mutation',
    auth: false,
    input: z.object({ phone: z.string(), password: z.string().optional() }).passthrough(),
    handler: ({ phone, password = '' }) => {
      const user = one('SELECT * FROM users WHERE phone=?', phone);
      if (!user) throw new TRPCError('账号不存在', 'NOT_FOUND');
      if (user.password_hash && user.password_hash !== hashPassword(password)) {
        throw new TRPCError('密码不正确', 'UNAUTHORIZED');
      }
      return { token: issueToken(user.id, 'access'), user: toUserInfo(user) };
    },
  },

  'user.refreshToken': {
    kind: 'mutation',
    input: pass.optional(),
    handler: (_input, { user }) => {
      const iat = Math.floor(Date.now() / 1000);
      return { token: issueToken(user.id, 'access'), refreshedAt: nowIso(), iat };
    },
  },

  'user.getUserInfo': {
    kind: 'query', input: pass.optional(),
    handler: (_i, { user }) => toUserInfo(user),
  },

  'user.getVisitorConfig': {
    kind: 'query', auth: false, input: pass.optional(),
    handler: (_i, { headers }) => ({
      countryCode: 'CN',
      countryCodeSource: headers['x-forwarded-for'] ? 'ip' : 'default',
      locale: headers.locale || 'zh',
      region: 'china',
      apiBase: `http://${config.host}:${config.port}`,
    }),
  },

  'user.updateClientSettings': {
    kind: 'mutation', input: pass,
    handler: (input, { user }) => {
      const merged = { ...defaultClientSettings(), ...(fromJson(user.client_settings, {}) || {}), ...input };
      run('UPDATE users SET client_settings=? WHERE id=?', toJson(merged), user.id);
      return merged;
    },
  },

  'user.updateExamCustomization': {
    kind: 'mutation', input: pass,
    handler: (input, { user }) => {
      const merged = { ...defaultExamCustomization(), ...(fromJson(user.exam_customization, {}) || {}), ...input };
      run('UPDATE users SET exam_customization=? WHERE id=?', toJson(merged), user.id);
      return merged;
    },
  },

  'user.updateInterviewPreference': {
    kind: 'mutation', input: pass,
    handler: (input, { user }) => {
      const merged = { ...defaultInterviewPreference(), ...(fromJson(user.interview_preference, {}) || {}), ...input };
      run('UPDATE users SET interview_preference=? WHERE id=?', toJson(merged), user.id);
      return merged;
    },
  },
};
