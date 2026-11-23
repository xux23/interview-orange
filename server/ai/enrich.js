/**
 * 模型增强层（P0/P1）：把原本的本地替身升级为真实模型调用，全部带兜底。
 *
 * 约定：每个函数在 provider=mock 或调用/解析失败时返回 null，
 * 调用方保留原有本地实现，因此离线模式行为不变。
 */
import zlib from 'node:zlib';
import { config } from '../config.js';
import { openaiComplete, providerName } from './provider.js';

const live = () => providerName() === 'openai' && Boolean(config.ai.apiKey);

/** 统一 JSON 调用：去 ```json 围栏 → 解析，失败按尾逗号修复重试 */
async function llmJson({ system, user, userContent, maxTokens = 1200, model }) {
  if (!live()) return null;
  const r = await openaiComplete({ system, messages: user ? [{ role: 'USER', content: user }] : [], userContent, maxTokens, model });
  const raw = String(r.text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  try {
    return JSON.parse(raw);
  } catch {
    const s = raw.indexOf('{');
    const e = raw.lastIndexOf('}');
    if (s < 0 || e <= s) return null;
    return JSON.parse(raw.slice(s, e + 1).replace(/,\s*([}\]])/g, '$1'));
  }
}

/* ───────────── 图片：BMP/PNG → 缩小 PNG（零依赖） ───────────── */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** RGBA 原始像素 → PNG buffer */
export function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * 24/32bpp 未压缩 BMP → 缩略 RGBA。
 * 容错：调用方可能传了被截断的 base64，这里只解已到达的行。
 */
export function bmpToThumb(buf, maxW = 96) {
  if (buf.length < 54 || buf[0] !== 0x42 || buf[1] !== 0x4d) return null;
  const dataOffset = buf.readUInt32LE(10);
  const width = buf.readInt32LE(18);
  const rawHeight = buf.readInt32LE(22);
  const bpp = buf.readUInt16LE(28);
  const compression = buf.readUInt32LE(30);
  if (width <= 0 || rawHeight === 0 || compression !== 0 || (bpp !== 24 && bpp !== 32)) return null;

  const bottomUp = rawHeight > 0;
  const height = Math.abs(rawHeight);
  const bytesPP = bpp / 8;
  const srcStride = Math.floor((width * bytesPP + 3) / 4) * 4;
  const rowsAvail = Math.max(0, Math.min(height, Math.floor((buf.length - dataOffset) / srcStride)));
  if (rowsAvail < 2) return null;

  const scale = Math.max(1, Math.ceil(width / maxW));
  const tw = Math.floor(width / scale);
  const th = Math.floor(rowsAvail / scale);
  if (tw < 2 || th < 2) return null;

  const out = Buffer.alloc(tw * th * 4);
  for (let ty = 0; ty < th; ty++) {
    const sy = ty * scale;
    const srcRow = bottomUp ? rowsAvail - 1 - sy : sy;
    if (srcRow < 0 || srcRow >= rowsAvail) continue;
    const rowStart = dataOffset + srcRow * srcStride;
    for (let tx = 0; tx < tw; tx++) {
      const sx = tx * scale;
      const p = rowStart + sx * bytesPP;
      if (p + 2 >= buf.length) continue;
      const o = (ty * tw + tx) * 4;
      out[o] = buf[p + 2];     // R
      out[o + 1] = buf[p + 1]; // G
      out[o + 2] = buf[p];     // B
      out[o + 3] = 255;
    }
  }
  return { width: tw, height: th, rgba: out };
}

/** 把前端传来的 dataURL/base64 转成适合视觉模型的小图 dataURL */
export function shrinkImageForVision(image, maxW = 96) {
  const s = String(image || '');
  const b64 = s.includes(',') ? s.slice(s.indexOf(',') + 1) : s;
  if (b64.length < 64) return null;
  let buf;
  try {
    buf = Buffer.from(b64, 'base64');
  } catch {
    return null;
  }
  // 已是 PNG（可能很小）：直接用
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50) {
    if (buf.length <= 512 * 1024) return `data:image/png;base64,${b64}`;
    return null;
  }
  const thumb = bmpToThumb(buf, maxW);
  if (!thumb) return null;
  const png = encodePng(thumb.width, thumb.height, thumb.rgba);
  return `data:image/png;base64,${png.toString('base64')}`;
}

