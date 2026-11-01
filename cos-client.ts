/*
 * 腾讯云 COS 的轻量 REST 客户端
 *
 * 为什么不用 cos-nodejs-sdk-v5：
 *   SDK 依赖 Node 的 http / https / crypto / stream，Obsidian 移动端没有 Node 运行时，
 *   插件因此被迫标记为「桌面端专用」。这里改成自己签名 + Obsidian 的 requestUrl：
 *     - requestUrl 在桌面端走 Electron net，在手机端走原生 HTTP，两端都可用；
 *     - 它绕过 CORS，不需要给 Bucket 配置跨域规则；
 *     - 只需要一份签名实现（TC3-HMAC-SHA256），桌面端和手机端行为一致。
 */

import { requestUrl } from 'obsidian';
import { hmacSha256, sha256Hex, toHex, utf8Bytes } from './hash';
import { TencentCOSUploaderSettings } from './settings';

const ALGORITHM = 'TC3-HMAC-SHA256';
const SERVICE = 'cos';
const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

export interface COSResponse {
    status: number;
    headers: Record<string, string>;
    text: string;
}

export interface SignParams {
    secretId: string;
    secretKey: string;
    /** 大写 HTTP 方法 */
    method: string;
    /** 已小写、含 bucket 的 host，例如 obsidian-1250000000.cos.ap-guangzhou.myqcloud.com */
    host: string;
    /** 已 URL 编码的路径，以 / 开头 */
    pathname: string;
    /** 已排序并编码的查询串（不含 ?），通常为空 */
    query: string;
    /** 需要参与签名的头，键必须是小写，不含 authorization */
    headers: Record<string, string>;
    /** 请求体的 sha256 十六进制 */
    payloadHash: string;
    /** Unix 时间戳（秒） */
    timestamp: number;
}

export interface SignResult {
    authorization: string;
    signedHeaders: string;
    canonicalRequest: string;
    stringToSign: string;
    signature: string;
}

/**
 * 计算 COS 的 TC3-HMAC-SHA256 签名。
 * 单独抽出来是为了能在测试里和 Node 的 crypto 逐字节对照。
 */
export function signRequest(params: SignParams): SignResult {
    const date = new Date(params.timestamp * 1000).toISOString().slice(0, 10);

    const normalizedHeaders: Record<string, string> = {};
    for (const [name, value] of Object.entries(params.headers)) {
        normalizedHeaders[name.toLowerCase()] = String(value).trim();
    }

    const headerNames = Object.keys(normalizedHeaders).sort();

    const canonicalHeaders =
        headerNames.map((name) => `${name}:${normalizedHeaders[name]}\n`).join('') || '\n';

    const signedHeaders = headerNames.join(';');

    const canonicalRequest = [
        params.method,
        params.pathname,
        params.query,
        canonicalHeaders,
        signedHeaders,
        params.payloadHash,
    ].join('\n');

    const scope = `${date}/${SERVICE}/tc3_request`;
    const stringToSign = [ALGORITHM, String(params.timestamp), scope, sha256Hex(utf8Bytes(canonicalRequest))].join(
        '\n'
    );

    const secretDate = hmacSha256(utf8Bytes(`TC3${params.secretKey}`), utf8Bytes(date));
    const secretService = hmacSha256(secretDate, utf8Bytes(SERVICE));
    const secretSigning = hmacSha256(secretService, utf8Bytes('tc3_request'));
    const signature = toHex(hmacSha256(secretSigning, utf8Bytes(stringToSign)));

    const authorization =
        `${ALGORITHM} Credential=${params.secretId}/${scope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`;

    return { authorization, signedHeaders, canonicalRequest, stringToSign, signature };
}

/** 对 key 的每一段做 URL 编码，保留 / 分隔符 */
export function encodeKey(key: string): string {
    return key
        .split('/')
        .map((segment) => encodeURIComponent(segment))
        .join('/');
}

export class COSClient {
    constructor(private readonly getSettings: () => TencentCOSUploaderSettings) {}

    /** 上传一个对象（会覆盖同名对象） */
    async putObject(
        key: string,
        body: Uint8Array,
        contentType: string,
        cacheControl?: string,
        signal?: AbortSignal
    ): Promise<COSResponse> {
        const headers: Record<string, string> = {
            'content-type': contentType || DEFAULT_CONTENT_TYPE,
        };
        if (cacheControl) headers['cache-control'] = cacheControl;

        return this.request({ method: 'PUT', key, body, headers }, signal);
    }

