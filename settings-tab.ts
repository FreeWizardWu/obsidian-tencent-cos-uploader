import { App, Platform, PluginSettingTab, Setting, Notice } from 'obsidian';
import TencentCOSUploaderPlugin from './main';
import { normalizeDomain, normalizePrefix } from './settings';

export class TencentCOSUploaderSettingTab extends PluginSettingTab {
    plugin: TencentCOSUploaderPlugin;
    private saveTimer: number | null = null;

    constructor(app: App, plugin: TencentCOSUploaderPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.addClass('tencent-cos-uploader-settings');

        this.renderCosSection(containerEl);
        this.renderNetworkSection(containerEl);
        this.renderUploadSection(containerEl);
        this.renderActions(containerEl);
    }

    /** 输入时不必每次按键都写盘 */
    private persist(): void {
        if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
        this.saveTimer = window.setTimeout(() => {
            this.saveTimer = null;
            void this.plugin.saveSettings();
        }, 600);
    }

    /* ------------------------------ COS ------------------------------ */

    private renderCosSection(containerEl: HTMLElement): void {
        new Setting(containerEl).setName('腾讯云 COS').setHeading();

        new Setting(containerEl)
            .setName('App ID')
            .setDesc('腾讯云账号的 App ID（仅作备注，可不填）')
            .addText((text) =>
                text
                    .setPlaceholder('1250000000')
                    .setValue(this.plugin.settings.appId)
                    .onChange((value) => {
                        this.plugin.settings.appId = value.trim();
                        this.persist();
                    })
            );

        this.passwordSetting(
            containerEl,
            'SecretId',
            '建议使用子账号密钥，并只授予该 Bucket 的上传权限',
            'AKIDxxxxxxxxxxxxxxxx',
            () => this.plugin.settings.secretId,
            (value) => (this.plugin.settings.secretId = value.trim())
        );

        this.passwordSetting(
            containerEl,
            'SecretKey',
            '密钥以明文保存在插件 data.json 中，请勿把该文件同步到公开仓库',
            'xxxxxxxxxxxxxxxx',
            () => this.plugin.settings.secretKey,
            (value) => (this.plugin.settings.secretKey = value.trim())
        );

        new Setting(containerEl)
            .setName('Bucket')
            .setDesc('存储桶名称，形如 obsidian-1250000000')
            .addText((text) =>
                text
                    .setPlaceholder('obsidian-1250000000')
                    .setValue(this.plugin.settings.bucket)
                    .onChange((value) => {
                        this.plugin.settings.bucket = value.trim();
                        this.persist();
                    })
            );

        new Setting(containerEl)
            .setName('Region')
            .setDesc('存储桶地域，形如 ap-guangzhou')
            .addText((text) =>
                text
                    .setPlaceholder('ap-guangzhou')
                    .setValue(this.plugin.settings.region)
                    .onChange((value) => {
                        this.plugin.settings.region = value.trim();
                        this.persist();
                    })
            );

        new Setting(containerEl)
            .setName('路径前缀')
            .setDesc('对象 key 的前缀，例如 picgo/；留空则放在根目录')
            .addText((text) =>
                text
                    .setPlaceholder('picgo/')
                    .setValue(this.plugin.settings.pathPrefix)
                    .onChange((value) => {
                        this.plugin.settings.pathPrefix = normalizePrefix(value);
                        this.persist();
                    })
            );

        new Setting(containerEl)
            .setName('自定义 CDN 域名')
            .setDesc('可选。留空则使用默认的 Bucket 域名')
            .addText((text) =>
                text
                    .setPlaceholder('cdn.example.com')
                    .setValue(this.plugin.settings.cdnDomain)
                    .onChange((value) => {
                        this.plugin.settings.cdnDomain = normalizeDomain(value);
                        this.persist();
                    })
            );
    }

    /* ------------------------------ 网络 ------------------------------ */

