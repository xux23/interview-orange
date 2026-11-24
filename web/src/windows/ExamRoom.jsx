import React, { useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { api, getToken, getSocketToken, locale } from '../api/client';
import { Markdown, parseFollowups, cleanAnswerLabel } from '../lib/markdown.jsx';
import { overlayWindow, publish } from '../lib/bridge';

export default function ExamRoom({ user }) {
  const params = useMemo(() => new URLSearchParams(location.hash.split('?')[1] || ''), []);
  const [goalId, setGoalId] = useState(params.get('goal') || '');
  const [preset, setPreset] = useState(params.get('preset') || user.examCustomization?.preset || '');
  const [mode, setMode] = useState(params.get('mode') || 'quick');
  const [customization, setCustomization] = useState(user.examCustomization || {});
  const [presets, setPresets] = useState([]);
  const [quota, setQuota] = useState(null);
  const [sessionId, setSessionId] = useState('');
  const [screenshot, setScreenshot] = useState('');
  const [questionText, setQuestionText] = useState('');
  const [stage, setStage] = useState('idle');
  const [reasoning, setReasoning] = useState('');
  const [answer, setAnswer] = useState('');
  const [reqId, setReqId] = useState('');
  const [history, setHistory] = useState([]);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const socketRef = useRef(null);
  const streamRef = useRef(null);
  const answerRef = useRef('');
  const questionRef = useRef('');

  useEffect(() => { questionRef.current = questionText; }, [questionText]);

  useEffect(() => {
    api.query('promptStudio.presets', { lang: locale() }).then((p) => setPresets(p.examPresets || [])).catch(() => {});
  }, []);

  useEffect(() => {
    const socket = io('/desktop', { auth: { token: getToken(), socketToken: getSocketToken(), locale: locale() }, transports: ['websocket', 'polling'] });
    socketRef.current = socket;
    socket.on('connect', () => {
      socket.emit('exam.session.start', {
        title: preset || '笔试答题', goalId: goalId || null, mode,
        customization: { ...customization, preset, codeQuality: mode, lang: locale() }, platform: 'win32',
      }, (ack) => {
        if (ack?.success) {
          setSessionId(ack.data.sessionId);
          setQuota({ isPro: ack.data.isPro, remainingMinutes: ack.data.remainingMinutes });
        }
      });
    });
    socket.on('exam.peers', () => {});
    socket.on('exam.start', ({ reqId: id }) => {
      answerRef.current = '';
      setReqId(id);
      setStage('working');
      setReasoning('');
      setAnswer('');
      publish({ type: 'overlay-exam', stage: 'start', reqId: id });
    });
    socket.on('exam.progress', ({ stage: s }) => setStage(s || 'working'));
    socket.on('exam.reasoning', ({ text }) => { setReasoning((r) => r + text); publish({ type: 'overlay-exam', stage: 'reasoning', text }); });
    socket.on('exam.delta', ({ text }) => {
      answerRef.current += text;
      setAnswer((a) => a + text);
      publish({ type: 'overlay-exam', stage: 'delta', text });
    });
    socket.on('exam.end', () => {
      setStage('done');
      setAnswer(answerRef.current);
      publish({ type: 'overlay-exam', stage: 'end' });
      // socket 回调在 effect 建立时捕获闭包，必须从 ref 取本轮最终值
      const q = questionRef.current.trim();
      setHistory((h) => [...h, { questionText: q || '（截图题）', answer: answerRef.current }]);
    });
    socket.on('exam.quota', (q) => setQuota(q));
    // 模型失败（文档 23 错误统一走 exam.error）：行内报错 + 浮窗提示，不再静默降级
    socket.on('exam.error', ({ message } = {}) => {
      const msg = message || '解题失败';
      setStage('idle');
      setError(msg);
      flash(msg);
      publish({ type: 'overlay-exam', stage: 'error', message: msg });
    });
    socket.on('connect_error', (e) => console.warn('exam socket error', e.message));
    return () => { socket.removeAllListeners(); socket.disconnect(); streamRef.current?.getTracks?.().forEach((t) => t.stop()); };
  }, []); // eslint-disable-line

  useEffect(() => {
    // 打开笔试浮窗（mode=exam）
    const style = user.clientSettings?.overlayStyle || {};
    overlayWindow.open({ mode: 'exam', style: { width: style.examWidth, height: style.examHeight } });
    publish({ type: 'overlay-mode', mode: 'exam' });
    return () => overlayWindow.hide();
  }, []); // eslint-disable-line

  const captureScreen = async () => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 1 } });
      streamRef.current = stream;
      const track = stream.getVideoTracks()[0];
      const video = document.createElement('video');
      video.srcObject = stream;
      await video.play();
      await new Promise((r) => setTimeout(r, 220));
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth || 1280;
      canvas.height = video.videoHeight || 720;
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
      setScreenshot(dataUrl);
      track.stop();
      streamRef.current = null;
      flash('已截取屏幕');
    } catch (e) {
      // P2：失败分支同样释放屏幕流，避免摄像头/共享指示灯常亮
      try { streamRef.current?.getTracks?.().forEach((t) => t.stop()); } catch { /* ignore */ }
      streamRef.current = null;
      flash(`截屏失败：${e.message}（可改用粘贴截图）`);
    }
  };

  const flash = (msg) => { setToast(msg); setTimeout(() => setToast(''), 2500); };

  useEffect(() => {
    const onPaste = (e) => {
      for (const item of e.clipboardData?.items || []) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile();
          const reader = new FileReader();
          reader.onload = () => setScreenshot(reader.result);
          reader.readAsDataURL(file);
          e.preventDefault();
        }
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, []);

  const solve = () => {
    if (!socketRef.current) return;
    if (!screenshot && !questionText.trim()) return flash('需要截图或题面');
    setError('');
    const payload = {
      screenshot, sessionId, mode,
      customization: { ...customization, preset, codeQuality: mode, lang: locale() },
      questionText,
      canCaptureWithCompatibility: true, canCaptureGpuChild: false, clientWindows: [],
    };
    socketRef.current.emit('exam.solve', payload, (ack) => {
      if (ack?.success) setReqId(ack.data.reqId);
    });
  };

  const followUp = (intent, extra = {}) => {
    socketRef.current?.emit('exam.followUp', { reqId, intent, ...extra }, () => {});
  };

  const finish = () => {
    socketRef.current?.emit('exam.session.complete', { sessionId }, () => {});
    overlayWindow.hide();
    setTimeout(() => window.close(), 400);
  };

  const followups = parseFollowups(answer).followups;

  return (
    <div className="exam-shell">
      <aside className="exam-side">
        <div className="row"><b>笔试房间</b><span className="spacer" /><span className="tiny muted">无额度限制</span></div>
        <div className="field">
          <label>预设</label>
          <select value={preset} onChange={(e) => setPreset(e.target.value)}>
            <option value="">自动判型</option>
            {presets.map((p) => <option key={p.slug} value={p.slug}>{p.title}</option>)}
          </select>
        </div>
        <div className="field">
          <label>模式</label>
          <select value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="quick">quick</option><option value="programming">programming</option>
          </select>
        </div>
        <div className="row">
          <button className="btn sm" onClick={captureScreen}>截取屏幕</button>
          <button className="btn sm" onClick={() => { setScreenshot(''); }}>清空截图</button>
        </div>
        <div className="field">
          <label>或粘贴题面（无截图时）</label>
          <textarea value={questionText} onChange={(e) => setQuestionText(e.target.value)} placeholder="例如：求两数之和的下标…" />
        </div>
        {screenshot && <img src={screenshot} alt="screenshot" style={{ width: '100%', borderRadius: 8, border: '1px solid var(--line)' }} />}
        <button className="btn primary" onClick={solve}>解题（扣 2 分钟）</button>
        <small className="muted">每次截图解题按官方口径扣 2 分钟；结果同步到浮窗。</small>
        <span className="spacer" />
        <div className="tiny muted">session：<span className="mono">{sessionId || '—'}</span></div>
        <button className="btn sm" onClick={finish}>结束并关闭</button>
      </aside>

      {toast && <div style={{ position: 'fixed', bottom: 16, left: '50%', transform: 'translateX(-50%)', background: '#111827', color: '#fff', padding: '8px 14px', borderRadius: 9, fontSize: 12.5, zIndex: 99 }}>{toast}</div>}
      <main className="exam-main">
        <div className="exam-stream">
          <div className="row" style={{ marginBottom: 10 }}>
            <span className={`pill ${stage === 'working' ? '' : 'gray'}`}>{stage === 'working' ? '识别/作答中' : stage === 'done' ? '完成' : '待解题'}</span>
            <small className="muted">reqId：{reqId || '—'}</small>
          </div>
          {error && (
            <div className="card pad" style={{ borderColor: '#c0392b', color: '#c0392b', marginBottom: 10 }}>
              ⚠ {error}
            </div>
          )}
          {reasoning && <div className="reasoning">{reasoning}</div>}
          {answer ? (
            <>
              <Markdown text={cleanAnswerLabel(parseFollowups(answer).body)} />
              {followups.length > 0 && (
                <div className="row" style={{ marginTop: 10 }}>
                  {followups.map((f) => <button key={f} className="btn sm" onClick={() => followUp('message', { message: f })}>{f}</button>)}
                  <button className="btn sm" onClick={() => followUp('nr')}>代码审查</button>
                  <button className="btn sm" onClick={() => followUp('$r')}>再简化</button>
                </div>
              )}
            </>
          ) : (
            <div className="card pad muted">还没有答案：先截图或粘贴题面，再点「解题」。</div>
          )}

          {history.length > 0 && (
            <div style={{ marginTop: 18 }}>
              <b>本场已完成 {history.length} 题</b>
              {history.map((h, i) => (
                <div key={i} className="card pad" style={{ marginTop: 8, background: 'var(--panel-2)' }}>
                  <small className="muted">Q{i + 1}：{h.questionText}</small>
                  <div style={{ maxHeight: 140, overflow: 'hidden' }}><Markdown text={cleanAnswerLabel(h.answer)} /></div>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
