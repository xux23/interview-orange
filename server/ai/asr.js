/**
 * 语音识别（ASR）接入层。
 *
 * 上层契约：transcribe({ pcm, sampleRate }) → { text, ms, model }，输入 PCM16 mono 整句音频。
 *
 * provider：
 *   - qianwen：OpenAI 兼容网关 /chat/completions，音频走 content[].input_audio（data-URL 形式放 data 字段），
 *     模型默认 qwen3.8-omni-flash。实测中/英文转写正确；enable_thinking:false + temperature:0 下 ~1.2s/句。
 *   - mock：未配置 key 时的本地替身（由 socket.js 走旧行为），本模块不参与。
 *
 * VAD 辅助：帧能量（RMS/峰值）判定，供 socket.js 做切句。
 */
import { config } from '../config.js';

export const asrEnabled = () =>
  Boolean(config.asr.apiKey) && (config.asr.provider || 'qianwen') !== 'mock';

export const asrName = () => (asrEnabled() ? config.asr.model : 'mock');

/** 44 字节 RIFF/WAVE 头（PCM16 mono） */
function wavHeader(sampleRate, dataLen) {
  const b = Buffer.alloc(44);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(36 + dataLen, 4);
  b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii');
  b.writeUInt32LE(16, 16);          // PCM chunk size
  b.writeUInt16LE(1, 20);           // PCM
  b.writeUInt16LE(1, 22);           // mono
  b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(sampleRate * 2, 28); // byte rate = rate * 1ch * 2B
  b.writeUInt16LE(2, 32);           // block align
  b.writeUInt16LE(16, 34);          // bits
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(dataLen, 40);
  return b;
}

export function pcm16ToWav(pcm, sampleRate = config.asr.sampleRate) {
  return Buffer.concat([wavHeader(sampleRate, pcm.length), pcm]);
}

/** PCM16 帧的归一化峰值（0~1），用于 VAD 语音/静音判定 */
export function pcmPeak(pcm) {
  let peak = 0;
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    const v = Math.abs(pcm.readInt16LE(i));
    if (v > peak) peak = v;
  }
  return peak / 32768;
}

/** 整句转写（qwenwen 网关）。失败抛错，由调用方决定回退。 */
export async function transcribe({ pcm, sampleRate = config.asr.sampleRate } = {}) {
  if (!asrEnabled()) throw new Error('ML_ASR_API_KEY 未配置（asr provider=qianwen）');
  const started = Date.now();
  const wav = pcm16ToWav(pcm, sampleRate);
  const res = await fetch(`${config.asr.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.asr.apiKey}` },
    body: JSON.stringify({
      model: config.asr.model,
      temperature: 0,
      enable_thinking: false,
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: '逐字转写音频中的人声语音，保留原语言与口语原文（含语气词），只输出转写文本本身，不要任何解释或标点修饰。若音频里没有人声，只输出空字符串。' },
          { type: 'input_audio', input_audio: { data: `data:audio/wav;base64,${wav.toString('base64')}` } },
        ],
      }],
    }),
  });
  if (!res.ok) throw new Error(`ASR 上游 ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  const text = String(json.choices?.[0]?.message?.content ?? '').trim();
  return { text, ms: Date.now() - started, model: json.model || config.asr.model };
}