/* ───────────── P1-1：视觉配色（overlay.suggestPalette） ───────────── */

const hex = (v, fallback) => (/^#[0-9a-fA-F]{6}$/.test(String(v || '')) ? String(v) : fallback);

export async function generatePalette({ image, mode = 'normal', current = {} }) {
  const small = shrinkImageForVision(image);
  if (!small) return null;
  const j = await llmJson({
    model: config.ai.visionModel,
    maxTokens: 400,
    system:
      '你是桌面配色采样器。看这张桌面截图，为主色系配一套「浮窗」配色，目标是让浮窗像壁纸的一部分（便于隐蔽）。' +
      '严格输出 JSON，不要解释：{"bg":"#RRGGBB","fg":"#RRGGBB","bgOpacity":0.8,"textOpacity":1,"textHalo":false,"theme":"light|dark"}' +
      '。bg 取截图主色调（可比原色略深/略浅）；fg 必须与 bg 有足够对比（浅色壁纸就给深色文字，反之给浅色）；' +
      'bgOpacity 在 0.6~0.95；textHalo 在背景复杂时为 true。',
    userContent: [
      { type: 'text', text: `模式：${mode}。当前配色：${JSON.stringify(current)}` },
      { type: 'image_url', image_url: { url: small } },
    ],
  });
  if (!j || !j.bg) return null;
  return {
    theme: j.theme === 'dark' ? 'dark' : 'light',
    paletteBg: hex(j.bg, '#ffffff'),
    paletteFg: hex(j.fg, '#1b1d21'),
    textHalo: Boolean(j.textHalo),
    bgOpacity: Math.min(0.98, Math.max(0.5, Number(j.bgOpacity) || 0.85)),
    textOpacity: Math.min(1, Math.max(0.6, Number(j.textOpacity) || 1)),
    mode,
    source: 'vision',
    applied: { ...current },
  };
}

/* ───────────── P1-2：语音转写（tools.stt.stt） ───────────── */

export async function transcribeAudio({ audioBase64, audioUrl }) {
  if (!config.asr.apiKey) return null;
  let buf = null;
  if (audioBase64) {
    const b64 = String(audioBase64).includes(',') ? String(audioBase64).split(',').pop() : String(audioBase64);
    buf = Buffer.from(b64, 'base64');
  } else if (audioUrl && /^https?:\/\//i.test(audioUrl)) {
    const r = await fetch(audioUrl);
    if (!r.ok) return null;
    buf = Buffer.from(await r.arrayBuffer());
  }
  if (!buf || buf.length < 1024) return null;

  // 非 WAV：按 16k PCM16 包装
  let wav = buf;
  const isWav = buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF';
  if (!isWav) {
    const { pcm16ToWav } = await import('./asr.js');
    wav = pcm16ToWav(buf, config.asr.sampleRate);
  }
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
          { type: 'text', text: '逐字转写音频中的人声语音，只输出转写文本，不要解释。' },
          { type: 'input_audio', input_audio: { data: `data:audio/wav;base64,${wav.toString('base64')}` } },
        ],
      }],
    }),
  });
  if (!res.ok) return null;
  const j = await res.json();
  const text = String(j.choices?.[0]?.message?.content ?? '').trim();
  if (!text) return null;
  return { text, model: j.model || config.asr.model };
}

/* ───────────── P1-3：岗位热词抽取（hotWords.ensureGoalHotWords） ───────────── */

export async function extractHotWords({ goal, resume }) {
  const j = await llmJson({
    maxTokens: 700,
    system:
      '你是面试语音识别（STT）的热词偏置器。根据岗位 JD 与候选人简历，抽出会在这场面里被说到的专业术语，' +
      '用于提升语音识别准确率。严格输出 JSON：{"hotWords":["类目1","类目2",...最多4个],"customHotWords":["术语",...20个]}' +
      '。术语要具体（如 gRPC、分库分表、MVCC），不要整句，不要重复，不要泛词（如 系统、业务）。',
    user: `岗位：${goal?.name || '技术岗'}\n岗位描述：${String(goal?.description || '').slice(0, 800)}\n简历：${String(resume?.content || resume?.title || '').slice(0, 2000)}`,
  });
  if (!j) return null;
  const custom = (j.customHotWords || []).map((s) => String(s).trim()).filter(Boolean).slice(0, 20);
  if (!custom.length) return null;
  return { hotWords: (j.hotWords || []).map((s) => String(s).trim()).filter(Boolean).slice(0, 4), customHotWords: custom };
}

