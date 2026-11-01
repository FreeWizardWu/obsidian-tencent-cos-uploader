/*
 * 图片下载器
 *
 * 为什么不能只用 Node 的 https.get：
 *   Node 的 http/https 模块既不会读 http_proxy / https_proxy 环境变量，
 *   也不会读操作系统的代理设置。像 pbs.twimg.com（X/Twitter）这类在部分网络
 *   环境下必须走代理才能访问的站点，直连会直接 ECONNRESET。
 *
 * 策略（按顺序尝试，任一成功即返回）：
 *   1. Obsidian 的 requestUrl —— 走 Chromium / 原生网络栈，自动使用系统代理，
 *      自动跟随重定向、处理 gzip，并绕过 CORS。桌面端和手机端都可用。
 *   2. Node 请求 + 插件设置里的 HTTP 代理（CONNECT 隧道）—— 仅桌面端。
 *   3. Node 直连（最后一次兜底）—— 仅桌面端。
 *
 * 手机端没有 Node 运行时，只会走第 1 条；Node 相关代码全部在 node-network.ts 里，
 * 用动态 import 惰性加载。
 */

import { Platform, requestUrl } from 'obsidian';
import { HttpStatusError } from './http-error';
import type { RawResponse } from './node-network';

export interface DownloadOptions {
    userAgent: string;
    proxyUrl: string;
    referer: string;
    timeoutMs: number;
    retries: number;
    maxBytes: number;
    preferObsidianRequest: boolean;
    /** 响应不是 image/* 时是否直接判定失败 */
    requireImageContentType: boolean;
    /** 同一域名允许的最大并发（0 或负数表示不限制） */
    perHostLimit: number;
}

export interface DownloadResult {
    buffer: ArrayBuffer;
    /** 推断出的扩展名，不含点，例如 jpg */
    ext: string;
    contentType: string;
    finalUrl: string;
    via: string;
}

/** 携带状态码与 Retry-After 的错误见 http-error.ts（桌面/移动两端共用） */

/** 域名级并发限制：同一图床被打太多并发请求时很容易被限流 */
class HostLimiter {
    private readonly active = new Map<string, number>();
    private readonly waiting = new Map<string, Array<() => void>>();

    async acquire(host: string, limit: number): Promise<() => void> {
        if (!limit || limit <= 0) return () => undefined;

        const current = this.active.get(host) || 0;
        if (current < limit) {
            this.active.set(host, current + 1);
            return () => this.release(host);
        }

        await new Promise<void>((resolve) => {
            const queue = this.waiting.get(host) || [];
            queue.push(resolve);
            this.waiting.set(host, queue);
        });

        this.active.set(host, (this.active.get(host) || 0) + 1);
        return () => this.release(host);
    }

    private release(host: string): void {
        const queue = this.waiting.get(host);
        const next = queue?.shift();
        if (next) {
            // 直接把名额交给下一个等待者，active 保持不变
            next();
            return;
        }
        const current = this.active.get(host) || 0;
        if (current <= 1) this.active.delete(host);
        else this.active.set(host, current - 1);
    }
}

const DEFAULT_ACCEPT = 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8';
const DEFAULT_ACCEPT_LANGUAGE = 'zh-CN,zh;q=0.9,en;q=0.8';

/** 常见防盗链站点的默认 Referer（后缀匹配） */
const REFERER_RULES: Array<[string, string]> = [
    ['twimg.com', 'https://x.com/'],
    ['x.com', 'https://x.com/'],
    ['zhimg.com', 'https://www.zhihu.com/'],
    ['sinaimg.cn', 'https://weibo.com/'],
    ['qpic.cn', 'https://mp.weixin.qq.com/'],
    ['qlogo.cn', 'https://mp.weixin.qq.com/'],
    ['xhscdn.com', 'https://www.xiaohongshu.com/'],
    ['hdslb.com', 'https://www.bilibili.com/'],
    ['bilibili.com', 'https://www.bilibili.com/'],
    ['pixiv.net', 'https://www.pixiv.net/'],
    ['pximg.net', 'https://www.pixiv.net/'],
    ['doubanio.com', 'https://www.douban.com/'],
    ['byteimg.com', 'https://www.toutiao.com/'],
    ['xiaobot.net', 'https://xiaobot.net/'],
    ['blockbeats.cn', 'https://www.theblockbeats.info/'],
    ['woshipm.com', 'https://www.woshipm.com/'],
    ['yunyingpai.com', 'https://www.yunyingpai.com/'],
    ['kickstarter.com', 'https://www.kickstarter.com/'],
    ['zeczec.com', 'https://www.zeczec.com/'],
    ['36kr.com', 'https://36kr.com/'],
    ['jianshu.com', 'https://www.jianshu.com/'],
    ['jianshu.io', 'https://www.jianshu.com/'],
    ['feishu.cn', 'https://www.feishu.cn/'],
    ['feishucdn.com', 'https://www.feishu.cn/'],
    ['notion.so', 'https://www.notion.so/'],
    ['githubusercontent.com', 'https://github.com/'],
    ['dify.ai', 'https://dify.ai/'],
    ['hf.space', 'https://huggingface.co/'],
    ['huggingface.co', 'https://huggingface.co/'],
];

