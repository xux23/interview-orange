import React, { useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { api, getToken, locale } from '../api/client';
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

  const flash = (msg) => { setToast(msg); setTimeout(() => setToast(''), 1400); };

  /* 门禁状态机：订阅主窗事件 + 兜底拉 seq */
  useEffect(() => {
    const g = createOverlayGate({
      onActivate: (state) => {
        setGate({ ...state });
        sessionRef.current = state.sessionId || sessionRef.current;
        if (state.sessionId) connect(state.sessionId);
        if (state.mode === 'preview' || state.mode === 'interview-preview') setCards([]);
      },
      onHide: () => {
        setGate((s) => ({ ...s, active: false }));
        disconnect();
      },
      onMode: (mode, patch, extra) => {
        if (mode) setGate((s) => ({ ...s, mode }));
        if (patch) setStyle(patch);
        if (extra && extra.type === 'overlay-exam') {
          if (extra.stage === 'start') setExam({ active: true, reqId: extra.reqId, reasoning: '', answer: '' });
          if (extra.stage === 'reasoning') setExam((e) => ({ ...e, reasoning: e.reasoning + extra.text }));
          if (extra.stage === 'delta') setExam((e) => ({ ...e, answer: e.answer + extra.text }));
          if (extra.stage === 'end') setExam((e) => ({ ...e, active: false }));
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
        if (now - lastEsc < 400) { publish({ type: 'overlay-hidden' }); setGate((s) => ({ ...s, active: false })); disconnect(); hideOverlayWindow(); }
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

  function connect(sessionId) {
    disconnect();
    if (!getToken() || !sessionId) return;
    const socket = io('/', {
      auth: { token: getToken(), locale: locale(), sessionId },
      transports: ['websocket', 'polling'],
    });
    socketRef.current = socket;
    let qBuf = '';
    let aBuf = '';

    socket.on('connect_error', (err) => flash(`连接失败：${err.message}`));

    socket.on('mock.questionStart', () => { qBuf = ''; });
    socket.on('mock.question', (chunk) => { qBuf += chunk; setCards((c) => updateLast(c, { question: qBuf })); });
    socket.on('mock.questionEnd', () => {
      setCards((c) => [...c, { id: `q-${Date.now()}`, question: qBuf, answer: '', at: new Date().toISOString() }]);
    });

    socket.on('ai.messageStart', () => { aBuf = ''; });
    socket.on('ai.message', (chunk) => {
      aBuf += chunk;
      setCards((c) => {
        if (!c.length) return [{ id: `a-${Date.now()}`, question: '', answer: aBuf, at: new Date().toISOString() }];
        return c.map((card, i) => (i === c.length - 1 ? { ...card, answer: aBuf } : card));
      });
    });
    socket.on('ai.messageEnd', () => {
      setCards((c) => {
        if (c.length && !c[c.length - 1].question) {
          return c.map((card, i) => (i === c.length - 1 ? { ...card, answer: aBuf } : card));
        }
        return [...c, { id: `a-${Date.now()}`, question: '', answer: aBuf, at: new Date().toISOString() }];
      });
    });

    socket.on('stt.segment', (seg) => {
      if (seg.completed) {
        qBuf = seg.text;
        setCards((c) => [...c, { id: `q-${Date.now()}`, question: seg.text, answer: '', at: new Date().toISOString() }]);
        aBuf = '';
      }
    });
    socket.on('mock.end', () => flash('会话已结束'));
    socket.on('overlay-style-hotkey-patch', (patch) => setStyle(patch));
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
      if (!e.altKey || !keys[e.key]) return;
      e.preventDefault();
      step(keys[e.key], 48); // 文档 03 §5：首次 48px
      clearInterval(timer);
      timer = setInterval(() => step(keys[e.key], 30), 30); // 之后每 30ms 步进 30px
    };
    const onUp = () => { clearInterval(timer); timer = null; };
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    return () => { clearInterval(timer); window.removeEventListener('keydown', onDown); window.removeEventListener('keyup', onUp); };
  }, []);

  /* ── 文档 03 §4：auto-palette（捕捉 → suggestPalette → 应用 + undo 快照）── */
  const paletteUndoRef = useRef(null);
  const autoPalette = async () => {
    const nat = window.orangeNative;
    let image = null;
    try {
      if (nat?.captureScreen) image = await nat.captureScreen();
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
    if (el) el.scrollTop = el.scrollHeight;
  }, [cards, exam.answer]);

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
        <button className="ov-btn" title="隐藏浮窗（Ctrl+Alt+H 可召回）" onClick={() => { publish({ type: 'overlay-hidden' }); setGate((s) => ({ ...s, active: false })); disconnect(); hideOverlayWindow(); }}>—</button>
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
          <div className="ov-card" style={{ borderLeft: '2px solid rgba(99,102,241,.5)' }}>
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
            {cardsView.length === 0 && <div className="ov-empty">最近答案会出现在这里<br /><span className="tiny">连接会话后逐字刷新</span></div>}
            {cardsView.map((card) => (
              <div className="ov-card" key={card.id} data-zone={"card-" + card.id} ref={(el) => window.__OVERLAY_DEBUG__?.registerZone?.(el)} style={{ borderLeft: '2px solid rgba(99,102,241,.5)' }}>
                {card.question && <div className="q">{card.question}</div>}
                {card.answer ? <Markdown className="a" text={card.answer} /> : <div className="q">生成中…</div>}
                {card.answer && (
                  <div className="ov-actions">
                    <button className="ov-btn" onClick={() => copy(card.answer)}>复制</button>
                  </div>
                )}
              </div>
            ))}
          </>
        )}
      </div>

      {gate.active && !isExam && (
        <div style={{ padding: '4px 8px 8px', display: 'flex', gap: 6 }}>
          <input
            type="text"
            value={inject}
            onChange={(e) => setInject(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && injectQuestion()}
            placeholder="注入面试官问题（本地 STT 替身）"
            style={{ flex: 1, fontSize: '11.5px', padding: '5px 8px', background: 'rgba(255,255,255,.7)', color: '#222' }}
          />
          <button className="ov-btn" onClick={injectQuestion}>问</button>
        </div>
      )}

      {toast && <div style={{ position: 'absolute', bottom: 8, left: 8, fontSize: 11, opacity: .75 }}>{toast}</div>}
    </div>
  );
}

function modeEmit(mode, gate) {
  const labels = { exam: '笔试', interview: '面试', preview: '预览', 'interview-preview': '预览' };
  return `${labels[mode] || mode} · #${gate.showSeq || currentShowSeq()}`;
}

function updateLast(cards, patch) {
  if (!cards.length) return [{ id: `q-${Date.now()}`, question: patch.question || '', answer: '', at: new Date().toISOString() }];
  return cards.map((c, i) => (i === cards.length - 1 ? { ...c, ...patch } : c));
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
  if (isNative || e.target.closest('button, input')) return;
  const sx = e.clientX;
  const sy = e.clientY;
  const move = (ev) => {
    try { window.moveBy(ev.clientX - sx, ev.clientY - sy); } catch { /* 浏览器不允许时忽略 */ }
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    publish({ type: 'drag-mode-changed', active: false });
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  publish({ type: 'drag-mode-changed', active: true });
}
