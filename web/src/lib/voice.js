/**
 * 语音采集（浏览器）：getUserMedia / getDisplayMedia → AudioWorklet 重采样到 16k →
 * PCM16 mono 帧 → socket.emit('stt.data', { data: <Uint8Array>, speakerId })。
 * 二进制帧（省 33% 带宽与编解码 CPU）；服务端同时兼容旧 base64 字符串。
 *
 * 用法：
 *   const stop = await startVoiceCapture({ socket, speakerId: 'self', onLevel, onError });
 *   stop();  // 停止采集并发送 stt.end
 *
 * system: true 时走 getDisplayMedia 共享音频（采集「面试官/系统声音」，Chromium 要求同时请求 video，
 * 采到后立即停掉 video 轨但保留 audio）。
 */

const WORKLET_SRC = `
class Pcm16Sender extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      const pcm = new Int16Array(ch.length);
      let sum = 0;
      for (let i = 0; i < ch.length; i++) {
        const s = Math.max(-1, Math.min(1, ch[i]));
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        sum += s * s;
      }
      this.port.postMessage({ pcm: pcm.buffer, level: Math.sqrt(sum / ch.length) }, [pcm.buffer]);
    }
    return true;
  }
}
registerProcessor('pcm16-sender', Pcm16Sender);
`;

function bufToB64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const STEP = 0x8000;
  for (let i = 0; i < bytes.length; i += STEP) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + STEP));
  return btoa(bin);
}

/** PCM 帧编码：优先二进制（socket.io 原生支持 TypedArray，省 33%）；不支持时回落 base64 */
const supportsBinary = (() => {
  try { return typeof Uint8Array === 'function' && Boolean(new Uint8Array(1)); } catch { return false; }
})();
const encodeFrame = (buf) => (supportsBinary ? new Uint8Array(buf) : bufToB64(buf));

export async function startVoiceCapture({ socket, speakerId = 'self', system = false, onLevel, onError } = {}) {
  if (!socket) throw new Error('socket 未连接');
  if (!navigator.mediaDevices) throw new Error('当前环境不支持媒体采集（需 Chromium 系浏览器或桌面端）');

  const ctx = new AudioContext({ sampleRate: 16000 });
  let moduleUrl = null;
  let stream = null;
  try {
    moduleUrl = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
    await ctx.audioWorklet.addModule(moduleUrl);

    if (system) {
      // 共享标签页/整个屏幕的声音（面试官说话声）；Chromium 要求 video:true 才允许音频
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: { echoCancellation: false, noiseSuppression: false } });
      if (stream.getAudioTracks().length === 0) {
        stream.getTracks().forEach((t) => t.stop());
        throw new Error('未选择共享音频：请勾选「共享标签页音频/系统音频」');
      }
      stream.getVideoTracks().forEach((t) => { t.stop(); stream.removeTrack(t); });
    } else {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    }
  } catch (e) {
    // P2：采集失败也要释放 AudioContext / Blob URL / 已拿到的媒体轨
    try { stream?.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
    try { await ctx.close(); } catch { /* ignore */ }
    if (moduleUrl) URL.revokeObjectURL(moduleUrl);
    onError?.(e?.message || String(e));
    throw e;
  }
  if (moduleUrl) URL.revokeObjectURL(moduleUrl);

  const src = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'pcm16-sender');
  src.connect(node); // 不连 destination：不需要回放

  let stopped = false;
  node.port.onmessage = (e) => {
    if (stopped) return;
    // P2：断线后不再发送音频帧（服务端已拒绝/重连中）
    if (socket.connected === false) return;
    const { pcm, level } = e.data;
    socket.emit('stt.data', { data: encodeFrame(pcm), speakerId });
    onLevel?.(level);
  };

  socket.emit('stt.start', { silenceGateMs: 2000, speakerId });

  const stop = () => {
    if (stopped) return;
    stopped = true;
    try {
      if (socket.connected !== false) socket.emit('stt.end', { speakerId });
    } catch { /* ignore */ }
    try { node.port.onmessage = null; node.disconnect(); src.disconnect(); } catch { /* ignore */ }
    stream.getTracks().forEach((t) => t.stop());
    ctx.close().catch(() => {});
    onLevel?.(0);
  };
  stream.getAudioTracks().forEach((t) => t.addEventListener('ended', stop));
  return stop;
}
