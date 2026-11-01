import { App, Modal, Setting, TFile } from 'obsidian';

export interface PreflightSummary {
    total: number;
    local: number;
    remote: number;
    inline: number;
    frontmatter: number;
    alreadyOnCos: number;
    skippedRemote: number;
    hosts: Array<[string, number]>;
}

/**
 * 上传前的确认弹窗：图片较多时先让人看清「要动多少张、都来自哪里」。
 */
export class PreflightModal extends Modal {
    private resolved = false;
    private resolveFn: (value: boolean) => void = () => undefined;

    constructor(
        app: App,
        private file: TFile,
        private summary: PreflightSummary
    ) {
        super(app);
    }

    openAndWait(): Promise<boolean> {
        return new Promise<boolean>((resolve) => {
            this.resolveFn = resolve;
            this.open();
        });
    }

    onOpen(): void {
        const { contentEl, titleEl } = this;
        titleEl.setText('确认上传图片到 COS');

        contentEl.createEl('p', {
            text: `笔记《${this.file.basename}》中找到 ${this.summary.total} 张待处理图片：`,
        });

        const list = contentEl.createEl('ul');
        const push = (label: string, count: number) => {
            if (count > 0) list.createEl('li', { text: `${label}：${count} 张` });
        };
        push('本地图片', this.summary.local);
        push('远程图片', this.summary.remote);
        push('base64 内嵌图', this.summary.inline);
        push('frontmatter 封面', this.summary.frontmatter);

        if (this.summary.hosts.length > 0) {
            const hostBox = contentEl.createEl('div');
            hostBox.createEl('p', { text: '远程图片来源：' });
            const hostList = hostBox.createEl('ul');
            for (const [host, count] of this.summary.hosts) {
                hostList.createEl('li', { text: `${host}：${count} 张` });
            }
        }

        const notes: string[] = [];
        if (this.summary.alreadyOnCos > 0) notes.push(`另有 ${this.summary.alreadyOnCos} 张已在 COS 上，会被跳过`);
        if (this.summary.skippedRemote > 0) notes.push(`${this.summary.skippedRemote} 张远程图片不在本次范围内`);
        if (notes.length > 0) {
            contentEl.createEl('p', { text: notes.join('；') + '。', cls: 'setting-item-description' });
        }

        contentEl.createEl('p', {
            text: '开始后状态栏会显示进度，点击状态栏可随时取消；已完成的图片仍会被替换。',
            cls: 'setting-item-description',
        });

        new Setting(contentEl)
            .addButton((button) =>
                button
                    .setButtonText(`开始上传 ${this.summary.total} 张`)
                    .setCta()
                    .onClick(() => this.finish(true))
            )
            .addButton((button) => button.setButtonText('取消').onClick(() => this.finish(false)));
    }

    onClose(): void {
        this.contentEl.empty();
        if (!this.resolved) {
            this.resolved = true;
            this.resolveFn(false);
        }
    }

    private finish(value: boolean): void {
        if (this.resolved) return;
        this.resolved = true;
        this.resolveFn(value);
        this.close();
    }
}
