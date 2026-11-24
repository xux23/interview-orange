/**
 * 模型增强层（P0/P1）：把原本的本地替身升级为真实模型调用。
 *
 * 约定：provider=mock 时返回 null，调用方走原有本地实现（离线模式主路径）；
 * provider=openai 时任何失败（网络/上游/输出不合法）直接抛错，由调用方报给前端——不做静默降级。
 */
import zlib from 'node:zlib';
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { config } from '../config.js';
import { openaiComplete, providerName } from './provider.js';

const live = () => providerName() === 'openai' && Boolean(config.ai.apiKey);

/** 统一 JSON 调用：mock 模式返回 null；openai 模式去 ```json 围栏 → 解析，失败按尾逗号修复重试，仍失败抛错 */
async function llmJson({ system, user, userContent, maxTokens = 1200, model }) {
  if (!live()) return null;
  const r = await openaiComplete({ system, messages: user ? [{ role: 'USER', content: user }] : [], userContent, maxTokens, model });
  const raw = String(r.text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  try {
    return JSON.parse(raw);
  } catch {
    const s = raw.indexOf('{');
    const e = raw.lastIndexOf('}');
    if (s < 0 || e <= s) throw new Error('模型未返回合法 JSON');
    try {
      return JSON.parse(raw.slice(s, e + 1).replace(/,\s*([}\]])/g, '$1'));
    } catch {
      throw new Error('模型输出不是合法 JSON');
    }
  }
}

/* ───────────── 图片：PNG/JPEG/WebP/BMP 嗅探与 BMP 转码（零依赖） ───────────── */

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

function jpegSize(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let p = 2;
  while (p + 8 < buf.length) {
    if (buf[p] !== 0xff) {
      p += 1;
      continue;
    }
    while (buf[p] === 0xff) p += 1;
    const marker = buf[p++];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xd9 || marker === 0xda || p + 2 > buf.length) break;
    const len = buf.readUInt16BE(p);
    if (len < 2 || p + len > buf.length) break;
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof && len >= 7) {
      const h = buf.readUInt16BE(p + 3);
      const w = buf.readUInt16BE(p + 5);
      return w && h ? { width: w, height: h } : null;
    }
    p += len;
  }
  return null;
}

function webpSize(buf) {
  if (buf.length < 30 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') return null;
  const kind = buf.toString('ascii', 12, 16);
  if (kind === 'VP8 ') {
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  if (kind === 'VP8L' && buf.length >= 25 && buf[20] === 0x2f) {
    const b = [buf[21], buf[22], buf[23], buf[24]];
    return {
      width: 1 + (((b[1] & 0x3f) << 8) | b[0]),
      height: 1 + (((b[3] & 0x0f) << 10) | (b[2] << 2) | ((b[1] & 0xc0) >> 6)),
    };
  }
  if (kind === 'VP8X' && buf.length >= 30) {
    const width = 1 + buf.readUIntLE(24, 3);
    const height = 1 + buf.readUIntLE(27, 3);
    return { width, height };
  }
  return null;
}

/** 按文件头识别截图格式，并读取像素宽高；无法识别返回 null */
export function sniffImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 16) return null;
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    if (buf.length < 24 || buf.toString('ascii', 12, 16) !== 'IHDR') return null;
    return { mime: 'image/png', ext: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  const jpeg = jpegSize(buf);
  if (jpeg) return { mime: 'image/jpeg', ext: 'jpg', ...jpeg };
  const webp = webpSize(buf);
  if (webp) return { mime: 'image/webp', ext: 'webp', ...webp };
  if (buf.length >= 30 && buf[0] === 0x42 && buf[1] === 0x4d) {
    const bpp = buf.readUInt16LE(28);
    const compression = buf.readUInt32LE(30);
    if (compression !== 0 || (bpp !== 24 && bpp !== 32)) return null;
    const width = buf.readInt32LE(18);
    const height = Math.abs(buf.readInt32LE(22));
    if (width <= 0 || height <= 0) return null;
    return { mime: 'image/bmp', ext: 'bmp', width, height };
  }
  return null;
}

function bmpInfo(buf) {
  if (buf.length < 54 || buf[0] !== 0x42 || buf[1] !== 0x4d) return null;
  const dataOffset = buf.readUInt32LE(10);
  const width = buf.readInt32LE(18);
  const rawHeight = buf.readInt32LE(22);
  const bpp = buf.readUInt16LE(28);
  const compression = buf.readUInt32LE(30);
  if (width <= 0 || rawHeight === 0 || compression !== 0 || (bpp !== 24 && bpp !== 32)) return null;
  if (dataOffset < 54 || dataOffset > buf.length) return null;
  const height = Math.abs(rawHeight);
  const bytesPP = bpp / 8;
  const srcStride = Math.floor((width * bytesPP + 3) / 4) * 4;
  if (srcStride <= 0 || width * height > 50_000_000) return null;
  const rowsAvail = Math.max(0, Math.min(height, Math.floor((buf.length - dataOffset) / srcStride)));
  return { dataOffset, width, height, rawHeight, bytesPP, srcStride, rowsAvail, bottomUp: rawHeight > 0 };
}

/** 未压缩 24/32bpp BMP → 全尺寸 PNG（笔试截图给视觉模型用） */
export function bmpToPng(buf) {
  const info = bmpInfo(buf);
  if (!info || info.rowsAvail < info.height || info.height < 2) return null;
  const { dataOffset, width, height, bytesPP, srcStride, bottomUp } = info;
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const srcRow = bottomUp ? height - 1 - y : y;
    const rowStart = dataOffset + srcRow * srcStride;
    for (let x = 0; x < width; x++) {
      const p = rowStart + x * bytesPP;
      const o = (y * width + x) * 4;
      rgba[o] = buf[p + 2];
      rgba[o + 1] = buf[p + 1];
      rgba[o + 2] = buf[p];
      rgba[o + 3] = 255;
    }
  }
  return { width, height, png: encodePng(width, height, rgba) };
}

