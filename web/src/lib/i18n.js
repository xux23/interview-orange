/**
 * i18n：官方以简体中文原文为 key，回退链 简 → 当前 → en → 原文。
 * 本地实现只内置 zh-CN 与 en-US 的常用键，其余语言回退到原文（结构保留，便于扩展）。
 */
export const LOCALES = [
  ['zh-CN', '简体中文'], ['yue-CN', '粵語'], ['zh-HK', '繁體中文'], ['en-US', 'English'],
  ['ja-JP', '日本語'], ['es-MX', 'Español'], ['pt-BR', 'Português'], ['de-DE', 'Deutsch'],
  ['fr-FR', 'Français'], ['ko-KR', '한국어'], ['vi-VN', 'Tiếng Việt'], ['ru-RU', 'Русский'], ['ar-SA', 'العربية'],
];

const EN = {
  '开始模拟面试': 'Start mock interview',
  '笔试助手': 'Exam assistant',
  '真实面试辅助': 'Live interview assist',
  '设置': 'Settings',
  '题库': 'Question bank',
  '结束并生成报告': 'Finish & report',
  '复制': 'Copy',
};

export function currentLocale() {
  return localStorage.getItem('desktop.locale') || 'zh-CN';
}

export function setLocale(lang) {
  localStorage.setItem('desktop.locale', lang);
  document.documentElement.lang = lang;
  window.dispatchEvent(new CustomEvent('desktop-locale-changed', { detail: lang }));
}

export function t(key) {
  const lang = currentLocale();
  if (lang.startsWith('zh')) return key; // key 本身就是简体原文
  return EN[key] || key;
}
