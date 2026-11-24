/**
 * 运行时设置中心（一级来源优先级：人工调用 settings.<section>.set > .env > 出厂默认）。
 * 设计要点：
 *  1. 只做「覆盖」不搬家——.env 仍是默认值，DB 里只存用户改过的字段，
 *     所以删掉 data/app.db 或调用 settings.<section>.reset 就能回到 .env 行为。
 *  2. 写入即热切换：config.ai / config.asr 是活对象，pipeline/provider/asr 每次调用都读它，
 *     不需要重启进程（对齐 RUN.md 里「改 .env 要重启」的旧边界）。
 *  3. API Key 永不回传明文：只回 hasKey + 掩码，空字符串表示「保留原值」。
 *
 * section：
 *  - ai ：对话/答题引擎（mock | openai，任意 OpenAI 兼容网关）
 *  - asr：语音识别（mock | qianwen，chat/completions + input_audio 整句转写）
 */
import { one, run } from './db.js';
import { config } from './config.js';
import { nowIso, fromJson } from './util.js';
import dns from 'node:dns/promises';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const AI_PROVIDERS = ['mock', 'openai'];
export const ASR_PROVIDERS = ['mock', 'qianwen'];

/* P1：API Key 落库前用 AES-256-GCM 加密（密钥在数据目录 .keyring，0600），
 * 避免直接读 SQLite 就拿到明文；本机同用户的进程仍可解密（本地单机应用的边界）。 */
function keyring() {
  const file = path.join(config.dataDir, '.keyring');
  try {
    if (fs.existsSync(file)) {
      const hex = fs.readFileSync(file, 'utf8').trim();
      if (/^[0-9a-f]{64}$/i.test(hex)) return Buffer.from(hex, 'hex');
    }
  } catch { /* 读取失败：重建 */ }
  const key = crypto.randomBytes(32);
  try {
    fs.writeFileSync(file, key.toString('hex'), { mode: 0o600 });
  } catch (e) {
    console.warn('[settings] 密钥环写入失败，Key 将以密文形式保存在内存密钥下:', e.message);
  }
  return key;
}
const KEYRING = keyring();

function encryptSecret(plain) {
  if (!plain || typeof plain !== 'string') return plain;
  if (plain.startsWith('enc:v1:')) return plain;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEYRING, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `enc:v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
}
function decryptSecret(v) {
  if (typeof v !== 'string' || !v.startsWith('enc:v1:')) return v;
  try {
    const parts = v.split(':');
    const d = crypto.createDecipheriv('aes-256-gcm', KEYRING, Buffer.from(parts[2], 'base64'));
    d.setAuthTag(Buffer.from(parts[3], 'base64'));
    return Buffer.concat([d.update(Buffer.from(parts[4], 'base64')), d.final()]).toString('utf8');
  } catch {
    return ''; // 密钥环丢失/损坏：按无 Key 处理，绝不把乱码当 Key 发出去
  }
}

/* P1：探测目标的 SSRF 防护——仅 http/https，解析结果不得是环回/私网/链路本地（含云元数据） */
function ipBlocked(ip) {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
    const o = ip.split('.').map(Number);
    if (o[0] === 127 || o[0] === 10) return true;
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;
    if (o[0] === 192 && o[1] === 168) return true;
    if (o[0] === 169 && o[1] === 254) return true;
    if (o[0] === 0 || o[0] >= 224) return true;
    return false;
  }
  const v6 = String(ip).toLowerCase();
  if (v6 === '::1' || v6 === '::') return true;
  if (/^fe[89ab]/.test(v6) || /^f[cd]/.test(v6)) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  return mapped ? ipBlocked(mapped[1]) : false;
}

async function assertProbeTarget(baseUrl, label) {
  let u;
  try {
    u = new URL(baseUrl);
  } catch {
    throw new Error(`${label} 不是合法 URL`);
  }
  if (!/^https?:$/.test(u.protocol)) throw new Error(`${label} 只支持 http / https`);
  let infos;
  try {
    infos = await dns.lookup(u.hostname, { all: true });
  } catch {
    throw new Error(`${label} 域名解析失败`);
  }
  if (!infos.length) throw new Error(`${label} 域名解析失败`);
  for (const { address } of infos) {
    if (ipBlocked(address)) throw new Error(`${label} 不能指向内网/本机/链路本地地址（安全限制）`);
  }
}

const maskKey = (k) => {
  if (!k) return '';
  if (k.length <= 8) return `***${k.slice(-2)}`;
  return `${k.slice(0, 4)}***${k.slice(-4)}`;
};

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function row(key) {
  return one('SELECT * FROM app_settings WHERE key=?', key);
}

function readSaved(key) {
  const saved = fromJson(row(key)?.value, {}) || {};
  if (typeof saved.apiKey === 'string' && saved.apiKey.startsWith('enc:v1:')) {
    saved.apiKey = decryptSecret(saved.apiKey);
  }
  return saved;
}

function writeSaved(key, merged) {
  const stored = { ...merged };
  if (typeof stored.apiKey === 'string' && stored.apiKey) {
    stored.apiKey = encryptSecret(stored.apiKey);
  }
  run(
    'INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at',
    key, JSON.stringify(stored), nowIso(),
  );
}

/** 共用：baseUrl 校验（http/https，去尾斜杠） */
function cleanBaseUrl(raw) {
  const v = String(raw ?? '').trim().replace(/\/+$/, '');
  if (!v) return undefined;
  let u;
  try {
    u = new URL(v);
  } catch {
    throw new Error('baseUrl 不是合法 URL（例：https://api.openai.com/v1）');
  }
  if (!/^https?:$/.test(u.protocol)) throw new Error('baseUrl 只支持 http / https');
  return v;
}

function cleanProvider(name, v, allowed) {
  const p = String(v).trim().toLowerCase();
  if (!allowed.includes(p)) throw new Error(`provider 只能是 ${allowed.join(' / ')}`);
  return p;
}

function cleanInt(v, min, max, label) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${label} 需要在 ${min} ~ ${max} 之间（整数）`);
  return n;
}

