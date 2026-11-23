/**
 * tRPC 兼容层（v11 语义）：
 *   query    → GET  /trpc/<proc>?input={"json":{...}}
 *   mutation → POST /trpc/<proc>   body {"json":{...}}
 * 响应：{result:{data:{json:<T>}}}；错误：{error:{json:{code,message,data:{code,httpStatus}}}}
 * 错误码对齐官方实测：-32600 BAD_REQUEST / -32001 UNAUTHORIZED / -32004 NOT_FOUND /
 * -32029 TOO_MANY_REQUESTS / METHOD_NOT_SUPPORTED(405)
 */
import { currentUser } from '../auth.js';
import { TRPCError, bad } from './errors.js';
import userRouter from './user.js';
import sessionRouter from './session.js';
import resourceRouter from './resource.js';
import bankRouter from './bank.js';
import miscRouter from './misc.js';

export { TRPCError, bad };

const routers = [userRouter, sessionRouter, resourceRouter, bankRouter, miscRouter];

/** { name: {kind, input, handler, auth} } */
export const registry = new Map();
for (const r of routers) for (const [name, proc] of Object.entries(r)) registry.set(name, proc);

export const procedures = () => [...registry.keys()];

/** superjson 信封解包：{"json":X,"meta":{"values":…}} → 还原 undefined/Date/NaN 等 */
export function resolveSuperjsonValue(json, values) {
  if (Array.isArray(values)) {
    const mark = values[0];
    if (mark === 'undefined') return undefined;
    if (mark === 'Date') return json === null ? null : new Date(json);
    if (mark === 'NaN') return Number.NaN;
    if (mark === 'Infinity') return Number.POSITIVE_INFINITY;
    if (mark === '-Infinity') return Number.NEGATIVE_INFINITY;
    return json;
  }
  if (values && typeof values === 'object' && json && typeof json === 'object') {
    const out = Array.isArray(json) ? [...json] : { ...json };
    for (const [k, v] of Object.entries(values)) out[k] = resolveSuperjsonValue(out[k], v);
    return out;
  }
  return json;
}

export function unwrapEnvelope(raw) {
  if (raw && typeof raw === 'object' && 'json' in raw && Object.keys(raw).length <= 2) {
    if (raw.meta && typeof raw.meta === 'object' && 'values' in raw.meta) {
      return resolveSuperjsonValue(raw.json, raw.meta.values);
    }
    return raw.json ?? {};
  }
  return raw ?? {};
}

export function parseInput(raw) {
  if (raw === undefined || raw === null || raw === '') return {};
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      throw bad('input 不是合法 JSON');
    }
  }
  return unwrapEnvelope(value);
}

export async function invoke(name, { kind, input, req }) {
  const proc = registry.get(name);
  if (!proc) throw bad(`No "query"-like procedure on path "${name}"`, 'NOT_FOUND', 404);
  if (kind !== proc.kind) throw new TRPCError(`Requested ${kind} on ${proc.kind} path`, 'METHOD_NOT_SUPPORTED', 405);

  const user = currentUser(req);
  if (proc.auth !== false && !user) throw new TRPCError('需要登录', 'UNAUTHORIZED', 401);

  let parsed = input;
  if (proc.input) {
    const result = proc.input.safeParse(input ?? {});
    if (!result.success) {
      const first = result.error.issues[0];
      throw bad(`输入校验失败：${first.path.join('.') || '(root)'} ${first.message}`, 'BAD_REQUEST');
    }
    parsed = result.data;
  }
  const ctx = { user, req, headers: req.headers };
  return proc.handler(parsed, ctx);
}
