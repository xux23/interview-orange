import React, { useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { api, refreshUser, locale, getSocketToken } from '../api/client';
import { LOCALES, setLocale as saveLocale } from '../lib/i18n';
import { overlayWindow, publish, subscribe } from '../lib/bridge';
import { isNative, stealthState, setContentProtection, setSkipTaskbar, disguiseTitle, panicToggle } from '../lib/native';
import { Markdown } from '../lib/markdown.jsx';
import { startVoiceCapture } from '../lib/voice';
import { getToken } from '../api/client';

const NAV = [
  {
    label: '练习',
    items: [
      ['home', '工作台', 'home'],
      ['mock', '模拟面试', 'mic'],
      ['exam', '笔试助手', 'monitor'],
      ['live', '真实面试辅助', 'live'],
    ],
  },
  {
    label: '资料',
    items: [
      ['bank', '题库', 'layers'],
      ['material', '资料库', 'folder'],
      ['prompt', '提示词工作室', 'terminal'],
    ],
  },
  {
    label: '系统',
    items: [
      ['stealth', '隐蔽与防检测', 'shield'],
      ['settings', '设置', 'sliders'],
    ],
  },
];

const SESSION_TYPE = { MOCK_INTERVIEW: '模拟面试', INTERVIEW: '真实面试', EXAM: '笔试' };

function NavIcon({ name }) {
  const common = {
    width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
  };
  const paths = {
    home: <><path d="M4 10.5 12 4l8 6.5" /><path d="M6 9.5V20h12V9.5" /><path d="M10 20v-5h4v5" /></>,
    mic: <><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0" /><path d="M12 18v3" /><path d="M9 21h6" /></>,
    monitor: <><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8" /><path d="M12 17v4" /></>,
    live: <><path d="M4 14v-2a8 8 0 0 1 16 0v2" /><rect x="3" y="13" width="4.5" height="7" rx="2" /><rect x="16.5" y="13" width="4.5" height="7" rx="2" /><path d="M19 20v1a3 3 0 0 1-3 3h-3" /></>,
    layers: <><path d="m12 3 9 5-9 5-9-5 9-5Z" /><path d="m3 13 9 5 9-5" /></>,
    folder: <><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" /></>,
    terminal: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3" /><path d="M13 15h4" /></>,
    shield: <><path d="M12 3 5 6v6c0 4.4 2.8 7.4 7 9 4.2-1.6 7-4.6 7-9V6l-7-3Z" /><path d="m9 12 2 2 4-4" /></>,
    sliders: <><path d="M4 7h10" /><path d="M18 7h2" /><circle cx="16" cy="7" r="2" /><path d="M4 17h2" /><path d="M10 17h10" /><circle cx="8" cy="17" r="2" /></>,
    sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
    moon: <><path d="M20 14.5A8 8 0 0 1 9.5 4a7 7 0 1 0 10.5 10.5Z" /></>,
  };
  return <svg {...common}>{paths[name] || paths.home}</svg>;
}

const DIFFICULTY = [
  ['FRESH_GRADUATE', '应届'],
  ['1_3_YEARS', '1-3 年'],
  ['3_5_YEARS', '3-5 年'],
  ['5_10_YEARS', '5-10 年'],
  ['10_YEARS', '10 年以上'],
];
const ROUNDS = [['FIRST', '一面'], ['SECOND', '二面'], ['THIRD', '三面'], ['HR', 'HR 面'], ['OTHER', '其他']];
const ANSWER_STYLES = [
  ['natural', '自然（要点 + 参考回答）'],
  ['keypoints', '只要要点'],
  ['answerOnly', '只要可念的一段'],
  ['structured', '结构化（STAR / 结论-依据-取舍）'],
];

export default function MainApp({ user: initialUser }) {
  const [tab, setTab] = useState(location.hash.includes('tab=') ? location.hash.split('tab=')[1].split('&')[0] : 'home');
  const [user, setUser] = useState(initialUser);
  const [toast, setToast] = useState('');
  const [theme, setTheme] = useState(localStorage.getItem('desktop.theme') || 'light');
  const [ann, setAnn] = useState(null);
  const [pendingNotice, setPendingNotice] = useState(null);
  const [countdown, setCountdown] = useState(5);
  const [hotkeyStatus, setHotkeyStatus] = useState(null);

  // P1-12：启动时主动拉一次热键实际注册状态（失败项在隐蔽页标红，不再无条件宣称可用）
  useEffect(() => {
    let cancelled = false;
    window.__ORANGE_INVOKE__?.('hotkeys.status')?.then((st) => {
      if (cancelled) return;
      setHotkeyStatus(st);
      if (st?.failed?.length) console.warn('[hotkeys] 以下热键未注册：', st.failed);
    }).catch(() => { /* 浏览器模式无原生壳 */ });
    return () => { cancelled = true; };
  }, []);

  // 文档 06 §5：公告 5 分钟轮询、使用须知弹窗（5s 倒计时确认）
  useEffect(() => {
    const load = () => api.query('announcement.getActive', { platform: 'windows' }).then(setAnn).catch(() => {});
    load();
    const t = setInterval(load, 5 * 60 * 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    api.query('notice.getPendingNotice', { kinds: ['usage-ack', 'compensation'] })
      .then(setPendingNotice)
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!pendingNotice) return;
    if (countdown <= 0) return;
    const t = setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [pendingNotice, countdown]);

  const ackNotice = async () => {
    try {
      if (pendingNotice?.id) await api.mutate('notice.ackNotice', { id: pendingNotice.id });
      localStorage.setItem('notice.usageAcknowledged.v2', '1');
    } catch { /* ignore */ }
    setPendingNotice(null);
  };

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('desktop.theme', theme);
  }, [theme]);

  // 崩溃恢复握手（文档 03 §3 / I:335-394）：15s 内等 overlay-session-ready，否则最小化主窗
  useEffect(() => {
    const nat = window.orangeNative;
    if (!nat?.crashRecovery) return;
    let done = false;
    nat.crashRecovery().then(async (st) => {
      if (!st?.isCrashRecovery) return;
      // 只有确实存在进行中的面试会话才恢复浮窗；否则启动时只弹一个空白预览，体验很差
      const active = await api.query('session.getActiveSession', { type: 'INTERVIEW' }).catch(() => null);
      if (!active) {
        console.info('[crash-recovery] 没有进行中的面试会话，跳过浮窗恢复');
        return;
      }
      // 原生 shim 的 showOverlay 返回 {seq}，不是裸数字（此前把对象当 seq，Number({})→NaN
      // 导致就绪回传 seq=0、releaseIfNotReady 判定失效）
      const shown = await nat.showOverlay({ mode: 'interview' });
      const seq = Number(shown && typeof shown === 'object' ? shown.seq : shown) || 0;
      const payload = { type: 'overlay-shown', seq, mode: 'interview', sessionId: active.id };
      // 浮窗 webview 可能比主窗晚挂载（BroadcastChannel 不回放）：登记 lastShown 供其
      // overlayShowSeqRequest 补发，并在 1.2s 后重发一次兜底（gate 对同一 show 幂等去重）
      overlayWindow.lastShown = payload;
      publish(payload);
      setTimeout(() => { if (!done) publish(payload); }, 1200);
      // 浮窗就绪信号走 BroadcastChannel（gate 发布 overlay-session-ready），
      // 不是原生 window 事件——此前监听错通道，永远等不到就绪
      const off = subscribe((msg) => {
        if (msg.type !== 'overlay-session-ready') return;
        if ((msg.seq ?? 0) >= (seq ?? 0)) {
          done = true;
          off();
          console.info('[crash-recovery] 浮窗已恢复（未抢焦点）');
        }
      });
      setTimeout(async () => {
        if (done) return;
        const stillNotReady = await nat.releaseIfNotReady(seq).catch(() => true);
        console.warn('[crash-recovery] 15s 未就绪，releaseSessionIfNotReady =', stillNotReady);
      }, 15000);
    }).catch(() => {});
  }, []);

  const notice = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(''), 2600);
  };

  const reloadUser = async () => setUser(await refreshUser());

  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">
          <div className="logo">面</div>
          <div>
            <b>面试橙</b>
            <div className="tiny muted">本地独立环境</div>
          </div>
        </div>
        <nav className="nav">
          {NAV.map((group) => (
            <div className="nav-group" key={group.label}>
              <div className="nav-label">{group.label}</div>
              {group.items.map(([key, label, icon]) => (
                <button key={key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>
                  <NavIcon name={icon} />
                  <span>{label}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="side-foot">
          <div className="side-note">
            <span className="status-dot" />
            <div>
              <b>本地档案</b>
              <span>无账号 · 数据在 ./data</span>
            </div>
            <button
              className="icon-btn"
              title={theme === 'light' ? '切到深色' : '切到浅色'}
              onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
            >
              <NavIcon name={theme === 'light' ? 'moon' : 'sun'} />
            </button>
          </div>
        </div>
      </aside>

      <main className="main">
        <div className="main-inner">
          {ann && (
            <div className="notice-bar">
              <span className="notice-tag">公告</span>
              <b>{ann.title}</b>
              <span className="notice-text">{ann.content}</span>
              <button className="icon-btn" aria-label="关闭公告" onClick={() => setAnn(null)}>×</button>
            </div>
          )}
          {tab === 'home' && <Home user={user} notice={notice} onTab={setTab} />}
          {tab === 'mock' && <MockSetup user={user} notice={notice} reloadUser={reloadUser} />}
          {tab === 'exam' && <ExamSetup user={user} notice={notice} reloadUser={reloadUser} />}
          {tab === 'live' && <LiveAssist user={user} notice={notice} />}
          {tab === 'bank' && <BankPage notice={notice} />}
          {tab === 'material' && <MaterialPage notice={notice} />}
          {tab === 'prompt' && <PromptPage notice={notice} />}
          {tab === 'stealth' && <StealthPage notice={notice} hotkeys={hotkeyStatus} />}
          {tab === 'settings' && <SettingsPage user={user} notice={notice} reloadUser={reloadUser} />}
        </div>
      </main>

      {pendingNotice && (
        <div className="modal-backdrop">
          <div className="modal-card">
            <div className="modal-head"><b>使用须知</b><span className="chip">首次使用</span></div>
            <p>
              {pendingNotice.payload?.text || '本工具用于模拟面试与笔试练习。请在合规场景下使用：国家考试、公务员录用、事业单位招聘、军队文职、职业资格考试等环节禁止使用。'}
            </p>
            <div className="row">
              <small className="muted">{(pendingNotice.payload?.countdownSec ?? 5) > 0 ? `${Math.max(0, countdown)} 秒后可确认` : '可确认'}</small>
              <span className="spacer" />
              <button className="btn primary" disabled={countdown > 0} onClick={ackNotice}>
                {countdown > 0 ? `我已阅读（${countdown}）` : '我已阅读并同意'}
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

/* ───────────── 工作台 ───────────── */
function Home({ user, notice, onTab }) {
  const [sessions, setSessions] = useState([]);
  const [report, setReport] = useState(null);
  const reportIdRef = useRef(null);

  useEffect(() => {
    api.query('session.getSessions', { page: 1, pageSize: 8 }).then((r) => setSessions(r.items)).catch(() => {});
  }, []);

  const openReport = async (id) => {
    reportIdRef.current = id;
    try {
      const r = await api.query('session.getSessionReport', { id });
      setReport(r);
    } catch (e) { notice(e.message); }
  };

  // P1-6：报告未就绪时真正轮询（带清理），不再只写「约 3 秒后自动刷新」的假文案
  useEffect(() => {
    if (!report || report.status === 'success' || report.status === 'READY') return undefined;
    if (!reportIdRef.current) return undefined;
    let cancelled = false;
    let timer = null;
    let tries = 0;
    const tick = async () => {
      if (cancelled) return;
      tries += 1;
      try {
        const r = await api.query('session.getSessionReport', { id: reportIdRef.current });
        if (cancelled) return;
        setReport(r);
        if (r?.status === 'success' || r?.status === 'READY' || tries >= 10) return;
      } catch { /* 继续重试 */ }
      if (!cancelled) timer = setTimeout(tick, 2500);
    };
    timer = setTimeout(tick, 2500);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [report?.status, report?.title]);

  return (
    <>
      <div className="page-title"><h1>工作台</h1><span className="chip">本地版</span></div>
      <p className="page-sub">今天的练习、报告与快捷入口。</p>
      <section className="hero">
        <h2>开口之前，答案已经在屏幕上。</h2>
        <p>模拟面试官按简历与岗位出题，实时给出「核心要点 + 参考回答」；笔试截图解题，答案直接投到浮窗。</p>
        <div className="row hero-actions">
          <button className="btn primary" onClick={() => onTab('mock')}>开始模拟面试</button>
          <button className="btn" onClick={() => onTab('exam')}>笔试助手</button>
          <button className="btn" onClick={() => onTab('live')}>真实面试浮窗</button>
        </div>
      </section>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="section-head">
          <b>最近会话</b><span className="count">{sessions.length}</span>
          <span className="spacer" />
          <button className="btn ghost sm" onClick={() => location.reload()}>刷新</button>
        </div>
        {sessions.length === 0 && (
          <div className="empty-state">
            <b>还没有会话</b>
            <span>从「模拟面试」开始，报告会保存在本地。</span>
          </div>
        )}
        {sessions.map((s) => {
          const live = s.status === 'ACTIVE';
          return (
            <div className="session-row" key={s.id}>
              <div className={`session-state ${live ? 'live' : 'done'}`}>
                <span className="status-dot" />{live ? '进行中' : '已完成'}
              </div>
              <div style={{ minWidth: 0 }}>
                <div className="session-title">{s.metadata?.title || SESSION_TYPE[s.type] || s.type}</div>
                <div className="session-meta">
                  <span>{new Date(s.createdAt).toLocaleString()}</span>
                  <span className="sep">/</span>
                  <span>{SESSION_TYPE[s.type] || s.type}</span>
                  <span className="sep">/</span>
                  <span>{s.realDuration ?? 0}s</span>
                </div>
              </div>
              <div className="session-action">
                {live
                  ? <button className="btn sm" onClick={() => window.open(`#mock?session=${s.id}`, 'ml-mock-room', 'width=980,height=760')}>进入房间</button>
                  : <button className="btn sm" onClick={() => openReport(s.id)}>查看报告</button>}
              </div>
            </div>
          );
        })}
      </div>

      {report && (
        <div className="card pad" style={{ marginTop: 16 }}>
          <div className="row"><b>{report.title || '复盘报告'}</b>
            <span className="chip">{report.status === 'success' ? '已生成' : report.status}</span>
            {report.score != null && <span className="chip">总分 {report.score}</span>}
            <span className="spacer" />
            <button className="btn sm" onClick={() => exportReportMarkdown(report)}>导出 Markdown</button>
            <button className="btn ghost sm" onClick={() => setReport(null)}>关闭</button>
          </div>

          {report.status !== 'success' && report.status !== 'READY' && (
            <p className="muted">报告{report.status === 'pending' ? '生成中，正在自动刷新…' : report.status}</p>
          )}

          {(() => {
            // 高危5：模型返回缺字段时不整页崩掉——数组逐个 Array.isArray 防护
            const summary = (report.interviewSummary && typeof report.interviewSummary === 'object') ? report.interviewSummary : null;
            if (!summary) return null;
            const dims = Array.isArray(summary.fiveDimensions) ? summary.fiveDimensions : [];
            const strengths = Array.isArray(summary.strengths) ? summary.strengths : [];
            const shortcomings = Array.isArray(summary.shortcomings) ? summary.shortcomings : [];
            const suggestions = Array.isArray(summary.interviewSuggestions) ? summary.interviewSuggestions : [];
            const emptyHint = <div className="muted tiny">未生成该部分</div>;
            return (
              <>
              <div className="grid3" style={{ marginTop: 10 }}>
                {dims.length === 0 && <div className="card pad" style={{ boxShadow: 'none', background: 'var(--panel-2)' }}>{emptyHint}</div>}
                {dims.map((d) => (
                  <div key={d.dimension} className="card pad" style={{ boxShadow: 'none', background: 'var(--panel-2)' }}>
                    <small>{d.dimension}</small>
                    <div><b>{d.score}</b>/100</div>
                    <div style={{ height: 4, background: 'var(--line)', borderRadius: 2, marginTop: 6 }}>
                      <div style={{ width: `${d.score}%`, height: '100%', background: 'var(--accent)', borderRadius: 2 }} />
                    </div>
                  </div>
                ))}
              </div>
              <p style={{ marginTop: 12 }}>{summary.interviewSummary}</p>
              <div className="grid2">
                <div><b>优点</b>{strengths.length === 0 ? emptyHint : <ul>{strengths.map((s, i) => <li key={i}><b>{s.strength}</b>：{s.reason}</li>)}</ul>}</div>
                <div><b>短板</b>{shortcomings.length === 0 ? emptyHint : <ul>{shortcomings.map((s, i) => <li key={i}><b>{s.shortcoming}</b>：{s.reason}</li>)}</ul>}</div>
              </div>
              <div><b>改进建议</b>{suggestions.length === 0 ? emptyHint : <ol>{suggestions.map((s, i) => <li key={i}>{s}</li>)}</ol>}</div>
              </>
            );
          })()}

          {Array.isArray(report.conversationAnalysis) && report.conversationAnalysis.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <b>逐段点评（{report.conversationAnalysis.length} 段）</b>
              {report.conversationAnalysis.map((seg, i) => (
                <div key={i} className="card pad" style={{ marginTop: 8, background: 'var(--panel-2)', boxShadow: 'none' }}>
                  <div className="row"><b>{seg.topic}</b><span className="chip">{seg.score}/100</span></div>
                  <small className="muted">Q：{seg.question}</small>
                  <div style={{ marginTop: 4 }}>A：{seg.answer}</div>
                  <div className="tiny" style={{ marginTop: 6, color: 'var(--muted)' }}>点评：{seg.evaluation}</div>
                  <div className="tiny" style={{ marginTop: 4 }}>建议：{seg.suggestion}</div>
                </div>
              ))}
            </div>
          )}

          {Array.isArray(report.relatedKnowledge) && (
            <div style={{ marginTop: 12 }}>
              <b>相关知识点（{report.relatedKnowledge.length}）</b>
              <ul>{report.relatedKnowledge.map((k, i) => <li key={i}><b>{k.knowledge}</b>：{k.concept}</li>)}</ul>
            </div>
          )}
        </div>
      )}
    </>
  );
}

/* ───────────── 报告导出（文档 23 §9.2：DH → markdown，剪贴板降级）───────────── */
function exportReportMarkdown(report) {
  const s = report.interviewSummary || {};
  const lines = [
    `# ${report.title || '复盘报告'}`,
    '',
    `生成时间：${report.generatedAt || new Date().toISOString()}`,
    `总分：${report.score ?? '-'}`,
    '',
    '## 五维评分',
    ...(s.fiveDimensions || []).map((d) => `- ${d.dimension}：${d.score}/100`),
    '',
    '## 总体评价',
    s.interviewSummary || '',
    '',
    '## 优点',
    ...(s.strengths || []).map((x) => `- **${x.strength}**：${x.reason}`),
    '',
    '## 短板',
    ...(s.shortcomings || []).map((x) => `- **${x.shortcoming}**：${x.reason}`),
    '',
    '## 改进建议',
    ...(s.interviewSuggestions || []).map((x, i) => `${i + 1}. ${x}`),
    '',
    '## 逐段点评',
    ...(report.conversationAnalysis || []).flatMap((seg) => [
      `### ${seg.topic}（${seg.score}/100）`,
      `- Q：${seg.question}`,
      `- A：${seg.answer}`,
      `- 点评：${seg.evaluation}`,
      `- 建议：${seg.suggestion}`,
      '',
    ]),
    '## 相关知识点',
    ...(report.relatedKnowledge || []).map((k) => `- **${k.knowledge}**：${k.concept}`),
  ];
  const md = lines.join('\n');
  const blob = new Blob([md], { type: 'text/markdown' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${(report.title || 'report').replace(/[\\/:*?"<>|]/g, '_')}.md`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* ───────────── 模拟面试设定 ───────────── */
function MockSetup({ user, notice, reloadUser }) {
  const [resumes, setResumes] = useState([]);
  const [goals, setGoals] = useState([]);
  const [form, setForm] = useState({ resumeId: '', goalId: '', difficulty: '3_5_YEARS', round: 'FIRST', answerStyle: 'natural', turnBudget: 8, assistMode: true });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.query('resume.getResumes').then((r) => {
      setResumes(r);
      setForm((f) => ({ ...f, resumeId: f.resumeId || r[0]?.id || '' }));
    }).catch(() => {});
    api.query('goal.getGoals').then((r) => {
      setGoals(r);
      setForm((f) => ({ ...f, goalId: f.goalId || r[0]?.id || '' }));
    }).catch(() => {});
  }, []);

  const start = async () => {
    if (!form.resumeId || !form.goalId) return notice('先选择简历和岗位');
    setBusy(true);
    try {
      const s = await api.mutate('session.createSession', {
        type: 'MOCK_INTERVIEW',
        resumeId: form.resumeId,
        goalId: form.goalId,
        audioSource: 'MICROPHONE',
        round: form.round,
        isTrial: false,
        metadata: {
          assistMode: form.assistMode, difficulty: form.difficulty, lang: locale(),
          turnBudget: form.turnBudget, basicsRatio: 0.4, answerStyle: form.answerStyle,
        },
      });
      await api.mutate('user.updateInterviewPreference', { answerStyle: form.answerStyle, assistMode: form.assistMode });
      window.open(`#mock?session=${s.id}`, 'ml-mock-room', 'width=980,height=760,left=80,top=60');
      notice('会话已创建，房间窗口已打开');
      reloadUser?.();
    } catch (e) { notice(e.message); } finally { setBusy(false); }
  };

  return (
    <>
      <div className="page-title"><h1>模拟面试</h1><span className="muted">AI 面试官按简历/岗位出题，逐字流式；你作答后给出辅助答案</span></div>
      <div className="grid2">
        <div className="card pad col">
          <div className="field">
            <label>简历</label>
            <select value={form.resumeId} onChange={(e) => setForm({ ...form, resumeId: e.target.value })}>
              {resumes.map((r) => <option key={r.id} value={r.id}>{r.title}{r.isSample ? '（示例）' : ''}</option>)}
            </select>
          </div>
          <div className="field">
            <label>岗位</label>
            <select value={form.goalId} onChange={(e) => setForm({ ...form, goalId: e.target.value })}>
              {goals.map((g) => <option key={g.id} value={g.id}>{g.name}{g.companyName ? ` @ ${g.companyName}` : ''}</option>)}
            </select>
          </div>
          <div className="grid2">
            <div className="field">
              <label>难度</label>
              <select value={form.difficulty} onChange={(e) => setForm({ ...form, difficulty: e.target.value })}>
                {DIFFICULTY.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <div className="field">
              <label>轮次</label>
              <select value={form.round} onChange={(e) => setForm({ ...form, round: e.target.value })}>
                {ROUNDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
          </div>
          <div className="field">
            <label>回答风格</label>
            <select value={form.answerStyle} onChange={(e) => setForm({ ...form, answerStyle: e.target.value })}>
              {ANSWER_STYLES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <div className="row">
            <label className="tiny muted"><input type="checkbox" checked={form.assistMode} onChange={(e) => setForm({ ...form, assistMode: e.target.checked })} /> 开启 AI 辅助回答</label>
            <span className="spacer" />
            <div className="field" style={{ width: 120 }}>
              <label>题量</label>
              <input type="number" min={4} max={20} value={form.turnBudget} onChange={(e) => setForm({ ...form, turnBudget: Number(e.target.value) })} />
            </div>
          </div>
          <button className="btn primary" disabled={busy} onClick={start}>{busy ? '创建中…' : '开始模拟面试'}</button>
          <small className="muted">会话创建后会打开独立房间窗口（#mock）；结束后自动生成复盘报告。</small>
        </div>

        <div className="card pad col">
          <b>官方答题提示词（zh-CN 摘要）</b>
          <small className="muted">来自服务端 presets。interview.official 3856 字，命中即证明提示词已原样生效。</small>
          <div className="card pad" style={{ boxShadow: 'none', background: 'var(--panel-2)', maxHeight: 380, overflow: 'auto' }}>
            <PresetPreview />
          </div>
        </div>
      </div>
    </>
  );
}

function PresetPreview() {
  const [text, setText] = useState('加载中…');
  useEffect(() => {
    api.query('promptStudio.presets', { lang: locale() }).then((p) => setText(p.interview.official.slice(0, 2400))).catch(() => setText('加载失败'));
  }, []);
  return <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12.5, margin: 0, lineHeight: 1.6 }}>{text}</pre>;
}

/* ───────────── 笔试助手 ───────────── */
function ExamSetup({ user, notice, reloadUser }) {
  const [presets, setPresets] = useState([]);
  const [goals, setGoals] = useState([]);
  const [sel, setSel] = useState({ goalId: '', preset: '', codeQuality: 'standard', customRequirements: '' });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.query('promptStudio.presets', { lang: locale() }).then((p) => setPresets(p.examPresets || [])).catch(() => {});
    api.query('goal.getGoals').then(setGoals).catch(() => {});
    api.query('examSession.list', { page: 1, pageSize: 6 }).then((r) => setSel((s) => ({ ...s, last: r.items }))).catch(() => {});
  }, []);

  const start = async () => {
    setBusy(true);
    try {
      await api.mutate('user.updateExamCustomization', {
        preset: sel.preset, codeQuality: sel.codeQuality, customRequirements: sel.customRequirements,
      });
      const q = new URLSearchParams({ goal: sel.goalId, preset: sel.preset, mode: sel.codeQuality });
      window.open(`#mock-exam?${q}`, 'ml-exam-room', 'width=1080,height=760,left=60,top=40');
      notice('笔试房间已打开，浮窗将自动接收答案');
    } catch (e) { notice(e.message); } finally { setBusy(false); }
  };

  return (
    <>
      <div className="page-title"><h1>笔试助手</h1><span className="muted">截图 → 识别 → 英文思考链 + 中文答案，每次解题扣 2 分钟</span></div>
      <div className="grid2">
        <div className="card pad col">
          <div className="field">
            <label>官方预设（24 个）</label>
            <select value={sel.preset} onChange={(e) => setSel({ ...sel, preset: e.target.value })}>
              <option value="">自动判型</option>
              {presets.map((p) => <option key={p.slug} value={p.slug}>{p.title} · {p.questionType}</option>)}
            </select>
          </div>
          <div className="field">
            <label>岗位（记录用）</label>
            <select value={sel.goalId} onChange={(e) => setSel({ ...sel, goalId: e.target.value })}>
              <option value="">不关联</option>
              {goals.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label>代码风格（exam.styles）</label>
            <select value={sel.codeQuality} onChange={(e) => setSel({ ...sel, codeQuality: e.target.value })}>
              <option value="standard">standard</option><option value="readable">readable</option>
              <option value="concise">concise</option><option value="performance">performance</option>
            </select>
          </div>
          <div className="field">
            <label>定制要求（注入提示词）</label>
            <textarea value={sel.customRequirements} onChange={(e) => setSel({ ...sel, customRequirements: e.target.value })} placeholder="例如：代码要 ACM 模式、注释少一点" />
          </div>
          <button className="btn primary" disabled={busy} onClick={start}>{busy ? '打开中…' : '打开笔试房间 + 浮窗'}</button>
          <small className="muted">房间内可用「共享屏幕」或「粘贴截图」两种方式采集题目；浮窗显示答案卡片。</small>
        </div>
        <div className="card pad col">
          <b>最近的笔试记录</b>
          {(sel.last || []).length === 0 && <small className="muted">还没有记录</small>}
          {(sel.last || []).map((e) => (
            <div className="list-item" key={e.id} style={{ paddingLeft: 0 }}>
              <span className="pill gray">{e.status}</span>
              <div><div style={{ fontWeight: 600 }}>{e.title}</div><small>题量 {e.questionCount} · 消耗 {e.costMinutes} 分钟 · {new Date(e.createdAt).toLocaleString()}</small></div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

/* ───────────── 真实面试浮窗 ───────────── */
function LiveAssist({ user, notice }) {
  const [resumes, setResumes] = useState([]);
  const [goals, setGoals] = useState([]);
  const [form, setForm] = useState({ resumeId: '', goalId: '', answerStyle: 'natural', audioSource: 'SPEAKER' });
  const [session, setSession] = useState(null);
  const [busy, setBusy] = useState(false);
  const [asrModel, setAsrModel] = useState('mock');
  const [cap, setCap] = useState({});   // { interviewer: bool, self: bool }
  const [capErr, setCapErr] = useState('');
  const socketRef = useRef(null);
  const stopsRef = useRef({});

  useEffect(() => {
    api.query('resume.getResumes').then((r) => { setResumes(r); setForm((f) => ({ ...f, resumeId: r[0]?.id || '' })); }).catch(() => {});
    api.query('goal.getGoals').then((r) => { setGoals(r); setForm((f) => ({ ...f, goalId: r[0]?.id || '' })); }).catch(() => {});
    fetch('/healthz').then((r) => r.json()).then((h) => setAsrModel(h.asr || 'mock')).catch(() => {});
    return () => { Object.values(stopsRef.current).forEach((s) => s?.()); socketRef.current?.disconnect(); };
  }, []);

  const start = async () => {
    setBusy(true);
    try {
      const active = await api.query('session.getActiveSession', { type: 'INTERVIEW' }).catch(() => null);
      const s = active || await api.mutate('session.createSession', {
        type: 'INTERVIEW', resumeId: form.resumeId, goalId: form.goalId,
        audioSource: form.audioSource, round: 'FIRST', isTrial: false,
        metadata: { assistMode: true, answerStyle: form.answerStyle, lang: locale() },
      });
      setSession(s);
      socketRef.current?.disconnect();
      socketRef.current = null;
      const style = user.clientSettings?.overlayStyle || {};
      overlayWindow.open({ mode: 'interview', sessionId: s.id, style: { width: style.interviewWidth, height: style.interviewHeight } });
      notice('浮窗已开：在浮窗里输入面试官的问题即可得到答案');
    } catch (e) { notice(e.message); } finally { setBusy(false); }
  };

  const stop = async () => {
    Object.values(stopsRef.current).forEach((s) => s?.());
    stopsRef.current = {};
    setCap({});
    if (session) await api.mutate('session.completeSession', { id: session.id }).catch(() => {});
    overlayWindow.close();
    setSession(null);
    notice('会话已结束，报告已生成');
  };

  /** 开/关一路音频采集：speakerId 决定语义（interviewer=系统共享音频 → 触发 AI 辅助；self=麦克风 → 记录我的回答） */
  const toggleCapture = async (kind) => {
    setCapErr('');
    if (cap[kind]) {
      stopsRef.current[kind]?.();
      stopsRef.current[kind] = null;
      setCap((c) => ({ ...c, [kind]: false }));
      return;
    }
    if (!session) { setCapErr('先开启浮窗建立会话，再采集音频'); return; }
    try {
      if (!socketRef.current) {
        socketRef.current = io('/', { auth: { token: getToken(), socketToken: getSocketToken(), locale: locale(), sessionId: session.id }, transports: ['websocket'] });
      }
      const stopFn = await startVoiceCapture({
        socket: socketRef.current,
        speakerId: kind === 'self' ? 'self' : 'Guest-1',
        system: kind !== 'self',
      });
      stopsRef.current[kind] = stopFn;
      setCap((c) => ({ ...c, [kind]: true }));
      notice(kind === 'self' ? '麦克风采集中：你的发言将转写并记录' : '面试官声音采集中：识别到提问将自动生成答案到浮窗');
    } catch (e) {
      setCapErr(e.message || String(e));
    }
  };

  return (
    <>
      <div className="page-title"><h1>真实面试辅助</h1><span className="muted">浮窗透明置顶，只显示要点与可念答案</span></div>
      <div className="grid2">
        <div className="card pad col">
          <div className="field">
            <label>简历</label>
            <select value={form.resumeId} onChange={(e) => setForm({ ...form, resumeId: e.target.value })}>
              {resumes.map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}
            </select>
          </div>
          <div className="field">
            <label>岗位</label>
            <select value={form.goalId} onChange={(e) => setForm({ ...form, goalId: e.target.value })}>
              {goals.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label>声音来源</label>
            <select value={form.audioSource} onChange={(e) => setForm({ ...form, audioSource: e.target.value })}>
              <option value="SPEAKER">系统扬声器（面试官）</option>
              <option value="MICROPHONE">麦克风</option>
              <option value="PHONE">电话</option>
            </select>
          </div>
          <div className="row">
            <button className="btn primary" disabled={busy} onClick={start}>{session ? '重新打开浮窗' : '开启浮窗'}</button>
            {session && <button className="btn" onClick={stop}>结束会话</button>}
          </div>
          <div className="divider" />
          {asrModel !== 'mock' ? (
            <div className="col" style={{ gap: 8 }}>
              <b>真实语音识别（{asrModel}）</b>
              <div className="row">
                <button className={`btn sm ${cap.interviewer ? 'primary' : ''}`} disabled={!session} onClick={() => toggleCapture('interviewer')}>
                  {cap.interviewer ? '⏹ 停止采集' : '🎙 面试官声音（共享音频）'}
                </button>
                <button className={`btn sm ${cap.self ? 'primary' : ''}`} disabled={!session} onClick={() => toggleCapture('self')}>
                  {cap.self ? '⏹ 停止麦克风' : '🎤 我的回答（麦克风）'}
                </button>
              </div>
              <small className="muted">
                「共享音频」需在弹窗里勾选标签页/系统声音——识别到面试官提问后，答案会自动流到浮窗；
                两者可同时开启。说完一句停顿约 2 秒出转写。
              </small>
              {capErr && <small style={{ color: '#c0392b' }}>{capErr}</small>}
            </div>
          ) : (
            <small className="muted">
              本地环境的 STT 由服务端模拟：浮窗里「注入面试官问题」框可直接输入文字，等价于转写结果；
              在 .env 配置 ML_ASR_API_KEY 后，这里会出现真实语音采集开关。
            </small>
          )}
        </div>

        <div className="card pad col">
          <b>浮窗协议（对齐 h109）</b>
          <div className="tiny muted col" style={{ gap: 4 }}>
            <div>· showOverlay() → 返回单调递增 seq；overlay-shown(seq)</div>
            <div>· 浮窗收到 seq 后激活 → 发 overlay-session-ready(seq)</div>
            <div>· 心跳 5s；overlay-hidden 让代数 +1；重复 seq 去重</div>
            <div>· preview / interview-preview 不发 sessionReady</div>
            <div>· 样式热键 patch：size / opacity / text-opacity / auto-palette</div>
          </div>
          <div className="divider" />
          <b>当前会话</b>
          {session ? (
            <div className="tiny">
              <div>sessionId：<span className="mono">{session.id}</span></div>
              <div>状态：{session.status} · 标题：{session.metadata?.title}</div>
              <div className="row" style={{ marginTop: 8 }}>
                <button className="btn sm" onClick={() => overlayWindow.open({ mode: 'interview', sessionId: session.id })}>再次 showOverlay</button>
                <button className="btn sm" onClick={() => overlayWindow.hide()}>hideOverlay</button>
              </div>
            </div>
          ) : <small className="muted">未开始</small>}
        </div>
      </div>
    </>
  );
}

/* ───────────── 题库 ───────────── */
function BankPage({ notice }) {
  const [overview, setOverview] = useState(null);
  const [items, setItems] = useState([]);
  const [sort, setSort] = useState('hot');
  const [detail, setDetail] = useState(null);
  // 押题：tRPC 生成 + socket 流式接收（文档 17）
  const [pred, setPred] = useState({ id: null, title: '', items: [], streaming: false });
  const predSocket = useRef(null);

  const load = () => {
    api.query('questionBank.getOverview').then(setOverview).catch(() => {});
    api.query('questionBank.listHot', { page: 1, pageSize: 20, sort }).then((r) => setItems(r.items)).catch(() => {});
  };
  useEffect(load, [sort]);

  const startPrediction = async () => {
    setPred({ id: 'pending', title: 'AI 押题生成中…', items: [], streaming: true });
    try {
      // P0：真模型押题（简历+JD+题库 → 题目与解析）
      const r = await api.mutate('questionPrediction.generate', { count: 8 });
      setPred({ id: r.id, title: '押题结果', items: r.items, streaming: false });
      notice(`已生成 ${r.items.length} 道押题（${r.source === 'model' ? 'AI 生成' : '题库兜底'}）`);
    } catch (e) {
      notice(`押题失败：${e.message}`);
      setPred({ id: null, title: '', items: [], streaming: false });
    }
  };
  useEffect(() => () => predSocket.current?.disconnect(), []);

  const toggle = async (id, kind) => {
    try {
      const r = await api.mutate(kind === 'fav' ? 'questionBank.toggleFavorite' : 'questionBank.toggleMet', { id });
      setItems((list) => list.map((q) => (q.id === id ? { ...q, ...r } : q)));
    } catch (e) { notice(e.message); }
  };

  return (
    <>
      <div className="page-title"><h1>题库</h1>
        <span className="muted">{overview ? `${overview.questionCount} 题 · 出现 ${overview.occurrenceCount} 次 · 收藏 ${overview.favoritedCount}` : ''}</span>
      </div>
      <div className="row" style={{ marginBottom: 12 }}>
        <select value={sort} onChange={(e) => setSort(e.target.value)}>
          <option value="hot">按热度</option><option value="recent">按最近</option>
        </select>
        <span className="spacer" />
        <button className="btn sm" onClick={async () => {
          const ids = items.filter((q) => q.favorited).map((q) => q.id);
          if (!ids.length) return notice('先收藏几道题');
          const r = await api.mutate('questionBank.saveToMaterial', { ids }).catch((e) => { notice(e.message); return null; });
          if (r) notice(`已保存 ${r.saved} 题到资料库`);
        }}>收藏转资料</button>
        <button className="btn sm" onClick={startPrediction} disabled={pred.streaming}>
          {pred.streaming ? 'AI 押题中…' : 'AI 生成押题'}
        </button>
      </div>

      {pred.id && (
        <div className="card pad" style={{ marginBottom: 12 }}>
          <div className="row">
            <b>{pred.title || '押题'}</b>
            <span className="chip">{pred.items.length} 条</span>
            {pred.streaming && <span className="chip">流式接收中…</span>}
            <span className="spacer" />
            <button className="btn ghost sm" onClick={() => {
              predSocket.current?.disconnect();
              setPred({ id: null, title: '', items: [], streaming: false });
            }}>关闭</button>
          </div>
          {pred.items.map((it, i) => (
            <div key={i} className="list-item" style={{ paddingLeft: 0 }}>
              <span className="pill">{Math.round((it.probability || 0) * 100)}%</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600 }}>{it.title}</div>
                <small className="muted">{it.category} · {it.company || '通用'}</small>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="card">
        {items.map((q) => (
          <div className="list-item" key={q.id}>
            <button className="btn ghost sm" onClick={() => toggle(q.id, 'fav')}>{q.favorited ? '★' : '☆'}</button>
            <div style={{ flex: 1, minWidth: 0, cursor: 'pointer' }} onClick={() => setDetail(q)}>
              <div style={{ fontWeight: 600 }}>{q.questionText}</div>
              <small>{q.company} · {q.tags.join('/')} · 出现 {q.askedCount} 次</small>
            </div>
            <button className="btn ghost sm" onClick={() => toggle(q.id, 'met')}>{q.met ? '已遇到' : '标记遇到'}</button>
          </div>
        ))}
      </div>
      {detail && (
        <div className="card pad" style={{ marginTop: 14 }}>
          <div className="row"><b>{detail.questionText}</b><span className="spacer" /><button className="btn ghost sm" onClick={() => setDetail(null)}>关闭</button></div>
          <div className="divider" />
          <Markdown text={detail.answer} />
        </div>
      )}
    </>
  );
}

/* ───────────── 资料库 ───────────── */
function MaterialPage({ notice }) {
  const [materials, setMaterials] = useState([]);
  const [libs, setLibs] = useState([]);
  const [active, setActive] = useState(null);
  const [entry, setEntry] = useState({ question: '', answer: '' });
  const [lib, setLib] = useState(null);

  const load = () => {
    api.query('material.getMaterials').then(setMaterials).catch(() => {});
    api.query('material.listOfficialLibraries').then(setLibs).catch(() => {});
  };
  useEffect(load, []);

  const open = async (id) => setActive(await api.query('material.getMaterial', { root: id }).catch((e) => { notice(e.message); return null; }));

  const create = async () => {
    const name = prompt('资料名称');
    if (!name) return;
    const m = await api.mutate('material.saveMaterial', { name, content: '' }).catch((e) => (notice(e.message), null));
    if (m) { load(); notice('已创建'); }
  };

  const addEntry = async () => {
    if (!active || !entry.question) return;
    await api.mutate('material.saveEntry', { materialId: active.id, ...entry }).catch((e) => notice(e.message));
    setEntry({ question: '', answer: '' });
    open(active.id);
  };

  return (
    <>
      <div className="page-title"><h1>资料库</h1><span className="muted">知识库会以【知识库：名称】正文格式注入答题提示词</span></div>
      <div className="grid2">
        <div className="card">
          <div className="row" style={{ padding: 12 }}><b>我的资料</b><span className="spacer" /><button className="btn sm" onClick={create}>新建</button></div>
          <div className="divider" style={{ margin: 0 }} />
          {materials.map((m) => (
            <div className="list-item" key={m.id} style={{ cursor: 'pointer' }} onClick={() => open(m.id)}>
              <div style={{ flex: 1 }}><div style={{ fontWeight: 600 }}>{m.name}</div><small>{m.entryCount} 条 · {m.content?.length || 0} 字</small></div>
              <button className="btn ghost sm" onClick={async (e) => {
                e.stopPropagation();
                await api.mutate('material.generateEntries', { materialId: m.id }).catch((err) => notice(err.message));
                load(); notice('已生成条目');
              }}>生成</button>
            </div>
          ))}
          {!materials.length && <div style={{ padding: 16 }} className="muted">还没有资料</div>}
        </div>

        <div className="card pad col">
          <b>官方资料库</b>
          {libs.map((l) => (
            <div key={l.id} className="list-item" style={{ paddingLeft: 0, cursor: 'pointer' }} onClick={async () => setLib(await api.query('material.getOfficialLibrary', { root: l.id }))}>
              <div><div style={{ fontWeight: 600 }}>{l.name}</div><small>{l.description} · {l.entryCount} 条</small></div>
            </div>
          ))}
        </div>
      </div>

      {active && (
        <div className="card pad" style={{ marginTop: 14 }}>
          <div className="row"><b>{active.name}</b><span className="spacer" /><button className="btn ghost sm" onClick={() => setActive(null)}>关闭</button></div>
          {(active.entries || []).map((e) => (
            <div key={e.id} className="list-item" style={{ paddingLeft: 0 }}>
              <div><div style={{ fontWeight: 600 }}>{e.question}</div><small className="muted">{e.answer}</small></div>
            </div>
          ))}
          <div className="row" style={{ marginTop: 8 }}>
            <input type="text" placeholder="问题" style={{ flex: 1 }} value={entry.question} onChange={(e) => setEntry({ ...entry, question: e.target.value })} />
            <input type="text" placeholder="答案" style={{ flex: 2 }} value={entry.answer} onChange={(e) => setEntry({ ...entry, answer: e.target.value })} />
            <button className="btn sm" onClick={addEntry}>添加</button>
          </div>
        </div>
      )}

      {lib && (
        <div className="card pad" style={{ marginTop: 14 }}>
          <div className="row"><b>{lib.name}</b><span className="spacer" /><button className="btn ghost sm" onClick={() => setLib(null)}>关闭</button></div>
          {(lib.entries || []).map((e, i) => (
            <div key={i} style={{ marginTop: 8 }}><small className="muted">Q：{e.question}</small><div>{e.answer}</div></div>
          ))}
        </div>
      )}
    </>
  );
}

/* ───────────── 提示词工作室 ───────────── */
function PromptPage({ notice }) {
  const [presets, setPresets] = useState(null);
  const [scene, setScene] = useState('interview');
  const [style, setStyle] = useState('natural');
  const [question, setQuestion] = useState('请做一个自我介绍');
  const [resumes, setResumes] = useState([]);
  const [goals, setGoals] = useState([]);
  const [resumeId, setResumeId] = useState('');
  const [goalId, setGoalId] = useState('');
  const [run, setRun] = useState(null);
  const [busy, setBusy] = useState(false);
  const [assistMsg, setAssistMsg] = useState('把提示词压到 6 条规则以内，保留双段输出');

  useEffect(() => {
    api.query('promptStudio.presets', { lang: locale() }).then(setPresets).catch(() => {});
    api.query('resume.getResumes').then((r) => { setResumes(r); setResumeId(r[0]?.id || ''); }).catch(() => {});
    api.query('goal.getGoals').then((r) => { setGoals(r); setGoalId(r[0]?.id || ''); }).catch(() => {});
  }, []);

  const doRun = async () => {
    setBusy(true);
    try {
      const r = await api.mutate('promptStudio.run', {
        scene, question, resumeId, goalId, lang: locale(), answerStyle: style,
      });
      setRun(r);
    } catch (e) { notice(e.message); } finally { setBusy(false); }
  };

  const doAssist = async () => {
    try {
      const r = await api.mutate('promptStudio.assist', { scene, mode: 'refine', draft: presets?.interview?.official || '', lang: locale(), instruction: assistMsg });
      notice(`已压缩为 ${r.prompt.length} 字：${r.summary}`);
    } catch (e) { notice(e.message); }
  };

  const styles = scene === 'interview' ? presets?.interview?.styles : presets?.exam?.styles;

  return (
    <>
      <div className="page-title"><h1>提示词工作室</h1><span className="muted">官方 presets 明文 · run 回显组装后的 systemPrompt</span></div>
      <div className="grid2">
        <div className="card pad col">
          <div className="row">
            <select value={scene} onChange={(e) => setScene(e.target.value)}>
              <option value="interview">面试答题</option><option value="exam">笔试答题</option>
            </select>
            <select value={style} onChange={(e) => setStyle(e.target.value)}>
              {(styles || []).map((s) => <option key={s.value} value={s.value}>{s.value}</option>)}
            </select>
          </div>
          <div className="field"><label>问题 / 题面</label><textarea value={question} onChange={(e) => setQuestion(e.target.value)} /></div>
          <div className="grid2">
            <div className="field"><label>简历</label>
              <select value={resumeId} onChange={(e) => setResumeId(e.target.value)}>
                <option value="">不注入</option>{resumes.map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}
              </select></div>
            <div className="field"><label>岗位</label>
              <select value={goalId} onChange={(e) => setGoalId(e.target.value)}>
                <option value="">不注入</option>{goals.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select></div>
          </div>
          <div className="row">
            <button className="btn primary" disabled={busy} onClick={doRun}>{busy ? '运行中…' : '试运行'}</button>
            <input type="text" style={{ flex: 1 }} value={assistMsg} onChange={(e) => setAssistMsg(e.target.value)} />
            <button className="btn" onClick={doAssist}>AI 改写</button>
          </div>
          <small className="muted">限流：run 6 次/分、assist 3 次/分（对齐官方实测）。</small>
        </div>

        <div className="card pad col">
          <b>官方提示词</b>
          <div className="tiny muted">
            {presets ? `official ${presets.interview?.official?.length || 0} 字 · 预设 ${presets.examPresets?.length || 0} 个 · 上限 ${presets.maxLength} 字` : '加载中'}
          </div>
          <div className="card pad" style={{ boxShadow: 'none', background: 'var(--panel-2)', maxHeight: 300, overflow: 'auto' }}>
            <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, margin: 0 }}>{(scene === 'interview' ? presets?.interview?.official : presets?.exam?.official) || ''}</pre>
          </div>
        </div>
      </div>

      {run && (
        <div className="grid2" style={{ marginTop: 14 }}>
          <div className="card pad">
            <div className="row"><b>组装后的 systemPrompt</b><span className="chip">{run.systemPrompt?.length || 0} 字</span></div>
            <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12.5, maxHeight: 420, overflow: 'auto' }}>{run.systemPrompt || '（exam 场景服务端不回显）'}</pre>
          </div>
          <div className="card pad">
            <div className="row"><b>答案</b><span className="chip">{run.totalMs}ms</span></div>
            <Markdown text={run.answer || ''} />
            {run.knowledge && <small className="muted">知识库注入：{run.knowledge.materials?.map((m) => m.name).join('、')}（{run.knowledge.mode} / {run.knowledge.totalChars} 字）</small>}
          </div>
        </div>
      )}
    </>
  );
}

/* ───────────── 隐蔽与防检测 ───────────── */
const HK_LABELS = {
  panic: 'panic 隐藏/恢复全部窗口',
  'toggle-overlay': '浮窗显示/隐藏',
  'close-overlay': '关闭所有浮窗',
  quit: '退出桌面端',
};

function StealthPage({ notice, hotkeys }) {
  const [state, setState] = useState(null);
  const [hk, setHk] = useState(hotkeys || null);
  const loadHotkeys = () => window.__ORANGE_INVOKE__?.('hotkeys.status')?.then(setHk).catch(() => { /* 浏览器模式 */ });
  useEffect(() => { setHk(hotkeys || null); }, [hotkeys]);
  useEffect(() => { loadHotkeys(); }, []);
  const [disguise, setDisguise] = useState(localStorage.getItem('stealth.disguiseTitle') || '');
  const [busy, setBusy] = useState(false);
  const [audio, setAudio] = useState({ running: false, level: 0, devices: null });
  const [procName, setProcName] = useState('notepad');

  const load = () => stealthState().then(setState).catch(() => setState({ browser: true }));
  useEffect(() => { load(); }, []); // eslint-disable-line
  // P2：离开隐蔽页时停止 WASAPI 采集，避免系统音频长期运行
  useEffect(() => () => { try { window.orangeNative?.audioStop?.(); } catch { /* ignore */ } }, []);

  // 原生事件：音频电平 / 焦点变化
  useEffect(() => {
    const onEvt = (ev) => {
      const d = ev.detail || {};
      if (d.event === 'audio-level') setAudio((a) => ({ ...a, level: Number(d.payload) || 0 }));
      if (d.event === 'audio-error') { setAudio((a) => ({ ...a, running: false })); notice(`音频采集失败：${d.payload}`); }
      if (d.event === 'focus-changed') console.info('[focus]', d.payload);
    };
    window.addEventListener('interview-orange', onEvt);
    return () => window.removeEventListener('interview-orange', onEvt);
  }, []); // eslint-disable-line

  const startAudio = async () => {
    const nat = window.orangeNative;
    if (!nat?.audioStart) return notice('系统音频采集需要 Rust 原生壳');
    try {
      const dev = await nat.audioDevices?.();
      await nat.audioStart({ minLevel: 0 });
      setAudio({ running: true, level: 0, devices: dev });
      notice('WASAPI 环回采集已启动（听面试官的声音）');
    } catch (e) { notice(`启动失败：${e.message}`); }
  };
  const stopAudio = async () => {
    await window.orangeNative?.audioStop?.();
    setAudio((a) => ({ ...a, running: false, level: 0 }));
    notice('已停止音频采集');
  };

  const toggleProtection = async (kind) => {
    if (busy) return;
    setBusy(true);
    try {
      const cur = state?.contentProtection?.[kind] ?? false;
      const r = await setContentProtection(kind, !cur);
      if (r) {
        // 原生壳返回完整映射时直接用；旧版只回 {ok,kind,enable} 时按本次参数更新该键，
        // 绝不把返回值整体当成 contentProtection 写入（那会让勾选框立刻回退）
        if (r.contentProtection && typeof r.contentProtection === 'object') {
          setState((s) => ({ ...(s || {}), contentProtection: r.contentProtection }));
        } else {
          const applied = typeof r.enable === 'boolean' ? r.enable : !cur;
          setState((s) => ({
            ...(s || {}),
            contentProtection: { ...(s?.contentProtection || {}), [kind]: applied },
          }));
        }
        if (r.ok === false) notice('防截屏未能生效（系统/显卡不支持，或窗口尚未就绪）');
      } else {
        notice('防截屏需要桌面端（双击 启动.bat 用 Rust 原生壳）');
      }
    } finally { setBusy(false); }
  };

  const applyDisguiseNow = async () => {
    localStorage.setItem('stealth.disguiseTitle', disguise);
    await disguiseTitle(disguise || '面试橙');
    notice(disguise ? `窗口标题已伪装为「${disguise}」` : '窗口标题已还原');
  };

  const cp = state?.contentProtection || { main: false, overlay: false };

  return (
    <>
      <div className="page-title"><h1>隐蔽与防检测</h1><span className="muted">对照文档 05/15/24：WDA 防截屏 · 窗口伪装 · 任务栏隐藏 · panic</span></div>
      <div className="grid2">
        <div className="card pad col">
          <b>WDA 防截屏（SetWindowDisplayAffinity）</b>
          <small className="muted">
            开启后该窗口不出现在截图/录屏/共享画面里（Win10 2004+ 的 EXCLUDEFROMCAPTURE）。
            注意：浮窗是**真透明**窗口，开启防截屏后部分显卡/DWM 组合会把它渲染成黑块——
            两者在系统层互斥，默认关闭以保透明；需要隐蔽时再开。
          </small>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span>浮窗防截屏</span>
            <label className="row"><input type="checkbox" checked={!!cp.overlay} disabled={busy || !isNative} onChange={() => toggleProtection('overlay')} /> {cp.overlay ? '已开启' : '关闭'}</label>
          </div>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span>主窗防截屏</span>
            <label className="row"><input type="checkbox" checked={!!cp.main} disabled={busy || !isNative} onChange={() => toggleProtection('main')} /> {cp.main ? '已开启' : '关闭'}</label>
          </div>
          {!isNative && <small className="muted">当前在浏览器模式：WDA 需要 Rust 原生壳（native\run.ps1）。</small>}
          <div className="divider" />
          <b>系统音频环回采集（WASAPI）</b>
          <small className="muted">直接采系统输出（面试官声音），不经麦克风；电平实时回传。</small>
          <div className="row">
            <button className="btn sm" disabled={!isNative || audio.running} onClick={startAudio}>开始采集</button>
            <button className="btn sm" disabled={!audio.running} onClick={stopAudio}>停止</button>
            <span className="spacer" />
            <span className="chip">{audio.running ? `电平 ${audio.level.toFixed(1)}` : '未采集'}</span>
          </div>
          <div style={{ height: 8, background: 'var(--line)', borderRadius: 4, overflow: 'hidden' }}>
            <div style={{ width: `${Math.min(100, audio.level * 4)}%`, height: '100%', background: 'var(--accent)', transition: 'width .12s' }} />
          </div>
          <div className="divider" />
          <b>主窗隐藏任务栏（stealth.hideFromTaskbar）</b>
          <div className="row">
            <button className="btn sm" disabled={!isNative} onClick={async () => { await setSkipTaskbar(true); notice('主窗已从任务栏隐藏（窗口仍在）'); }}>隐藏</button>
            <button className="btn sm" disabled={!isNative} onClick={async () => { await setSkipTaskbar(false); notice('已恢复任务栏显示'); }}>恢复</button>
          </div>
        </div>

        <div className="card pad col">
          <b>窗口伪装（disguise）</b>
          <small className="muted">改窗口标题；进程名/版本信息/图标级伪装需原生壳，见 RUN.md 边界。</small>
          <div className="field">
            <label>伪装标题</label>
            <div className="row">
              <input type="text" style={{ flex: 1 }} value={disguise} placeholder="如：记事本" onChange={(e) => setDisguise(e.target.value)} />
              <button className="btn sm" onClick={applyDisguiseNow}>应用</button>
            </div>
          </div>
          <div className="divider" />
          <b>进程级伪装（复制自身为指定文件名）</b>
          <small className="muted">生成一份可独立运行的 exe 副本（进程名/文件名即伪装名）；PE 版本信息与图标改写见 RUN.md 边界。</small>
          <div className="row">
            <input type="text" style={{ flex: 1 }} value={procName} onChange={(e) => setProcName(e.target.value)} placeholder="如：notepad" />
            <button className="btn sm" disabled={!window.orangeNative?.disguiseProcess} onClick={async () => {
              try {
                const r = await window.orangeNative.disguiseProcess(procName, false);
                notice(`已生成伪装副本：${r.path}`);
              } catch (e) { notice(`失败：${e.message}`); }
            }}>生成副本</button>
          </div>
          <div className="divider" />
          <b>panic 紧急隐藏</b>
          <small className="muted">
            全局热键 <span className="mono">{hk?.hotkey || '（未注册）'}</span>：一键隐藏全部窗口（并开启防截屏），再按一次恢复。
            {isNative && !hk?.hotkey && <span style={{ color: '#c0392b' }}> 当前未注册成功，请到设置页重新保存或关闭其它实例。</span>}
          </small>
          <div className="row">
            <button className="btn" disabled={!isNative} onClick={async () => { const n = await panicToggle(); notice(n ? `已隐藏 ${n} 个窗口（${hk?.hotkey || '热键'} 恢复）` : '已恢复'); load(); }}>立即隐藏 / 恢复</button>
          </div>
          <div className="divider" />
          <b>热键速查（实际注册状态）</b>
          <div className="tiny muted col" style={{ gap: 2 }}>
            {hk?.items?.length ? hk.items.map((it) => (
              <div key={`${it.action}-${it.id}`} style={it.ok ? undefined : { color: '#c0392b' }}>
                <span className="mono">{it.accel || '—'}</span> {HK_LABELS[it.action] || it.action}
                {it.ok ? '（已注册）' : `（未注册：可能被其它实例或程序占用，Win32 错误 ${it.error ?? '?'}）`}
              </div>
            )) : <div>正在读取热键状态…（浏览器模式无可注册热键）</div>}
          </div>
          {hk?.failed?.length > 0 && (
            <small style={{ color: '#c0392b' }}>有 {hk.failed.length} 项热键未注册；关闭占用它们的程序后到设置页重新保存即可恢复。</small>
          )}
          {state?.browser && <small className="muted">浏览器模式：仅热键中「浮窗显隐」由页面内 Esc 双击提供，其余需桌面端。</small>}
        </div>
      </div>
    </>
  );
}

/* ───────────── 设置 ───────────── */
function SettingsPage({ user, notice, reloadUser }) {
  const [lang, setLang] = useState(locale());
  const [style, setStyleState] = useState(user.clientSettings?.overlayStyle || {});
  // 实时预览：设置页每次调整都经 bus 推给已打开的浮窗（原生壳跨 webview 已验证可用）；
  // 保存仍走 user.updateClientSettings 持久化，两者不冲突。
  const styleTimer = useRef(null);
  const setStyle = (next) => {
    setStyleState(next);
    clearTimeout(styleTimer.current);
    styleTimer.current = setTimeout(() => {
      overlayWindow.push({ type: 'overlay-style', style: next });
    }, 120);
  };
  useEffect(() => () => clearTimeout(styleTimer.current), []);
  // P1-4：默认与实际注册的 panic 热键一致（原生壳默认 Ctrl+Alt+Esc）
  const [panic, setPanic] = useState(user.clientSettings?.panicHotkey || 'Ctrl+Alt+Esc');
  const [busy, setBusy] = useState(false);
  const [env, setEnv] = useState(null);
  useEffect(() => { fetch('/healthz').then((r) => r.json()).then(setEnv).catch(() => {}); }, []);

  /* ── AI 接入运行时配置（settings.ai.*）：写 DB + 热切换，不需要重启 ── */
  const [aiInfo, setAiInfo] = useState(null);
  const [aiForm, setAiForm] = useState(null);
  const [aiProbe, setAiProbe] = useState(null);
  const [aiBusy, setAiBusy] = useState(false);

  const fillAI = (r) => {
    setAiInfo(r);
    setAiForm({
      provider: r.provider, baseUrl: r.baseUrl, model: r.model,
      visionModel: r.visionModel, temperature: r.temperature, apiKey: '',
    });
  };
  const refreshHealth = () => fetch('/healthz').then((r) => r.json()).then(setEnv).catch(() => {});

  useEffect(() => {
    api.query('settings.ai.get').then(fillAI).catch((e) => notice(`读取 AI 配置失败：${e.message}`));
  }, []);

  const aiPayload = () => {
    const p = {
      provider: aiForm.provider,
      baseUrl: aiForm.baseUrl,
      model: aiForm.model,
      visionModel: aiForm.visionModel,
      temperature: Number(aiForm.temperature),
    };
    if (String(aiForm.apiKey || '').trim()) p.apiKey = aiForm.apiKey.trim();
    return p;
  };

  const aiSave = async () => {
    setAiBusy(true);
    try {
      const r = await api.mutate('settings.ai.set', aiPayload());
      fillAI(r);
      refreshHealth();
      notice(`AI 配置已保存并热切换：provider=${r.provider}${r.hasKey ? '（Key 已保存）' : '（未配置 Key）'}`);
    } catch (e) { notice(e.message); } finally { setAiBusy(false); }
  };

  const aiTest = async () => {
    setAiBusy(true);
    setAiProbe(null);
    try {
      const r = await api.mutate('settings.ai.probe', aiPayload());
      setAiProbe(r);
      const bad = (r.checks || []).find((c) => !c.ok);
      notice(r.ok ? `连通性自检通过（${r.latencyMs}ms）` : `自检未通过：${r.error || bad?.detail || '未知原因'}`);
    } catch (e) {
      setAiProbe({ ok: false, checks: [{ name: 'request', ok: false, detail: e.message }] });
      notice(e.message);
    } finally { setAiBusy(false); }
  };

  const aiReset = async () => {
    setAiBusy(true);
    try {
      const r = await api.mutate('settings.ai.reset', {});
      fillAI(r);
      refreshHealth();
      notice('已回退到 .env / 出厂默认配置');
    } catch (e) { notice(e.message); } finally { setAiBusy(false); }
  };

  const aiClearKey = async () => {
    setAiBusy(true);
    try {
      const r = await api.mutate('settings.ai.set', { clearApiKey: true, provider: 'mock' });
      fillAI(r);
      refreshHealth();
      notice('API Key 已清除，provider 回落 mock');
    } catch (e) { notice(e.message); } finally { setAiBusy(false); }
  };

  /* ── ASR 语音识别运行时配置（settings.asr.*）：同一套覆盖机制，独立 section ── */
  const [asrInfo, setAsrInfo] = useState(null);
  const [asrForm, setAsrForm] = useState(null);
  const [asrProbe, setAsrProbe] = useState(null);
  const [asrBusy, setAsrBusy] = useState(false);

  const fillASR = (r) => {
    setAsrInfo(r);
    setAsrForm({
      provider: r.provider, baseUrl: r.baseUrl, model: r.model,
      silenceGateMs: r.silenceGateMs, maxUtteranceMs: r.maxUtteranceMs, apiKey: '',
    });
  };

  useEffect(() => {
    api.query('settings.asr.get').then(fillASR).catch((e) => notice(`读取 ASR 配置失败：${e.message}`));
  }, []);

  const asrPayload = () => {
    const p = {
      provider: asrForm.provider,
      baseUrl: asrForm.baseUrl,
      model: asrForm.model,
      silenceGateMs: Number(asrForm.silenceGateMs),
      maxUtteranceMs: Number(asrForm.maxUtteranceMs),
    };
    if (String(asrForm.apiKey || '').trim()) p.apiKey = asrForm.apiKey.trim();
    return p;
  };

  const asrSave = async () => {
    setAsrBusy(true);
    try {
      const r = await api.mutate('settings.asr.set', asrPayload());
      fillASR(r);
      refreshHealth();
      notice(`语音识别已保存并热切换：provider=${r.provider} · ${r.task === 'real' ? '真实转写' : '本地替身'}`);
    } catch (e) { notice(e.message); } finally { setAsrBusy(false); }
  };

  const asrTest = async () => {
    setAsrBusy(true);
    setAsrProbe(null);
    try {
      const r = await api.mutate('settings.asr.probe', asrPayload());
      setAsrProbe(r);
      const bad = (r.checks || []).find((c) => !c.ok);
      notice(r.ok ? `ASR 自检通过（${r.latencyMs}ms）` : `ASR 自检未通过：${r.error || bad?.detail || '未知原因'}`);
    } catch (e) {
      setAsrProbe({ ok: false, checks: [{ name: 'request', ok: false, detail: e.message }] });
      notice(e.message);
    } finally { setAsrBusy(false); }
  };

  const asrReset = async () => {
    setAsrBusy(true);
    try {
      const r = await api.mutate('settings.asr.reset', {});
      fillASR(r);
      refreshHealth();
      notice('语音识别已回退到 .env / 出厂默认配置');
    } catch (e) { notice(e.message); } finally { setAsrBusy(false); }
  };

  const asrClearKey = async () => {
    setAsrBusy(true);
    try {
      const r = await api.mutate('settings.asr.set', { clearApiKey: true, provider: 'mock' });
      fillASR(r);
      refreshHealth();
      notice('ASR Key 已清除，语音识别回落本地替身');
    } catch (e) { notice(e.message); } finally { setAsrBusy(false); }
  };

  const save = async () => {
    setBusy(true);
    try {
      await api.mutate('user.updateClientSettings', { overlayStyle: style, panicHotkey: panic, locale: lang });
      saveLocale(lang);
      // P1-4：保存后把 panic 热键热注册进原生壳（不重启即生效），并回显实际注册结果
      try {
        const r = await window.orangeNative?.hotkeys?.([{ accel: panic, action: 'panic' }]);
        const items = (r?.registered || []).filter((i) => i.ok !== false);
        const failed = r?.failed || [];
        notice(items.length > 0
          ? `设置已保存；panic 热键已注册：${items.map((i) => i.accel).join('、')}${failed.length ? `；另有 ${failed.length} 项被占用未注册` : ''}`
          : `设置已保存；panic 热键未注册${failed.length ? '（可能被其它实例占用）' : '（无修饰键组合如 Esc+Esc 只能在浮窗内双击 Esc 触发）'}`);
      } catch (e) {
        notice(`设置已保存（客户端 1s 防抖提交）；热键注册失败：${e.message}`);
      }
      await reloadUser();
    } catch (e) { notice(e.message); } finally { setBusy(false); }
  };

  const exportCfg = () => {
    const payload = {
      exportedAt: new Date().toISOString(),
      version: '1.0.0',
      clientSettings: user.clientSettings,
      examCustomization: user.examCustomization,
      interviewPreference: user.interviewPreference,
      // P2：过滤所有 token / token_<region>，避免把凭证写进导出文件
      local: Object.fromEntries(Object.keys(localStorage)
        .filter((k) => !/^token(_|$)/.test(k))
        .map((k) => [k, localStorage.getItem(k)])),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    const href = URL.createObjectURL(blob);
    a.href = href;
    a.download = 'interview-orange-config.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(href), 2000); // P2：过早 revoke 会让部分环境下载失败
  };

  const importCfg = async (file) => {
    try {
      const cfg = JSON.parse(await file.text());
      if (cfg.clientSettings) await api.mutate('user.updateClientSettings', cfg.clientSettings);
      if (cfg.examCustomization) await api.mutate('user.updateExamCustomization', cfg.examCustomization);
      if (cfg.interviewPreference) await api.mutate('user.updateInterviewPreference', cfg.interviewPreference);
      // P2：local 段真正回写（过滤 token 类键）
      if (cfg.local && typeof cfg.local === 'object') {
        for (const [k, v] of Object.entries(cfg.local)) {
          if (/^token(_|$)/.test(k) || typeof v !== 'string') continue;
          localStorage.setItem(k, v);
        }
      }
      await reloadUser();
      notice('配置已导入（逐字段校验通过）');
    } catch (e) { notice(`导入失败：${e.message}`); }
  };

  const num = (key, label, min, max, step = 0.05) => (
    <div className="field" key={key}>
      <label>{label}：{String(style[key])}</label>
      <input type="range" min={min} max={max} step={step} value={style[key] ?? min}
        onChange={(e) => setStyle({ ...style, [key]: Number(e.target.value) })} />
    </div>
  );

  return (
    <>
      <div className="page-title"><h1>设置</h1><span className="muted">浮窗样式 / 热键 / 配置导入导出</span></div>
      <div className="grid2">
        <div className="card pad col">
          <b>浮窗样式（overlay.style）</b>
          <div className="row">
            <div className="field" style={{ flex: 1 }}><label>主题</label>
              <select value={style.theme || 'light'} onChange={(e) => setStyle({ ...style, theme: e.target.value })}>
                <option value="light">light</option><option value="dark">dark</option>
              </select>
            </div>
            <div className="field" style={{ flex: 1 }}><label>语言</label>
              <select value={lang} onChange={(e) => setLang(e.target.value)}>
                {LOCALES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
          </div>
          {num('examBgOpacity', '笔试背景透明度', 0.1, 1)}
          {num('interviewBgOpacity', '面试背景透明度', 0.1, 1)}
          {num('examTextOpacity', '笔试文字透明度', 0.3, 1)}
          {num('interviewTextOpacity', '面试文字透明度', 0.3, 1)}
          {num('fontScale', '字号缩放', 0.3, 2, 0.05)}
          {num('scrollSpeed', '滚动速度', 0.05, 3, 0.05)}
          <div className="row">
            <label className="tiny"><input type="checkbox" checked={style.textHalo !== false} onChange={(e) => setStyle({ ...style, textHalo: e.target.checked })} /> 文字描边</label>
            <label className="tiny"><input type="checkbox" checked={!!style.textBold} onChange={(e) => setStyle({ ...style, textBold: e.target.checked })} /> 加粗</label>
          </div>
          <div className="grid2">
            <div className="field"><label>笔试浮窗宽</label>
              <input type="number" value={style.examWidth ?? 420} onChange={(e) => setStyle({ ...style, examWidth: Number(e.target.value) })} /></div>
            <div className="field"><label>笔试浮窗高</label>
              <input type="number" value={style.examHeight ?? 520} onChange={(e) => setStyle({ ...style, examHeight: Number(e.target.value) })} /></div>
          </div>
          <div className="field"><label>紧急隐藏热键（panic）</label>
            <input type="text" value={panic} onChange={(e) => setPanic(e.target.value)} placeholder="Ctrl+Alt+Esc" />
            <small className="muted">需含 Ctrl/Alt/Shift/Win 至少一个修饰键才会全局注册（如 Ctrl+Alt+P）；无修饰键组合（如 Esc+Esc）不会注册，仅浮窗内双击 Esc 生效。</small>
          </div>
          <div className="row">
            <button className="btn primary" disabled={busy} onClick={save}>保存</button>
            <button className="btn" onClick={() => overlayWindow.open({ mode: 'interview', style })}>打开浮窗预览</button>
          </div>
        </div>

        <div className="card pad col">
          <b>配置导入导出</b>
          <small className="muted">对齐 wk()/kk()：导出为单 JSON，导入逐字段校验。</small>
          <div className="row">
            <button className="btn" onClick={exportCfg}>导出配置</button>
            <label className="btn" style={{ cursor: 'pointer' }}>
              导入配置
              <input type="file" accept="application/json" hidden onChange={(e) => { const f = e.target.files[0]; if (f) importCfg(f).finally(() => { e.target.value = ''; }); }} />
            </label>
          </div>
          <div className="divider" />
          <b>本地档案</b>
          <div className="tiny muted">
            <div>档案：<span className="mono">{user.id}</span></div>
            <div>账号模块已移除：本地单用户，无需登录/订阅</div>
          </div>
          <div className="divider" />
          <b>本地环境</b>
          <div className="tiny muted">
            <div>
              AI 引擎：{env
                ? (env.provider === 'mock'
                  ? '本地 mock 大脑（离线；在下方 AI 接入填 Key 可切真模型）'
                  : `真实模型 ${env.model || ''}（来源 ${env.providerSource === 'settings' ? '设置页' : '.env'}）`.trim())
                : '读取中…'}
            </div>
            <div>语音识别：{env ? (env.asr === 'mock' ? '本地替身（未配 ASR key，可在下方卡片切换）' : `${env.asr}${env.asrSource === 'settings' ? '（设置页覆盖）' : ''}`) : '读取中…'}</div>
            <div>服务：http://127.0.0.1:8756（{env?.version || ''}）</div>
            <div>数据目录：./data/app.db（SQLite 单文件，整目录可搬迁）</div>
          </div>
          <div className="divider" />
          <b>提示词缓存</b>
          <button className="btn sm" onClick={() => { localStorage.removeItem('prompts.cache'); notice('已清空本地提示词缓存'); }}>清空</button>
        </div>
      </div>

      <div className="card pad col" style={{ marginTop: 14 }}>
        <b>AI 接入（运行时配置中心）</b>
        <small className="muted">
          写入 data/app.db 并立即热切换（无需重启服务）；API Key 留空表示「保留原值」，服务端只回掩码。
          当前来源：{aiInfo ? (aiInfo.source === 'settings' ? `设置页覆盖（${aiInfo.savedKeys.length} 个字段）` : '.env / 出厂默认') : '读取中…'}
          {aiInfo?.updatedAt ? ` · 更新于 ${new Date(aiInfo.updatedAt).toLocaleString()}` : ''}
        </small>
        {aiForm ? (
          <>
            {aiInfo?.modelsLocked && (
              <small className="muted" style={{ marginBottom: 8 }}>
                网关与模型已内置：{aiInfo.builtin?.baseUrl} · {aiInfo.builtin?.model} / {aiInfo.builtin?.visionModel}。
                只需粘贴 API Key 并保存即可；如需更换请编辑 .env（ML_LOCK_MODELS=0）。
              </small>
            )}
            <div className="row" style={{ alignItems: 'flex-end' }}>
              <div className="field" style={{ flex: 2 }}>
                <label>provider</label>
                <select value={aiForm.provider} onChange={(e) => setAiForm({ ...aiForm, provider: e.target.value })}>
                  <option value="mock">mock（离线确定性大脑，零外网）</option>
                  <option value="openai">openai（任意 OpenAI 兼容网关）</option>
                </select>
              </div>
              <div className="field" style={{ flex: 1 }}>
                <label>temperature</label>
                <input type="number" min="0" max="2" step="0.05" value={aiForm.temperature}
                  onChange={(e) => setAiForm({ ...aiForm, temperature: e.target.value })} />
              </div>
            </div>
            <div className="field">
              <label>Base URL（含 /v1，末尾斜杠自动去掉）</label>
              <input value={aiForm.baseUrl} placeholder="https://api.openai.com/v1"
                disabled={!!aiInfo?.modelsLocked}
                onChange={(e) => setAiForm({ ...aiForm, baseUrl: e.target.value })} />
            </div>
            <div className="field">
              <label>API Key {aiInfo?.hasKey ? `（已保存 ${aiInfo.apiKeyMasked}，留空不修改）` : '（未配置）'}</label>
              <input type="password" autoComplete="off" value={aiForm.apiKey}
                placeholder={aiInfo?.hasKey ? '留空保留原 Key' : '粘贴 Key 即启用真实模型'}
                onChange={(e) => {
                  const v = e.target.value;
                  setAiForm((f) => ({ ...f, apiKey: v, ...(v.trim() && f.provider === 'mock' ? { provider: 'openai' } : {}) }));
                }} />
            </div>
            <div className="grid2">
              <div className="field">
                <label>文本模型（面试/笔试答题）</label>
                <input value={aiForm.model} placeholder="deepseek-v4.1-flash"
                  disabled={!!aiInfo?.modelsLocked}
                  onChange={(e) => setAiForm({ ...aiForm, model: e.target.value })} />
              </div>
              <div className="field">
                <label>视觉模型（笔试截图题面）</label>
                <input value={aiForm.visionModel} placeholder="qwen3.5-omni-flash"
                  disabled={!!aiInfo?.modelsLocked}
                  onChange={(e) => setAiForm({ ...aiForm, visionModel: e.target.value })} />
              </div>
            </div>
            <div className="row">
              <button className="btn primary" disabled={aiBusy} onClick={aiSave}>保存并热切换</button>
              <button className="btn" disabled={aiBusy} onClick={aiTest}>连通性自检</button>
              <button className="btn" disabled={aiBusy} onClick={aiReset}>回退 .env</button>
              {aiInfo?.hasKey && <button className="btn sm" disabled={aiBusy} onClick={aiClearKey}>清除 Key</button>}
            </div>
            {aiProbe && (
              <div className="tiny" style={{ marginTop: 10 }}>
                <div>
                  <b>{aiProbe.ok ? '✅ 自检通过' : '❌ 自检未通过'}</b>
                  {` · ${aiProbe.provider || ''}`}
                  {typeof aiProbe.latencyMs === 'number' ? ` · ${aiProbe.latencyMs}ms` : ''}
                  {aiProbe.model ? ` · ${aiProbe.model}` : ''}
                </div>
                {(aiProbe.checks || []).map((c) => (
                  <div key={c.name} className="mono" style={{ color: c.ok ? undefined : '#dc2626', opacity: c.ok ? 0.8 : 1 }}>
                    {c.ok ? '✓' : '✗'} {c.name}: {c.detail}
                  </div>
                ))}
                {aiProbe.reply && <div>回包：<span className="mono">{aiProbe.reply}</span></div>}
                {aiProbe.models?.length > 0 && (
                  <div className="muted">目录预览：{aiProbe.models.slice(0, 6).join(', ')}{aiProbe.models.length > 6 ? ' …' : ''}</div>
                )}
              </div>
            )}
            <small className="muted" style={{ marginTop: 8 }}>
              自检真发一次 1-token 补全（验 Key 权限 + 模型名有效性），不落库、不改当前生效配置。
            </small>
          </>
        ) : <small className="muted">读取中…</small>}
      </div>

      <div className="card pad col" style={{ marginTop: 14 }}>
        <b>语音识别（运行时配置中心）</b>
        <small className="muted">
          与 AI 接入同一套覆盖机制，独立 section（app_settings.key = asr）；保存后新的语音连接即按新配置切句/转写。
          当前：{asrInfo ? `${asrInfo.task === 'real' ? '真实转写' : '本地替身'} · ${asrInfo.source === 'settings' ? `设置页覆盖（${asrInfo.savedKeys.length} 个字段）` : '.env / 出厂默认'}` : '读取中…'}
          {asrInfo?.updatedAt ? ` · 更新于 ${new Date(asrInfo.updatedAt).toLocaleString()}` : ''}
        </small>
        {asrForm ? (
          <>
            {asrInfo?.modelsLocked && (
              <small className="muted" style={{ marginBottom: 8 }}>
                网关与模型已内置：{asrInfo.builtin?.baseUrl} · {asrInfo.builtin?.model}。
                只需粘贴语音识别 Key 并保存；不填则使用本地替身。
              </small>
            )}
            <div className="row" style={{ alignItems: 'flex-end' }}>
              <div className="field" style={{ flex: 2 }}>
                <label>provider</label>
                <select value={asrForm.provider} onChange={(e) => setAsrForm({ ...asrForm, provider: e.target.value })}>
                  <option value="mock">mock（本地替身，零外网）</option>
                  <option value="qianwen">qianwen（chat/completions + input_audio）</option>
                </select>
              </div>
              <div className="field" style={{ flex: 1 }}>
                <label>静音收句门限（ms）</label>
                <input type="number" min="200" max="6000" step="100" value={asrForm.silenceGateMs}
                  onChange={(e) => setAsrForm({ ...asrForm, silenceGateMs: e.target.value })} />
              </div>
              <div className="field" style={{ flex: 1 }}>
                <label>单句最长（ms）</label>
                <input type="number" min="1000" max="120000" step="1000" value={asrForm.maxUtteranceMs}
                  onChange={(e) => setAsrForm({ ...asrForm, maxUtteranceMs: e.target.value })} />
              </div>
            </div>
            <div className="field">
              <label>Base URL（含 /v1）</label>
              <input value={asrForm.baseUrl} placeholder="https://maas.qianwenaiapi.com/compatible-mode/v1"
                disabled={!!asrInfo?.modelsLocked}
                onChange={(e) => setAsrForm({ ...asrForm, baseUrl: e.target.value })} />
            </div>
            <div className="field">
              <label>API Key {asrInfo?.hasKey ? `（已保存 ${asrInfo.apiKeyMasked}，留空不修改）` : '（未配置）'}</label>
              <input type="password" autoComplete="off" value={asrForm.apiKey}
                placeholder={asrInfo?.hasKey ? '留空保留原 Key' : '粘贴 Key 即启用真实转写'}
                onChange={(e) => {
                  const v = e.target.value;
                  setAsrForm((f) => ({ ...f, apiKey: v, ...(v.trim() && f.provider === 'mock' ? { provider: 'qianwen' } : {}) }));
                }} />
            </div>
            <div className="field">
              <label>转写模型</label>
              <input value={asrForm.model} placeholder="qwen3.5-omni-flash"
                disabled={!!asrInfo?.modelsLocked}
                onChange={(e) => setAsrForm({ ...asrForm, model: e.target.value })} />
            </div>
            <div className="row">
              <button className="btn primary" disabled={asrBusy} onClick={asrSave}>保存并热切换</button>
              <button className="btn" disabled={asrBusy} onClick={asrTest}>连通性自检</button>
              <button className="btn" disabled={asrBusy} onClick={asrReset}>回退 .env</button>
              {asrInfo?.hasKey && <button className="btn sm" disabled={asrBusy} onClick={asrClearKey}>清除 Key</button>}
            </div>
            {asrProbe && (
              <div className="tiny" style={{ marginTop: 10 }}>
                <div>
                  <b>{asrProbe.ok ? '✅ 自检通过' : '❌ 自检未通过'}</b>
                  {` · ${asrProbe.provider || ''}`}
                  {typeof asrProbe.latencyMs === 'number' ? ` · ${asrProbe.latencyMs}ms` : ''}
                  {asrProbe.model ? ` · ${asrProbe.model}` : ''}
                </div>
                {(asrProbe.checks || []).map((c) => (
                  <div key={c.name} className="mono" style={{ color: c.ok ? undefined : '#dc2626', opacity: c.ok ? 0.8 : 1 }}>
                    {c.ok ? '✓' : '✗'} {c.name}: {c.detail}
                  </div>
                ))}
                {asrProbe.text ? <div>回包：<span className="mono">{asrProbe.text}</span></div> : null}
              </div>
            )}
            <small className="muted" style={{ marginTop: 8 }}>
              自检真发一段 0.4s 静音 WAV 走 input_audio 通道（验 Key 权限 + 网关是否支持音频块 + 模型名），不落库、不改生效配置。
            </small>
          </>
        ) : <small className="muted">读取中…</small>}
      </div>
    </>
  );
}
