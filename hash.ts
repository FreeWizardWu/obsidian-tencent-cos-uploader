/*
 * 纯 JS 的哈希实现（MD5 / SHA-256 / HMAC-SHA256）
 *
 * 为什么不用 Node 的 crypto 模块：
 *   Obsidian 移动端没有 Node 运行时，`require('crypto')` 直接不可用。
 *   Web Crypto（crypto.subtle）在部分 WebView 里不是安全上下文，同样不可靠，
 *   而且它本身不支持 MD5。所以这里自带一份实现，桌面端和手机端行为完全一致。
 *
 * 正确性由 scripts/selftest.mjs 与 Node 的 crypto 逐字节比对保证。
 */

/* -------------------------------------------------------------------------- */
/* 工具                                                                       */
/* -------------------------------------------------------------------------- */

function rotl32(value: number, shift: number): number {
    return (value << shift) | (value >>> (32 - shift));
}

function rotr32(value: number, shift: number): number {
    return (value >>> shift) | (value << (32 - shift));
}

/** 字节数组转小写十六进制字符串 */
export function toHex(bytes: Uint8Array): string {
    let out = '';
    for (let i = 0; i < bytes.length; i++) {
        out += (bytes[i] >>> 4).toString(16) + (bytes[i] & 0x0f).toString(16);
    }
    return out;
}

/** 字符串转 UTF-8 字节（不依赖 TextEncoder，老 WebView 也安全） */
export function utf8Bytes(text: string): Uint8Array {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text);

    const encoded = unescape(encodeURIComponent(text));
    const bytes = new Uint8Array(encoded.length);
    for (let i = 0; i < encoded.length; i++) bytes[i] = encoded.charCodeAt(i);
    return bytes;
}

/* -------------------------------------------------------------------------- */
/* MD5                                                                        */
/* -------------------------------------------------------------------------- */

const MD5_SHIFTS = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

