/*
 * 图片链接解析与替换
 *
 * 设计要点：所有替换都基于「位置区间」而不是字符串 replace()，
 * 这样同一张图片在笔记中出现多次时不会出现「只替换第一处」的问题。
 */

export type ImageLinkKind = 'markdown' | 'wiki' | 'reference' | 'html' | 'frontmatter';

export interface ImageLink {
    kind: ImageLinkKind;
    /** 在原文中的起始下标（含） */
    start: number;
    /** 在原文中的结束下标（不含） */
    end: number;
    /** 原始文本 */
    raw: string;
    /** 图片描述 */
    alt: string;
    /** 链接目标：远程 URL 或 vault 内相对路径 */
    target: string;
    /** Markdown 标题（![a](url "title") 里的 title） */
    title?: string;
    /** HTML img 标签的其余属性（用于原样保留） */
    htmlAttrs?: string;
}

const IMAGE_EXTENSIONS = new Set([
    'png', 'jpg', 'jpeg', 'jfif', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif', 'tif', 'tiff', 'heic', 'heif',
]);

const IMAGE_EXT_PATTERN = /\.(png|jpe?g|jfif|gif|webp|svg|bmp|ico|avif|tiff?|heic|heif)$/i;

/** 该路径看起来是不是一张图片（只看扩展名） */
export function looksLikeImagePath(target: string): boolean {
    const clean = stripQueryAndHash(target);
    return IMAGE_EXT_PATTERN.test(clean);
}

export function isRemoteTarget(target: string): boolean {
    return /^(https?:)?\/\//i.test(target);
}

