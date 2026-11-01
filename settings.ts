export interface TencentCOSUploaderSettings {
    /* ---- 腾讯云 COS ---- */
    appId: string;
    secretId: string;
    secretKey: string;
    bucket: string;
    region: string;
    pathPrefix: string;
    cdnDomain: string;

    /* ---- 网络 ---- */
    /** HTTP 代理，例如 http://127.0.0.1:7897，留空则不使用 */
    proxyUrl: string;
    /** 是否优先使用 Obsidian requestUrl（走系统代理） */
    preferObsidianRequest: boolean;
    /** 自定义 User-Agent，留空使用内置值 */
    userAgent: string;
    /** 自定义 Referer，留空则按图片域名自动推断 */
    referer: string;
    /** 单次请求超时（毫秒） */
    timeoutMs: number;
    /** 失败重试次数 */
    retries: number;
    /** 同一域名允许的最大并发（限流用，0 表示不限制） */
    perHostLimit: number;

    /* ---- 上传 ---- */
    /** 并发数 1-8 */
    concurrency: number;
    /** 文件命名方式 */
    naming: 'hash' | 'timestamp' | 'original';
    /** 使用 hash 命名时，若 COS 上已存在同一文件则跳过上传 */
    skipIfExists: boolean;
    /** 上传后的对象缓存时间（秒） */
    cacheControlSeconds: number;
    /** 是否上传 base64 内嵌图片 */
    uploadInlineBase64: boolean;
    /** 是否上传 frontmatter 里的封面图 */
    uploadFrontmatterCovers: boolean;
    /** 待处理图片数达到该值时先弹窗确认（0 表示始终不确认） */
    confirmThreshold: number;
}

export const DEFAULT_SETTINGS: TencentCOSUploaderSettings = {
    appId: '',
    secretId: '',
    secretKey: '',
    bucket: '',
    region: '',
    pathPrefix: '',
    cdnDomain: '',

    proxyUrl: '',
    preferObsidianRequest: true,
    userAgent: '',
    referer: '',
    timeoutMs: 30000,
    retries: 2,
    perHostLimit: 2,

    concurrency: 4,
    naming: 'hash',
    skipIfExists: true,
    cacheControlSeconds: 31536000,
    uploadInlineBase64: true,
    uploadFrontmatterCovers: true,
    confirmThreshold: 10,
};

/** 迁移旧版本配置，补齐缺失字段并做类型收敛 */
export function migrateSettings(data: unknown): TencentCOSUploaderSettings {
    const raw = (data || {}) as Record<string, unknown>;
    const settings: TencentCOSUploaderSettings = { ...DEFAULT_SETTINGS };

    for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof TencentCOSUploaderSettings>) {
        const value = raw[key];
        if (value === undefined || value === null) continue;

        const defaultValue = DEFAULT_SETTINGS[key];
        if (typeof defaultValue === 'number') {
            const num = Number(value);
            if (Number.isFinite(num)) (settings[key] as number) = num;
        } else if (typeof defaultValue === 'boolean') {
            (settings[key] as boolean) = Boolean(value);
        } else {
            (settings[key] as string) = String(value);
        }
    }

    // 旧版本没有 naming 字段，保持原有 timestamp 行为习惯但默认用 hash 更省空间；
    // 这里仅在字段缺失时使用默认值，已显式保存过的值不会被覆盖。
    if (raw.naming !== 'hash' && raw.naming !== 'timestamp' && raw.naming !== 'original') {
        settings.naming = DEFAULT_SETTINGS.naming;
    }

    settings.concurrency = clamp(settings.concurrency, 1, 8);
    settings.retries = clamp(settings.retries, 0, 5);
    settings.timeoutMs = clamp(settings.timeoutMs, 3000, 180000);
    settings.cacheControlSeconds = clamp(settings.cacheControlSeconds, 0, 31536000);
    settings.perHostLimit = clamp(settings.perHostLimit, 0, 8);
    settings.confirmThreshold = clamp(settings.confirmThreshold, 0, 5000);

    settings.appId = String(settings.appId || '').trim();
    settings.secretId = String(settings.secretId || '').trim();
    settings.secretKey = String(settings.secretKey || '').trim();
    settings.bucket = String(settings.bucket || '').trim();
    settings.region = String(settings.region || '').trim();
    settings.proxyUrl = String(settings.proxyUrl || '').trim();
    settings.cdnDomain = normalizeDomain(String(settings.cdnDomain || ''));
    settings.pathPrefix = normalizePrefix(String(settings.pathPrefix || ''));

    return settings;
}

export function normalizePrefix(prefix: string): string {
    const trimmed = prefix.trim().replace(/^\/+/, '');
    if (!trimmed) return '';
    return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
}

export function normalizeDomain(domain: string): string {
    return domain
        .trim()
        .replace(/^https?:\/\//i, '')
        .replace(/\/+$/, '');
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, Math.round(value)));
}
