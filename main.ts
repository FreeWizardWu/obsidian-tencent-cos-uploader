import { Plugin, TFile, Notice, Platform } from 'obsidian';
import { TencentCOSUploaderSettings, migrateSettings } from './settings';
import { TencentCOSUploaderSettingTab } from './settings-tab';
import { ImageDownloader, DownloadOptions } from './downloader';
import { COSUploader } from './cos-uploader';
import { PreflightModal, PreflightSummary } from './preflight-modal';
import {
    parseImageLinks,
    replaceImageTargets,
    isRemoteTarget,
    isImageExtension,
    looksLikeImagePath,
    isBase64ImageDataUri,
    decodeBase64ImageDataUri,
    extensionOf,
} from './parser';

const LEGACY_TEMP_DIR_NAME = 'tencent-cos-uploader-temp';
const DEFAULT_USER_AGENT =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

type TaskKind = 'local' | 'remote' | 'inline';

interface ImageTask {
    /** 笔记里出现的原始链接，作为替换用的 key */
    target: string;
    kind: TaskKind;
    referer?: string;
}

/** 一次运行的可取消上下文 */
class RunToken {
    cancelled = false;
    private readonly controller = new AbortController();

    get signal(): AbortSignal {
        return this.controller.signal;
    }

    cancel(): void {
        this.cancelled = true;
        this.controller.abort();
    }
}

export default class TencentCOSUploaderPlugin extends Plugin {
    settings: TencentCOSUploaderSettings;
    private downloader = new ImageDownloader();
    private uploader: COSUploader;
    private statusBarEl: HTMLElement | null = null;
    private activeRun: RunToken | null = null;
    private activePreflight: PreflightModal | null = null;

    async onload() {
        await this.loadSettings();
        this.uploader = new COSUploader(() => this.settings);

        void this.cleanupLegacyTempDir();

        this.addCommand({
            id: 'upload-local-images',
            name: 'Upload local images in current note',
            checkCallback: (checking: boolean) => {
                const activeFile = this.app.workspace.getActiveFile();
                if (!activeFile || activeFile.extension !== 'md') return false;
                if (!checking) void this.uploadAllImages(activeFile, false);
                return true;
            },
        });

        this.addCommand({
            id: 'upload-all-images',
            name: 'Upload all images (local + remote + inline) in current note',
            checkCallback: (checking: boolean) => {
                const activeFile = this.app.workspace.getActiveFile();
                if (!activeFile || activeFile.extension !== 'md') return false;
                if (!checking) void this.uploadAllImages(activeFile, true);
                return true;
            },
        });

        this.addCommand({
            id: 'cancel-upload',
            name: 'Cancel running image upload',
            checkCallback: (checking: boolean) => {
                if (!this.activeRun) return false;
                if (!checking) this.cancelActiveRun();
                return true;
            },
        });

        this.addCommand({
            id: 'test-cos-connection',
            name: 'Test COS connection',
            callback: () => void this.testConnection(),
        });

        this.addRibbonIcon('image', '上传笔记图片到 COS（本地 + 远程 + 内嵌）', () => {
            const activeFile = this.app.workspace.getActiveFile();
            if (activeFile && activeFile.extension === 'md') {
                void this.uploadAllImages(activeFile, true);
            } else {
                new Notice('请先打开一篇 Markdown 笔记。');
            }
        });

        this.registerEvent(
            this.app.workspace.on('file-menu', (menu, file) => {
                if (!(file instanceof TFile) || file.extension !== 'md') return;
                menu.addItem((item) =>
                    item
                        .setTitle('上传笔记图片到 COS')
                        .setIcon('image')
                        .onClick(() => void this.uploadAllImages(file as TFile, true))
                );
            })
        );

        this.addSettingTab(new TencentCOSUploaderSettingTab(this.app, this));
    }

    onunload() {
        // 卸载时直接断掉，不要留下复位定时器
        if (this.activeRun) {
            this.activeRun.cancel();
            this.activeRun = null;
        }
        if (this.activePreflight) {
            this.activePreflight.close();
            this.activePreflight = null;
        }
        this.setStatusBar(null);
    }

