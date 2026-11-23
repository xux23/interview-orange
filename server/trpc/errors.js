/** 独立错误模块：防止 trpc/index.js ↔ router 模块的循环依赖 */
export class TRPCError extends Error {
  constructor(message, code = 'BAD_REQUEST', httpStatus) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus ?? ({
      BAD_REQUEST: 400,
      UNAUTHORIZED: 401,
      NOT_FOUND: 404,
      METHOD_NOT_SUPPORTED: 405,
      CONFLICT: 409,
      TOO_MANY_REQUESTS: 429,
      INTERNAL_SERVER_ERROR: 500,
    }[code] || 400);
  }
}
export const bad = (msg, code, status) => new TRPCError(msg, code || 'BAD_REQUEST', status);
export const unauthorized = () => new TRPCError('需要登录', 'UNAUTHORIZED', 401);
