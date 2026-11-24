/**
 * 全局配置：独立环境（自带数据目录、自带端口、自带密钥），不读写任何外部安装。
 * 所有路径均相对项目根，可整目录搬迁。
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

function readDotEnv(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

const env = { ...readDotEnv(path.join(root, '.env')), ...process.env };

/** P2：数值配置校验——非法值回落到默认，避免 NaN 绕过上限/端口等约束 */
const num = (v, def, min = 1, max = Number.MAX_SAFE_INTEGER) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : def;
};

export const config = {
  version: 'interview-orange/1.0.0',
  appVersion: '1.0.0',
  port: num(env.ML_PORT, 8756, 1, 65535),
  host: env.ML_HOST || '127.0.0.1',
  dataDir: path.resolve(root, env.ML_DATA_DIR || 'data'),
  publicDir: path.resolve(root, 'public'),
  promptsDir: path.resolve(root, 'data/prompts'),
  screenshotsDir: path.resolve(root, env.ML_DATA_DIR || 'data', 'screenshots'),
  // P3：未显式配置时用每次启动随机 secret（不再使用可预测默认值）
  secret: env.ML_SECRET || crypto.randomBytes(32).toString('hex'),
  tokenTtlMs: 1000 * 60 * 60 * 24 * 7,
  // AI provider：mock（离线可用，默认）| openai（任意 OpenAI 兼容网关）
  ai: {
    // 只填 Key 即切真实模型：未显式指定 provider 时按 Key 是否存在自动选择
    provider: env.ML_AI_PROVIDER || (env.ML_AI_API_KEY ? 'openai' : 'mock'),
    baseUrl: env.ML_AI_BASE_URL || 'https://maas.qianwenaiapi.com/compatible-mode/v1',
    apiKey: env.ML_AI_API_KEY || '',
    model: env.ML_AI_MODEL || 'deepseek-v4.1-flash',
    temperature: num(env.ML_AI_TEMPERATURE, 0.6, 0, 2),
    // 视觉/多模态模型：笔试截图识别题面用（千问网关 omni 系列）；3.5-omni-flash 读题/解题延迟约为 3.8 的 1/3
    visionModel: env.ML_AI_VISION_MODEL || 'qwen3.5-omni-flash',
  },
  // ASR 语音识别：mock（本地替身，默认）| qianwen（OpenAI 兼容网关 chat/completions + input_audio 整句转写）
  // 选型实测（2026-11-24，maas.qianwenaiapi.com）：qwen3.5-omni-flash 708ms/句、qwen3.8-omni 924ms，均逐字全对；
  // 专用 ASR 模型（qwen-audio-3.0-asr-flash / fun-asr-flash）在 chat/completions 返回 400，realtime 类无 WS 入口，unisound 未激活，均排除。
  asr: {
    provider: env.ML_ASR_PROVIDER || (env.ML_ASR_API_KEY ? 'qianwen' : 'mock'),
    baseUrl: env.ML_ASR_BASE_URL || 'https://maas.qianwenaiapi.com/compatible-mode/v1',
    apiKey: env.ML_ASR_API_KEY || '',
    model: env.ML_ASR_MODEL || 'qwen3.5-omni-flash',
    sampleRate: num(env.ML_ASR_SAMPLE_RATE, 16000, 8000, 48000),
    silenceGateMs: num(env.ML_ASR_SILENCE_GATE_MS, 2000, 200, 6000),
    maxUtteranceMs: num(env.ML_ASR_MAX_UTTERANCE_MS, 30000, 1000, 120000),
  },
  // 模型/网关内置：默认锁定（用户只填 Key）；ML_LOCK_MODELS=0 可解锁供开发调试
  lockModels: env.ML_LOCK_MODELS !== '0',
  limits: {
    interviewRunPerMinute: 6,
    examRunPerMinute: 3,
    promptAssistPerMinute: 3,
    examMinutesPerSolve: 2,
  },
};

for (const dir of [config.dataDir, config.promptsDir, config.screenshotsDir]) {
  fs.mkdirSync(dir, { recursive: true });
}

/** @deprecated 账号模块已移除（2026-11-23）：订阅等级不再生效，保留仅为类型兼容 */
export const isPro = () => true;
