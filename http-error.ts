/** 携带状态码与 Retry-After 的错误，用于 429 / 5xx 退避重试 */
export class HttpStatusError extends Error {
    constructor(
        public readonly status: number,
        message: string,
        public readonly retryAfterMs?: number
    ) {
        super(message);
        this.name = 'HttpStatusError';
    }
}