    /* ------------------------------------------------------------------ */
    /* 配置                                                               */
    /* ------------------------------------------------------------------ */

    async loadSettings() {
        this.settings = migrateSettings(await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    /** 本插件不再需要预初始化 SDK，客户端每次读取最新设置 */

    private validateSettings(): boolean {
        const missing: string[] = [];
        if (!this.settings.secretId) missing.push('SecretId');
        if (!this.settings.secretKey) missing.push('SecretKey');
        if (!this.settings.bucket) missing.push('Bucket');
        if (!this.settings.region) missing.push('Region');

        if (missing.length > 0) {
            new Notice(`COS 配置不完整，缺少：${missing.join('、')}。请到插件设置中补齐。`, 8000);
            console.error('[COS Uploader] 配置缺失:', missing);
            return false;
        }
        return true;
    }

    private get downloadOptions(): DownloadOptions {
        return {
            userAgent: this.settings.userAgent.trim() || DEFAULT_USER_AGENT,
            proxyUrl: this.settings.proxyUrl,
            referer: this.settings.referer,
            timeoutMs: this.settings.timeoutMs,
            retries: this.settings.retries,
            maxBytes: 80 * 1024 * 1024,
            preferObsidianRequest: this.settings.preferObsidianRequest,
            requireImageContentType: true,
            perHostLimit: this.settings.perHostLimit,
        };
    }

    async uploaderTestConnection(): Promise<string> {
        const missing: string[] = [];
        if (!this.settings.secretId) missing.push('SecretId');
        if (!this.settings.secretKey) missing.push('SecretKey');
        if (!this.settings.bucket) missing.push('Bucket');
        if (!this.settings.region) missing.push('Region');
        if (missing.length > 0) throw new Error(`配置不完整，缺少：${missing.join('、')}`);

        return this.uploader.testConnection();
    }

    async testConnection() {
        if (!this.validateSettings()) return;
        const notice = new Notice('正在测试 COS 连接…', 0);
        try {
            const message = await this.uploader.testConnection();
            notice.setMessage(message);
            setTimeout(() => notice.hide(), 6000);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            notice.setMessage(`连接失败：${message}`);
            setTimeout(() => notice.hide(), 10000);
        }
    }

    cancelActiveRun() {
        const token = this.activeRun;
        if (!token) return;

        token.cancel();

        // 预检弹窗还开着的话，先把弹窗关掉，否则流程永远卡在等用户点击
        if (this.activePreflight) {
            this.activePreflight.close();
            this.activePreflight = null;
        }

        new Notice('正在取消，等待进行中的任务收尾…');

        // 兜底：网络层卡死时也不能让插件一直锁在“上一次上传还没结束”
        setTimeout(() => {
            if (this.activeRun === token) {
                this.activeRun = null;
                this.setStatusBar(null);
                new Notice('已强制复位上传状态，可以重新开始了。', 8000);
            }
        }, 15000);
    }

    /* ------------------------------------------------------------------ */
    /* 主流程                                                             */
    /* ------------------------------------------------------------------ */

    async uploadAllImages(file: TFile, includeRemote = false) {
        if (!this.validateSettings()) return;
        if (this.activeRun) {
            new Notice(
                '上一次上传还没结束。点击状态栏或运行 “Cancel running image upload” 可以取消（取消后最多 15 秒会自动复位）。'
            );
            return;
        }

        const token = new RunToken();
        this.activeRun = token;
        const notice = new Notice('正在扫描图片…', 0);

        try {
            const content = await this.app.vault.read(file);
            const articleReferer = this.getArticleReferer(file);
            const collected = this.collectTasks(content, includeRemote, articleReferer);

            if (collected.tasks.length === 0) {
                notice.hide();
                new Notice(this.describeNothingToDo(collected));
                return;
            }

            // 预检确认：图片较多时先让人确认再动手
            if (collected.tasks.length >= this.settings.confirmThreshold) {
                notice.hide();
                const summary = this.buildSummary(collected);
                this.activePreflight = new PreflightModal(this.app, file, summary);
                let confirmed = false;
                try {
                    confirmed = await this.activePreflight.openAndWait();
                } finally {
                    this.activePreflight = null;
                }
                if (!confirmed) {
                    new Notice('已取消，笔记未做任何修改。');
                    return;
                }
            }

            const mapping = new Map<string, string>();
            const total = collected.tasks.length;
            let done = 0;
            let success = 0;
            let reused = 0;
            let failed = 0;
            const failures: string[] = [];

            const updateProgress = (hint: string) => {
                const base = `COS ${done}/${total}（成功 ${success}，复用 ${reused}，失败 ${failed}）`;
                const line = token.cancelled ? `${base} 正在取消…` : `${base} · 点击取消`;
                this.setStatusBar(line);
                notice.setMessage(`${line}\n${hint}`);
            };

            this.setStatusBarCancellable(token);
            updateProgress('准备中…');

            await runWithConcurrency(collected.tasks, this.settings.concurrency, token, async (task) => {
                updateProgress(`处理: ${shorten(task.target, 48)}`);
                try {
                    const result = await withTaskTimeout(
                        this.runTask(task, file, token),
                        TASK_TIMEOUT_MS,
                        token
                    );
                    mapping.set(task.target, result.url);
                    if (result.reused) reused++;
                    else success++;
                } catch (error) {
                    if (token.cancelled && !mapping.has(task.target)) {
                        // 取消导致的失败不计入失败数
                        return;
                    }
                    failed++;
                    const message = error instanceof Error ? error.message : String(error);
                    failures.push(`${shorten(describeTarget(task), 60)} → ${message}`);
                    console.error('[COS Uploader] 处理失败:', task.target.slice(0, 120), error);
                } finally {
                    done++;
                    updateProgress(`最近: ${shorten(describeTarget(task), 48)}`);
                }
            });

            if (mapping.size > 0) {
                await this.applyReplacements(file, mapping);
            }

            this.setStatusBar(null);
            notice.hide();

            const skippedParts: string[] = [];
            if (collected.alreadyOnCos > 0) skippedParts.push(`跳过 ${collected.alreadyOnCos} 张已在 COS 上`);
            if (collected.skippedRemote > 0) skippedParts.push(`${collected.skippedRemote} 张远程图片未包含`);
            const skippedText = skippedParts.length ? `，${skippedParts.join('，')}` : '';

            if (token.cancelled) {
                new Notice(
                    `已取消：已替换 ${mapping.size} 张图片，其余保持原样${skippedText}。`,
                    10000
                );
            } else if (failures.length === 0) {
                new Notice(
                    `完成：上传 ${success} 张${reused > 0 ? `，复用已有 ${reused} 张` : ''}${skippedText}。`
                );
            } else {
                new Notice(
                    `完成：成功 ${success + reused} 张，失败 ${failed} 张${skippedText}。\n` +
                        failures.slice(0, 3).join('\n') +
                        (failures.length > 3 ? `\n…还有 ${failures.length - 3} 条，详见开发者控制台` : ''),
                    12000
                );
                console.warn('[COS Uploader] 全部失败详情:', failures);
            }
        } catch (error) {
            notice.hide();
            this.setStatusBar(null);
            const message = error instanceof Error ? error.message : String(error);
            new Notice(`上传过程出错：${message}`, 10000);
            console.error('[COS Uploader] 上传过程出错:', error);
        } finally {
            this.activeRun = null;
        }
    }

    /* ------------------------------------------------------------------ */
    /* 任务收集                                                           */
    /* ------------------------------------------------------------------ */

    private collectTasks(content: string, includeRemote: boolean, articleReferer?: string) {
        const links = parseImageLinks(content);
        const tasks: ImageTask[] = [];
        const seen = new Set<string>();
        let alreadyOnCos = 0;
        let skippedRemote = 0;
        let skippedInline = 0;
        let skippedFrontmatter = 0;

        for (const link of links) {
            const target = link.target.trim();
            if (!target) continue;

            if (link.kind === 'frontmatter' && !this.settings.uploadFrontmatterCovers) {
                skippedFrontmatter++;
                continue;
            }

            if (isBase64ImageDataUri(target)) {
                if (!this.settings.uploadInlineBase64) {
                    skippedInline++;
                    continue;
                }
                if (seen.has(target)) continue;
                seen.add(target);
                tasks.push({ target, kind: 'inline' });
                continue;
            }
            if (/^(blob|file|javascript|mailto):/i.test(target)) continue;

            if (this.uploader.isOwnUrl(target)) {
                alreadyOnCos++;
                continue;
            }

            const remote = isRemoteTarget(target);
            if (remote && !includeRemote) {
                skippedRemote++;
                continue;
            }
            if (!remote && !looksLikeImagePath(target) && extensionOf(target) && link.kind !== 'wiki') {
                continue;
            }
            if (link.kind === 'frontmatter' && !remote) continue;

            if (seen.has(target)) continue;
            seen.add(target);
            tasks.push({ target, kind: remote ? 'remote' : 'local', referer: articleReferer });
        }

        return { tasks, alreadyOnCos, skippedRemote, skippedInline, skippedFrontmatter };
    }

    private buildSummary(collected: ReturnType<TencentCOSUploaderPlugin['collectTasks']>): PreflightSummary {
        const hosts = new Map<string, number>();
        let local = 0;
        let remote = 0;
        let inline = 0;
        let frontmatter = 0;

        for (const task of collected.tasks) {
            if (task.kind === 'local') local++;
            else if (task.kind === 'inline') inline++;
            else {
                remote++;
                try {
                    const host = new URL(task.target).hostname;
                    hosts.set(host, (hosts.get(host) || 0) + 1);
                } catch {
                    hosts.set('(未知)', 1);
                }
            }
        }

        return {
            total: collected.tasks.length,
            local,
            remote,
            inline,
            frontmatter,
            alreadyOnCos: collected.alreadyOnCos,
            skippedRemote: collected.skippedRemote,
            hosts: [...hosts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8),
        };
    }

    private describeNothingToDo(collected: ReturnType<TencentCOSUploaderPlugin['collectTasks']>): string {
        if (collected.skippedRemote > 0) {
            return `没有找到本地图片。这篇笔记还有 ${collected.skippedRemote} 张远程图片，请用 “Upload all images” 命令。`;
        }
        if (collected.skippedInline > 0) {
            return `有 ${collected.skippedInline} 张 base64 内嵌图，但设置里关闭了内嵌图上传。`;
        }
        if (collected.skippedFrontmatter > 0) {
            return `有 ${collected.skippedFrontmatter} 张 frontmatter 封面，但设置里关闭了封面上传。`;
        }
        if (collected.alreadyOnCos > 0) {
            return `没有需要上传的图片（${collected.alreadyOnCos} 张已在 COS 上）。`;
        }
        return '没有找到需要上传的图片。';
    }

    /* ------------------------------------------------------------------ */
    /* 单任务执行                                                         */
    /* ------------------------------------------------------------------ */

    private async runTask(
        task: ImageTask,
        noteFile: TFile,
        token: RunToken
    ): Promise<{ url: string; reused: boolean }> {
        if (task.kind === 'inline') return this.handleInlineImage(task.target, token);
        if (task.kind === 'local') return this.handleLocalImage(task.target, noteFile, token);
        return this.handleRemoteImage(task.target, task.referer, token);
    }

    private async handleRemoteImage(
        src: string,
        referer: string | undefined,
        token: RunToken
    ): Promise<{ url: string; reused: boolean }> {
        const download = await this.downloader.download(
            src,
            this.downloadOptions,
            referer,
            token.signal
        );
        const fileName = fileNameFromUrl(download.finalUrl || src, download.ext);

        const result = await this.uploader.upload(
            {
                buffer: download.buffer,
                ext: download.ext,
                fileName,
                contentType: download.contentType,
            },
            token.signal
        );

        console.log(`[COS Uploader] 远程图片完成 (${download.via}): ${shorten(src, 50)} → ${result.url}`);
        return { url: result.url, reused: result.skipped };
    }

    private async handleLocalImage(
        src: string,
        noteFile: TFile,
        token: RunToken
    ): Promise<{ url: string; reused: boolean }> {
        const imageFile = this.resolveLocalImage(src, noteFile);
        if (!imageFile) throw new Error('在库中找不到该图片文件');
        if (!isImageExtension(imageFile.extension)) {
            throw new Error(`不是图片文件（.${imageFile.extension}）`);
        }

        const buffer = (await this.app.vault.readBinary(imageFile)) as ArrayBuffer;
        const result = await this.uploader.upload(
            {
                buffer,
                ext: imageFile.extension.toLowerCase(),
                fileName: imageFile.name,
            },
            token.signal
        );
        return { url: result.url, reused: result.skipped };
    }

    private async handleInlineImage(
        target: string,
        token: RunToken
    ): Promise<{ url: string; reused: boolean }> {
        const decoded = decodeBase64ImageDataUri(target);
        if (!decoded) throw new Error('base64 内嵌图解码失败');

        const result = await this.uploader.upload(
            {
                buffer: decoded.buffer,
                ext: decoded.ext,
                contentType: decoded.mime,
                fileName: `inline.${decoded.ext}`,
            },
            token.signal
        );
        console.log(`[COS Uploader] 内嵌图完成: ${result.url}`);
        return { url: result.url, reused: result.skipped };
    }

    private resolveLocalImage(src: string, noteFile: TFile): TFile | null {
        const candidates = new Set<string>([src]);

        try {
            candidates.add(decodeURIComponent(src));
        } catch {
            /* 忽略非法编码 */
        }
        candidates.add(src.replace(/\\/g, '/').split('#')[0].split('|')[0].trim());
        candidates.add(basename(src.replace(/\\/g, '/')));

        for (const candidate of candidates) {
            if (!candidate) continue;
            const resolved = this.app.metadataCache.getFirstLinkpathDest(candidate, noteFile.path);
            if (resolved) return resolved;
        }
        return null;
    }

    /* ------------------------------------------------------------------ */
    /* 写回                                                               */
    /* ------------------------------------------------------------------ */

    private async applyReplacements(file: TFile, mapping: Map<string, string>): Promise<void> {
        const apply = (data: string) => replaceImageTargets(data, mapping);

        const vaultAny = this.app.vault as unknown as {
            process?: (file: TFile, fn: (data: string) => string) => Promise<string>;
        };

        if (typeof vaultAny.process === 'function') {
            await vaultAny.process(file, apply);
            return;
        }

        const current = await this.app.vault.read(file);
        const updated = apply(current);
        if (updated !== current) await this.app.vault.modify(file, updated);
    }

    private getArticleReferer(file: TFile): string | undefined {
        if (this.settings.referer) return this.settings.referer;

        const cache = this.app.metadataCache.getFileCache(file);
        const frontmatter = cache?.frontmatter as Record<string, unknown> | undefined;
        if (!frontmatter) return undefined;

        for (const key of ['source', 'url', 'link', 'original', 'from']) {
            const value = frontmatter[key];
            if (typeof value !== 'string') continue;
            const match = /^https?:\/\/[^\s/]+/i.exec(value.trim());
            if (match) return `${match[0]}/`;
        }
        return undefined;
    }

    /* ------------------------------------------------------------------ */
    /* 状态栏                                                             */
    /* ------------------------------------------------------------------ */

    private setStatusBar(text: string | null) {
        if (text === null) {
            if (this.statusBarEl) {
                this.statusBarEl.remove();
                this.statusBarEl = null;
            }
            return;
        }
        if (!this.statusBarEl) this.statusBarEl = this.addStatusBarItem();
        this.statusBarEl.setText(text);
    }

    private setStatusBarCancellable(token: RunToken) {
        this.setStatusBar('COS 准备中…');
        if (!this.statusBarEl) return;
        this.statusBarEl.setAttribute('aria-label', '点击取消上传');
        this.statusBarEl.addClass('mod-clickable');
        this.statusBarEl.onClickEvent(() => {
            if (!token.cancelled) {
                token.cancel();
                new Notice('正在取消，等待进行中的任务收尾…');
            }
        });
    }

    /** 清理旧版本残留在 .obsidian/plugins 下的临时目录（仅桌面端） */
    private async cleanupLegacyTempDir() {
        if (!Platform.isDesktopApp) return;
        try {
            const basePath = (this.app.vault.adapter as unknown as { basePath?: string }).basePath;
            const manifestDir = this.manifest.dir;
            if (!basePath || !manifestDir) return;

            const [fs, path] = await Promise.all([import('fs'), import('path')]);
            const legacyDir = path.resolve(basePath, manifestDir, '..', LEGACY_TEMP_DIR_NAME);
            if (fs.existsSync(legacyDir)) {
                fs.rmSync(legacyDir, { recursive: true, force: true });
                console.log('[COS Uploader] 已清理旧临时目录:', legacyDir);
            }
        } catch (error) {
            console.warn('[COS Uploader] 清理旧临时目录失败:', error);
        }
    }
}

/* -------------------------------------------------------------------------- */
/* 工具函数                                                                   */
/* -------------------------------------------------------------------------- */

/** 单张图片的处理上限，防止某一张卡死拖住整轮上传 */
const TASK_TIMEOUT_MS = 180_000;

/**
 * 给单个任务套上超时与取消。
 * 底层请求本身已经有超时了，这里是最后一道保险：
 * 即使某个 Promise 永远不 settle，整轮上传也能结束，不会把插件锁死。
 */
function withTaskTimeout<T>(promise: Promise<T>, timeoutMs: number, token: RunToken): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        let settled = false;

        const cleanup = () => {
            clearTimeout(timer);
            token.signal.removeEventListener('abort', onAbort);
        };
        const finish = (error: Error | null, value?: T) => {
            if (settled) return;
            settled = true;
            cleanup();
            if (error) reject(error);
            else resolve(value as T);
        };

        const timer = setTimeout(
            () => finish(new Error(`处理超时（超过 ${Math.round(timeoutMs / 1000)} 秒）`)),
            timeoutMs
        );
        const onAbort = () => finish(new Error('已取消'));

        if (token.cancelled) {
            finish(new Error('已取消'));
            return;
        }
        token.signal.addEventListener('abort', onAbort, { once: true });

        promise.then(
            (value) => finish(null, value),
            (error) => finish(error instanceof Error ? error : new Error(String(error)))
        );
    });
}

