/** 原生能力探测与浮窗控制（浏览器 / Rust 原生壳双跑；shim 由 native/src/main.rs 注入） */
export const native = typeof window !== 'undefined' ? window.orangeNative || null : null;
export const isNative = Boolean(native?.native);

let hiddenBySelf = false;

/** 隐藏浮窗（保留窗口，之后可 showInactive 复用） */
export async function hideOverlayWindow() {
  hiddenBySelf = true;
  try {
    if (native?.toggleOverlay) return await native.toggleOverlay(false);
    window.close();
  } catch {
    /* ignore */
  }
}

/** 彻底关闭浮窗窗口（× 关闭） */
export async function closeOverlayWindow() {
  hiddenBySelf = true;
  try {
    if (native?.closeOverlay) return await native.closeOverlay();
    window.close();
  } catch {
    /* ignore */
  }
}

/* ── 隐蔽与防检测（对照文档 05/15/24；浏览器模式下返回受限状态） ── */

export async function stealthState() {
  if (native?.stealthState) return await native.stealthState();
  return { contentProtection: { main: false, overlay: false }, wdaSupported: false, panicHidden: 0, browser: true };
}

export async function setContentProtection(kind, enable) {
  if (native?.setContentProtection) return await native.setContentProtection(kind, enable);
  return null;
}

export async function setSkipTaskbar(enable) {
  if (native?.setSkipTaskbar) return await native.setSkipTaskbar(enable);
  return null;
}

export async function disguiseTitle(title) {
  if (native?.disguiseTitle) return await native.disguiseTitle(title);
  document.title = title || document.title;
  return true;
}

export async function panicToggle() {
  if (native?.panic) return await native.panic();
  return null;
}

export const wasHiddenBySelf = () => hiddenBySelf;