/** 去掉 URL 的 query 与 hash（用于判断扩展名） */
function stripQueryAndHash(value: string): string {
    const idx = value.search(/[?#]/);
    return idx === -1 ? value : value.slice(0, idx);
}

function extensionOf(target: string): string {
    const clean = stripQueryAndHash(target);
    const dot = clean.lastIndexOf('.');
    return dot === -1 ? '' : clean.slice(dot + 1).toLowerCase();
}

/** 该扩展名是否是可上传的图片格式 */
export function isImageExtension(ext: string): boolean {
    return IMAGE_EXTENSIONS.has(ext.toLowerCase());
}

/**
 * 解析笔记中全部图片链接。
 *
 * 支持：
 * 1. `![alt](url)`、`![alt](<url with space>)`、`![alt](url "title")`、URL 内含括号
 * 2. `![alt][ref]` + `[ref]: url` 引用式
 * 3. `![[image.png]]`、`![[image.png|alt]]`、`![[image.png|300]]`
 * 4. `![[说明]](url)`（部分剪藏工具产生的混合格式）
 * 5. `<img src="...">`
 */
export function parseImageLinks(content: string): ImageLink[] {
    const candidates: ImageLink[] = [];

    collectWikiLinks(content, candidates);
    collectMarkdownLinks(content, candidates);
    collectReferenceLinks(content, candidates);
    collectHtmlImages(content, candidates);
    collectFrontmatterImages(content, candidates);

    const codeRanges = collectCodeRanges(content);

    // 按起点排序，丢掉与已接受区间重叠的匹配（避免同一个位置被多个规则命中）
    candidates.sort((a, b) => a.start - b.start || b.end - a.end);
    const result: ImageLink[] = [];
    let lastEnd = -1;
    for (const candidate of candidates) {
        if (candidate.start < lastEnd) continue;
        // 代码块 / 行内代码里的图片语法只是示例，不应该被上传替换
        if (inRanges(candidate.start, codeRanges)) continue;
        result.push(candidate);
        lastEnd = candidate.end;
    }
    return result;
}

/** frontmatter 里常用于图片的字段名 */
const FRONTMATTER_IMAGE_KEYS = new Set([
    'cover',
    'image',
    'img',
    'banner',
    'thumbnail',
    'thumb',
    'poster',
    'header',
    'hero',
    'picture',
    'avatar',
    'cover_url',
    'coverurl',
    'image_url',
    'imageurl',
    'preview',
    'featured_image',
]);

/**
 * frontmatter 里的封面图，例如 `cover: https://x.com/a.jpg`
 * 只替换 URL 本身（引号与其余前缀保持原样）。
 */
function collectFrontmatterImages(content: string, out: ImageLink[]): void {
    const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
    if (!block) return;

    const bodyStart = block.index + block[0].indexOf(block[1]);
    const lines = block[1].split('\n');
    let offset = bodyStart;

    for (const line of lines) {
        const lineStart = offset;
        offset += line.length + 1;

        const match = /^(\s*)([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
        if (!match) continue;
        if (!FRONTMATTER_IMAGE_KEYS.has(match[2].trim().toLowerCase())) continue;

        const rawValue = match[3];
        const quoted = /^(["'])(.*)\1$/.exec(rawValue.trim());
        const value = quoted ? quoted[2] : rawValue.trim();
        if (!/^https?:\/\//i.test(value)) continue;

        const valueIndexInLine = line.indexOf(rawValue) + (quoted ? 1 : 0);
        const start = lineStart + valueIndexInLine;

        out.push({
            kind: 'frontmatter',
            start,
            end: start + value.length,
            raw: value,
            alt: match[2].trim(),
            target: normalizeTarget(value),
        });
    }
}

/** 是否是可解码的 base64 内嵌图片 */
export function isBase64ImageDataUri(target: string): boolean {
    return /^data:image\/[a-z0-9.+-]+;base64,/i.test(target.trim());
}

/** 解析 base64 内嵌图片为字节，失败返回 null */
export function decodeBase64ImageDataUri(target: string): { buffer: ArrayBuffer; mime: string; ext: string } | null {
    const match = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i.exec(target.trim());
    if (!match) return null;

    const mime = match[1].toLowerCase();
    const base64 = match[2].replace(/\s/g, '');
    const extMap: Record<string, string> = {
        'image/jpeg': 'jpg',
        'image/jpg': 'jpg',
        'image/png': 'png',
        'image/gif': 'gif',
        'image/webp': 'webp',
        'image/svg+xml': 'svg',
        'image/bmp': 'bmp',
        'image/x-icon': 'ico',
        'image/avif': 'avif',
    };

    try {
        const binary = decodeBase64(base64);
        if (binary.length === 0) return null;
        return {
            buffer: binary.buffer as ArrayBuffer,
            mime,
            ext: extMap[mime] || 'png',
        };
    } catch {
        return null;
    }
}

/** base64 → 字节（用 atob，桌面端和移动端都有，不依赖 Buffer） */
function decodeBase64(value: string): Uint8Array {
    let normalized = value.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
    while (normalized.length % 4 !== 0) normalized += '=';

    const binary = atob(normalized);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

/** 代码块与行内代码的区间，避免误伤示例文本 */
function collectCodeRanges(content: string): Array<[number, number]> {
    const ranges: Array<[number, number]> = [];

    const fencePattern = /^[ \t]{0,3}(`{3,}|~{3,})[^\n]*$/gm;
    let match: RegExpExecArray | null;
    while ((match = fencePattern.exec(content)) !== null) {
        const marker = match[1];
        const start = match.index;
        const closePattern = new RegExp(
            `^[ \\t]{0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}[ \\t]*$`,
            'gm'
        );
        closePattern.lastIndex = start + match[0].length;
        const close = closePattern.exec(content);
        const end = close ? close.index + close[0].length : content.length;
        ranges.push([start, end]);
        fencePattern.lastIndex = end;
    }

    let i = 0;
    while (i < content.length) {
        if (content[i] !== '`') {
            i++;
            continue;
        }
        let runLength = 0;
        while (content[i + runLength] === '`') runLength++;

        let j = i + runLength;
        let closed = -1;
        while (j < content.length) {
            if (content[j] === '`') {
                let length = 0;
                while (content[j + length] === '`') length++;
                if (length === runLength) {
                    closed = j + length;
                    break;
                }
                j += length;
            } else {
                j++;
            }
        }
        if (closed === -1) break;
        ranges.push([i, closed]);
        i = closed;
    }

    return ranges;
}

function inRanges(index: number, ranges: Array<[number, number]>): boolean {
    for (const [start, end] of ranges) {
        if (index >= start && index < end) return true;
    }
    return false;
}

/* ------------------------------------------------------------------ */
/* Wiki 链接：![[image.png]] / ![[image.png|alt]] / ![[alt]](url)        */
/* ------------------------------------------------------------------ */

function collectWikiLinks(content: string, out: ImageLink[]): void {
    const pattern = /!\[\[([^\]\n]+)\]\]/g;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(content)) !== null) {
        const start = match.index;
        const inner = match[1];
        let end = start + match[0].length;

        // 1) 混合格式 ![[alt]](url)：括号紧跟在 ]] 之后
        const inline = content[end] === '(' ? parseInlineDestination(content, end) : null;
        if (inline) {
            const parts = splitWikiInner(inner);
            out.push({
                kind: 'markdown',
                start,
                end: inline.end,
                raw: content.slice(start, inline.end),
                // 混合格式里 [[]] 中的内容本身就是 alt
                alt: parts.alt || parts.path,
                target: inline.target,
                title: inline.title,
            });
            continue;
        }

        // 2) 纯 wiki 链接：只处理图片扩展名，其他（笔记链接、PDF 等）跳过
        const { path, alt } = splitWikiInner(inner);
        if (!path || !looksLikeImagePath(path)) continue;

        out.push({
            kind: 'wiki',
            start,
            end,
            raw: match[0],
            alt,
            target: normalizeTarget(path),
        });
    }
}

/** 拆分 `路径|宽高` 或 `路径|alt` */
function splitWikiInner(inner: string): { path: string; alt: string } {
    const pipeIndex = inner.indexOf('|');
    if (pipeIndex === -1) return { path: inner.trim(), alt: '' };

    const path = inner.slice(0, pipeIndex).trim();
    const suffix = inner.slice(pipeIndex + 1).trim();

    // `![[image.png|300]]`、`![[image.png|300x200]]` 里的数字是尺寸，不是 alt
    if (/^\d+(x\d+)?$/i.test(suffix)) return { path, alt: '' };

    return { path, alt: suffix };
}

/* ------------------------------------------------------------------ */
/* 内联 Markdown：![alt](url)                                          */
/* ------------------------------------------------------------------ */

function collectMarkdownLinks(content: string, out: ImageLink[]): void {
    const pattern = /!\[([^\]\n]*)\]\(/g;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(content)) !== null) {
        const start = match.index;
        const openParen = start + match[0].length - 1;
        const parsed = parseInlineDestination(content, openParen);
        if (!parsed) continue;

        out.push({
            kind: 'markdown',
            start,
            end: parsed.end,
            raw: content.slice(start, parsed.end),
            alt: match[1],
            target: parsed.target,
            title: parsed.title,
        });

        // 避免把 alt 里的内容再匹配一次
        pattern.lastIndex = parsed.end;
    }
}

interface ParsedDestination {
    target: string;
    title?: string;
    end: number;
}

/** 从 `(` 处开始解析 `(dest "title")`，返回结束下标 */
function parseInlineDestination(content: string, openParen: number): ParsedDestination | null {
    if (content[openParen] !== '(') return null;

    let i = openParen + 1;
    i = skipSpacesAndNewlines(content, i);

    let raw: string;
    if (content[i] === '<') {
        const close = content.indexOf('>', i + 1);
        if (close === -1) return null;
        raw = content.slice(i + 1, close);
        i = close + 1;
    } else {
        const start = i;
        let depth = 0;
        while (i < content.length) {
            const ch = content[i];
            if (ch === '\\') {
                i += 2;
                continue;
            }
            if (ch === '\n') break;
            if (ch === '(') {
                depth++;
                i++;
                continue;
            }
            if (ch === ')') {
                if (depth === 0) break;
                depth--;
                i++;
                continue;
            }
            i++;
        }
        raw = content.slice(start, i);
    }

    const extracted = extractTitle(raw);
    const target = normalizeTarget(extracted.target);
    if (!target) return null;

    i = skipSpacesAndNewlines(content, i);

    // 可选标题："title" / 'title' / (title)
    let title = extracted.title;
    const quote = content[i];
    if (quote === '"' || quote === "'") {
        const close = content.indexOf(quote, i + 1);
        if (close === -1) return null;
        title = content.slice(i + 1, close);
        i = skipSpacesAndNewlines(content, close + 1);
    } else if (quote === '(') {
        const close = content.indexOf(')', i + 1);
        if (close === -1) return null;
        title = content.slice(i + 1, close);
        i = skipSpacesAndNewlines(content, close + 1);
    }

    if (content[i] !== ')') return null;

    return { target, title, end: i + 1 };
}

/** 从 `url "title"` 里拆出标题（标题也可能被写在同一对括号内） */
function extractTitle(raw: string): { target: string; title?: string } {
    const match = /\s+("([^"]*)"|'([^']*)'|\(([^)]*)\))\s*$/.exec(raw);
    if (!match) return { target: raw };

    const rest = raw.slice(0, match.index);
    // `![a](notes (1).png)` 这种把括号写进文件名的，不当作标题
    if (!rest.trim()) return { target: raw };

    return { target: rest, title: match[2] ?? match[3] ?? match[4] };
}

/** 去转义、把未编码的空格补成 %20 */
function normalizeTarget(target: string): string {
    const trimmed = target.trim();
    // data: URI 里的空白必须原样保留，否则 base64 解码失败
    if (/^data:/i.test(trimmed)) return trimmed;
    return unescapeMarkdown(trimmed).replace(/\s/g, '%20');
}

function skipSpacesAndNewlines(content: string, index: number): number {
    let i = index;
    while (i < content.length && /\s/.test(content[i])) i++;
    return i;
}

function unescapeMarkdown(value: string): string {
    return value.replace(/\\([()[\]<>*_~`#!-])/g, '$1');
}

/* ------------------------------------------------------------------ */
/* 引用式：![alt][ref] + [ref]: url                                     */
/* ------------------------------------------------------------------ */

function collectReferenceLinks(content: string, out: ImageLink[]): void {
    const definitions = collectReferenceDefinitions(content);
    if (definitions.size === 0) return;

    const pattern = /!\[([^\]\n]*)\]\[([^\]\n]*)\]/g;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(content)) !== null) {
        const label = (match[2] || match[1]).trim().toLowerCase();
        const target = definitions.get(label);
        if (!target) continue;

        out.push({
            kind: 'reference',
            start: match.index,
            end: match.index + match[0].length,
            raw: match[0],
            alt: match[1],
            target: normalizeTarget(target),
        });
    }
}

function collectReferenceDefinitions(content: string): Map<string, string> {
    const definitions = new Map<string, string>();
    const pattern = /^ {0,3}\[([^\]\n]+)\]:[ \t]*<?([^\s>]+)>?/gm;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(content)) !== null) {
        definitions.set(match[1].trim().toLowerCase(), match[2]);
    }
    return definitions;
}

/* ------------------------------------------------------------------ */
/* HTML：<img src="...">                                              */
/* ------------------------------------------------------------------ */

function collectHtmlImages(content: string, out: ImageLink[]): void {
    const pattern = /<img\b[^>]*>/gi;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(content)) !== null) {
        const tag = match[0];
        const srcMatch = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
        if (!srcMatch) continue;

        const target = (srcMatch[1] ?? srcMatch[2] ?? srcMatch[3] ?? '').trim();
        if (!target) continue;

        const altMatch = /\balt\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);

        out.push({
            kind: 'html',
            start: match.index,
            end: match.index + tag.length,
            raw: tag,
            alt: altMatch?.[1] ?? altMatch?.[2] ?? '',
            target: normalizeTarget(target),
            htmlAttrs: tag,
        });
    }
}

/* ------------------------------------------------------------------ */
/* 替换                                                               */
/* ------------------------------------------------------------------ */

/**
 * 把笔记中 target 命中的图片链接替换成新的 URL。
 * @param mapping 原始 target -> 新的 URL
 */
export function replaceImageTargets(content: string, mapping: Map<string, string>): string {
    if (mapping.size === 0) return content;

    const links = parseImageLinks(content);
    let out = '';
    let cursor = 0;
    let changed = false;

    for (const link of links) {
        const url = mapping.get(link.target);
        if (!url) continue;

        out += content.slice(cursor, link.start);
        out += renderLink(link, url);
        cursor = link.end;
        changed = true;
    }

    if (!changed) return content;
    out += content.slice(cursor);
    return out;
}

function renderLink(link: ImageLink, url: string): string {
    // frontmatter 只替换 URL 文本本身，保留引号与 key
    if (link.kind === 'frontmatter') return encodeMarkdownUrl(url);

    if (link.kind === 'html') {
        // 保留 <img> 上的其他属性，只换 src
        return link.raw.replace(
            /\bsrc\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i,
            `src="${escapeHtmlAttribute(url)}"`
        );
    }

    const alt = escapeMarkdownText(link.alt);
    const title = link.title ? ` "${link.title}"` : '';
    return `![${alt}](${encodeMarkdownUrl(url)}${title})`;
}

function escapeMarkdownText(value: string): string {
    return value.replace(/[[\]]/g, (m) => `\\${m}`);
}

function escapeHtmlAttribute(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

/** Markdown 链接目标里如果出现空格或括号，用尖括号包起来 */
export function encodeMarkdownUrl(url: string): string {
    const encoded = encodeURI(url).replace(/\(/g, '%28').replace(/\)/g, '%29');
    return /[\s]/.test(encoded) ? `<${encoded}>` : encoded;
}

/** 统计笔记中的候选图片信息，用于日志与提示 */
export function summarizeLinks(links: ImageLink[]): { remote: number; local: number } {
    let remote = 0;
    let local = 0;
    for (const link of links) {
        if (isRemoteTarget(link.target)) remote++;
        else local++;
    }
    return { remote, local };
}

export { extensionOf };