const MD5_K = (() => {
    const table = new Int32Array(64);
    for (let i = 0; i < 64; i++) {
        table[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;
    }
    return table;
})();

/** MD5，返回 16 字节 */
export function md5(input: Uint8Array): Uint8Array {
    const length = input.length;
    const blockCount = ((length + 8) >> 6) + 1;
    const padded = new Uint8Array(blockCount * 64);
    padded.set(input);
    padded[length] = 0x80;

    const view = new DataView(padded.buffer);
    const bitLength = length * 8;
    view.setUint32(blockCount * 64 - 8, bitLength >>> 0, true);
    view.setUint32(blockCount * 64 - 4, Math.floor(bitLength / 4294967296), true);

    let a0 = 0x67452301;
    let b0 = 0xefcdab89 | 0;
    let c0 = 0x98badcfe | 0;
    let d0 = 0x10325476;

    const words = new Int32Array(16);

    for (let offset = 0; offset < padded.length; offset += 64) {
        for (let i = 0; i < 16; i++) words[i] = view.getInt32(offset + i * 4, true);

        let a = a0;
        let b = b0;
        let c = c0;
        let d = d0;

        for (let i = 0; i < 64; i++) {
            let f: number;
            let g: number;

            if (i < 16) {
                f = (b & c) | (~b & d);
                g = i;
            } else if (i < 32) {
                f = (d & b) | (~d & c);
                g = (5 * i + 1) % 16;
            } else if (i < 48) {
                f = b ^ c ^ d;
                g = (3 * i + 5) % 16;
            } else {
                f = c ^ (b | ~d);
                g = (7 * i) % 16;
            }

            const sum = (f + a + MD5_K[i] + words[g]) | 0;
            a = d;
            d = c;
            c = b;
            b = (b + rotl32(sum, MD5_SHIFTS[i])) | 0;
        }

        a0 = (a0 + a) | 0;
        b0 = (b0 + b) | 0;
        c0 = (c0 + c) | 0;
        d0 = (d0 + d) | 0;
    }

    const out = new Uint8Array(16);
    const outView = new DataView(out.buffer);
    outView.setInt32(0, a0, true);
    outView.setInt32(4, b0, true);
    outView.setInt32(8, c0, true);
    outView.setInt32(12, d0, true);
    return out;
}

/** MD5 十六进制字符串 */
export function md5Hex(input: Uint8Array): string {
    return toHex(md5(input));
}

/* -------------------------------------------------------------------------- */
/* SHA-256                                                                    */
/* -------------------------------------------------------------------------- */

const SHA256_K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** SHA-256，返回 32 字节 */
export function sha256(input: Uint8Array): Uint8Array {
    const h = new Uint32Array([
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ]);

    const length = input.length;
    const blockCount = ((length + 8) >> 6) + 1;
    const padded = new Uint8Array(blockCount * 64);
    padded.set(input);
    padded[length] = 0x80;

    const view = new DataView(padded.buffer);
    const bitLength = length * 8;
    view.setUint32(blockCount * 64 - 8, Math.floor(bitLength / 4294967296));
    view.setUint32(blockCount * 64 - 4, bitLength >>> 0);

    const w = new Uint32Array(64);

    for (let offset = 0; offset < padded.length; offset += 64) {
        for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);

        for (let i = 16; i < 64; i++) {
            const s0 = rotr32(w[i - 15], 7) ^ rotr32(w[i - 15], 18) ^ (w[i - 15] >>> 3);
            const s1 = rotr32(w[i - 2], 17) ^ rotr32(w[i - 2], 19) ^ (w[i - 2] >>> 10);
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
        }

        let a = h[0];
        let b = h[1];
        let c = h[2];
        let d = h[3];
        let e = h[4];
        let f = h[5];
        let g = h[6];
        let hh = h[7];

        for (let i = 0; i < 64; i++) {
            const S1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
            const ch = (e & f) ^ (~e & g);
            const temp1 = (hh + S1 + ch + SHA256_K[i] + w[i]) | 0;
            const S0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
            const maj = (a & b) ^ (a & c) ^ (b & c);
            const temp2 = (S0 + maj) | 0;

            hh = g;
            g = f;
            f = e;
            e = (d + temp1) | 0;
            d = c;
            c = b;
            b = a;
            a = (temp1 + temp2) | 0;
        }

        h[0] = (h[0] + a) | 0;
        h[1] = (h[1] + b) | 0;
        h[2] = (h[2] + c) | 0;
        h[3] = (h[3] + d) | 0;
        h[4] = (h[4] + e) | 0;
        h[5] = (h[5] + f) | 0;
        h[6] = (h[6] + g) | 0;
        h[7] = (h[7] + hh) | 0;
    }

    const out = new Uint8Array(32);
    const outView = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) outView.setUint32(i * 4, h[i]);
    return out;
}

/** SHA-256 十六进制字符串 */
export function sha256Hex(input: Uint8Array): string {
    return toHex(sha256(input));
}

/* -------------------------------------------------------------------------- */
/* HMAC-SHA256                                                                */
/* -------------------------------------------------------------------------- */

/** HMAC-SHA256，返回 32 字节 */
export function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
    const blockSize = 64;
    const normalizedKey = key.length > blockSize ? sha256(key) : key;

    const inner = new Uint8Array(blockSize + message.length);
    const outer = new Uint8Array(blockSize + 32);

    for (let i = 0; i < blockSize; i++) {
        const byte = i < normalizedKey.length ? normalizedKey[i] : 0;
        inner[i] = byte ^ 0x36;
        outer[i] = byte ^ 0x5c;
    }

    inner.set(message, blockSize);
    outer.set(sha256(inner), blockSize);
    return sha256(outer);
}

/** HMAC-SHA256 十六进制字符串 */
export function hmacSha256Hex(key: Uint8Array, message: Uint8Array): string {
    return toHex(hmacSha256(key, message));
}