    private renderNetworkSection(containerEl: HTMLElement): void {
        new Setting(containerEl).setName('下载网络').setHeading();

        if (!Platform.isDesktopApp) {
            containerEl.createEl('p', {
                text:
                    '移动端只能走系统网络（Obsidian 自带的 requestUrl），代理设置不生效，因此已隐藏。' +
                    '如果某些图片下载失败，请检查手机当前网络能否访问对应域名。',
                cls: 'setting-item-description',
            });
        }

        if (Platform.isDesktopApp) {
            new Setting(containerEl)
                .setName('HTTP 代理')
                .setDesc(
                    '下载海外图片（X/Twitter、GitHub 等）时使用，例如 http://127.0.0.1:7897。' +
                        '留空则只依赖系统代理；不支持 socks:// 地址，请填代理软件的 HTTP 端口。'
                )
                .addText((text) =>
                    text
                        .setPlaceholder('http://127.0.0.1:7897')
                        .setValue(this.plugin.settings.proxyUrl)
                        .onChange((value) => {
                            this.plugin.settings.proxyUrl = value.trim();
                            this.persist();
                        })
                );

            new Setting(containerEl)
                .setName('优先使用 Obsidian 网络栈')
                .setDesc(
                    '开启后先用 Obsidian 内置的 requestUrl 下载（会自动使用系统代理），失败再回退到上面的 HTTP 代理 / 直连。建议保持开启。'
                )
                .addToggle((toggle) =>
                    toggle.setValue(this.plugin.settings.preferObsidianRequest).onChange((value) => {
                        this.plugin.settings.preferObsidianRequest = value;
                        void this.plugin.saveSettings();
                    })
                );
        }

        new Setting(containerEl)
            .setName('自定义 User-Agent')
            .setDesc('留空使用内置的浏览器 UA。部分站点会拒绝非浏览器 UA。')
            .addText((text) =>
                text
                    .setPlaceholder('Mozilla/5.0 ...')
                    .setValue(this.plugin.settings.userAgent)
                    .onChange((value) => {
                        this.plugin.settings.userAgent = value;
                        this.persist();
                    })
            );

        new Setting(containerEl)
            .setName('自定义 Referer')
            .setDesc('留空则按图片域名自动推断（如 pbs.twimg.com → https://x.com/）。防盗链站点可在此手工指定。')
            .addText((text) =>
                text
                    .setPlaceholder('https://x.com/')
                    .setValue(this.plugin.settings.referer)
                    .onChange((value) => {
                        this.plugin.settings.referer = value.trim();
                        this.persist();
                    })
            );

        new Setting(containerEl)
            .setName('超时时间（毫秒）')
            .setDesc('单次下载请求的超时时间')
            .addText((text) =>
                text
                    .setPlaceholder('30000')
                    .setValue(String(this.plugin.settings.timeoutMs))
                    .onChange((value) => {
                        const num = Number(value);
                        if (Number.isFinite(num) && num >= 3000) {
                            this.plugin.settings.timeoutMs = num;
                            this.persist();
                        }
                    })
            );

        new Setting(containerEl)
            .setName('失败重试次数')
            .setDesc('遇到超时、连接重置、5xx 时自动重试的次数（0-5）')
            .addSlider((slider) =>
                slider
                    .setLimits(0, 5, 1)
                    .setValue(this.plugin.settings.retries)
                    .setDynamicTooltip()
                    .onChange((value) => {
                        this.plugin.settings.retries = value;
                        this.persist();
                    })
            );

        new Setting(containerEl)
            .setName('同域名并发上限')
            .setDesc(
                '同一个图床（如 mmbiz.qpic.cn）同时发起的请求数上限，用于避免被限流。遇到大量 429 时可以调低。'
            )
            .addSlider((slider) =>
                slider
                    .setLimits(0, 8, 1)
                    .setValue(this.plugin.settings.perHostLimit)
                    .setDynamicTooltip()
                    .onChange((value) => {
                        this.plugin.settings.perHostLimit = value;
                        this.persist();
                    })
            );
    }

    /* ------------------------------ 上传 ------------------------------ */

