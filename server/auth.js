/**
 * 本地档案（账号模块已移除，2026-11-23）：
 * 不再有登录、token 校验、订阅与计费——所有 tRPC 请求与 socket 连接一律归属
 * DB 中按创建时间排序的第一个用户（seed 建立的本地档案）。
 * client 侧保留的 authorization 头与兼容桩 token（user.getTempToken/loginByTempToken）
 * 一律忽略，仅为 /legacy 原版前端与既有测试脚本提供协议形状。
 */
import crypto from 'node:crypto';
import { one } from './db.js';
import { config } from './config.js';

/** 本地单一档案用户（无则 null，由调用方给出「请先 seed」提示） */
export function singleUser() {
  return one('SELECT * FROM users ORDER BY created_at ASC LIMIT 1');
}

/** tRPC 兼容入口：忽略 token，恒返回本地档案 */
export function currentUser() {
  return singleUser();
}

/* ── 以下仅为兼容旧引用保留（不再参与鉴权） ── */
export const hashPassword = (pwd) => crypto.scryptSync(pwd || '', config.secret, 32).toString('hex');
