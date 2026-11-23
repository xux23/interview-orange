/**
 * 全局配置：独立环境（自带数据目录、自带端口、自带密钥），不读写任何外部安装。
 * 所有路径均相对项目根，可整目录搬迁。
 */
import fs from 'node:fs';
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

export const config = {
  version: 'interview-orange/1.0.0',
  appVersion: '1.0.0',
  port: Number(env.ML_PORT || 8756),
  host: env.ML_HOST || '127.0.0.1',
  dataDir: path.resolve(root, env.ML_DATA_DIR || 'data'),
  publicDir: path.resolve(root, 'public'),
  promptsDir: path.resolve(root, 'data/prompts'),
  screenshotsDir: path.resolve(root, env.ML_DATA_DIR || 'data', 'screenshots'),
  secret: env.ML_SECRET || 'interview-orange-local-dev-secret',
  tokenTtlMs: 1000 * 60 * 60 * 24 * 7,
  // AI provider：mock（离线可用，默认）| openai（任意 OpenAI 兼容网关）
  ai: {
    provider: env.ML_AI_PROVIDER || 'mock',
    baseUrl: env.ML_AI_BASE_URL || 'https://api.openai.com/v1',
    apiKey: env.ML_AI_API_KEY || '',
    model: env.ML_AI_MODEL || 'gpt-4o-mini',
    temperature: Number(env.ML_AI_TEMPERATURE || 0.6),
    // 视觉/多模态模型：笔试截图识别题面用（千问网关用 omni 系列）
    visionModel: env.ML_AI_VISION_MODEL || 'qwen3.8-omni-flash',
  },
  // ASR 语音识别：mock（本地替身，默认）| qianwen（OpenAI 兼容网关 chat/completions + input_audio 整句转写）
  // 选型实测（2026-11，maas.qianwenaiapi.com）：qwen3.8-omni-flash 中/英全对、~1.2s/句（enable_thinking:false+temperature:0）；
  // unisound/unisound-u2 产品未激活；qwen-audio-3.1-realtime-* 无 /realtime WS 入口，均排除。
  asr: {
    provider: env.ML_ASR_PROVIDER || (env.ML_ASR_API_KEY ? 'qianwen' : 'mock'),
    baseUrl: env.ML_ASR_BASE_URL || 'https://maas.qianwenaiapi.com/compatible-mode/v1',
    apiKey: env.ML_ASR_API_KEY || '',
    model: env.ML_ASR_MODEL || 'qwen3.8-omni-flash',
    sampleRate: Number(env.ML_ASR_SAMPLE_RATE || 16000),
    silenceGateMs: Number(env.ML_ASR_SILENCE_GATE_MS || 2000),
    maxUtteranceMs: Number(env.ML_ASR_MAX_UTTERANCE_MS || 30000),
  },
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

export const isPro = (user) =>
  user?.sub_level === 'PRO' && user?.sub_expire_at && Date.parse(user.sub_expire_at) > Date.now();