/**
 * 把截图 buffer 转成视觉模型可用的 data URL。
 * PNG/JPEG/WebP 原样透传；BMP 转全尺寸 PNG（保留 OCR 所需清晰度）。
 */
export function imageForVision(buf) {
  const info = sniffImage(buf);
  if (!info || info.width < 16 || info.height < 16) return null;
  if (info.mime !== 'image/bmp') {
    return { mime: info.mime, width: info.width, height: info.height, url: `data:${info.mime};base64,${buf.toString('base64')}` };
  }
  const png = bmpToPng(buf);
  if (!png) return null;
  return { mime: 'image/png', width: png.width, height: png.height, url: `data:image/png;base64,${png.png.toString('base64')}` };
}

/**
 * 24/32bpp 未压缩 BMP → 缩略 RGBA。
 * 容错：调用方可能传了被截断的 base64，这里只解已到达的行。
 */
export function bmpToThumb(buf, maxW = 96) {
  const info = bmpInfo(buf);
  if (!info) return null;
  const { dataOffset, width, bytesPP, srcStride, rowsAvail, bottomUp } = info;
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
  const info = sniffImage(buf);
  // PNG/JPEG/WebP 且体积可控：直接交给视觉模型
  if (info && info.mime !== 'image/bmp' && buf.length <= 512 * 1024) return `data:${info.mime};base64,${b64}`;
  // 大图/原生 BMP：解码成缩略图，避免 IPC/请求体过大
  const thumb = bmpToThumb(buf, maxW);
  if (!thumb) return null;
  const png = encodePng(thumb.width, thumb.height, thumb.rgba);
  return `data:image/png;base64,${png.toString('base64')}`;
}

/* ───────────── P1-1：视觉配色（overlay.suggestPalette） ───────────── */

const hex = (v, fallback) => (/^#[0-9a-fA-F]{6}$/.test(String(v || '')) ? String(v) : fallback);

export async function generatePalette({ image, mode = 'normal', current = {} }) {
  if (!live()) return null;
  const small = shrinkImageForVision(image);
  if (!small) throw new Error('截图数据无法解析为图像（仅支持 PNG / 未压缩 BMP）');
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
  if (!j || !j.bg) throw new Error('模型未返回合法的配色 JSON');
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

const AUDIO_URL_LIMIT = 25 * 1024 * 1024; // 音频下载上限 25MB

/** 高危1：私网/环回/链路本地（含 169.254.169.254 元数据地址）/组播广播地址一律拒绝 */
function ipBlocked(ip) {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
    const o = ip.split('.').map(Number);
    if (o[0] === 127 || o[0] === 10) return true; // 127/8、10/8
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true; // 172.16/12
    if (o[0] === 192 && o[1] === 168) return true; // 192.168/16
    if (o[0] === 169 && o[1] === 254) return true; // 169.254/16（含云元数据）
    if (o[0] === 0 || o[0] >= 224) return true; // 0.0.0.0、组播/广播
    return false;
  }
  const v6 = String(ip).toLowerCase();
  if (v6 === '::1' || v6 === '::') return true;
  if (/^fe[89ab]/.test(v6)) return true; // fe80::/10 链路本地
  if (/^f[cd]/.test(v6)) return true; // fc00::/7 唯一本地
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6); // IPv4-mapped
  if (mapped) return ipBlocked(mapped[1]);
  return false;
}

