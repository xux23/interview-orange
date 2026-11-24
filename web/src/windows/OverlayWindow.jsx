import React, { useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { api, getToken, getSocketToken, locale } from '../api/client';
import { createOverlayGate, publish, currentShowSeq } from '../lib/bridge';
import { Markdown, cleanAnswerLabel, parseFollowups } from '../lib/markdown.jsx';
import { closeOverlayWindow, hideOverlayWindow, isNative } from '../lib/native';

const DEFAULT_STYLE = {
  theme: 'light', interviewBgOpacity: 0.85, examBgOpacity: 0.85,
  interviewTextOpacity: 1, examTextOpacity: 1,
  examBorderOpacity: 0, interviewBorderOpacity: 0,
  textHalo: true, textBold: false, fontScale: 1, scrollSpeed: 1,
  hotkeyOpacityStep: 0.1, examSolveHoverMs: 1200,
  examWidth: 420, examHeight: 520, interviewWidth: 400, interviewHeight: 620,
  paletteBg: '', paletteFg: '',
};

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const DEMO_ANSWER = `**核心要点**
- 后端方向 · Node.js/MySQL/Redis · 订单链路 P99 110ms

**参考回答**
面试官好，我是张伟，后端开发方向，主要做 Node.js 与 Java。最近这段经历负责订单链路的下单、支付回调和履约，qps 峰值 8000，P99 110ms。为了稳定性做过两件事：一是把超时关单从定时轮询改成延迟消息加幂等消费，重复关单率从 0.3% 降到 0；二是补齐链路压测，定位到连接池和慢查询两个瓶颈，把 P99 从 800ms 压到 120ms。`;

export default function OverlayWindow({ user }) {
  const [style, setStyleState] = useState(() => ({
    ...DEFAULT_STYLE, ...(JSON.parse(localStorage.getItem('overlay.style') || '{}')), ...(user.clientSettings?.overlayStyle || {}),
  }));
  const [gate, setGate] = useState({ active: false, mode: localStorage.getItem('overlay.mode') || 'preview', seq: 0 });
  const [cards, setCards] = useState([]);
  const [exam, setExam] = useState({ reasoning: '', answer: '', active: false, reqId: null });
  const [inject, setInject] = useState('');
  const [toast, setToast] = useState('');
  const [newestFirst, setNewestFirst] = useState(false);
  const socketRef = useRef(null);
  const sessionRef = useRef(null);
  const cardRef = useRef(null);
  const saveTimer = useRef(null);
  const lastSizeRef = useRef(null);

  const styleRef = useRef(style);
  styleRef.current = style;

  const setStyle = (patch) => {
    setStyleState((s) => {
      const next = typeof patch === 'function' ? patch(s) : { ...s, ...patch };
      localStorage.setItem('overlay.style', JSON.stringify(next));
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        api.mutate('user.updateClientSettings', { overlayStyle: next }).catch(() => {});
      }, 600);
      return next;
    });
  };

  // 小项6：卸载时清理防抖定时器
  useEffect(() => () => clearTimeout(saveTimer.current), []);

  /* 按样式里的尺寸调整原生浮窗（exam/interview 各自键，兼容旧 width/height）；
   * 浏览器模式由 window.open 的 features 决定，这里只走原生。 */
  function sizeOf(styleObj, mode) {
    const isExam = mode === 'exam';
    return {
      w: Number(isExam ? (styleObj.examWidth ?? styleObj.width) : (styleObj.interviewWidth ?? styleObj.width)),
      h: Number(isExam ? (styleObj.examHeight ?? styleObj.height) : (styleObj.interviewHeight ?? styleObj.height)),
    };
  }
  function applyWindowSize(w, h) {
    const nat = window.orangeNative;
    if (!nat?.winRect || !nat?.winPosition) return;
    if (!Number.isFinite(w) || w < 200 || !Number.isFinite(h) || h < 200) return;
    nat.winRect('overlay')
      .then((r) => r && nat.winPosition({ x: r.x, y: r.y, w: Math.round(w), h: Math.round(h) }))
      .catch(() => {});
  }

  // 设置页实时推来的尺寸变化：仅当值真正变化且浮窗已激活时调整（首次只登记，保留用户拖动尺寸）
  useEffect(() => {
    const { w, h } = sizeOf(style, gate.mode === 'exam' ? 'exam' : 'interview');
    if (!Number.isFinite(w) || w < 200 || !Number.isFinite(h) || h < 200) return;
    const prev = lastSizeRef.current;
    lastSizeRef.current = { w, h };
    if (!prev || (prev.w === w && prev.h === h)) return;
    if (!gate.active) return;
    applyWindowSize(w, h);
  }, [style.examWidth, style.examHeight, style.interviewWidth, style.interviewHeight, style.width, style.height, gate.active, gate.mode]);

  const flash = (msg) => { setToast(msg); setTimeout(() => setToast(''), 1400); };

  /* 门禁状态机：订阅主窗事件 + 兜底拉 seq */
  useEffect(() => {
    const g = createOverlayGate({
      onActivate: (state) => {
        const prev = sessionRef.current;
        // 新会话必须清掉上一场残留的卡片；同一会话重新显示时保留
        if (state.sessionId && state.sessionId !== prev) setCards([]);
        setGate({ ...state });
        // 打开/预览时携带的样式立即应用（只取已知键，过滤 width/height 等非样式字段）
        if (state.style && typeof state.style === 'object') {
          const patch = {};
          for (const k of [...Object.keys(DEFAULT_STYLE), 'examWidth', 'examHeight', 'interviewWidth', 'interviewHeight']) {
            if (k in state.style) patch[k] = state.style[k];
          }
          if (Object.keys(patch).length) setStyle(patch);
          // 打开/预览时按样式尺寸调整原生窗口（兼容旧 width/height 键）
          const { w, h } = sizeOf(state.style, state.mode || 'interview');
          applyWindowSize(w, h);
        }
        // P1-3：持久化会话标识——窗口隐藏/被关闭后经热键召回或重载，仍能接回原会话
        if (state.sessionId) {
          try { localStorage.setItem('overlay.session', JSON.stringify({ sessionId: state.sessionId, mode: state.mode })); } catch { /* ignore */ }
        }
        let persisted = null;
        try { persisted = JSON.parse(localStorage.getItem('overlay.session') || 'null'); } catch { persisted = null; }
        const rejoin = state.sessionId || prev || persisted?.sessionId || null;
        sessionRef.current = rejoin;
        if (state.sessionId) {
          connect(state.sessionId);
        } else if (rejoin && !socketRef.current && (state.mode === 'interview' || state.mode === 'exam')) {
          // 热键召回的无 sessionId shown：socket 若已断，按持久化会话重连
          connect(rejoin);
        }
        // P0-2：预览态只在「确实从有会话切到预览」时清卡片，窗口重新显示不再清
        if ((state.mode === 'preview' || state.mode === 'interview-preview') && prev) setCards([]);
      },
      onHide: () => {
        // P0-2：隐藏（显隐热键）≠ 会话结束——不断 socket，重新显示后流式继续
        setGate((s) => ({ ...s, active: false }));
      },
      onMode: (mode, patch, extra) => {
        if (mode) setGate((s) => ({ ...s, mode }));
        if (patch) setStyle(patch);
        if (extra && extra.type === 'overlay-exam') {
          if (extra.stage === 'start') setExam({ active: true, reqId: extra.reqId, reasoning: '', answer: '' });
          if (extra.stage === 'reasoning') setExam((e) => ({ ...e, reasoning: e.reasoning + extra.text }));
          if (extra.stage === 'delta') setExam((e) => ({ ...e, answer: e.answer + extra.text }));
          if (extra.stage === 'end') setExam((e) => ({ ...e, active: false }));
          if (extra.stage === 'error') {
            setExam((e) => ({ ...e, active: false }));
            flash(`⚠ ${extra.message || '解题失败'}`);
          }
        }
        if (extra && extra.type === 'overlay-ai-text') {
          setInject(extra.text || '');
        }
      },
      onSessionReady: () => flash('浮窗已就绪'),
    });
    return () => { g.close(); disconnect(); };
  }, []); // eslint-disable-line

  /* 键盘兜底：没有原生热键时也能调样式 */
  useEffect(() => {
    let lastEsc = 0;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        const now = Date.now();
        if (now - lastEsc < 400) { publish({ type: 'overlay-hidden' }); setGate((s) => ({ ...s, active: false })); hideOverlayWindow(); }
        lastEsc = now;
        return;
      }
      if (!e.altKey || !e.ctrlKey) return;
      const s = styleRef.current;
      const patch = {};
      switch (e.key) {
        case '+': case '=': patch.fontScale = clamp((s.fontScale || 1) * 1.1, 0.3, 4); break;
        case '-': patch.fontScale = clamp((s.fontScale || 1) / 1.1, 0.3, 4); break;
        case 'ArrowUp': patch.examBgOpacity = clamp((s.examBgOpacity || 0.85) + (s.hotkeyOpacityStep || 0.1), 0, 1); patch.interviewBgOpacity = patch.examBgOpacity; break;
        case 'ArrowDown': patch.examBgOpacity = clamp((s.examBgOpacity || 0.85) - (s.hotkeyOpacityStep || 0.1), 0, 1); patch.interviewBgOpacity = patch.examBgOpacity; break;
        case 't': patch.textHalo = !s.textHalo; break;
        case 'p': e.preventDefault(); autoPalette(); return;
        case 'u': e.preventDefault(); restorePalette(); return;
        default: return;
      }
      e.preventDefault();
      setStyle(patch);
      flash('样式已更新');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []); // eslint-disable-line

  /* 高危4：流式轮次独立成 streamRef（{qid, question, answer}），cards 只放已完成的轮次。
   * questionStart → 新轮次；question → 只更新 streamRef.question；
   * questionEnd → 用该 qid 落一张卡片（答案稍后经 ai.* 按同 qid 补上）；
   * ai.message → 更新 streamRef.answer（无问题先到的答案只建一次轮次）；
   * ai.messageEnd → 按 qid 找已提交卡片补 answer，找不到则整卡提交。 */
  const streamRef = useRef(null);
  const [streamView, setStreamView] = useState(null);
  const qidSeq = useRef(0);

  function connect(sessionId) {
    disconnect();
    if (!sessionId) return; // 账号模块已移除：无需 token，有会话即连
    const socket = io('/', {
      auth: { token: getToken(), socketToken: getSocketToken(), locale: locale(), sessionId },
      transports: ['websocket', 'polling'],
    });
    socketRef.current = socket;

    const touch = () => setStreamView(streamRef.current ? { ...streamRef.current } : null);
    const beginStream = (prefix) => {
      if (streamRef.current) commitStream(); // 上一轮仍在流式：先收尾，避免轮次交叉
      qidSeq.current += 1;
      streamRef.current = { qid: `${prefix}-${Date.now()}-${qidSeq.current}`, question: '', answer: '' };
      touch();
    };
    const commitStream = () => {
      const s = streamRef.current;
      if (!s) return;
      streamRef.current = null;
      touch();
      if (!s.question && !s.answer) return;
      setCards((c) => {
        const idx = c.findIndex((card) => card.id === s.qid);
        if (idx >= 0) {
          const next = [...c];
          next[idx] = { ...next[idx], answer: s.answer || next[idx].answer };
          return next;
        }
        return [...c, { id: s.qid, question: s.question, answer: s.answer, at: new Date().toISOString() }];
      });
    };
    const commitQuestion = () => {
      const s = streamRef.current;
      if (!s) return;
      setCards((c) => [...c, { id: s.qid, question: s.question, answer: '', at: new Date().toISOString() }]);
    };

    socket.on('connect_error', (err) => flash(`连接失败：${err.message}`));

    socket.on('mock.questionStart', () => beginStream('q'));
    socket.on('mock.question', (chunk) => {
      if (!streamRef.current) beginStream('q'); // 没收到 Start 的兜底
      streamRef.current.question += chunk;
      touch();
    });
    socket.on('mock.questionEnd', () => commitQuestion());

    socket.on('ai.messageStart', () => {
      // 答案先到（questionEnd 已落卡片并保留同轮次）或「无问题只有答案」：只建一次轮次
      if (!streamRef.current) beginStream('a');
    });
    socket.on('ai.message', (chunk) => {
      if (!streamRef.current) beginStream('a');
      streamRef.current.answer += chunk;
      touch();
    });
    socket.on('ai.messageEnd', () => commitStream());

    socket.on('stt.segment', (seg) => {
      // self 是自己的回答（服务端只记录，不触发辅助），不要当成面试官问题加卡片
      if (seg.completed && seg.speakerId !== 'self') {
        // 先收尾上一个仍在流式的轮次，再按「一次性提交」路径建本轮
        commitStream();
        qidSeq.current += 1;
        const qid = `q-${Date.now()}-${qidSeq.current}`;
        setCards((c) => [...c, { id: qid, question: seg.text, answer: '', at: new Date().toISOString() }]);
        // 挂一个已提交的轮次，后续 ai.* 的答案按同 qid 补到这张卡片
        streamRef.current = { qid, question: seg.text, answer: '' };
        touch();
      }
    });
    // 服务端模型失败直接推送错误（不再静默降级）：以错误卡片 + toast 呈现
    socket.on('ai.error', (e) => {
      const message = e?.message || 'AI 生成失败';
      flash(`⚠ ${message}`);
      setCards((c) => [...c, { id: `err-${Date.now()}`, question: '⚠ AI 出错', answer: message, at: new Date().toISOString() }]);
    });
    socket.on('mock.end', () => flash('会话已结束'));
  }

  function disconnect() {
    if (socketRef.current) {
      socketRef.current.removeAllListeners();
      socketRef.current.disconnect();
      socketRef.current = null;
    }
  }

  const injectQuestion = () => {
    if (!inject.trim()) return;
    if (!socketRef.current || !gate.active) return flash('浮窗尚未激活会话');
    socketRef.current.emit('stt.inject', { text: inject.trim(), speakerId: 'Guest-1' });
    setInject('');
  };

  const mode = gate.mode || 'preview';
  const isExam = mode === 'exam';
  const bgOpacity = isExam ? style.examBgOpacity : style.interviewBgOpacity;
  const textOpacity = isExam ? style.examTextOpacity : style.interviewTextOpacity;
  const borderOpacity = isExam ? style.examBorderOpacity : style.interviewBorderOpacity;
  const theme = style.theme === 'dark' ? 'dark' : 'light';
  const fg = style.paletteFg || (theme === 'dark' ? '#f2f4f6' : '#1b1d21');
  const bg = style.paletteBg || (theme === 'dark' ? '#12161b' : '#ffffff');

  const cardsView = useMemo(() => (newestFirst ? [...cards].reverse() : cards), [cards, newestFirst]);

  /* ── 文档 03 §5：zones 分区注册（350ms 遍历 rect + JSON diff 后才下发）── */
  const shellRef = useRef(null);
  const zonesRef = useRef([]);
  const zoneElsRef = useRef([]);
  useEffect(() => {
    let last = '';
    const collect = () => {
      const base = shellRef.current?.getBoundingClientRect();
      if (!base) return;
      const zones = Array.from(shellRef.current?.querySelectorAll?.('[data-zone]') || [])
        .map((el, i) => {
          const r = el.getBoundingClientRect();
          if (r.width < 8 || r.height < 8) return null;
          return {
            id: el.dataset.zone || `zone-${i}`,
            x: Math.round(r.left - base.left),
            y: Math.round(r.top - base.top),
            w: Math.round(r.width),
            h: Math.round(r.height),
          };
        })
        .filter(Boolean);
      const json = JSON.stringify(zones);
      if (json === last) return;
      last = json;
      zonesRef.current = zones;
      publish({ type: 'overlay-zones', zones });
      try { window.__ORANGE_INVOKE__?.('cmd_set_overlay_zones', { zones }); } catch { /* 原生壳缺失 */ }
    };
    const t = setInterval(collect, 350);
    collect();
    return () => clearInterval(t);
  }, []);

  /* ── 文档 03 §5：键盘移动（首次 48px，之后每 30ms 步进 30px）── */
  useEffect(() => {
    const keys = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
    let timer = null;
    const step = async (dir, px = 30) => {
      const [dx, dy] = dir;
      const nat = window.orangeNative;
      if (nat?.winRect) {
        const r = await nat.winRect('overlay').catch(() => null);
        if (r) {
          await nat.winPosition?.({ x: r.x + dx * px, y: r.y + dy * px, w: r.w, h: r.h });
          return;
        }
      }
      try { window.moveBy(dx * px, dy * px); } catch { /* 浏览器忽略 */ }
    };
    const onDown = (e) => {
      if (e.repeat) return; // P1-5：OS 自动重复不重建定时器
      // P1-6：Ctrl+Alt+方向键只调样式（上方热键），不移动窗口
      if (!e.altKey || e.ctrlKey || !keys[e.key]) return;
      e.preventDefault();
      step(keys[e.key], 48); // 文档 03 §5：首次 48px
      clearInterval(timer);
      timer = setInterval(() => step(keys[e.key], 30), 30); // 之后每 30ms 步进 30px
    };
    // P1-5：只在放开的确实是方向键时停；失焦/切窗（keyup 收不到）兜底清理
    const onUp = (e) => {
      if (keys[e.key]) { clearInterval(timer); timer = null; }
    };
    const stopAll = () => { clearInterval(timer); timer = null; };
    const onVis = () => { if (document.hidden) stopAll(); };
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    window.addEventListener('blur', stopAll);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(timer);
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
      window.removeEventListener('blur', stopAll);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  /* ── 文档 03 §4：auto-palette（捕捉 → suggestPalette → 应用 + undo 快照）── */
  const paletteUndoRef = useRef(null);
  const autoPalette = async () => {
    const nat = window.orangeNative;
    let image = null;
    try {
      // 配色采样 480px 足够：原生侧降采样后再传（IPC 体积从 ~16MB 降到 ~0.5MB）
      if (nat?.captureScreen) image = await nat.captureScreen({ maxWidth: 480 });
    } catch { /* 落回浏览器路径 */ }
    if (!image) return flash('自动配色需要原生壳的截屏能力');
    paletteUndoRef.current = { ...styleRef.current };
    setStyle({ examBgOpacity: 0, interviewBgOpacity: 0 });
    try {
      const r = await api.mutate('overlay.suggestPalette', {
        // 服务端会把 BMP 转成小图送视觉模型，这里不再截断（截断会破坏图像数据）
        image: String(image), mode: isExam ? 'normal' : 'dualCamera', current: styleRef.current,
      });
      setStyle({
        theme: r.theme, paletteBg: r.paletteBg, paletteFg: r.paletteFg,
        textHalo: r.textHalo, examBgOpacity: r.bgOpacity, interviewBgOpacity: r.bgOpacity,
        examTextOpacity: r.textOpacity, interviewTextOpacity: r.textOpacity,
      });
      flash(`自动配色：${r.theme}（${r.sampled?.color || ''}）`);
    } catch (e) {
      // P1-5：失败必须恢复原透明度快照，否则浮窗保持全透明不可见
      if (paletteUndoRef.current) {
        setStyle(paletteUndoRef.current);
        paletteUndoRef.current = null;
      }
      flash(`自动配色失败：${e.message}`);
    }
  };
  const restorePalette = () => {
    if (!paletteUndoRef.current) return flash('没有可撤销的配色');
    setStyle(paletteUndoRef.current);
    paletteUndoRef.current = null;
    flash('已恢复上一套配色');
  };

  // 调试句柄（供 CDP/自检读取 zones 与触发配色）
  useEffect(() => {
    window.__OVERLAY_DEBUG__ = {
      zones: () => zonesRef.current,
      autoPalette,
      restorePalette,
      registerZone: (el) => { if (el) zoneElsRef.current.push(el); },
    };
  }, []); // eslint-disable-line


  useEffect(() => {
    const el = cardRef.current;
    if (!el) return undefined;
    const to = el.scrollHeight - el.clientHeight;
    const from = el.scrollTop;
    const speed = Number(styleRef.current.scrollSpeed) || 1; // 0.05 ~ 3
    if (to <= from) return undefined;
    if (speed >= 3) { el.scrollTop = to; return undefined; }
    // scrollSpeed 越大越快：基准 420ms，按倍率缩放（80ms ~ 1200ms）
    const dur = Math.min(1200, Math.max(80, 420 / speed));
    const t0 = performance.now();
    let raf = 0;
    const tick = (now) => {
      const p = Math.min(1, (now - t0) / dur);
      el.scrollTop = from + (to - from) * p;
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [cards, streamView, exam.answer]);

  return (
    <div
      ref={shellRef}
      className="overlay-shell"
      style={{
        background: rgba2(bg, bgOpacity),
        color: fg,
        border: `${Math.round(1 + borderOpacity * 2)}px solid rgba(120,130,160,${0.15 + borderOpacity})`,
        fontSize: `${Math.round(14 * (style.fontScale || 1))}px`,
        fontWeight: style.textBold ? 650 : 450,
        textShadow: style.textHalo ? (theme === 'dark' ? '0 1px 2px rgba(0,0,0,.85)' : '0 1px 1px rgba(255,255,255,.9)') : 'none',
        opacity: 1,
      }}
    >
      <div className="ov-head" onPointerDown={startDrag}>
        <span className="overlay-badge">{modeEmit(mode, gate)}</span>
        <div className="ov-drag">面试橙 · {isExam ? '笔试' : '面试'}</div>
        <button className="ov-btn" title="新建优先" onClick={() => setNewestFirst((v) => !v)}>{newestFirst ? '旧→新' : '新→旧'}</button>
        <button className="ov-btn" title="隐藏浮窗（Ctrl+Alt+H 可召回）" onClick={() => { publish({ type: 'overlay-hidden' }); setGate((s) => ({ ...s, active: false })); hideOverlayWindow(); }}>—</button>
        <button className="ov-btn" title="关闭浮窗（Ctrl+Alt+Shift+X）" onClick={() => { publish({ type: 'overlay-hidden' }); disconnect(); closeOverlayWindow(); }}>×</button>
      </div>

      <div className="ov-body" ref={cardRef} style={{ opacity: textOpacity }} data-zone="body">
        {!gate.active && (
          <div className="ov-empty">
            {mode === 'preview' ? (
              <>
                <div>浮窗预览（preview）<br />没有会话时不发 session-ready</div>
                <div style={{ marginTop: 8 }} className="tiny">主窗口「真实面试辅助」或「笔试助手」会打开正式浮窗</div>
              </>
            ) : (
              <div>等待会话激活…<br /><span className="tiny">showOverlay() → seq {currentShowSeq()}</span></div>
            )}
          </div>
        )}

        {!gate.active && mode === 'preview' && (
          <div className="ov-card" style={{ borderLeft: '2px solid var(--accent)' }}>
            <div className="q">示例问题：请先做一个自我介绍</div>
            <Markdown className="a" text={DEMO_ANSWER} />
            <div className="ov-actions">
              <button className="ov-btn" onClick={() => copy(DEMO_ANSWER)}>复制</button>
            </div>
          </div>
        )}

        {gate.active && isExam && (
          <>
            {style.showReasoning !== false && exam.reasoning && <div className="reasoning">{exam.reasoning.slice(-600)}</div>}
            {!exam.answer && !exam.active && <div className="ov-empty">等待截图解题…</div>}
            {exam.answer && (
              <div className="ov-card" style={{ background: 'transparent' }}>
                <Markdown text={cleanAnswerLabel(exam.answer)} />
                {parseFollowups(exam.answer).followups.length > 0 && (
                  <div className="ov-actions">
                    {parseFollowups(exam.answer).followups.map((f) => (
                      <button key={f} className="ov-btn" onClick={() => publish({ type: 'overlay-followup', text: f })}>{f}</button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {gate.active && !isExam && (
          <>
            {cardsView.length === 0 && !streamView && <div className="ov-empty">最近答案会出现在这里<br /><span className="tiny">连接会话后逐字刷新</span></div>}
            {/* 仍在流式、尚未落卡片的轮次（问题识别中）实时显示 */}
            {streamView && !cardsView.some((c) => c.id === streamView.qid) && (
              <div className="ov-card" style={{ borderLeft: '2px solid var(--accent)' }} data-zone={'card-' + streamView.qid}>
                <div className="q">{streamView.question || '识别问题中…'}<span className="muted">▍</span></div>
                {streamView.answer && <Markdown className="a" text={streamView.answer} />}
              </div>
            )}
            {cardsView.map((card) => {
              // 该卡片对应的轮次仍在流式：答案实时从 streamView 取
              const live = streamView && streamView.qid === card.id ? streamView : null;
              const answer = live ? live.answer : card.answer;
              return (
                <div className="ov-card" key={card.id} data-zone={"card-" + card.id} ref={(el) => window.__OVERLAY_DEBUG__?.registerZone?.(el)} style={{ borderLeft: '2px solid var(--accent)' }}>
                  {card.question && <div className="q">{card.question}</div>}
                  {answer ? <Markdown className="a" text={answer} /> : <div className="q">生成中…</div>}
                  {answer && (
                    <div className="ov-actions">
                      <button className="ov-btn" onClick={() => copy(answer)}>复制</button>
                    </div>
                  )}
                </div>
              );
            })}
          </>
        )}
      </div>

      {gate.active && !isExam && (
        <div className="ov-input-row">
          <input
            type="text"
            value={inject}
            onChange={(e) => setInject(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.keyCode === 229) return; // 小项5：IME 组合中不触发
              if (e.key === 'Enter') injectQuestion();
            }}
            placeholder="注入面试官问题（本地 STT 替身）"
            style={{
              background: theme === 'dark' ? 'rgba(18,22,27,.72)' : 'rgba(255,255,255,.78)',
              color: fg,
              borderColor: 'rgba(127,127,127,.35)',
            }}
          />
          <button className="ov-btn" onClick={injectQuestion}>问</button>
        </div>
      )}

      {toast && <div className="ov-toast">{toast}</div>}
    </div>
  );
}

function modeEmit(mode, gate) {
  const labels = { exam: '笔试', interview: '面试', preview: '预览', 'interview-preview': '预览' };
  return `${labels[mode] || mode} · #${gate.showSeq || currentShowSeq()}`;
}

function rgba2(hex, alpha) {
  const h = String(hex || '#ffffff').replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const r = parseInt(full.slice(0, 2), 16) || 255;
  const g = parseInt(full.slice(2, 4), 16) || 255;
  const b = parseInt(full.slice(4, 6), 16) || 255;
  return `rgba(${r},${g},${b},${clamp(alpha, 0.05, 1)})`;
}

function copy(text) {
  navigator.clipboard?.writeText(text).catch(() => {});
}

function startDrag(e) {
  if (e.target.closest('button, input')) return;
  const sx = e.clientX;
  const sy = e.clientY;
  const nat = window.orangeNative;
  publish({ type: 'drag-mode-changed', active: true });
  let move;
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    publish({ type: 'drag-mode-changed', active: false });
  };
  if (nat?.winRect && nat?.winPosition) {
    // 原生壳：WebView2 不支持 window.moveBy，经 IPC 按指针增量移动窗口
    // （窗口随指针移动后，指针下的 clientX 基本不动，天然形成「拖到哪跟到哪」的稳定模型）
    let base = null;
    nat.winRect('overlay').then((r) => { base = r; }).catch(() => {});
    move = (ev) => {
      if (!base) return;
      nat.winPosition({ x: base.x + (ev.clientX - sx), y: base.y + (ev.clientY - sy), w: base.w, h: base.h }).catch(() => {});
    };
  } else {
    // 浏览器：moveBy 仅对脚本打开的弹窗有效
    move = (ev) => {
      try { window.moveBy(ev.clientX - sx, ev.clientY - sy); } catch { /* 浏览器不允许时忽略 */ }
    };
  }
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}
