/*
 * Node 专用网络层（仅桌面端）
 *
 * 单独拆成文件的原因：
 *   Obsidian 移动端没有 Node 运行时，`require('http')` 这类语句一旦出现在
 *   main.js 的顶层就会让插件在手机上直接崩溃。把 Node 相关代码放进这个模块后，
 *   downloader 只在 Platform.isDesktopApp 时用动态 import 加载它，
 *   esbuild 会把它包成惰性初始化的代码块，手机上永远不会执行到。
 */

import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as tls from 'tls';
import { HttpStatusError } from './http-error';

export interface RawResponse {
    status: number;
    contentType: string;
    buffer: ArrayBuffer;
    finalUrl: string;
}

export interface NodeRequestOptions {
    proxyUrl: string;
    timeoutMs: number;
    maxBytes: number;
}

interface ParsedProxy {
    host: string;
    port: number;
    authHeader?: string;
}

interface NodeResponse extends RawResponse {
    location?: string;
    retryAfter?: string;
}

/** 用 Node 的 http/https 下载，可选走 HTTP 代理的 CONNECT 隧道 */
export async function nodeGet(
    url: string,
    headers: Record<string, string>,
    options: NodeRequestOptions,
    signal?: AbortSignal
): Promise<RawResponse> {
    let currentUrl = url;
    const proxy = options.proxyUrl ? parseProxyUrl(options.proxyUrl) : null;

    for (let redirect = 0; redirect <= 5; redirect++) {
        const parsed = new URL(currentUrl);
        const isHttps = parsed.protocol === 'https:';
        const port = Number(parsed.port || (isHttps ? 443 : 80));
        const requestHeaders: Record<string, string> = {
            ...headers,
            Host: parsed.host,
            // 自己不解压，避免把 gzip 当图片
            'Accept-Encoding': 'identity',
        };

        const response = await nodeGetOnce(parsed, port, isHttps, requestHeaders, options, proxy, signal);

        if (response.status >= 300 && response.status < 400 && response.location) {
            currentUrl = new URL(response.location, currentUrl).toString();
            continue;
        }

        if (response.status !== 200) {
            throw new HttpStatusError(response.status, `HTTP ${response.status}`, parseRetryAfter(response.retryAfter));
        }
        if (!response.buffer || response.buffer.byteLength === 0) throw new Error('响应内容为空');

        return {
            status: response.status,
            contentType: response.contentType,
            buffer: response.buffer,
            finalUrl: currentUrl,
        };
    }

    throw new Error('重定向次数过多');
}

function nodeGetOnce(
    parsed: URL,
    port: number,
    isHttps: boolean,
    headers: Record<string, string>,
    options: NodeRequestOptions,
    proxy: ParsedProxy | null,
    signal?: AbortSignal
): Promise<NodeResponse> {
    return new Promise((resolve, reject) => {
        const path = `${parsed.pathname}${parsed.search}`;
        let settled = false;
        const fail = (error: Error) => {
            if (settled) return;
            settled = true;
            reject(error);
        };
        const done = (value: NodeResponse) => {
            if (settled) return;
            settled = true;
            resolve(value);
        };

        const start = async () => {
            const requestOptions: https.RequestOptions = {
                host: parsed.hostname,
                port,
                path,
                method: 'GET',
                headers,
            };

            let socketFactory: (() => net.Socket) | null = null;

            if (proxy) {
                const tunnel = await connectTunnel(proxy, parsed.hostname, port, options.timeoutMs);
                if (isHttps) {
                    socketFactory = () =>
                        tls.connect({
                            socket: tunnel,
                            servername: parsed.hostname,
                            ALPNProtocols: ['http/1.1'],
                        });
                } else {
                    socketFactory = () => tunnel;
                }
            }

            const request = isHttps
                ? https.request(
                      socketFactory
                          ? { ...requestOptions, createConnection: () => socketFactory!() as tls.TLSSocket }
                          : requestOptions,
                      onResponse
                  )
                : http.request(
                      socketFactory
                          ? { ...requestOptions, createConnection: () => socketFactory!() }
                          : requestOptions,
                      onResponse
                  );

            request.setTimeout(options.timeoutMs, () => request.destroy(new Error('下载超时')));
            request.on('error', (error) => fail(new Error(describeNetworkError(error))));

            const onAbort = () => request.destroy(new Error('已取消'));
            signal?.addEventListener('abort', onAbort, { once: true });
            request.on('close', () => signal?.removeEventListener('abort', onAbort));

            request.end();

            function onResponse(response: http.IncomingMessage) {
                const status = response.statusCode ?? 0;
                const contentType = String(response.headers['content-type'] || '');
                const retryAfter = String(response.headers['retry-after'] || '');

                if (status >= 300 && status < 400 && response.headers.location) {
                    response.resume();
                    done({
                        status,
                        contentType,
                        buffer: new ArrayBuffer(0),
                        finalUrl: parsed.toString(),
                        location: String(response.headers.location),
                        retryAfter,
                    });
                    return;
                }

                if (status !== 200) {
                    // 非 200 不下载内容体，直接把状态交给上层决定是否退避重试
                    response.resume();
                    done({
                        status,
                        contentType,
                        buffer: new ArrayBuffer(0),
                        finalUrl: parsed.toString(),
                        retryAfter,
                    });
                    return;
                }

                const chunks: Buffer[] = [];
                let total = 0;

                response.on('data', (chunk: Buffer) => {
                    total += chunk.length;
                    if (total > options.maxBytes) {
                        request.destroy(new Error(`图片过大（超过 ${formatBytes(options.maxBytes)}）`));
                        return;
                    }
                    chunks.push(chunk);
                });
                response.on('end', () => {
                    const merged = Buffer.concat(chunks);
                    done({
                        status,
                        contentType,
                        buffer: merged.buffer.slice(
                            merged.byteOffset,
                            merged.byteOffset + merged.byteLength
                        ) as ArrayBuffer,
                        finalUrl: parsed.toString(),
                    });
                });
                response.on('error', (error) => fail(new Error(describeNetworkError(error))));
            }
        };

        start().catch((error) => fail(error instanceof Error ? error : new Error(String(error))));
    });
}

