import React from 'react';

/** [[FOLLOWUP: a | b | c]] 追问标签解析（官方笔试协议） */
export function parseFollowups(text = '') {
  const m = String(text).match(/\[\[FOLLOWUP:\s*([^\]]+)\]\]/);
  if (!m) return { body: text, followups: [] };
  const followups = m[1].split('|').map((s) => s.trim()).filter(Boolean);
  return { body: text.replace(m[0], '').trim(), followups };
}

/** 答案标签清洗（对齐 T:29060 的 vT）：去 `**答案**：` / `答案：` 前缀 */
export function cleanAnswerLabel(text = '') {
  return String(text).replace(/^\s*\*\*答案(?:要点)?\*\*[：:]\s*/, '').replace(/^\s*答案[：:]\s*/, '');
}

function inline(text, keyPrefix) {
  const nodes = [];
  let rest = text;
  let i = 0;
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/;
  while (rest.length) {
    const m = re.exec(rest);
    if (!m) { nodes.push(rest); break; }
    if (m.index > 0) nodes.push(rest.slice(0, m.index));
    const tok = m[0];
    const key = `${keyPrefix}-${i++}`;
    if (tok.startsWith('**')) nodes.push(<strong key={key}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith('`')) nodes.push(<code key={key}>{tok.slice(1, -1)}</code>);
    else nodes.push(<em key={key}>{tok.slice(1, -1)}</em>);
    rest = rest.slice(m.index + tok.length);
  }
  return nodes;
}

export function Markdown({ text = '', className = '' }) {
  const blocks = [];
  const lines = String(text).split(/\r?\n/);
  let code = null;
  let codeBuf = [];
  let list = null;

  const flushList = () => {
    if (list) { blocks.push(<ul key={`ul-${blocks.length}`}>{list}</ul>); list = null; }
  };

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    if (line.trim().startsWith('```')) {
      if (code === null) { code = line.trim().slice(3) || 'code'; codeBuf = []; }
      else {
        blocks.push(
          <pre key={`pre-${blocks.length}`} className="md-code">
            <span className="md-lang">{code}</span>
            <code>{codeBuf.join('\n')}</code>
          </pre>,
        );
        code = null;
        codeBuf = [];
      }
      continue;
    }
    if (code !== null) { codeBuf.push(line); continue; }

    const t = line.trim();
    if (!t) { flushList(); continue; }
    if (t.startsWith('###')) { flushList(); blocks.push(<h4 key={`h-${idx}`}>{inline(t.replace(/^#+\s*/, ''), `h${idx}`)}</h4>); continue; }
    if (t.startsWith('##')) { flushList(); blocks.push(<h3 key={`h-${idx}`}>{inline(t.replace(/^#+\s*/, ''), `h${idx}`)}</h3>); continue; }
    if (/^[-*•]\s/.test(t)) {
      if (!list) list = [];
      list.push(<li key={`li-${idx}`}>{inline(t.replace(/^[-*•]\s*/, ''), `l${idx}`)}</li>);
      continue;
    }
    if (/^\d+\s*\./.test(t)) {
      flushList();
      blocks.push(<p key={`p-${idx}`} className="md-num">{inline(t, `p${idx}`)}</p>);
      continue;
    }
    flushList();
    blocks.push(<p key={`p-${idx}`}>{inline(t, `p${idx}`)}</p>);
  }
  flushList();
  if (code !== null && codeBuf.length) {
    blocks.push(<pre key="pre-tail" className="md-code"><code>{codeBuf.join('\n')}</code></pre>);
  }
  return <div className={`md ${className}`}>{blocks}</div>;
}