/** 高危1 + P1：audioUrl 下载防 SSRF——仅 http(s)、dns.lookup 全量解析后逐个校验（解析后再校验，
 *  不信字面量）；连接以 lookup 固定到已校验的 IP（防 DNS rebinding）；15s 超时、拒绝重定向、
 *  25MB 封顶；错误信息不回显内网地址细节。 */
function fetchAudioSafe(rawUrl) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(String(rawUrl));
    } catch {
      reject(new Error('音频 URL 不合法'));
      return;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      reject(new Error('仅支持 http/https 音频地址'));
      return;
    }
    dns.lookup(u.hostname, { all: true }).then((infos) => {
      if (!infos.length) {
        reject(new Error('音频域名解析失败'));
        return;
      }
      for (const { address } of infos) {
        if (ipBlocked(address)) {
          reject(new Error('音频地址被拒绝（不允许访问内网/本地地址）'));
          return;
        }
      }
      // 固定到首个已校验解析结果：后续连接不会再走一次 DNS（防 rebinding）
      const pinned = infos[0];
      const client = u.protocol === 'https:' ? https : http;
      let settled = false;
      const fail = (msg) => {
        if (settled) return;
        settled = true;
        reject(new Error(msg));
      };
      const req = client.request(
        {
          protocol: u.protocol,
          hostname: u.hostname,
          port: u.port || undefined,
          path: `${u.pathname}${u.search}`,
          method: 'GET',
          lookup: (_h, _opts, cb) => cb(null, pinned.address, pinned.family),
          headers: { host: u.host, 'user-agent': 'interview-orange/1.0', accept: '*/*' },
          timeout: 15000,
        },
        (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400) {
            res.resume();
            req.destroy();
            fail('音频下载失败（重定向被拒绝）');
            return;
          }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            res.resume();
            req.destroy();
            fail(`音频下载失败（上游 ${res.statusCode}）`);
            return;
          }
          const declared = Number(res.headers['content-length'] || 0);
          if (declared > AUDIO_URL_LIMIT) {
            res.resume();
            req.destroy();
            fail('音频文件超过 25MB 上限');
            return;
          }
          const chunks = [];
          let total = 0;
          res.on('data', (c) => {
            total += c.length;
            if (total > AUDIO_URL_LIMIT) {
              req.destroy();
              fail('音频文件超过 25MB 上限');
              return;
            }
            chunks.push(c);
          });
          res.on('end', () => {
            if (settled) return;
            settled = true;
            resolve(Buffer.concat(chunks));
          });
          res.on('error', () => fail('音频下载失败（连接中断）'));
        },
      );
      req.on('timeout', () => {
        req.destroy();
        fail('音频下载失败（超时）');
      });
      req.on('error', () => fail('音频下载失败（超时或网络错误）'));
      req.end();
    }).catch(() => reject(new Error('音频域名解析失败')));
  });
}

export async function transcribeAudio({ audioBase64, audioUrl }) {
  if (!config.asr.apiKey) return null; // mock 模式：调用方走替身
  let buf = null;
  if (audioBase64) {
    const b64 = String(audioBase64).includes(',') ? String(audioBase64).split(',').pop() : String(audioBase64);
    buf = Buffer.from(b64, 'base64');
  } else if (audioUrl && /^https?:\/\//i.test(audioUrl)) {
    buf = await fetchAudioSafe(audioUrl);
  }
  if (!buf || buf.length < 1024) throw new Error('音频数据缺失或过短（<1KB）');

  // 非 WAV：按 16k PCM16 包装
  let wav = buf;
  const isWav = buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF';
  if (!isWav) {
    const { pcm16ToWav } = await import('./asr.js');
    wav = pcm16ToWav(buf, config.asr.sampleRate);
  }
  let res;
  try {
    res = await fetch(`${config.asr.baseUrl.replace(/\/$/, '')}/chat/completions`, {
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
  } catch (e) {
    throw new Error(`ASR 网关连接失败（${config.asr.baseUrl}）：${e?.cause?.message || e?.message || e}`);
  }
  if (!res.ok) throw new Error(`ASR 上游 ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  const text = String(j.choices?.[0]?.message?.content ?? '').trim();
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
  if (!j) return null; // mock 模式
  const custom = (j.customHotWords || []).map((s) => String(s).trim()).filter(Boolean).slice(0, 20);
  if (!custom.length) throw new Error('模型未抽取出任何热词术语');
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
  if (!j) return null; // mock 模式
  const list = (j.suggestions || []).filter((s) => s?.name);
  if (!list.length) throw new Error('模型未返回任何岗位推荐');
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
  if (!j) return null; // mock 模式
  const list = (j.entries || []).filter((e) => e?.question);
  if (!list.length) throw new Error('模型未生成任何问答对');
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
  if (!j) return null; // mock 模式
  const list = (j.items || []).filter((x) => x?.title);
  if (!list.length) throw new Error('模型未生成任何押题');
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
