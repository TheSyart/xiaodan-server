// 学分的业务错误。单独一个文件,store.ts 与 units.ts 都要用,放这里免得互相 import。

export type CreditErrorCode =
  | 'invalid' | 'not_found' | 'device_not_found' | 'already_scored' | 'archived'
  | 'insufficient_balance' | 'insufficient_wallet' | 'already_reverted' | 'not_revertible'
  | 'read_only_key' | 'idempotency_key_reused';

/** 带 HTTP 状态与机器可读代码的业务错误,路由层原样转成 {error, code} */
export class CreditError extends Error {
  readonly status: 400 | 403 | 404 | 409 | 422;
  readonly code: CreditErrorCode;

  constructor(message: string, status: 400 | 403 | 404 | 409 | 422, code: CreditErrorCode) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