const MIME_EXT: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/pjpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
    'image/bmp': 'bmp',
    'image/x-ms-bmp': 'bmp',
    'image/x-icon': 'ico',
    'image/vnd.microsoft.icon': 'ico',
    'image/avif': 'avif',
    'image/heic': 'heic',
    'image/heif': 'heif',
    'image/tiff': 'tiff',
};

export class ImageDownloader {
    private readonly hostLimiter = new HostLimiter();

    /** 规范化 URL：补全协议相对地址、转义未编码的非 ASCII 与空格 */
    static normalizeUrl(raw: string): string {
        let value = raw.trim();
        if (value.startsWith('<') && value.endsWith('>')) value = value.slice(1, -1).trim();
        if (value.startsWith('//')) value = 'https:' + value;
        // 部分剪藏工具会把 / 写成 \
        if (/^https?:\/\//i.test(value)) value = value.replace(/\\\//g, '/');
        try {
            return encodeURI(value);
        } catch {
            return value;
        }
    }

    /** 根据 URL 主机推断一个合理的 Referer */
    static guessReferer(url: string): string {
        try {
            const parsed = new URL(url);
            const host = parsed.hostname.toLowerCase();
            for (const [suffix, referer] of REFERER_RULES) {
                if (host === suffix || host.endsWith('.' + suffix)) return referer;
            }
            return `${parsed.protocol}//${parsed.host}/`;
        } catch {
            return '';
        }
    }

    /**
     * 下载一张图片。
     * @param url 原始链接
     * @param options 配置
     * @param fallbackReferer 用户手工指定或文章出处页面提供的 Referer
     */
    async download(
        url: string,
        options: DownloadOptions,
        fallbackReferer?: string,
        signal?: AbortSignal
    ): Promise<DownloadResult> {
        const normalized = ImageDownloader.normalizeUrl(url);
        if (!/^https?:\/\//i.test(normalized)) {
            throw new Error(`不支持的链接协议: ${normalized.slice(0, 40)}`);
        }
        if (signal?.aborted) throw new Error('已取消');

        const host = (() => {
            try {
                return new URL(normalized).hostname.toLowerCase();
            } catch {
                return '';
            }
        })();
        const release = await this.hostLimiter.acquire(host, options.perHostLimit);

        try {
            return await this.downloadWithRetry(normalized, options, fallbackReferer, signal);
        } finally {
            release();
        }
    }

    private async downloadWithRetry(
        normalized: string,
        options: DownloadOptions,
        fallbackReferer: string | undefined,
        signal: AbortSignal | undefined
    ): Promise<DownloadResult> {
        const headers: Record<string, string> = {
            'User-Agent': options.userAgent,
            Accept: DEFAULT_ACCEPT,
            'Accept-Language': DEFAULT_ACCEPT_LANGUAGE,
        };
        const referer = fallbackReferer || options.referer || ImageDownloader.guessReferer(normalized);
        if (referer) headers.Referer = referer;

        const strategies: Array<{ name: string; run: () => Promise<RawResponse> }> = [];

        if (options.preferObsidianRequest) {
            strategies.push({
                name: 'requestUrl',
                run: () => this.requestUrlGet(normalized, headers, options.timeoutMs, options.maxBytes, signal),
            });
        }
        if (options.proxyUrl && Platform.isDesktopApp) {
            strategies.push({
                name: `node+proxy(${options.proxyUrl})`,
                run: () => this.nodeGet(normalized, headers, options, true, signal),
            });
        }
        // Node 直连只在桌面端可用；手机端只有 requestUrl 一条路
        if (Platform.isDesktopApp) {
            strategies.push({
                name: 'node',
                run: () => this.nodeGet(normalized, headers, options, false, signal),
            });
        }

        const errors: string[] = [];

        for (const strategy of strategies) {
            const attempts = Math.max(1, options.retries + 1);
            for (let attempt = 1; attempt <= attempts; attempt++) {
                if (signal?.aborted) throw new Error('已取消');

                try {
                    const raw = await strategy.run();
                    const ext = ImageDownloader.resolveExtension(raw.buffer, raw.contentType, normalized, options);
                    return {
                        buffer: raw.buffer,
                        ext,
                        contentType: raw.contentType,
                        finalUrl: raw.finalUrl,
                        via: strategy.name,
                    };
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    const retriable = isRetriableError(error);
                    if (attempt === attempts || !retriable) {
                        errors.push(`[${strategy.name}] ${message}`);
                        break;
                    }

                    // 429 / 503 优先遵守服务器给的 Retry-After
                    const retryAfter = error instanceof HttpStatusError ? error.retryAfterMs : undefined;
                    const delay = Math.min(retryAfter ?? 300 * attempt, 20_000);
                    console.warn(
                        `[COS Uploader] ${strategy.name} 第 ${attempt} 次失败（${message}），${delay}ms 后重试`
                    );
                    await sleep(delay);
                }
            }
        }

        throw new Error(explainFailure(normalized, errors, options));
    }

    /* --------------------------- Obsidian requestUrl --------------------------- */

    private async requestUrlGet(
        url: string,
        headers: Record<string, string>,
        timeoutMs: number,
        maxBytes: number,
        signal?: AbortSignal
    ): Promise<RawResponse> {
        const response = await withTimeout(
            requestUrl({ url, method: 'GET', headers, throw: false }),
            timeoutMs,
            '下载超时',
            signal
        );

        if (response.status < 200 || response.status >= 300) {
            throw new HttpStatusError(
                response.status,
                `HTTP ${response.status}`,
                parseRetryAfter(pickHeader(response.headers, 'retry-after'))
            );
        }

        const buffer = response.arrayBuffer;
        if (!buffer || buffer.byteLength === 0) throw new Error('响应内容为空');
        if (buffer.byteLength > maxBytes) throw new Error(`图片过大（${formatBytes(buffer.byteLength)}）`);

        return {
            status: response.status,
            contentType: pickHeader(response.headers, 'content-type'),
            buffer,
            finalUrl: url,
        };
    }

    /* ------------------------------ Node 请求 ------------------------------ */

    /**
     * 桌面端专用：Node 直连 / HTTP 代理隧道。
     * 这里用动态 import 加载 node-network.ts，esbuild 会把它包成惰性初始化的代码块，
     * 手机端永远不会执行到里面的 require('http')。
     */
    private async nodeGet(
        url: string,
        headers: Record<string, string>,
        options: DownloadOptions,
        useProxy: boolean,
        signal?: AbortSignal
    ): Promise<RawResponse> {
        if (!Platform.isDesktopApp) {
            throw new Error('当前平台不支持 Node 网络请求（移动端只走 Obsidian 网络栈）');
        }

        const network = await import('./node-network');
        return network.nodeGet(
            url,
            headers,
            {
                proxyUrl: useProxy ? options.proxyUrl : '',
                timeoutMs: options.timeoutMs,
                maxBytes: options.maxBytes,
            },
            signal
        );
    }

    /* ---------------------------- 结果校验 ---------------------------- */

    private static resolveExtension(
        buffer: ArrayBuffer,
        contentType: string,
        url: string,
        options: DownloadOptions
    ): string {
        const mime = contentType.split(';')[0].trim().toLowerCase();
        const sniffed = sniffImageExtension(buffer);
        const fromMime = MIME_EXT[mime] || null;

        if (!sniffed) {
            const isDeclaredImage = mime.startsWith('image/');
            if (mime.includes('html')) {
                throw new Error(
                    `返回的是网页而不是图片（Content-Type: ${mime}），通常意味着被防盗链或登录验证拦截`
                );
            }
            if (!options.requireImageContentType) {
                const guessed = fromMime || extensionFromUrl(url) || 'png';
                return guessed;
            }
            if (!isDeclaredImage) {
                throw new Error(`返回内容不是图片（Content-Type: ${mime || '未知'}）`);
            }
            return fromMime || extensionFromUrl(url) || 'png';
        }

        if (sniffed === 'jpg' && fromMime === 'png') return 'jpg';
        return sniffed;
    }
}

/* -------------------------------------------------------------------------- */
/* 内部工具                                                                   */
/* -------------------------------------------------------------------------- */

function sniffImageExtension(buffer: ArrayBuffer): string | null {
    if (!buffer || buffer.byteLength < 12) return null;

    const bytes = new Uint8Array(buffer);
    const ascii = (start: number, end: number) => {
        let out = '';
        for (let i = start; i < Math.min(end, bytes.length); i++) out += String.fromCharCode(bytes[i]);
        return out;
    };

    if (bytes[0] === 0x89 && ascii(1, 4) === 'PNG') return 'png';
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
    if (ascii(0, 4) === 'GIF8') return 'gif';
    if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
    if (bytes[0] === 0x42 && bytes[1] === 0x4d) return 'bmp';
    if (bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x01 && bytes[3] === 0x00) return 'ico';
    if (ascii(4, 8) === 'ftyp') {
        const brand = ascii(8, 12).toLowerCase();
        if (brand.startsWith('avi')) return 'avif';
        if (brand.startsWith('hei') || brand.startsWith('mif')) return 'heic';
    }
    if (bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a) return 'tiff';
    if (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a) return 'tiff';

    // SVG 是文本，检查头部
    const head = new TextDecoder('utf-8', { fatal: false })
        .decode(new Uint8Array(buffer, 0, Math.min(512, buffer.byteLength)))
        .trim()
        .toLowerCase();
    if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'svg';

    return null;
}

function extensionFromUrl(url: string): string | null {
    try {
        const parsed = new URL(url);
        const fromQuery = parsed.searchParams.get('format');
        if (fromQuery && /^[a-z0-9]{2,5}$/i.test(fromQuery)) return fromQuery.toLowerCase();

        const clean = parsed.pathname.split('?')[0];
        const dot = clean.lastIndexOf('.');
        if (dot === -1) return null;
        const ext = clean.slice(dot + 1).toLowerCase();
        return /^[a-z0-9]{2,5}$/.test(ext) ? ext : null;
    } catch {
        return null;
    }
}

function pickHeader(headers: Record<string, string>, name: string): string {
    const lower = name.toLowerCase();
    for (const key of Object.keys(headers || {})) {
        if (key.toLowerCase() === lower) return headers[key];
    }
    return '';
}

function isRetriableError(error: unknown): boolean {
    // 429（限流）、408（请求超时）、5xx 值得重试
    if (error instanceof HttpStatusError) {
        return error.status === 408 || error.status === 429 || error.status >= 500;
    }
    const message = error instanceof Error ? error.message : String(error);
    return /超时|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|EPIPE/i.test(message);
}

/** 解析 Retry-After（秒数或 HTTP 日期） */
function parseRetryAfter(value: string | undefined): number | undefined {
    const raw = String(value || '').trim();
    if (!raw) return undefined;

    if (/^\d+$/.test(raw)) {
        const seconds = Number(raw);
        return Number.isFinite(seconds) ? seconds * 1000 : undefined;
    }

    const date = Date.parse(raw);
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
    return undefined;
}

function explainFailure(url: string, errors: string[], options: DownloadOptions): string {
    const detail = errors.join('；');
    const hints: string[] = [];

    if (!options.proxyUrl && Platform.isDesktopApp && /ECONNRESET|超时|重置|ENOTFOUND|DNS/.test(detail)) {
        hints.push('该域名可能需要在插件设置里填写代理（例如 http://127.0.0.1:7897）');
    }
    if (/ECONNRESET|重置/.test(detail) && options.proxyUrl && Platform.isDesktopApp) {
        hints.push('代理已配置但仍被重置，请确认代理软件正在运行且端口正确');
    }
    if (!Platform.isDesktopApp && /ECONNRESET|超时|重置|ENOTFOUND|DNS/.test(detail)) {
        hints.push('移动端只能走系统网络，请确认手机当前网络能访问该域名');
    }
    if (/HTTP 403|防盗链|网页而不是图片/.test(detail)) {
        hints.push('可以尝试在设置里为该站点填写自定义 Referer');
    }

    const host = (() => {
        try {
            return new URL(url).hostname;
        } catch {
            return url.slice(0, 40);
        }
    })();

    return `下载失败 ${host}: ${detail}${hints.length ? ` → ${hints.join('；')}` : ''}`;
}

function withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    message: string,
    signal?: AbortSignal
): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        const onAbort = () => {
            clearTimeout(timer);
            reject(new Error('已取消'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });

        const cleanup = () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
        };

        promise.then(
            (value) => {
                cleanup();
                resolve(value);
            },
            (error) => {
                cleanup();
                reject(error instanceof Error ? error : new Error(String(error)));
            }
        );
    });
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