    private renderUploadSection(containerEl: HTMLElement): void {
        new Setting(containerEl).setName('上传').setHeading();

        new Setting(containerEl)
            .setName('文件命名方式')
            .setDesc(
                '内容哈希：同一张图只存一份，重复运行零成本（推荐）；时间戳：每次运行都新建对象；原名：保持原始文件名，可能重名覆盖。'
            )
            .addDropdown((dropdown) =>
                dropdown
                    .addOption('hash', '内容哈希（推荐）')
                    .addOption('timestamp', '时间戳_文件名')
                    .addOption('original', '原始文件名')
                    .setValue(this.plugin.settings.naming)
                    .onChange((value) => {
                        this.plugin.settings.naming = value as 'hash' | 'timestamp' | 'original';
                        void this.plugin.saveSettings();
                        this.display();
                    })
            );

        if (this.plugin.settings.naming === 'hash') {
            new Setting(containerEl)
                .setName('哈希已存在时跳过上传')
                .setDesc('上传前先检查 COS 是否已有同名对象，有则直接复用链接，不再消耗流量')
                .addToggle((toggle) =>
                    toggle.setValue(this.plugin.settings.skipIfExists).onChange((value) => {
                        this.plugin.settings.skipIfExists = value;
                        void this.plugin.saveSettings();
                    })
                );
        }

        new Setting(containerEl)
            .setName('并发数')
            .setDesc('同时下载/上传的图片数量，过大可能被图床限流')
            .addSlider((slider) =>
                slider
                    .setLimits(1, 8, 1)
                    .setValue(this.plugin.settings.concurrency)
                    .setDynamicTooltip()
                    .onChange((value) => {
                        this.plugin.settings.concurrency = value;
                        this.persist();
                    })
            );

        new Setting(containerEl)
            .setName('缓存时间（秒）')
            .setDesc('对象 Cache-Control 的 max-age，默认 31536000（一年）。填 0 表示不缓存。')
            .addText((text) =>
                text
                    .setPlaceholder('31536000')
                    .setValue(String(this.plugin.settings.cacheControlSeconds))
                    .onChange((value) => {
                        const num = Number(value);
                        if (Number.isFinite(num) && num >= 0) {
                            this.plugin.settings.cacheControlSeconds = num;
                            this.persist();
                        }
                    })
            );

        new Setting(containerEl)
            .setName('上传 base64 内嵌图')
            .setDesc('把笔记里 data:image/...;base64 形式的内嵌图片解码后上传，再把正文替换成 COS 链接')
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.uploadInlineBase64).onChange((value) => {
                    this.plugin.settings.uploadInlineBase64 = value;
                    void this.plugin.saveSettings();
                })
            );

        new Setting(containerEl)
            .setName('上传 frontmatter 封面')
            .setDesc('处理 cover / image / banner 等字段里的外链封面图')
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.uploadFrontmatterCovers).onChange((value) => {
                    this.plugin.settings.uploadFrontmatterCovers = value;
                    void this.plugin.saveSettings();
                })
            );

        new Setting(containerEl)
            .setName('上传前确认阈值')
            .setDesc('待处理图片数达到该值时先弹出确认窗口。填 0 表示从不确认，直接开始。')
            .addText((text) =>
                text
                    .setPlaceholder('10')
                    .setValue(String(this.plugin.settings.confirmThreshold))
                    .onChange((value) => {
                        const num = Number(value);
                        if (Number.isFinite(num) && num >= 0) {
                            this.plugin.settings.confirmThreshold = num;
                            this.persist();
                        }
                    })
            );
    }

    /* ------------------------------ 操作 ------------------------------ */

    private renderActions(containerEl: HTMLElement): void {
        new Setting(containerEl).setName('操作').setHeading();

        new Setting(containerEl)
            .setName('测试 COS 连接')
            .setDesc('上传一个临时文件再删除，用来验证密钥 / Bucket / Region 是否正确')
            .addButton((button) =>
                button.setButtonText('测试').onClick(async () => {
                    button.setDisabled(true);
                    const notice = new Notice('正在测试 COS 连接…', 0);
                    try {
                        const message = await this.plugin.uploaderTestConnection();
                        notice.setMessage(message);
                    } catch (error) {
                        notice.setMessage(
                            `连接失败：${error instanceof Error ? error.message : String(error)}`
                        );
                    } finally {
                        button.setDisabled(false);
                        window.setTimeout(() => notice.hide(), 8000);
                    }
                })
            );
    }

    /* ------------------------------ 工具 ------------------------------ */

    private passwordSetting(
        containerEl: HTMLElement,
        name: string,
        desc: string,
        placeholder: string,
        getValue: () => string,
        setValue: (value: string) => void
    ): void {
        let inputEl: HTMLInputElement | null = null;

        new Setting(containerEl)
            .setName(name)
            .setDesc(desc)
            .addText((text) => {
                inputEl = text.inputEl;
                text.inputEl.type = 'password';
                text.inputEl.autocomplete = 'off';
                text
                    .setPlaceholder(placeholder)
                    .setValue(getValue())
                    .onChange((value) => {
                        setValue(value);
                        this.persist();
                    });
            })
            .addExtraButton((button) => {
                button
                    .setIcon('eye')
                    .setTooltip('显示 / 隐藏')
                    .onClick(() => {
                        if (!inputEl) return;
                        inputEl.type = inputEl.type === 'password' ? 'text' : 'password';
                    });
            });
    }
}