    /** 对象是否存在（取消时抛出，不会被当成“不存在”） */
    async headObject(key: string, signal?: AbortSignal): Promise<boolean> {
        try {
            const response = await this.request({ method: 'HEAD', key }, signal);
            return response.status >= 200 && response.status < 300;
        } catch (error) {
            if (isCancelled(error)) throw error;
            return false;
        }
    }

    /** 删除对象（不存在也算成功） */
    async deleteObject(key: string, signal?: AbortSignal): Promise<void> {
        try {
            await this.request({ method: 'DELETE', key }, signal);
        } catch (error) {
            if (isCancelled(error)) throw error;
            console.warn('[COS Uploader] 删除临时对象失败（可忽略）:', error);
        }
    }

    /* ------------------------------------------------------------------ */

    private async request(
        init: {
            method: 'PUT' | 'HEAD' | 'DELETE' | 'GET';
            key: string;
            body?: Uint8Array;
            headers?: Record<string, string>;
        },
        signal?: AbortSignal
    ): Promise<COSResponse> {
        const settings = this.getSettings();
        const bucket = (settings.bucket || '').trim();
        const region = (settings.region || '').trim();

        if (!settings.secretId || !settings.secretKey) {
            throw new Error('请先在插件设置里填写 SecretId 和 SecretKey');
        }
        if (!bucket || !region) {
            throw new Error('请先在插件设置里填写 Bucket 和 Region');
        }

        const host = `${bucket}.cos.${region}.myqcloud.com`;
        const pathname = `/${encodeKey(init.key)}`;
        const body = init.body || new Uint8Array(0);

        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(init.headers || {})) {
            headers[name.toLowerCase()] = value;
        }
        headers.host = host;

        const timestamp = Math.floor(Date.now() / 1000);
        const { authorization } = signRequest({
            secretId: settings.secretId,
            secretKey: settings.secretKey,
            method: init.method,
            host,
            pathname,
            query: '',
            headers,
            payloadHash: sha256Hex(body),
            timestamp,
        });

        const url = `https://${host}${pathname}`;
        const requestHeaders: Record<string, string> = { ...headers, Authorization: authorization };
        // Host 由底层自动带上，手工设置反而可能被浏览器内核拒绝
        delete requestHeaders.host;

        const timeoutMs = clampTimeout(settings.timeoutMs);
        return this.send(url, init.method, requestHeaders, init.method === 'PUT' ? body : undefined, timeoutMs, signal);
    }

    /**
     * 发请求。优先用 requestUrl（绕过 CORS、走原生网络），
     * 失败时退回 fetch（Bucket 若配了跨域规则也能成功）。
     *
     * 两个保命措施：
     *   1. 硬超时 —— 否则一次卡死的 PUT 会让整个上传永远不结束，
     *      并把插件锁在“上一次上传还没结束”的状态里（旧版就是这么卡的）。
     *   2. 可取消 —— 外部 AbortSignal 一旦触发立刻放弃等待。
     */
    private async send(
        url: string,
        method: string,
        headers: Record<string, string>,
        body: Uint8Array | undefined,
        timeoutMs: number,
        signal?: AbortSignal
    ): Promise<COSResponse> {
        const payload = body ? toArrayBuffer(body) : undefined;
        const attempts = 2;
        let lastError: Error | null = null;

        for (let attempt = 1; attempt <= attempts; attempt++) {
            if (signal?.aborted) throw cancelledError();

            try {
                const response = await this.sendOnce(url, method, headers, payload, timeoutMs, signal);
                if (response.status >= 200 && response.status < 300) return response;

                const error = new COSRequestError(describeCosError(response), response.status);
                // 4xx 重试也没用（密钥、权限、桶名问题），直接报错
                if (response.status < 500) throw error;
                lastError = error;
            } catch (error) {
                if (isCancelled(error) || signal?.aborted) throw cancelledError();
                if (error instanceof COSRequestError && error.status < 500) throw error;
                lastError = error instanceof Error ? error : new Error(String(error));
                console.warn(`[COS Uploader] ${method} 第 ${attempt} 次失败：${lastError.message}`);
            }

            if (attempt < attempts) await sleep(400 * attempt);
        }

        throw lastError || new Error('上传失败');
    }

    private async sendOnce(
        url: string,
        method: string,
        headers: Record<string, string>,
        payload: ArrayBuffer | undefined,
        timeoutMs: number,
        signal?: AbortSignal
    ): Promise<COSResponse> {
        try {
            const raw = await withTimeoutAndAbort(
                requestUrl({ url, method, headers, body: payload, throw: false }),
                timeoutMs,
                signal
            );
            return {
                status: raw.status,
                headers: raw.headers || {},
                text: raw.text || '',
            };
        } catch (error) {
            // 超时 / 取消要往上抛，不要拿 fetch 再试一遍
            if (isCancelled(error) || isTimeout(error)) throw error;
            console.warn('[COS Uploader] requestUrl 失败，尝试 fetch 回退:', error);
            return fetchRequest(url, method, headers, payload, timeoutMs, signal);
        }
    }
}