async function fetchTimeout(url, init = {}, ms = 10_000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    // P1：探测请求不跟随重定向（避免被 302 带到内网/其它主机）
    return await fetch(url, { ...init, redirect: 'manual', signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** best-effort 拉模型目录（有的网关不实现 /models，不算致命） */
async function probeModels(base, apiKey, checks) {
  try {
    const r = await fetchTimeout(`${base}/models`, { headers: { authorization: `Bearer ${apiKey}` } }, 8000);
    if (r.ok) {
      const j = await r.json().catch(() => ({}));
      const models = (j.data || j.models || []).map((m) => (typeof m === 'string' ? m : m?.id)).filter(Boolean);
      checks.push({ name: 'models', ok: true, detail: `GET /models 成功，可用模型 ${models.length} 个` });
      return models;
    }
    const t = (await r.text().catch(() => '')).slice(0, 300);
    checks.push({ name: 'models', ok: false, detail: `GET /models → ${r.status} ${t}`.trim() });
    return [];
  } catch (e) {
    checks.push({ name: 'models', ok: false, detail: `GET /models 不可用（${e.name === 'AbortError' ? '超时 8s' : e.message}），继续测主接口` });
    return [];
  }
}

/* ─────────────────────────── AI（对话/答题） ─────────────────────────── */

const AI_FIELDS = ['provider', 'baseUrl', 'apiKey', 'model', 'visionModel', 'temperature'];
/** 进程启动时的 .env 基线：reset 时用来还原 */
const aiBaseline = { ...config.ai };

export function savedAI() {
  return readSaved('ai');
}

/** 字段级校验 + 归一化；只返回用户真正传了的字段 */
export function sanitizeAI(patch = {}) {
  const out = {};
  if (patch.provider !== undefined && patch.provider !== null && patch.provider !== '') {
    out.provider = cleanProvider('ai', patch.provider, AI_PROVIDERS);
  }
  if (patch.baseUrl !== undefined) {
    const b = cleanBaseUrl(patch.baseUrl);
    if (b) out.baseUrl = b;
  }
  for (const f of ['model', 'visionModel']) {
    if (patch[f] !== undefined) {
      const v = String(patch[f] ?? '').trim();
      if (v) out[f] = v;
    }
  }
  if (patch.temperature !== undefined && patch.temperature !== null && patch.temperature !== '') {
    const t = Number(patch.temperature);
    if (!Number.isFinite(t) || t < 0 || t > 2) throw new Error('temperature 需要在 0 ~ 2 之间');
    out.temperature = t;
  }
  if (patch.clearApiKey) {
    out.apiKey = '';
  } else if (typeof patch.apiKey === 'string' && patch.apiKey.trim()) {
    out.apiKey = patch.apiKey.trim();
  }
  return out;
}

/** 把 DB 里的覆盖值刷进活对象 config.ai（幂等） */
export function applySavedAI() {
  const saved = savedAI();
  for (const f of AI_FIELDS) if (has(saved, f)) config.ai[f] = saved[f];
  return config.ai;
}

/** 前端展示用视图：明文 key 不出服务端 */
export function aiSnapshot() {
  const saved = savedAI();
  return {
    provider: config.ai.provider,
    baseUrl: config.ai.baseUrl,
    model: config.ai.model,
    visionModel: config.ai.visionModel,
    temperature: config.ai.temperature,
    hasKey: Boolean(config.ai.apiKey),
    apiKeyMasked: maskKey(config.ai.apiKey),
    source: Object.keys(saved).length ? 'settings' : 'env',
    savedKeys: Object.keys(saved),
    updatedAt: row('ai')?.updated_at || null,
    envBaseline: {
      provider: aiBaseline.provider,
      baseUrl: aiBaseline.baseUrl,
      model: aiBaseline.model,
      visionModel: aiBaseline.visionModel,
    },
  };
}

export function saveAI(patch = {}) {
  const clean = sanitizeAI(patch);
  if (!Object.keys(clean).length) throw new Error('没有需要保存的字段');
  const merged = { ...savedAI(), ...clean };
  // 组合校验：切 openai 必须能拿到 key（本次传入或已有）
  const nextProvider = merged.provider ?? config.ai.provider;
  if (AI_PROVIDERS.includes(nextProvider) && nextProvider !== 'mock') {
    const key = has(merged, 'apiKey') ? merged.apiKey : config.ai.apiKey;
    if (!key) throw new Error(`provider=${nextProvider} 需要先填 API Key`);
  }
  writeSaved('ai', merged);
  applySavedAI();
  return aiSnapshot();
}

/** 回到 .env 基线（删掉 DB 覆盖） */
export function resetAI() {
  run('DELETE FROM app_settings WHERE key=?', 'ai');
  Object.assign(config.ai, aiBaseline);
  return aiSnapshot();
}

/**
 * 连通性自检：验 key + 验 endpoint + 验模型名（真发一次 1-token 请求，不落库）。
 * 输入可带未保存的表单值，便于「先测后存」。
 */
export async function probeAI(input = {}) {
  const clean = sanitizeAI(input);
  const cand = { ...config.ai, ...clean };
  const checks = [];
  if (cand.provider !== 'openai') {
    return {
      ok: true, provider: cand.provider, baseUrl: cand.baseUrl, model: cand.model,
      latencyMs: 0, reply: null, models: [],
      checks: [{ name: 'provider', ok: true, detail: `provider=${cand.provider}，离线确定性大脑，无需外网` }],
    };
  }
  const base = String(cand.baseUrl || '').replace(/\/+$/, '');
  if (!base) return { ok: false, provider: 'openai', error: 'baseUrl 为空', checks };
  if (!cand.apiKey) return { ok: false, provider: 'openai', error: 'API Key 为空', checks };
  // P1：换了网关地址又没重新填 Key 时，拒绝把已保存的 Key 发往新地址（防密钥外泄）
  if (clean.baseUrl && clean.baseUrl !== String(config.ai.baseUrl || '').replace(/\/+$/, '') && !input.apiKey) {
    throw new Error('更换网关地址时必须同时填写 API Key（不会把已保存的 Key 发往新地址）');
  }
  await assertProbeTarget(base, 'baseUrl');

  const headers = { 'content-type': 'application/json', authorization: `Bearer ${cand.apiKey}` };
  const models = await probeModels(base, cand.apiKey, checks);

  const started = Date.now();
  try {
    const r = await fetchTimeout(`${base}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: cand.model,
        messages: [{ role: 'user', content: 'ping（连通性自检，请只回 ok）' }],
        max_tokens: 8,
        temperature: 0,
        stream: false,
        enable_thinking: false,
      }),
    }, 15_000);
    const latencyMs = Date.now() - started;
    const body = await r.text().catch(() => '');
    if (!r.ok) {
      checks.push({ name: 'chat', ok: false, detail: `POST /chat/completions → ${r.status} ${body.slice(0, 300)}` });
      return { ok: false, provider: 'openai', baseUrl: base, model: cand.model, latencyMs, models, checks, error: `上游 ${r.status}` };
    }
    let reply = '';
    try {
      const j = JSON.parse(body);
      reply = j.choices?.[0]?.message?.content ?? j.choices?.[0]?.text ?? '';
    } catch {
      reply = body.slice(0, 120);
    }
    checks.push({ name: 'chat', ok: true, detail: `POST /chat/completions 成功（${latencyMs}ms，${reply.length} 字符）` });
    const modelKnown = models.length ? models.includes(cand.model) : null;
    if (modelKnown === false) checks.push({ name: 'model', ok: false, detail: `/models 列表里没有 ${cand.model}，但补全可用（网关可能不下发目录）` });
    return { ok: true, provider: 'openai', baseUrl: base, model: cand.model, latencyMs, reply: String(reply).slice(0, 200), models: models.slice(0, 30), modelKnown, checks };
  } catch (e) {
    const latencyMs = Date.now() - started;
    const detail = e.name === 'AbortError' ? 'POST /chat/completions 超时（15s）' : `POST /chat/completions 失败：${e.message}`;
    checks.push({ name: 'chat', ok: false, detail });
    return { ok: false, provider: 'openai', baseUrl: base, model: cand.model, latencyMs, models, checks, error: e.message };
  }
}

/* ─────────────────────────── ASR（语音识别） ─────────────────────────── */

const ASR_FIELDS = ['provider', 'baseUrl', 'apiKey', 'model', 'silenceGateMs', 'maxUtteranceMs', 'sampleRate'];
const asrBaseline = { ...config.asr };

export function savedASR() {
  return readSaved('asr');
}

export function sanitizeASR(patch = {}) {
  const out = {};
  if (patch.provider !== undefined && patch.provider !== null && patch.provider !== '') {
    out.provider = cleanProvider('asr', patch.provider, ASR_PROVIDERS);
  }
  if (patch.baseUrl !== undefined) {
    const b = cleanBaseUrl(patch.baseUrl);
    if (b) out.baseUrl = b;
  }
  if (patch.model !== undefined) {
    const v = String(patch.model ?? '').trim();
    if (v) out.model = v;
  }
  if (patch.silenceGateMs !== undefined && patch.silenceGateMs !== null && patch.silenceGateMs !== '') {
    out.silenceGateMs = cleanInt(patch.silenceGateMs, 200, 6000, 'silenceGateMs');
  }
  if (patch.maxUtteranceMs !== undefined && patch.maxUtteranceMs !== null && patch.maxUtteranceMs !== '') {
    out.maxUtteranceMs = cleanInt(patch.maxUtteranceMs, 1000, 120_000, 'maxUtteranceMs');
  }
  if (patch.clearApiKey) {
    out.apiKey = '';
  } else if (typeof patch.apiKey === 'string' && patch.apiKey.trim()) {
    out.apiKey = patch.apiKey.trim();
  }
  return out;
}

export function applySavedASR() {
  const saved = savedASR();
  for (const f of ASR_FIELDS) if (has(saved, f)) config.asr[f] = saved[f];
  return config.asr;
}

export function asrSnapshot() {
  const saved = savedASR();
  const on = Boolean(config.asr.apiKey) && (config.asr.provider || 'qianwen') !== 'mock';
  return {
    provider: config.asr.provider,
    baseUrl: config.asr.baseUrl,
    model: config.asr.model,
    silenceGateMs: config.asr.silenceGateMs,
    maxUtteranceMs: config.asr.maxUtteranceMs,
    task: on ? 'real' : 'mock',
    hasKey: Boolean(config.asr.apiKey),
    apiKeyMasked: maskKey(config.asr.apiKey),
    source: Object.keys(saved).length ? 'settings' : 'env',
    savedKeys: Object.keys(saved),
    updatedAt: row('asr')?.updated_at || null,
    envBaseline: {
      provider: asrBaseline.provider,
      baseUrl: asrBaseline.baseUrl,
      model: asrBaseline.model,
    },
  };
}

export function saveASR(patch = {}) {
  const clean = sanitizeASR(patch);
  if (!Object.keys(clean).length) throw new Error('没有需要保存的字段');
  const merged = { ...savedASR(), ...clean };
  const nextProvider = merged.provider ?? config.asr.provider;
  if (nextProvider !== 'mock') {
    const key = has(merged, 'apiKey') ? merged.apiKey : config.asr.apiKey;
    if (!key) throw new Error(`provider=${nextProvider} 需要先填 API Key`);
  }
  writeSaved('asr', merged);
  applySavedASR();
  return asrSnapshot();
}

export function resetASR() {
  run('DELETE FROM app_settings WHERE key=?', 'asr');
  Object.assign(config.asr, asrBaseline);
  return asrSnapshot();
}

/** 0.4s 静音 PCM16（16k mono），仅用于自检请求体，不产生可识别语音 */
function silentPcm(ms = 400, sampleRate = 16_000) {
  return Buffer.alloc(Math.round((sampleRate * ms) / 1000) * 2);
}

function wavFromPcm(pcm, sampleRate = 16_000) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/**
 * ASR 连通性自检：真发一段 0.4s 静音 WAV 走 chat/completions + input_audio，
 * 验 key 权限、网关是否支持音频块、模型名是否存在。不落库、不改生效配置。
 */
export async function probeASR(input = {}) {
  const clean = sanitizeASR(input);
  const cand = { ...config.asr, ...clean };
  const checks = [];
  if ((cand.provider || 'qianwen') === 'mock') {
    return {
      ok: true, provider: 'mock', baseUrl: cand.baseUrl, model: 'mock',
      latencyMs: 0, text: null, models: [],
      checks: [{ name: 'provider', ok: true, detail: 'provider=mock，本地替身转写（stt.inject/stt.data 模拟）' }],
    };
  }
  const base = String(cand.baseUrl || '').replace(/\/+$/, '');
  if (!base) return { ok: false, provider: cand.provider, error: 'baseUrl 为空', checks };
  if (!cand.apiKey) return { ok: false, provider: cand.provider, error: 'API Key 为空', checks };
  // P1：更换网关地址又未填 Key 时，拒绝复用已保存 Key
  if (clean.baseUrl && clean.baseUrl !== String(config.asr.baseUrl || '').replace(/\/+$/, '') && !input.apiKey) {
    throw new Error('更换网关地址时必须同时填写 API Key（不会把已保存的 Key 发往新地址）');
  }
  await assertProbeTarget(base, 'baseUrl');

  const headers = { 'content-type': 'application/json', authorization: `Bearer ${cand.apiKey}` };
  const models = await probeModels(base, cand.apiKey, checks);

  const wav = wavFromPcm(silentPcm(400, 16_000), 16_000);
  const started = Date.now();
  try {
    const r = await fetchTimeout(`${base}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: cand.model,
        temperature: 0,
        enable_thinking: false,
        max_tokens: 16,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: '这是一段静音测试音频。只输出转写文本本身；若没有人声，输出空字符串。' },
            { type: 'input_audio', input_audio: { data: `data:audio/wav;base64,${wav.toString('base64')}` } },
          ],
        }],
      }),
    }, 20_000);
    const latencyMs = Date.now() - started;
    const body = await r.text().catch(() => '');
    if (!r.ok) {
      checks.push({ name: 'audio', ok: false, detail: `POST /chat/completions(input_audio) → ${r.status} ${body.slice(0, 300)}` });
      return { ok: false, provider: cand.provider, baseUrl: base, model: cand.model, latencyMs, models, checks, error: `上游 ${r.status}` };
    }
    let text = '';
    try {
      const j = JSON.parse(body);
      text = String(j.choices?.[0]?.message?.content ?? '');
    } catch {
      text = body.slice(0, 120);
    }
    checks.push({ name: 'audio', ok: true, detail: `input_audio 转写通道可用（${latencyMs}ms，返回 ${text.length} 字符）` });
    const modelKnown = models.length ? models.includes(cand.model) : null;
    if (modelKnown === false) checks.push({ name: 'model', ok: false, detail: `/models 列表里没有 ${cand.model}，但音频通道可用` });
    return { ok: true, provider: cand.provider, baseUrl: base, model: cand.model, latencyMs, text: text.slice(0, 200), models: models.slice(0, 30), modelKnown, checks };
  } catch (e) {
    const latencyMs = Date.now() - started;
    const detail = e.name === 'AbortError' ? 'POST /chat/completions 超时（20s）' : `POST /chat/completions 失败：${e.message}`;
    checks.push({ name: 'audio', ok: false, detail });
    return { ok: false, provider: cand.provider, baseUrl: base, model: cand.model, latencyMs, models, checks, error: e.message };
  }
}

/* ─────────────────────────── 启动装载 ─────────────────────────── */

/** 进程启动时调用：把上次在设置页保存的覆盖值生效（任一 section 失败不影响其它） */
export function bootSettings() {
  // P1：把历史明文 Key 迁移为密文
  for (const key of ['ai', 'asr']) {
    try {
      const r = row(key);
      if (!r) continue;
      const saved = fromJson(r.value, {});
      if (saved && typeof saved.apiKey === 'string' && saved.apiKey && !saved.apiKey.startsWith('enc:v1:')) {
        writeSaved(key, saved);
        console.log(`[settings] 已把 ${key} 的明文 API Key 迁移为加密存储`);
      }
    } catch (e) {
      console.warn(`[settings] ${key} 密钥迁移失败:`, e.message);
    }
  }
  for (const [name, apply] of [['ai', applySavedAI], ['asr', applySavedASR]]) {
    try {
      apply();
    } catch (e) {
      console.warn(`[settings] 读取 ${name} 覆盖失败，按 .env 基线运行:`, e.message);
    }
  }
  return { ai: config.ai, asr: config.asr };
}

/** 兼容旧调用名 */
export const bootAISettings = bootSettings;
