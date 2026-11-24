import React, { useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { api, getToken, getSocketToken, locale, currentUser } from '../api/client';
import { Markdown } from '../lib/markdown.jsx';
import { overlayWindow, publish } from '../lib/bridge';
import { startVoiceCapture } from '../lib/voice';

const scoreBand = (score) => {
  const n = Number(score);
  if (!Number.isFinite(n)) return '—';
  if (n >= 90) return '优秀';
  if (n >= 80) return '良好';
  if (n >= 70) return '一般';
  if (n >= 60) return '需改进';
  return '不足';
};

export default function MockRoom({ user }) {
  const params = useMemo(() => new URLSearchParams(location.hash.split('?')[1] || ''), []);
  const sessionId = params.get('session') || '';
  const [session, setSession] = useState(null);
  const [status, setStatus] = useState('ACTIVE');
  const [items, setItems] = useState([]); // {role, content}
  const [draftQuestion, setDraftQuestion] = useState('');
  const [draftAnswer, setDraftAnswer] = useState('');
  const [assist, setAssist] = useState(true);
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState(null);
  const [connected, setConnected] = useState(false);
  const [micOn, setMicOn] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [micErr, setMicErr] = useState('');
  const [asrModel, setAsrModel] = useState('mock');
  const stopMicRef = useRef(null);
  const socketRef = useRef(null);
  const bodyRef = useRef(null);
  const startedRef = useRef(false);

  useEffect(() => {
    if (!sessionId) return;
    fetch('/healthz').then((r) => r.json()).then((h) => setAsrModel(h.asr || 'mock')).catch(() => {});
    api.query('session.getSession', { id: sessionId }).then((s) => {
      setSession(s);
      setStatus(s.status);
      setItems((s.messages || []).map((m) => ({ role: m.role, content: m.content })));
      setAssist(s.metadata?.assistMode !== false);
    }).catch(() => {});

    const socket = io('/', {
      auth: { token: getToken(), socketToken: getSocketToken(), locale: locale(), sessionId },
      transports: ['websocket', 'polling'],
    });
    socketRef.current = socket;
    socket.on('connect', () => {
      setConnected(true);
      socket.emit('mock.join', {});
      // P1-7：重连不再重复 mock.start（服务端也有按会话的幂等保护）
      if (!startedRef.current) {
        startedRef.current = true;
        socket.emit('mock.start', {});
      }
    });
    socket.on('connect_error', (e) => console.warn('socket error', e.message));

    socket.on('mock.questionStart', () => setDraftQuestion(''));
    socket.on('mock.question', (chunk) => setDraftQuestion((q) => q + chunk));
    socket.on('mock.questionEnd', () => {
      setDraftQuestion((q) => {
        if (q) {
          setItems((list) => [...list, { role: 'INTERVIEWER', content: q }]);
          publish({ type: 'overlay-ai-text', text: q });
        }
        return '';
      });
    });

    socket.on('ai.messageStart', () => setDraftAnswer(''));
    socket.on('ai.message', (chunk) => setDraftAnswer((a) => a + chunk));
    socket.on('ai.messageEnd', () => {
      setDraftAnswer((a) => {
        if (a) {
          setItems((list) => [...list, { role: 'ASSISTANT', content: a }]);
          publish({ type: 'overlay-ai-text', text: a });
        }
        return '';
      });
    });
    socket.on('audio.permission', () => {});
    // 服务端模型失败（出题/答题）直接推送错误，不再静默降级
    socket.on('ai.error', (e) => {
      setDraftAnswer('');
      setItems((list) => [...list, { role: 'SYSTEM', content: `⚠ ${e?.message || 'AI 生成失败'}` }]);
    });
    // 语音作答：服务端转写完成后按 self 说话人广播；本地同步展示
    socket.on('stt.segment', (seg) => {
      if (seg?.completed && seg.speakerId === 'self' && seg.text) {
        setItems((list) => [...list, { role: 'USER', content: `🎙 ${seg.text}` }]);
      }
    });
    socket.on('mock.end', () => setStatus('COMPLETED'));

    const poll = setInterval(async () => {
      try {
        const r = await api.query('session.sessionStatus', { id: sessionId });
        setStatus(r.status);
        if (r.status !== 'ACTIVE') {
          clearInterval(poll);
          setReport(await api.query('session.getSessionReport', { id: sessionId }).catch(() => null));
        }
      } catch { /* ignore */ }
    }, 3000);

    return () => {
      clearInterval(poll);
      stopMicRef.current?.();
      socket.removeAllListeners();
      socket.disconnect();
    };
  }, [sessionId]);

  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items, draftQuestion, draftAnswer]);

  const send = () => {
    if (!answer.trim() || !socketRef.current) return;
    socketRef.current.emit('mock.answer', { answer: answer.trim() });
    setItems((l) => [...l, { role: 'USER', content: answer.trim() }]);
    setAnswer('');
  };

  const toggleAssist = () => {
    const next = !assist;
    setAssist(next);
    socketRef.current?.emit('mock.toggleAssist', { assistMode: next });
  };

  const toggleMic = async () => {
    setMicErr('');
    if (asrModel === 'mock') {
      setMicErr('未配置 ML_ASR_API_KEY，当前为本地模拟语音识别，请改用文字作答');
      return;
    }
    if (micOn) {
      stopMicRef.current?.();
      stopMicRef.current = null;
      setMicOn(false);
      return;
    }
    try {
      const stop = await startVoiceCapture({
        socket: socketRef.current,
        speakerId: 'self',
        onLevel: setMicLevel,
        onError: setMicErr,
      });
      stopMicRef.current = stop;
      setMicOn(true);
    } catch (e) {
      setMicErr(e.message || String(e));
      setMicOn(false);
    }
  };

  const finish = async () => {
    setBusy(true);
    try {
      socketRef.current?.emit('mock.end', {});
      const r = await api.mutate('session.completeSession', { id: sessionId });
      setStatus('COMPLETED');
      setReport(await api.query('session.getSessionReport', { id: sessionId }).catch(() => null));
      if (r) setSession(r);
    } catch (e) { alert(e.message); } finally { setBusy(false); }
  };

  if (!sessionId) {
    return <div style={{ padding: 30 }}><h3>没有会话参数</h3><p className="muted">请从主工作台「模拟面试」创建会话。</p></div>;
  }

  const reportSummary = report?.interviewSummary || {};
  const dimensions = Array.isArray(reportSummary.fiveDimensions) ? reportSummary.fiveDimensions : [];
  const conversation = Array.isArray(report?.conversationAnalysis) ? report.conversationAnalysis : [];
  const hasScore = report?.score != null && Number.isFinite(Number(report.score));

  return (
    <div className="room">
      <div className="room-head">
        <span className={`pill ${status === 'ACTIVE' ? '' : 'gray'}`}>{status === 'ACTIVE' ? '进行中' : '已结束'}</span>
        <b>{session?.metadata?.title || '模拟面试'}</b>
        <small className="muted">{session?.goal?.name} · {session?.resume?.title}</small>
        <span className="spacer" />
        <small className="muted">{connected ? '已连接 socket' : '连接中…'}</small>
        {asrModel === 'mock' && <small className="muted" title="未配置 ML_ASR_API_KEY，语音作答不可用">语音未配置</small>}
        <button className={`btn sm ${micOn ? 'primary' : 'ghost'}`} disabled={status !== 'ACTIVE' || asrModel === 'mock'} onClick={toggleMic}>
          {micOn ? '⏹ 停止语音' : '🎤 语音作答'}
        </button>
        <button className="btn ghost sm" onClick={toggleAssist}>{assist ? '关闭辅助' : '开启辅助'}</button>
        {/* P0-3：走统一入口 overlayWindow.open（原生壳显示预建浮窗、浏览器开弹窗），
            不再手写 publish({seq: Date.now()})（13 位时间戳会污染原生 seq 门禁） */}
        <button className="btn sm" onClick={() => overlayWindow.open({ mode: 'interview', sessionId })}>浮窗</button>
        <button className="btn primary sm" disabled={busy || status !== 'ACTIVE'} onClick={finish}>{busy ? '生成中…' : '结束并生成报告'}</button>
      </div>

      <div className="room-body" ref={bodyRef}>
        {items.map((m, i) => (
          <div key={i} className={`msg ${m.role === 'INTERVIEWER' ? 'interviewer' : m.role === 'ASSISTANT' ? 'assistant' : m.role === 'USER' ? 'user' : 'system'}`}>
            {m.role === 'ASSISTANT' ? <Markdown text={m.content} /> : <div style={{ whiteSpace: 'pre-wrap' }}>{m.content}</div>}
          </div>
        ))}
        {draftQuestion && <div className="msg interviewer">{draftQuestion}<span className="muted">▍</span></div>}
        {draftAnswer && <div className="msg assistant"><Markdown text={draftAnswer} /><span className="muted">▍</span></div>}
        {micOn && (
          <div className="msg system" style={{ fontSize: 12 }}>
            🎙 正在聆听你的回答{micLevel > 0.02 ? ' ●' : ' ○'}（说完停顿约 2 秒自动提交；说话请保持音量清晰）
          </div>
        )}
        {micErr && <div className="msg system" style={{ color: '#c0392b', fontSize: 12 }}>🎤 {micErr}</div>}
        {status === 'COMPLETED' && report && (
          <div className="card pad" style={{ alignSelf: 'stretch' }}>
            <div className="row"><b>{hasScore ? `复盘报告：${report.score} 分（${scoreBand(report.score)}）` : '复盘报告'}</b><span className="spacer" />
              <button className="btn sm" onClick={() => window.close()}>关闭窗口</button></div>
            {reportSummary.interviewSummary
              ? <p className="muted">{reportSummary.interviewSummary}</p>
              : report.status && <p className="muted">报告状态：{report.status}</p>}
            {dimensions.map((d) => <div key={d.dimension} className="tiny">· {d.dimension} {d.score}/100 — {d.comment}</div>)}
            {conversation.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <b>逐段点评（{conversation.length} 段）</b>
                {conversation.map((seg, i) => (
                  <div key={i} className="tiny" style={{ marginTop: 4 }}>
                    · {seg.topic} {seg.score}/100 — {seg.evaluation}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="room-input">
        <textarea
          placeholder={status === 'ACTIVE' ? '输入你的回答（Enter 发送，Shift+Enter 换行）' : '会话已结束'}
          value={answer}
          disabled={status !== 'ACTIVE'}
          onChange={(e) => setAnswer(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return; // 小项5：IME 组合中不发送
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
          }}
        />
        <button className="btn primary" disabled={status !== 'ACTIVE' || !answer.trim()} onClick={send}>发送</button>
      </div>
    </div>
  );
}
