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
  lastShown: null, // 最近一次 overlay-shown 载荷（浮窗晚加载错过广播时按请求补发）

  open({ mode = 'interview', sessionId = null, style = {} } = {}) {
    this.mode = mode;
    this.seq = nextShowSeq();
    const payload = { type: 'overlay-shown', seq: this.seq, mode, sessionId, style };
    this.lastShown = payload;
    const nat = window.orangeNative;
    if (nat?.showOverlay) {
      // 原生壳：显示预建的 overlay 窗口；seq 一并发给 Rust，保证 sessionReady 对得上
      try { nat.showOverlay({ mode, sessionId, seq: this.seq }); } catch { /* ignore */ }
    } else {
      const w = Number(style.width || (mode === 'exam' ? 440 : 400));
      const h = Number(style.height || (mode === 'exam' ? 540 : 620));
      const features = `popup=1,width=${w},height=${h},left=${Math.max(0, screen.availWidth - w - 24)},top=60`;
      if (!this.handle || this.handle.closed) {
        this.handle = window.open(`${location.origin}${location.pathname}#overlay`, 'ml-overlay', features);
      }
      this.handle?.focus?.();
    }
    publish(payload);
    clearInterval(this.timer);
    this.timer = setInterval(() => publish({ type: 'overlay-heartbeat' }), 5000);
    return this.seq;
  },

  hide() {
    this.lastShown = null;
    publish({ type: 'overlay-hidden' });
    try { window.orangeNative?.hideOverlay?.(); } catch { /* ignore */ }
    clearInterval(this.timer);
    this.timer = null;
  },

  setMode(mode) {
    this.mode = mode;
    publish({ type: 'overlay-mode', mode });
  },

  push(event) {
    publish(event);
  },

  close() {
    this.lastShown = null;
    clearInterval(this.timer);
    publish({ type: 'overlay-hidden' });
    try { window.orangeNative?.closeOverlay?.(); } catch { /* ignore */ }
    try { this.handle?.close?.(); } catch { /* ignore */ }
    this.handle = null;
  },
};

/* 浮窗晚于 overlay-shown 加载时（浏览器 window.open；BroadcastChannel 不回放），
 * 浮窗启动会发 overlayShowSeqRequest —— 主窗在此补发最近一次载荷（含 sessionId），
 * 否则浮窗只能走无 sessionId 的兜底激活，socket 永远连不上。 */
subscribe((msg) => {
  if (msg.type === 'overlayShowSeqRequest' && overlayWindow.lastShown) {
    publish(overlayWindow.lastShown);
  }
});

/** P1-4：原生壳的热键/焦点事件（window.__ORANGE_EMIT__ 派发的 'interview-orange'）
 *  转发到 bus，供各窗口 UI 订阅（native-hotkey 的自定义动作在此不再无人接收）。 */
export function startNativeEventBridge() {
  window.addEventListener('interview-orange', (ev) => {
    const d = ev.detail || {};
    if (d.event === 'native-hotkey') {
      console.info('[native-hotkey]', d.payload?.hotkey);
      publish({ type: 'native-hotkey', hotkey: d.payload?.hotkey });
    }
  });
}

/** 浮窗侧：门禁状态机（seq 去重 + 心跳 + 三路激活 + sessionReady） */
export function createOverlayGate({ onActivate, onHide, onSessionReady, onMode }) {
  const state = { active: false, mode: null, seq: null, showSeq: null, sessionId: null };
  let latestSeq = 0;
  let token = null; // 当前 showSeq 令牌
  let hiddenGen = 0;

  const activate = (msg) => {
    const seq = Number(msg.seq || 0);
    const sid = msg.sessionId || null;
    const mode = msg.mode || localStorage.getItem('overlay.mode') || 'interview';
    // P0-2 保护：浮窗已激活时收到「无 sessionId 且 mode 为 preview/缺失」的 overlay-shown
    // （显隐热键广播等），只当作窗口被重新显示——保持 mode/sessionId/卡片不变，不重新激活
    if (state.active && !sid && (msg.mode == null || msg.mode === 'preview')) {
      return;
    }
    // 去重只针对「同一次 show」；换了 sessionId / 模式必须重新激活，
    // 否则浏览器 seq 与原生 seq 不一致时新会话会被旧 seq 挡掉。
    if (seq > 0 && latestSeq >= seq && state.active && state.sessionId === sid && state.mode === mode) return;
    latestSeq = Math.max(latestSeq, seq);
    token = seq || latestSeq;
    state.seq = latestSeq;
    state.showSeq = token;
    state.mode = mode;
    state.sessionId = sid;
    localStorage.setItem('overlay.mode', mode);
    state.active = true;
    onMode?.(mode);
    onActivate?.({ ...state, sessionId: sid, style: msg.style || null });
    if (mode === 'exam' || mode === 'interview') {
      publish({ type: 'overlay-session-ready', seq: token });
      onSessionReady?.({ seq: token, mode });
    }
  };

  const hide = () => {
    token = null;
    hiddenGen += 1;
    state.active = false;
    state.sessionId = null;
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

  // 兜底：订阅后主动拉一次当前 seq；主窗若在（含补发机制）会在毫秒级回发带 sessionId 的
  // overlay-shown，给它们留出窗口后再退回无 sessionId 的本地激活（孤儿浮窗/预览）
  setTimeout(() => {
    publish({ type: 'overlayShowSeqRequest' });
    setTimeout(() => {
      const seq = currentShowSeq();
      if (seq > 0 && !state.active) activate({ seq, mode: localStorage.getItem('overlay.mode'), style: null });
    }, 600);
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
