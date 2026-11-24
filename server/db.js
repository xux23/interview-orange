/**
 * 数据层：node:sqlite（Node 内置，零原生依赖）——完全独立，数据落在 ./data/app.db。
 * 表结构对齐 09 号文档泄露的 prisma 模型（AiSession / Goal / Resume / Message / ...）。
 */
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

export const dbFile = path.join(config.dataDir, 'app.db');
export const db = new DatabaseSync(dbFile);

db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

export function migrate() {
  db.exec(`
  CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT);

  -- 运行时设置（设置页写入，优先于 .env；整目录搬迁时随 data/app.db 一起走）
  CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    phone TEXT UNIQUE,
    password_hash TEXT,
    country_code TEXT DEFAULT 'CN',
    last_interview_lang TEXT DEFAULT 'zh-CN',
    sub_level TEXT DEFAULT 'TRIAL',
    sub_expire_at TEXT,
    interview_time INTEGER DEFAULT 0,
    mock_interview_count INTEGER DEFAULT 1,
    question_prediction_count INTEGER DEFAULT 2,
    credits INTEGER DEFAULT 0,
    interview_preference TEXT,
    exam_customization TEXT,
    client_settings TEXT,
    created_at TEXT
  );

  CREATE TABLE IF NOT EXISTS resumes (
    id TEXT PRIMARY KEY, user_id TEXT, title TEXT, content TEXT,
    is_sample INTEGER DEFAULT 0, created_at TEXT
  );

  CREATE TABLE IF NOT EXISTS goals (
    id TEXT PRIMARY KEY, user_id TEXT, name TEXT, company_name TEXT, description TEXT,
    custom_hot_words TEXT, last_round TEXT, result TEXT, result_at TEXT, created_at TEXT
  );

  CREATE TABLE IF NOT EXISTS materials (
    id TEXT PRIMARY KEY, user_id TEXT, name TEXT, content TEXT, created_at TEXT
  );

  CREATE TABLE IF NOT EXISTS material_entries (
    id TEXT PRIMARY KEY, material_id TEXT, question TEXT, answer TEXT, source TEXT, created_at TEXT
  );

  CREATE TABLE IF NOT EXISTS official_libraries (
    id TEXT PRIMARY KEY, name TEXT, description TEXT, category TEXT, entry_count INTEGER, created_at TEXT
  );

  CREATE TABLE IF NOT EXISTS official_library_entries (
    id TEXT PRIMARY KEY, library_id TEXT, question TEXT, answer TEXT
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY, user_id TEXT,
    type TEXT, status TEXT DEFAULT 'ACTIVE',
    metadata TEXT, context TEXT, cost TEXT, token_usage TEXT, report TEXT, experience TEXT,
    goal_id TEXT, resume_id TEXT, voice_id TEXT, audio_source TEXT,
    is_trial INTEGER DEFAULT 0,
    created_at TEXT, updated_at TEXT, deleted_at TEXT, expires_at TEXT, completed_at TEXT,
    real_duration INTEGER, round TEXT,
    outcome TEXT, outcome_source TEXT, outcome_at TEXT, outcome_asked_at TEXT,
    rating INTEGER, rating_comment TEXT, rated_at TEXT, rating_asked_at TEXT
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, metadata TEXT, created_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);

  CREATE TABLE IF NOT EXISTS transcripts (
    id TEXT PRIMARY KEY, session_id TEXT, speaker_id TEXT, utterance_id TEXT,
    completed INTEGER DEFAULT 1, text TEXT, created_at TEXT
  );

  CREATE TABLE IF NOT EXISTS exam_sessions (
    id TEXT PRIMARY KEY, user_id TEXT, title TEXT, goal_id TEXT, status TEXT DEFAULT 'ACTIVE',
    platform TEXT, mode TEXT, question_count INTEGER DEFAULT 0, cost_minutes INTEGER DEFAULT 0,
    outcome TEXT, questions TEXT, created_at TEXT, updated_at TEXT
  );

  CREATE TABLE IF NOT EXISTS questions (
    id TEXT PRIMARY KEY, question_text TEXT, answer TEXT, company TEXT, options TEXT,
    tags TEXT, difficulty TEXT, hot INTEGER DEFAULT 0, asked_count INTEGER DEFAULT 0,
    locked INTEGER DEFAULT 0, created_at TEXT
  );

  CREATE TABLE IF NOT EXISTS user_question_state (
    user_id TEXT, question_id TEXT, favorited INTEGER DEFAULT 0, met INTEGER DEFAULT 0,
    updated_at TEXT, PRIMARY KEY (user_id, question_id)
  );

  CREATE TABLE IF NOT EXISTS predictions (
    id TEXT PRIMARY KEY, user_id TEXT, goal_id TEXT, title TEXT, status TEXT, items TEXT, created_at TEXT
  );

  CREATE TABLE IF NOT EXISTS feedbacks (
    id TEXT PRIMARY KEY, user_id TEXT, message TEXT, status TEXT DEFAULT 'PENDING',
    created_at TEXT, updated_at TEXT
  );

  CREATE TABLE IF NOT EXISTS feedback_replies (
    id TEXT PRIMARY KEY, feedback_id TEXT, content TEXT, role TEXT, created_at TEXT
  );

  CREATE TABLE IF NOT EXISTS voiceprints (
    user_id TEXT PRIMARY KEY, enrolled INTEGER DEFAULT 0, enrolled_at TEXT, status TEXT DEFAULT 'available'
  );

  CREATE TABLE IF NOT EXISTS uploads (
    key TEXT PRIMARY KEY, user_id TEXT, file_path TEXT, name TEXT, size INTEGER, created_at TEXT
  );

  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY, user_id TEXT, sku TEXT, channel TEXT, status TEXT,
    amount INTEGER, created_at TEXT
  );

  CREATE TABLE IF NOT EXISTS announcements (
    id TEXT PRIMARY KEY, platform TEXT, title TEXT, content TEXT, active INTEGER DEFAULT 1, created_at TEXT
  );

  CREATE TABLE IF NOT EXISTS notices (
    id TEXT PRIMARY KEY, user_id TEXT, kind TEXT, payload TEXT, ack INTEGER DEFAULT 0, created_at TEXT
  );

  CREATE TABLE IF NOT EXISTS agent_sessions (
    id TEXT PRIMARY KEY, session_id TEXT, agent TEXT, status TEXT, data TEXT, created_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
  -- 常用查询路径：会话转写 / 用户会话列表
  CREATE INDEX IF NOT EXISTS idx_transcripts_session ON transcripts(session_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_sessions_user_status ON sessions(user_id, status);
  `);
}

export const one = (sql, ...params) => db.prepare(sql).get(...params) ?? null;
export const all = (sql, ...params) => db.prepare(sql).all(...params);
export const run = (sql, ...params) => db.prepare(sql).run(...params);

export function tx(fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export const meta = {
  get: (key, fallback = null) => one('SELECT value FROM schema_meta WHERE key=?', key)?.value ?? fallback,
  set(key, value) {
    run(
      'INSERT INTO schema_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      key,
      String(value),
    );
  },
};