/* -------------------------------------------------------------------------- */
/* 工具                                                                       */
/* -------------------------------------------------------------------------- */

/** 带上 HTTP 状态码的错误，用于区分「4xx 不该重试」和「5xx 值得重试」 */
class COSRequestError extends Error {
    constructor(
        message: string,
        public readonly status: number
    ) {
        super(message);
        this.name = 'COSRequestError';
    }
}

const CANCEL_MESSAGE = '已取消';
const TIMEOUT_MESSAGE = '上传超时';

function cancelledError(): Error {
    return new Error(CANCEL_MESSAGE);
}

export function isCancelled(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return message === CANCEL_MESSAGE;
}

function isTimeout(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return message === TIMEOUT_MESSAGE;
}

function clampTimeout(value: number): number {
    if (!Number.isFinite(value) || value <= 0) return 30000;
    return Math.min(Math.max(value, 1000), 180000);
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 给任意 Promise 套上硬超时 + 取消。
 * 即使底层请求一直不返回（比如网络处于半断开状态），调用方也能继续往下走，
 * 不会把整个上传流程锁死。
 */
function withTimeoutAndAbort<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        let settled = false;

        const cleanup = () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
        };
        const finish = (error: Error | null, value?: T) => {
            if (settled) return;
            settled = true;
            cleanup();
            if (error) reject(error);
            else resolve(value as T);
        };

        const timer = setTimeout(() => finish(new Error(TIMEOUT_MESSAGE)), timeoutMs);
        const onAbort = () => finish(cancelledError());

        if (signal?.aborted) {
            finish(cancelledError());
            return;
        }
        signal?.addEventListener('abort', onAbort, { once: true });

        promise.then(
            (value) => finish(null, value),
            (error) => finish(error instanceof Error ? error : new Error(String(error)))
        );
    });
}

async function fetchRequest(
    url: string,
    method: string,
    headers: Record<string, string>,
    body: ArrayBuffer | undefined,
    timeoutMs: number,
    signal?: AbortSignal
): Promise<COSResponse> {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    const onAbort = () => controller?.abort();
    if (controller && signal) {
        if (signal.aborted) throw cancelledError();
        signal.addEventListener('abort', onAbort, { once: true });
    }

    let response: Response;
    try {
        response = await fetch(url, { method, headers, body, signal: controller?.signal });
    } catch (error) {
        if (signal?.aborted) throw cancelledError();
        if (isTimeout(error)) throw error;
        throw new Error(`网络请求失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
    }

    const text = await response.text().catch(() => '');
    const collected: Record<string, string> = {};
    response.headers.forEach((value, name) => {
        collected[name] = value;
    });

    return { status: response.status, headers: collected, text };
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
        return bytes.buffer as ArrayBuffer;
    }
    return bytes.slice().buffer as ArrayBuffer;
}

/** 把 COS 返回的 XML 错误翻译成能看懂的中文 */
export function describeCosError(response: COSResponse): string {
    const text = response.text || '';
    const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1] || '';
    const message = /<Message>([^<]+)<\/Message>/.exec(text)?.[1] || '';

    switch (code) {
        case 'AccessDenied':
            return '访问被拒绝（AccessDenied）：检查密钥权限、Bucket 与 Region 是否匹配';
        case 'InvalidAccessKeyId':
            return 'SecretId 无效：请检查密钥是否填写正确';
        case 'SignatureDoesNotMatch':
            return '签名错误：SecretKey 不正确，或系统时间偏差过大';
        case 'NoSuchBucket':
            return 'Bucket 不存在：请检查 Bucket 名称与 Region';
        case 'RequestTimeTooSkewed':
            return '本机时间与服务器相差过大，请校准系统时间后重试';
        default:
            break;
    }

    if (code || message) return `${code ? code + ': ' : ''}${message}`;
    return `HTTP ${response.status}${text ? `：${text.slice(0, 200)}` : ''}`;
}
