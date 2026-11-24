import { z } from 'zod';
import { one, run } from '../db.js';
import { fromJson, toJson, nowIso } from '../util.js';
import { config } from '../config.js';
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
      // 账号模块已移除：asset 字段仅为 /legacy 原版前端显示兼容
      subLevel: 'PRO',
      subExpireAt: null,
      interviewTime: 9999,
      mockInterviewCount: 9999,
      questionPredictionCount: 9999,
      credits: 0,
      isPro: true,
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
  /* ── 兼容桩（账号模块已移除，token 一律忽略；仅供 /legacy 原版前端与既有测试脚本保持协议形状） ── */
  'user.getTempToken': {
    kind: 'mutation',
    auth: false,
    input: z.object({ phone: z.string().optional(), token: z.string().optional() }).passthrough().optional(),
    handler: () => ({ token: 'local', expiresIn: 999999 }),
  },

  'user.loginByTempToken': {
    kind: 'mutation',
    auth: false,
    input: z.object({
      token: z.string().optional(),
      client: z.enum(['desktop', 'web', 'apply', 'apply-ext']).optional(),
      version: z.string().optional(),
      platform: z.enum(['win32', 'darwin', 'linux']).optional(),
    }).passthrough(),
    handler: ({ client = 'desktop', version = config.version, platform = 'win32' }) =>
      ({ token: 'local', client, version, platform, user: toUserInfo(demoUser()) }),
  },

  'user.refreshToken': {
    kind: 'mutation',
    input: pass.optional(),
    handler: () => ({ token: 'local', refreshedAt: nowIso(), iat: Math.floor(Date.now() / 1000) }),
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
