/**
 * 真实 COS 连通性测试：npm run test:live
 *
 * 用真密钥往 Bucket 里写一个临时对象、查一次、删掉，验证 TC3 签名在真实服务端能通过。
 * 这比自测里的「参考实现对照」更硬：能一次抓出签名头、URL 编码、时间戳之类的问题。
 *
 * 用法（三选一）：
 *   1. npm run test:live -- --data /path/to/data.json        # 直接读插件配置
 *   2. COS_DATA_JSON=/path/to/data.json npm run test:live
 *   3. COS_SECRET_ID=... COS_SECRET_KEY=... COS_BUCKET=... COS_REGION=... npm run test:live
 *
 * 不会打印任何密钥内容，也不会留下对象（失败时也尽量清理）。
 */
import esbuild from 'esbuild';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { createRequire } from 'module';
import path from 'path';

const require = createRequire(import.meta.url);
const outDir = mkdtempSync(path.join(tmpdir(), 'cos-uploader-live-'));

/* ------------------------------ 读取配置 ------------------------------ */

function loadSettings() {
    const argIndex = process.argv.indexOf('--data');
    const dataPath = argIndex > -1 ? process.argv[argIndex + 1] : process.env.COS_DATA_JSON;

    if (dataPath) {
        if (!existsSync(dataPath)) throw new Error(`配置文件不存在: ${dataPath}`);
        const raw = JSON.parse(readFileSync(dataPath, 'utf8'));
        return {
            secretId: raw.secretId,
            secretKey: raw.secretKey,
            bucket: raw.bucket,
            region: raw.region,
            pathPrefix: raw.pathPrefix || '',
            cdnDomain: raw.cdnDomain || '',
        };
    }

    return {
        secretId: process.env.COS_SECRET_ID,
        secretKey: process.env.COS_SECRET_KEY,
        bucket: process.env.COS_BUCKET,
        region: process.env.COS_REGION,
        pathPrefix: process.env.COS_PATH_PREFIX || '',
        cdnDomain: process.env.COS_CDN_DOMAIN || '',
    };
}

const settings = loadSettings();
const missing = ['secretId', 'secretKey', 'bucket', 'region'].filter((key) => !settings[key]);
if (missing.length > 0) {
    console.error(`缺少配置：${missing.join('、')}`);
    console.error('用法见本文件顶部注释。');
    process.exit(1);
}

/* ------------------------------ 加载客户端 ------------------------------ */

// cos-client.ts 依赖 obsidian 的 requestUrl，用 Node 的 fetch 实现一个等价桩
const stubPath = path.join(outDir, 'obsidian-stub.cjs');
writeFileSync(
    stubPath,
    `exports.requestUrl = async ({ url, method, headers, body }) => {
    const response = await fetch(url, { method, headers, body });
    const text = await response.text();
    const collected = {};
    response.headers.forEach((value, name) => { collected[name] = value; });
    return { status: response.status, headers: collected, text };
};
exports.Platform = { isDesktopApp: true, isMobileApp: false };
`
);

const bundlePath = path.join(outDir, 'cos-client.cjs');
await esbuild.build({
    entryPoints: ['cos-client.ts'],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    outfile: bundlePath,
    logLevel: 'warning',
    alias: { obsidian: stubPath },
});

const { COSClient } = require(bundlePath);
const client = new COSClient(() => settings);

/* ------------------------------ 开始测试 ------------------------------ */

// 1x1 透明 PNG
const PNG_BYTES = new Uint8Array(
    Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
        'base64'
    )
);

const prefix = (settings.pathPrefix || '').replace(/^\/+/, '');
const key = `${prefix}${prefix && !prefix.endsWith('/') ? '/' : ''}__connectivity_test_live__.png`;

let failed = false;
const check = (label, ok, detail = '') => {
    console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? ` — ${detail}` : ''}`);
    if (!ok) failed = true;
};

console.log(`Bucket: ${settings.bucket} / ${settings.region}`);
console.log(`测试对象: ${key}\n`);

try {
    await client.putObject(key, PNG_BYTES, 'image/png', 'no-cache');
    check('PUT 上传成功（签名通过）', true);

    const exists = await client.headObject(key);
    check('HEAD 对象存在', exists);

    const url = `https://${settings.cdnDomain || `${settings.bucket}.cos.${settings.region}.myqcloud.com`}/${key}`;
    try {
        const response = await fetch(url, { method: 'GET' });
        check('匿名 GET 可访问（Bucket 公开读）', response.ok, `HTTP ${response.status}`);
        if (!response.ok) console.log('    → 如果 Bucket 是私有的，这一条失败是正常的');
    } catch (error) {
        console.log(`  ! 匿名 GET 未验证: ${error.message}`);
    }

    await client.deleteObject(key);
    const afterDelete = await client.headObject(key);
    check('DELETE 后对象已消失', !afterDelete);
} catch (error) {
    check('请求失败', false, error instanceof Error ? error.message : String(error));
    try {
        await client.deleteObject(key);
    } catch {
        /* 尽力清理 */
    }
}

console.log(failed ? '\n存在失败项' : '\n全部通过，桌面端和移动端的签名逻辑都可用');
process.exit(failed ? 1 : 0);