async function runWithConcurrency<T>(
    items: T[],
    limit: number,
    token: RunToken,
    worker: (item: T, index: number) => Promise<void>
): Promise<void> {
    const size = Math.max(1, Math.min(limit, items.length));
    let cursor = 0;

    const runners = Array.from({ length: size }, async () => {
        while (true) {
            if (token.cancelled) return;
            const index = cursor++;
            if (index >= items.length) return;
            await worker(items[index], index);
        }
    });

    await Promise.all(runners);
}

function fileNameFromUrl(url: string, ext: string): string {
    try {
        const parsed = new URL(url);
        const base = decodeURIComponent(parsed.pathname.split('/').pop() || '');
        if (base && /\.[a-z0-9]{2,5}$/i.test(base)) return base;
        const id = parsed.pathname.split('/').filter(Boolean).pop() || 'image';
        return `${id}.${ext}`;
    } catch {
        return `image.${ext}`;
    }
}

function shorten(value: string, max: number): string {
    return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** 取路径的最后一段（不依赖 Node 的 path 模块） */
function basename(value: string): string {
    const parts = value.split('/');
    return parts[parts.length - 1] || value;
}

function describeTarget(task: ImageTask): string {
    if (task.kind === 'inline') return '(base64 内嵌图)';
    return task.target;
}
