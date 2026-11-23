import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { windowKind, startUiVersionHandshake } from './lib/bridge';
import { bootstrapAuth, currentUser } from './api/client';
import MainApp from './windows/MainApp';
import OverlayWindow from './windows/OverlayWindow';
import MockRoom from './windows/MockRoom';
import ExamRoom from './windows/ExamRoom';

const kind = windowKind();
const TITLES = {
  main: '面试橙 · 工作台',
  overlay: '面试橙 · 浮窗',
  mock: '面试橙 · 面试房间',
  'mock-exam': '面试橙 · 笔试房间',
};
document.title = TITLES[kind] || '面试橙';
startUiVersionHandshake(kind);
if (kind === 'overlay') {
  document.documentElement.classList.add('overlay');
  document.body.classList.add('overlay');
  document.documentElement.setAttribute('data-theme', 'light');
} else {
  const theme = localStorage.getItem('desktop.theme') || 'light';
  document.documentElement.setAttribute('data-theme', theme);
}

function Boot() {
  const [user, setUser] = useState(currentUser());
  const [error, setError] = useState('');

  useEffect(() => {
    bootstrapAuth().then(setUser).catch((e) => setError(e.message || '连接失败'));
  }, []);

  if (error) {
    return (
      <div style={{ padding: 40, textAlign: 'center' }}>
        <h3>启动失败</h3>
        <p className="muted">{error}</p>
        <p className="muted tiny">确认本地服务已启动（npm start → http://127.0.0.1:8756）</p>
        <button className="btn" onClick={() => location.reload()}>重新加载</button>
      </div>
    );
  }
  if (!user) return <div style={{ padding: 40 }} className="muted">连接本地服务…</div>;

  if (kind === 'overlay') return <OverlayWindow user={user} />;
  if (kind === 'mock') return <MockRoom user={user} />;
  if (kind === 'mock-exam') return <ExamRoom user={user} />;
  return <MainApp user={user} />;
}

createRoot(document.getElementById('root')).render(<Boot />);
