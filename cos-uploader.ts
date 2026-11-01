import { COSClient, encodeKey } from './cos-client';
import { md5Hex, utf8Bytes } from './hash';
import { normalizePrefix, TencentCOSUploaderSettings } from './settings';

export interface UploadRequest {
    buffer: ArrayBuffer;
    /** 不含点的扩展名，例如 jpg */
    ext: string;
    /** 原始文件名（可选，用于 original / timestamp 命名） */
    fileName?: string;
    contentType?: string;
    /** 由字节内容计算出的指纹，用于跨次运行去重 */
    fingerprint?: string;
}

export class COSUploader {
    private readonly client: COSClient;

    constructor(private getSettings: () => TencentCOSUploaderSettings) {
        this.client = new COSClient(getSettings);
    }

    /** 基于内容计算指纹（md5 前 16 位），纯 JS 实现，手机端同样可用 */
    static fingerprint(buffer: ArrayBuffer): string {
        return md5Hex(new Uint8Array(buffer)).slice(0, 16);
    }

    /** 根据设置生成对象 key */
    buildKey(request: UploadRequest): string {
        const settings = this.getSettings();
        const prefix = normalizePrefix(settings.pathPrefix);
        const ext = (request.ext || 'png').replace(/^\./, '').toLowerCase();
        const fingerprint = request.fingerprint || COSUploader.fingerprint(request.buffer);
        const safeName = sanitizeFileName(request.fileName || '', ext);

        if (settings.naming === 'timestamp') {
            return `${prefix}${Date.now()}_${safeName}`;
        }
        if (settings.naming === 'original') {
            return `${prefix}${safeName}`;
        }
        return `${prefix}${fingerprint}.${ext}`;
    }

    /** 生成可访问的 URL（对每段做 URL 编码，中文/空格文件名不会失效） */
    buildUrl(key: string): string {
        const settings = this.getSettings();
        const domain = settings.cdnDomain || `${settings.bucket}.cos.${settings.region}.myqcloud.com`;
        return `https://${domain}/${encodeKey(key)}`;
    }

    /** 该 URL 是否已经指向自己的 COS */
    isOwnUrl(url: string, region?: string, bucket?: string): boolean {
        const settings = this.getSettings();
        const target = url.trim();
        const candidates = new Set<string>();

        if (settings.cdnDomain) candidates.add(settings.cdnDomain.toLowerCase());
        if (settings.bucket && settings.region) {
            candidates.add(`${settings.bucket}.cos.${settings.region}.myqcloud.com`.toLowerCase());
        }
        if (bucket && region) candidates.add(`${bucket}.cos.${region}.myqcloud.com`.toLowerCase());

        let host: string;
        try {
            host = new URL(target).hostname.toLowerCase();
        } catch {
            return false;
        }
        return candidates.has(host);
    }

    /**
     * 上传图片，返回可访问 URL。
     * 当 naming=hash 且 skipIfExists 打开时，若 COS 上已有相同内容则直接复用。
     * signal 用于取消：用户点取消后，进行中的请求会尽快返回“已取消”。
     */
    async upload(
        request: UploadRequest,
        signal?: AbortSignal
    ): Promise<{ url: string; key: string; skipped: boolean }> {
        const settings = this.getSettings();
        const key = this.buildKey(request);
        const contentType = request.contentType || mimeTypeFromExt(request.ext);

        if (settings.naming === 'hash' && settings.skipIfExists) {
            const exists = await this.client.headObject(key, signal);
            if (exists) {
                return { url: this.buildUrl(key), key, skipped: true };
            }
        }

        await this.client.putObject(
            key,
            new Uint8Array(request.buffer),
            contentType,
            settings.cacheControlSeconds > 0 ? `public, max-age=${settings.cacheControlSeconds}` : 'no-cache',
            signal
        );

        return { url: this.buildUrl(key), key, skipped: false };
    }

    /** 测试配置是否可用（用于设置页的“测试连接”） */
    async testConnection(): Promise<string> {
        const settings = this.getSettings();
        if (!settings.bucket || !settings.region) throw new Error('请先填写 Bucket 和 Region');

        const key = `${normalizePrefix(settings.pathPrefix)}__connectivity_test__.txt`;
        await this.client.putObject(key, utf8Bytes('ok'), 'text/plain');
        await this.client.deleteObject(key);

        return `连接正常，可以访问 ${this.buildUrl(key)}`;
    }
}

function sanitizeFileName(name: string, ext: string): string {
    let base = name
        .replace(/^.*[\\/]/, '')
        .replace(/\.[^.]*$/, '')
        .replace(/[\\/:*?"<>|#%&\s]+/g, '_')
        .replace(/^_+|_+$/g, '');

    if (!base) base = 'image';
    if (base.length > 60) base = base.slice(0, 60);

    return `${base}.${ext}`;
}

export function mimeTypeFromExt(ext: string): string {
    const map: Record<string, string> = {
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        png: 'image/png',
        gif: 'image/gif',
        webp: 'image/webp',
        svg: 'image/svg+xml',
        bmp: 'image/bmp',
        ico: 'image/x-icon',
        avif: 'image/avif',
        heic: 'image/heic',
        heif: 'image/heif',
        tif: 'image/tiff',
        tiff: 'image/tiff',
    };
    return map[(ext || '').toLowerCase()] || 'application/octet-stream';
}