/* ───────────── P1-4：岗位推荐（goal.suggestFromResume） ───────────── */

export async function suggestGoalsFromResume({ resume, facts }) {
  const j = await llmJson({
    maxTokens: 800,
    system:
      '你是求职顾问。根据简历内容推荐 3 个最匹配的目标岗位。严格输出 JSON：' +
      '{"suggestions":[{"name":"岗位名（含方向/技术栈）","companyName":"公司名","description":"一句话岗位要求，含 1-2 个技术点"}]}',
    user: `简历标题：${resume?.title || ''}\n技术栈/要点：${(facts?.techs || []).join('、')}\n年限：${facts?.years || '未标注'}\n简历正文：${String(resume?.content || '').slice(0, 3000)}`,
  });
  const list = (j?.suggestions || []).filter((s) => s?.name);
  if (!list.length) return null;
  return list.slice(0, 3).map((s) => ({
    name: String(s.name),
    companyName: String(s.companyName || ''),
    description: String(s.description || ''),
  }));
}

/* ───────────── P1-5：资料问答对生成（material.generateEntries） ───────────── */

export async function generateMaterialEntries({ material, max = 5 }) {
  const j = await llmJson({
    maxTokens: 1200,
    system:
      `你是面试资料整理员。把给定资料拆成最多 ${max} 组「面试官会问的问题 + 可直接念的回答」。` +
      '严格输出 JSON：{"entries":[{"question":"问题","answer":"回答（80-200字，第一句给结论）"}]}',
    user: `资料名称：${material?.name || ''}\n资料正文：${String(material?.content || '').slice(0, 4000)}`,
  });
  const list = (j?.entries || []).filter((e) => e?.question);
  if (!list.length) return null;
  return list.slice(0, max).map((e) => ({ question: String(e.question), answer: String(e.answer || '') }));
}

/* ───────────── P0：押题生成（questionPrediction.generate） ───────────── */

export async function generatePredictionItems({ goal, resume, bankRows = [], experience = '', count = 8 }) {
  const bankBrief = bankRows.slice(0, 40).map((q, i) => `${i + 1}. ${q.question_text}`).join('\n');
  const j = await llmJson({
    maxTokens: 2600,
    system:
      '你是面试押题引擎。结合岗位 JD、候选人简历与题库，预测这场面试最可能问到的题目，并写出解析。' +
      `严格输出 JSON：{"items":[{"title":"问题","category":"分类","probability":0到1的小数,"difficulty":"简单|中等|困难","reference":"参考答案要点（80-200字）","hotWords":["关键词"]}]}` +
      `，共 ${count} 题，probability 递减，题目不得重复。`,
    user:
      `岗位：${goal?.name || '技术岗'}\nJD：${String(goal?.description || '').slice(0, 800)}\n` +
      `简历：${String(resume?.content || resume?.title || '').slice(0, 2500)}\n经验：${experience || '未提供'}\n` +
      `题库参考（可改写、不要照抄）：\n${bankBrief}`,
  });
  const list = (j?.items || []).filter((x) => x?.title);
  if (!list.length) return null;
  return list.slice(0, count).map((x, i) => ({
    id: `pp-${Date.now().toString(36)}-${i}`,
    title: String(x.title),
    category: String(x.category || '通用'),
    probability: Math.min(0.99, Math.max(0.05, Number(x.probability) || 0.8 - i * 0.05)),
    difficulty: ['简单', '中等', '困难'].includes(x.difficulty) ? x.difficulty : '中等',
    hotWords: (x.hotWords || []).map(String).slice(0, 4),
    reference: String(x.reference || ''),
  }));
}
