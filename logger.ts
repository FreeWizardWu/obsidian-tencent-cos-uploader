/*
 * 轻量日志：内存环形缓冲 + console 双写
 *
 * 为什么需要它：Obsidian 的开发者控制台在手机上看不到，出问题时只能靠猜。
 * 这里把关键步骤都记在内存里（最近 800 条），用户可以随时用
 * 命令 “Export diagnostics log” 导出到插件目录，贴给我就能定位问题。
 */

const MAX_LINES = 800;
const buffer: string[] = [];

function stamp(): string {
    const d = new Date();
    const pad = (n: number, width = 2) => String(n).padStart(width, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function push(level: string, message: string, detail?: unknown): void {
    let line = `${stamp()} [${level}] ${message}`;
    if (detail !== undefined) {
        line += ` ${safeStringify(detail)}`;
    }
    buffer.push(line);
    if (buffer.length > MAX_LINES) buffer.splice(0, buffer.length - MAX_LINES);
}

function safeStringify(value: unknown): string {
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    if (typeof value === 'string') return value;
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

export function logInfo(message: string, detail?: unknown): void {
    push('info', message, detail);
    console.log(`[COS Uploader] ${message}`, detail ?? '');
}

export function logWarn(message: string, detail?: unknown): void {
    push('warn', message, detail);
    console.warn(`[COS Uploader] ${message}`, detail ?? '');
}

export function logError(message: string, detail?: unknown): void {
    push('error', message, detail);
    console.error(`[COS Uploader] ${message}`, detail ?? '');
}

/** 取完整日志文本（导出用） */
export function getLogText(): string {
    return buffer.length === 0 ? '（暂无日志）' : buffer.join('\n');
}

export function clearLog(): void {
    buffer.length = 0;
}

/** 记录一次耗时操作的结果 */
export function logTiming(label: string, startedAt: number, extra?: string): void {
    const ms = Date.now() - startedAt;
    push('info', `${label} 耗时 ${ms}ms${extra ? ` ${extra}` : ''}`);
}