function parseProxyUrl(raw: string): ParsedProxy {
    const trimmed = raw.trim();
    if (!trimmed) throw new Error('代理地址为空');
    if (/^socks/i.test(trimmed)) {
        throw new Error('暂不支持 SOCKS 代理，请把代理换成 HTTP 端口（Clash 的混合端口通常同时支持 HTTP）');
    }
    const withScheme = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
    const parsed = new URL(withScheme);
    const authHeader = parsed.username
        ? 'Basic ' +
          Buffer.from(
              `${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password || '')}`
          ).toString('base64')
        : undefined;

    return {
        host: parsed.hostname,
        port: Number(parsed.port || 8080),
        authHeader,
    };
}

function connectTunnel(proxy: ParsedProxy, host: string, port: number, timeoutMs: number): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
        const socket = net.connect({ host: proxy.host, port: proxy.port });
        let buffer = '';
        let settled = false;

        const fail = (error: Error) => {
            if (settled) return;
            settled = true;
            socket.destroy();
            reject(error);
        };

        socket.setTimeout(timeoutMs, () => fail(new Error('代理连接超时')));
        socket.on('error', (error) =>
            fail(new Error(`无法连接代理 ${proxy.host}:${proxy.port}（${error.message}）`))
        );

        socket.on('connect', () => {
            const authLine = proxy.authHeader ? `Proxy-Authorization: ${proxy.authHeader}\r\n` : '';
            socket.write(
                `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${authLine}Proxy-Connection: Keep-Alive\r\n\r\n`
            );
        });

        const onData = (chunk: Buffer) => {
            buffer += chunk.toString('latin1');
            const headerEnd = buffer.indexOf('\r\n\r\n');
            if (headerEnd === -1) return;

            socket.removeListener('data', onData);
            socket.setTimeout(0);
            const statusLine = buffer.slice(0, buffer.indexOf('\r\n')).trim();
            const status = Number(statusLine.split(/\s+/)[1]);

            if (status !== 200) {
                fail(new Error(`代理 CONNECT 失败: ${statusLine || '无响应'}`));
                return;
            }

            settled = true;
            resolve(socket);
        };

        socket.on('data', onData);
    });
}

function describeNetworkError(error: NodeJS.ErrnoException): string {
    switch (error.code) {
        case 'ENOTFOUND':
            return '域名解析失败（DNS 污染或被墙？）';
        case 'ECONNRESET':
            return '连接被重置（ECONNRESET，通常是网络需要代理）';
        case 'ETIMEDOUT':
            return '连接超时';
        case 'ECONNREFUSED':
            return '连接被拒绝';
        case 'EPROTO':
        case 'ERR_SSL_WRONG_VERSION_NUMBER':
            return 'TLS 握手失败';
        default:
            return error.message;
    }
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

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
