/**
 * 窗口身份与浮窗桥：对齐 03 号文档的三窗口模型 + seq 门禁协议。
 * 浏览器实现用 BroadcastChannel 模拟 Tauri 的 emit/listen；原生壳可替换为 window.orangeNative。
 */
export function windowKind() {
  const raw = location.hash.replace(/^#/, '').split('?')[0];
  if (raw === 'overlay') return 'overlay';
  if (raw === 'mock') return 'mock';
  if (raw === 'mock-exam') return 'mock-exam';
  return 'main';
}
export const hashQuery = () => {
  const q = location.hash.split('?')[1] || '';
  return new URLSearchParams(q);
};

const CHANNEL = 'interview-orange-bus';
const SEQ_KEY = 'overlay.showSeq';
export const UI_VERSION = '0.3.25-clone.1';

const bus = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(CHANNEL) : null;
const listeners = new Set();

if (bus) {
  bus.onmessage = (ev) => {
    for (const fn of listeners) fn(ev.data || {});
  };
}

export function publish(msg) {
  bus?.postMessage(msg);
  for (const fn of listeners) fn({ ...msg, local: true });
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export const nextShowSeq = () => {
  const n = Number(localStorage.getItem(SEQ_KEY) || 0) + 1;
  localStorage.setItem(SEQ_KEY, String(n));
  return n;
};
export const currentShowSeq = () => Number(localStorage.getItem(SEQ_KEY) || 0);

/** 文档 01 §5：热更协议——主窗/浮窗互报 UI 版本，不一致即 reload 对齐 */
export function startUiVersionHandshake(kind) {
  const mine = UI_VERSION;
  publish({ type: 'ui-loaded', window: kind, version: mine });
  publish({ type: 'ui-version-request', window: kind });
  const off = subscribe((msg) => {
    if (msg.type === 'ui-loaded' && msg.window !== kind && msg.version && msg.version !== mine) {
      console.warn(`[hotpatch] ${kind} 版本 ${mine} ≠ ${msg.window} 版本 ${msg.version}，重载对齐`);
      setTimeout(() => location.reload(), 300);
    }
    if (msg.type === 'ui-version-request' && msg.window !== kind) {
      publish({ type: 'ui-loaded', window: kind, version: mine });
    }
  });
  return off;
}

/** 主窗侧：打开/复用浮窗，发 seq，等 sessionReady */
export const overlayWindow = {
  handle: null,
  seq: 0,
  mode: 'interview',
  timer: null,

  open({ mode = 'interview', sessionId = null, style = {} } = {}) {
    this.mode = mode;
    const w = Number(style.width || (mode === 'exam' ? 440 : 400));
    const h = Number(style.height || (mode === 'exam' ? 540 : 620));
    const features = `popup=1,width=${w},height=${h},left=${Math.max(0, screen.availWidth - w - 24)},top=60`;
    if (!this.handle || this.handle.closed) {
      this.handle = window.open(`${location.origin}${location.pathname}#overlay`, 'ml-overlay', features);
    }
    this.handle?.focus?.();
    this.seq = nextShowSeq();
    const payload = { type: 'overlay-shown', seq: this.seq, mode, sessionId, style };
    publish(payload);
    if (this.handle) {
      try { this.handle.postMessage(payload, location.origin); } catch { /* ignore */ }
    }
    clearInterval(this.timer);
    this.timer = setInterval(() => publish({ type: 'overlay-heartbeat' }), 5000);
    return this.seq;
  },

  hide() {
    publish({ type: 'overlay-hidden' });
    clearInterval(this.timer);
    this.timer = null;
  },

  setMode(mode) {
    this.mode = mode;
    publish({ type: 'overlay-mode', mode });
  },

  push(event) {
    publish(event);
    if (this.handle) {
      try { this.handle.postMessage(event, location.origin); } catch { /* ignore */ }
    }
  },

  close() {
    clearInterval(this.timer);
    publish({ type: 'overlay-hidden' });
    try { this.handle?.close?.(); } catch { /* ignore */ }
    this.handle = null;
  },
};

/** 浮窗侧：门禁状态机（seq 去重 + 心跳 + 三路激活 + sessionReady） */
export function createOverlayGate({ onActivate, onHide, onSessionReady, onMode }) {
  const state = { active: false, mode: null, seq: null, showSeq: null };
  let latestSeq = 0;
  let token = null; // 当前 showSeq 令牌
  let hiddenGen = 0;

  const activate = (msg) => {
    const seq = Number(msg.seq || 0);
    if (seq > 0 && latestSeq >= seq && state.active) return; // 去重
    latestSeq = Math.max(latestSeq, seq);
    token = seq || latestSeq;
    state.seq = latestSeq;
    state.showSeq = token;
    state.mode = msg.mode || localStorage.getItem('overlay.mode') || 'interview';
    localStorage.setItem('overlay.mode', state.mode);
    state.active = true;
    onMode?.(state.mode);
    onActivate?.({ ...state, sessionId: msg.sessionId || null, style: msg.style || null });
    if (state.mode === 'exam' || state.mode === 'interview') {
      publish({ type: 'overlay-session-ready', seq: token });
      onSessionReady?.({ seq: token, mode: state.mode });
    }
  };

  const hide = () => {
    token = null;
    hiddenGen += 1;
    state.active = false;
    onHide?.(state);
  };

  const off = subscribe((msg) => {
    if (msg.type === 'overlay-shown') activate(msg);
    else if (msg.type === 'overlay-hidden') hide();
    else if (msg.type === 'overlay-mode') {
      state.mode = msg.mode;
      onMode?.(msg.mode);
    } else if (msg.type === 'overlay-style') {
      onMode?.(state.mode, msg.style);
    } else if (msg.type === 'overlay-exam') {
      onMode?.(state.mode, null, msg);
    } else if (msg.type === 'overlay-ai') {
      onMode?.(state.mode, null, msg);
    }
  });

  // 兜底：订阅后主动拉一次当前 seq（主窗可能在本窗就绪前已 show）
  setTimeout(() => {
    publish({ type: 'overlayShowSeqRequest' });
    const seq = currentShowSeq();
    if (seq > 0 && !state.active) activate({ seq, mode: localStorage.getItem('overlay.mode'), style: null });
  }, 250);

  const heartbeat = setInterval(() => publish({ type: 'overlay-heartbeat', active: state.active }), 5000);

  return {
    state,
    close() {
      off();
      clearInterval(heartbeat);
    },
  };
}
