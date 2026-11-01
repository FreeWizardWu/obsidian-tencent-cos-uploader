/**
 * 自测脚本：npm test
 *
 * 这里覆盖那些最容易出错、又不需要真实网络/COS 的逻辑：
 * - 链接解析（各种 Markdown / wiki / HTML / 引用式写法）
 * - 替换（同一张图出现多次、保留标题、避免误伤代码块）
 * - 下载器的 URL 规范化、Referer 推断、图片字节嗅探
 * - 纯 JS 哈希（MD5 / SHA-256 / HMAC-SHA256）与 Node crypto 逐字节对照
 * - COS 的 TC3-HMAC-SHA256 签名与参考实现对照
 */
import esbuild from 'esbuild';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { createRequire } from 'module';
import { createHash, createHmac } from 'crypto';
import path from 'path';
import assert from 'assert';

const require = createRequire(import.meta.url);
const outDir = mkdtempSync(path.join(tmpdir(), 'cos-uploader-test-'));

// downloader.ts / cos-client.ts 依赖 obsidian，用桩替代以便在纯 Node 下跑
const obsidianStub = path.join(outDir, 'obsidian-stub.cjs');
writeFileSync(
    obsidianStub,
    'exports.requestUrl = async () => { throw new Error("stub"); };\n' +
        // 用 getter 读全局开关，这样 bundle 内联的桩也能被测试实时切换平台
        'exports.Platform = { get isDesktopApp() { return globalThis.__STUB_DESKTOP__ !== false; },\n' +
        '  get isMobileApp() { return globalThis.__STUB_DESKTOP__ === false; } };\n'
);

async function bundle(entry, aliases = {}, name) {
    const outfile = path.join(outDir, `${name || path.basename(entry, '.ts')}.cjs`);
    await esbuild.build({
        entryPoints: [entry],
        bundle: true,
        format: 'cjs',
        platform: 'node',
        outfile,
        logLevel: 'warning',
        alias: aliases,
    });
    return require(outfile);
}

const parser = await bundle('parser.ts');
const downloader = await bundle('downloader.ts', { obsidian: obsidianStub });
const hash = await bundle('hash.ts');
const cosClient = await bundle('cos-client.ts', { obsidian: obsidianStub });
const cosUploader = await bundle('cos-uploader.ts', { obsidian: obsidianStub });

const { parseImageLinks, replaceImageTargets, isBase64ImageDataUri, decodeBase64ImageDataUri } = parser;
const { ImageDownloader } = downloader;
const { md5Hex, sha256Hex, hmacSha256Hex } = hash;
const { signRequest, encodeKey, describeCosError } = cosClient;
const { COSUploader } = cosUploader;

let passed = 0;
function test(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (error) {
        console.error(`  ✗ ${name}\n    ${error.message}`);
        process.exitCode = 1;
    }
}

console.log('链接解析');

test('标准 Markdown', () => {
    const links = parseImageLinks('![alt](https://a.com/1.png)');
    assert.strictEqual(links.length, 1);
    assert.strictEqual(links[0].target, 'https://a.com/1.png');
    assert.strictEqual(links[0].alt, 'alt');
});

test('尖括号 + 空格', () => {
    const links = parseImageLinks('![b](<https://a.com/2 with space.png>)');
    assert.strictEqual(links[0].target, 'https://a.com/2%20with%20space.png');
});

test('URL 内含括号', () => {
    const links = parseImageLinks('![c](https://a.com/wiki/Foo_(bar).png)');
    assert.strictEqual(links[0].target, 'https://a.com/wiki/Foo_(bar).png');
});

test('标题不被并入 URL', () => {
    const links = parseImageLinks('![a](https://a.com/1.png "标题")');
    assert.strictEqual(links[0].target, 'https://a.com/1.png');
    assert.strictEqual(links[0].title, '标题');
});

test('wiki 链接与尺寸', () => {
    const links = parseImageLinks('![[image.png]] ![[image.png|alt text]] ![[image.png|300]]');
    assert.deepStrictEqual(
        links.map((l) => [l.kind, l.alt, l.target]),
        [
            ['wiki', '', 'image.png'],
            ['wiki', 'alt text', 'image.png'],
            ['wiki', '', 'image.png'],
        ]
    );
});

test('wiki 链接不误伤笔记/PDF', () => {
    assert.strictEqual(parseImageLinks('![[My Note]] ![[doc.pdf]]').length, 0);
});

test('剪藏混合格式 ![[alt]](url)', () => {
    const links = parseImageLinks('![[绿帽子]](https://a.com/z.png)');
    assert.strictEqual(links.length, 1);
    assert.strictEqual(links[0].alt, '绿帽子');
    assert.strictEqual(links[0].target, 'https://a.com/z.png');
});

test('引用式', () => {
    const links = parseImageLinks('![d][ref]\n\n[ref]: https://a.com/4.png');
    assert.strictEqual(links[0].target, 'https://a.com/4.png');
});

test('HTML img', () => {
    const links = parseImageLinks('<img src="https://a.com/5.png" alt="f" width="200">');
    assert.strictEqual(links[0].kind, 'html');
    assert.strictEqual(links[0].target, 'https://a.com/5.png');
});

test('代码块与行内代码里的示例不算图片', () => {
    const md = '正常 ![](a.png)\n\n```\n![](code.png)\n```\n\n行内 `![](inline.png)`\n';
    assert.deepStrictEqual(
        parseImageLinks(md).map((l) => l.target),
        ['a.png']
    );
});

console.log('替换');

test('同一张图出现多次时全部替换', () => {
    const md = 'A ![](https://a.com/x.png) B ![](https://a.com/x.png) C';
    const out = replaceImageTargets(md, new Map([['https://a.com/x.png', 'https://cos/1.png']]));
    assert.strictEqual((out.match(/https:\/\/cos\/1\.png/g) || []).length, 2);
});

test('保留标题、保留 HTML 其他属性', () => {
    const md = '![alt](https://a.com/2.png "标题") <img src="https://a.com/3.png" width="9">';
    const out = replaceImageTargets(
        md,
        new Map([
            ['https://a.com/2.png', 'https://cos/2.png'],
            ['https://a.com/3.png', 'https://cos/3.png'],
        ])
    );
    assert.ok(out.includes('![alt](https://cos/2.png "标题")'), out);
    assert.ok(out.includes('<img src="https://cos/3.png" width="9">'), out);
});

test('wiki 链接转成标准 Markdown', () => {
    const out = replaceImageTargets('![[image.png|300]]', new Map([['image.png', 'https://cos/1.png']]));
    assert.strictEqual(out, '![](https://cos/1.png)');
});

test('未命中的链接保持原样', () => {
    const md = '![](a.png) ![](b.png)';
    const out = replaceImageTargets(md, new Map([['a.png', 'https://cos/a.png']]));
    assert.strictEqual(out, '![](https://cos/a.png) ![](b.png)');
});

console.log('base64 内嵌图');

test('识别并解码 data:image base64', () => {
    // 1x1 透明 PNG
    const uri =
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
    assert.ok(isBase64ImageDataUri(uri));
    const decoded = decodeBase64ImageDataUri(uri);
    assert.ok(decoded);
    assert.strictEqual(decoded.ext, 'png');
    assert.ok(decoded.buffer.byteLength > 50);
});

test('base64 不会被空格转义破坏', () => {
    const uri = 'data:image/png;base64,AAAA BBBB';
    const links = parseImageLinks(`![x](${uri})`);
    assert.strictEqual(links[0].target, uri);
});

test('内嵌图能替换成 COS 链接', () => {
    const uri = 'data:image/png;base64,AAAA';
    const out = replaceImageTargets(`![](${uri})`, new Map([[uri, 'https://cos/1.png']]));
    assert.strictEqual(out, '![](https://cos/1.png)');
});

console.log('frontmatter 封面');

test('识别 cover 字段', () => {
    const md = '---\ncover: https://a.com/c.jpg\ntitle: 标题\n---\n正文';
    const links = parseImageLinks(md);
    assert.strictEqual(links.length, 1);
    assert.strictEqual(links[0].kind, 'frontmatter');
    assert.strictEqual(links[0].target, 'https://a.com/c.jpg');
});

test('封面替换保留引号与其他字段', () => {
    const md = '---\ncover: "https://a.com/c.jpg"\ntitle: 标题\n---\n正文';
    const out = replaceImageTargets(md, new Map([['https://a.com/c.jpg', 'https://cos/c.jpg']]));
    assert.ok(out.includes('cover: "https://cos/c.jpg"'), out);
    assert.ok(out.includes('title: 标题'), out);
});

test('非图片字段不当封面', () => {
    assert.strictEqual(parseImageLinks('---\nsource: https://a.com/page.html\n---\n').length, 0);
});

console.log('下载器工具');

test('协议相对地址与空格转义', () => {
    assert.strictEqual(
        ImageDownloader.normalizeUrl('//a.com/图 片.png'),
        'https://a.com/%E5%9B%BE%20%E7%89%87.png'
    );
});

test('按域名推断 Referer', () => {
    assert.strictEqual(ImageDownloader.guessReferer('https://pbs.twimg.com/media/x.jpg'), 'https://x.com/');
    assert.strictEqual(ImageDownloader.guessReferer('https://pic1.zhimg.com/x.jpg'), 'https://www.zhihu.com/');
    assert.strictEqual(ImageDownloader.guessReferer('https://unknown.example/x.jpg'), 'https://unknown.example/');
});

console.log('哈希（与 Node crypto 对照）');

function sampleBytes(length, seed = 0) {
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i++) bytes[i] = (i * 31 + seed * 7 + length) & 0xff;
    return bytes;
}

const HASH_LENGTHS = [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 1000, 65537];

test('MD5 与 crypto 一致（含 56/64 字节填充边界）', () => {
    for (const length of HASH_LENGTHS) {
        const bytes = sampleBytes(length);
        assert.strictEqual(
            md5Hex(bytes),
            createHash('md5').update(Buffer.from(bytes)).digest('hex'),
            `长度 ${length} 不一致`
        );
    }
});

test('SHA-256 与 crypto 一致', () => {
    for (const length of HASH_LENGTHS) {
        const bytes = sampleBytes(length, 3);
        assert.strictEqual(
            sha256Hex(bytes),
            createHash('sha256').update(Buffer.from(bytes)).digest('hex'),
            `长度 ${length} 不一致`
        );
    }
});

test('HMAC-SHA256 与 crypto 一致（key 短/等长/超长）', () => {
    for (const keyLength of [0, 1, 32, 63, 64, 65, 100]) {
        const key = sampleBytes(keyLength, 5);
        const message = sampleBytes(200, 9);
        assert.strictEqual(
            hmacSha256Hex(key, message),
            createHmac('sha256', Buffer.from(key)).update(Buffer.from(message)).digest('hex'),
            `key 长度 ${keyLength} 不一致`
        );
    }
});

test('内容指纹与旧版（Node md5 前 16 位）完全一致', () => {
    const bytes = sampleBytes(4096, 11);
    const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const legacy = createHash('md5').update(Buffer.from(bytes)).digest('hex').slice(0, 16);
    assert.strictEqual(COSUploader.fingerprint(arrayBuffer), legacy);
});

console.log('COS 签名');

const ALGORITHM = 'TC3-HMAC-SHA256';

/** 用 Node 的 crypto 独立实现一遍 TC3 签名，作为对照 */
function referenceSign(params) {
    const date = new Date(params.timestamp * 1000).toISOString().slice(0, 10);
    const names = Object.keys(params.headers)
        .map((name) => name.toLowerCase())
        .sort();
    const canonicalHeaders =
        names.map((name) => `${name}:${String(params.headers[name]).trim()}\n`).join('') || '\n';
    const signedHeaders = names.join(';');
    const canonicalRequest = [
        params.method,
        params.pathname,
        params.query,
        canonicalHeaders,
        signedHeaders,
        params.payloadHash,
    ].join('\n');
    const scope = `${date}/cos/tc3_request`;
    const stringToSign = [
        ALGORITHM,
        String(params.timestamp),
        scope,
        createHash('sha256').update(canonicalRequest).digest('hex'),
    ].join('\n');

    const secretDate = createHmac('sha256', `TC3${params.secretKey}`).update(date).digest();
    const secretService = createHmac('sha256', secretDate).update('cos').digest();
    const secretSigning = createHmac('sha256', secretService).update('tc3_request').digest();
    const signature = createHmac('sha256', secretSigning).update(stringToSign).digest('hex');

    return {
        signature,
        signedHeaders,
        canonicalRequest,
        stringToSign,
        authorization: `${ALGORITHM} Credential=${params.secretId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    };
}

const SIGN_PARAMS = {
    secretId: 'AKIDEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLE',
    secretKey: 'SECRETKEYEXAMPLEEXAMPLEEXAMPLEEXAMPLE',
    method: 'PUT',
    host: 'obsidian-1250000000.cos.ap-guangzhou.myqcloud.com',
    pathname: '/picgo/9f2c1a7be3d54a01.png',
    query: '',
    headers: {
        'content-type': 'image/png',
        'cache-control': 'public, max-age=31536000',
        host: 'obsidian-1250000000.cos.ap-guangzhou.myqcloud.com',
    },
    payloadHash: createHash('sha256').update(Buffer.from(sampleBytes(512, 2))).digest('hex'),
    timestamp: 1700000000,
};

test('TC3 签名与参考实现完全一致', () => {
    const actual = signRequest(SIGN_PARAMS);
    const expected = referenceSign(SIGN_PARAMS);
    assert.strictEqual(actual.signature, expected.signature);
    assert.strictEqual(actual.authorization, expected.authorization);
    assert.strictEqual(actual.canonicalRequest, expected.canonicalRequest);
    assert.strictEqual(actual.stringToSign, expected.stringToSign);
});

test('签名头按字典序、全部小写', () => {
    const { signedHeaders } = signRequest(SIGN_PARAMS);
    assert.strictEqual(signedHeaders, 'cache-control;content-type;host');
});

test('签名对不同方法/路径/时间戳敏感', () => {
    const base = signRequest(SIGN_PARAMS).signature;
    assert.notStrictEqual(signRequest({ ...SIGN_PARAMS, method: 'HEAD' }).signature, base);
    assert.notStrictEqual(signRequest({ ...SIGN_PARAMS, pathname: '/a.png' }).signature, base);
    assert.notStrictEqual(signRequest({ ...SIGN_PARAMS, timestamp: 1700000001 }).signature, base);
    assert.notStrictEqual(signRequest({ ...SIGN_PARAMS, secretKey: 'other' }).signature, base);
});

test('Authorization 格式符合 COS 要求', () => {
    const { authorization } = signRequest(SIGN_PARAMS);
    assert.ok(
        /^TC3-HMAC-SHA256 Credential=AKIDEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLE\/\d{4}-\d{2}-\d{2}\/cos\/tc3_request, SignedHeaders=[a-z;-]+, Signature=[0-9a-f]{64}$/.test(
            authorization
        ),
        authorization
    );
});

console.log('COS 客户端工具');

test('对象 key 按段编码，保留斜杠', () => {
    assert.strictEqual(encodeKey('a/中文 b.png'), 'a/%E4%B8%AD%E6%96%87%20b.png');
    assert.strictEqual(encodeKey('picgo/9f2c.png'), 'picgo/9f2c.png');
});

test('COS 错误翻译成中文', () => {
    assert.match(
        describeCosError({ status: 403, headers: {}, text: '<Error><Code>AccessDenied</Code><Message>x</Message></Error>' }),
        /访问被拒绝/
    );
    assert.match(
        describeCosError({ status: 404, headers: {}, text: '<Error><Code>NoSuchBucket</Code><Message>x</Message></Error>' }),
        /Bucket 不存在/
    );
    assert.match(describeCosError({ status: 500, headers: {}, text: '' }), /HTTP 500/);
});

console.log('上传器');

function makeUploader(overrides = {}) {
    const settings = {
        bucket: 'obsidian-1250000000',
        region: 'ap-guangzhou',
        pathPrefix: 'picgo/',
        cdnDomain: '',
        naming: 'hash',
        skipIfExists: true,
        cacheControlSeconds: 31536000,
        ...overrides,
    };
    return new COSUploader(() => settings);
}

test('hash 命名使用内容指纹，与旧版 key 一致', () => {
    const bytes = sampleBytes(1024, 13);
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const uploader = makeUploader();
    const key = uploader.buildKey({ buffer, ext: 'png', fileName: '截图 2024.png' });
    const fingerprint = createHash('md5').update(Buffer.from(bytes)).digest('hex').slice(0, 16);
    assert.strictEqual(key, `picgo/${fingerprint}.png`);
});

test('timestamp / original 命名', () => {
    const buffer = new ArrayBuffer(8);
    const timestamped = makeUploader({ naming: 'timestamp' }).buildKey({
        buffer,
        ext: 'jpg',
        fileName: 'my pic.jpg',
    });
    assert.match(timestamped, /^picgo\/\d+_my_pic\.jpg$/);

    assert.strictEqual(
        makeUploader({ naming: 'original' }).buildKey({ buffer, ext: 'jpg', fileName: 'a/b/my pic.jpg' }),
        'picgo/my_pic.jpg'
    );
});

test('生成 URL：默认域名与自定义 CDN', () => {
    assert.strictEqual(
        makeUploader().buildUrl('picgo/1.png'),
        'https://obsidian-1250000000.cos.ap-guangzhou.myqcloud.com/picgo/1.png'
    );
    assert.strictEqual(
        makeUploader({ cdnDomain: 'cdn.example.com' }).buildUrl('picgo/1.png'),
        'https://cdn.example.com/picgo/1.png'
    );
});

test('识别自家 URL，避免重复上传', () => {
    const uploader = makeUploader();
    assert.ok(uploader.isOwnUrl('https://obsidian-1250000000.cos.ap-guangzhou.myqcloud.com/picgo/a.png'));
    assert.ok(!uploader.isOwnUrl('https://pbs.twimg.com/media/a.jpg'));
});
console.log('平台适配');

const stubModule = require(obsidianStub);

async function testAsync(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (error) {
        console.error(`  ✗ ${name}\n    ${error.message}`);
        process.exitCode = 1;
    }
}

const DOWNLOAD_OPTIONS = {
    userAgent: 'test-agent',
    proxyUrl: 'http://127.0.0.1:7897',
    referer: '',
    timeoutMs: 1000,
    retries: 0,
    maxBytes: 1024 * 1024,
    preferObsidianRequest: true,
    requireImageContentType: true,
    perHostLimit: 0,
};

async function collectFailureMessages(isDesktop) {
    globalThis.__STUB_DESKTOP__ = isDesktop;
    try {
        const downloaderInstance = new ImageDownloader();
        try {
            await downloaderInstance.download('https://example.com/x.png', DOWNLOAD_OPTIONS);
        } catch (error) {
            return error.message;
        }
        throw new Error('本应失败却成功了');
    } finally {
        globalThis.__STUB_DESKTOP__ = true;
    }
}

await testAsync('移动端只走 requestUrl，不会尝试 Node 请求', async () => {
    const message = await collectFailureMessages(false);
    assert.ok(message.includes('[requestUrl]'), message);
    assert.ok(!message.includes('[node'), message);
});

await testAsync('桌面端会依次尝试 requestUrl / 代理 / Node 直连', async () => {
    const message = await collectFailureMessages(true);
    assert.ok(message.includes('[requestUrl]'), message);
    assert.ok(message.includes('[node+proxy'), message);
    assert.ok(/\[node\]/.test(message), message);
});
console.log('上传超时与取消（旧版卡死的根因）');

const hangStub = path.join(outDir, 'obsidian-hang.cjs');
writeFileSync(
    hangStub,
    'globalThis.__REQUEST_COUNT__ = 0;\n' +
        'exports.requestUrl = () => { globalThis.__REQUEST_COUNT__++; return new Promise(() => {}); };\n' +
        'exports.Platform = { isDesktopApp: true, isMobileApp: false };\n'
);

const forbiddenStub = path.join(outDir, 'obsidian-forbidden.cjs');
writeFileSync(
    forbiddenStub,
    'globalThis.__REQUEST_COUNT__ = 0;\n' +
        'exports.requestUrl = async () => { globalThis.__REQUEST_COUNT__++;\n' +
        '  return { status: 403, headers: {}, text: "<Error><Code>AccessDenied</Code><Message>denied</Message></Error>" }; };\n' +
        'exports.Platform = { isDesktopApp: true, isMobileApp: false };\n'
);

const hangModule = await bundle('cos-client.ts', { obsidian: hangStub }, 'cos-client-hang');
const forbiddenModule = await bundle('cos-client.ts', { obsidian: forbiddenStub }, 'cos-client-forbidden');

const FAST_SETTINGS = {
    secretId: 'AKIDEXAMPLE',
    secretKey: 'secret',
    bucket: 'obsidian-1250000000',
    region: 'ap-guangzhou',
    timeoutMs: 1000,
};

await testAsync('请求卡住时超时返回，不会永远挂起', async () => {
    const client = new hangModule.COSClient(() => FAST_SETTINGS);
    const started = Date.now();
    await assert.rejects(
        () => client.putObject('a.png', new Uint8Array(4), 'image/png'),
        /上传超时/
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 8000, `耗时 ${elapsed}ms，超时保护没生效`);
});

await testAsync('取消后立即返回「已取消」', async () => {
    const client = new hangModule.COSClient(() => FAST_SETTINGS);
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(
        () => client.putObject('a.png', new Uint8Array(4), 'image/png', undefined, controller.signal),
        /已取消/
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 900, `耗时 ${elapsed}ms，取消没生效`);
});

await testAsync('4xx 不重试，5xx 才重试', async () => {
    globalThis.__REQUEST_COUNT__ = 0;
    const client = new forbiddenModule.COSClient(() => FAST_SETTINGS);
    await assert.rejects(
        () => client.putObject('a.png', new Uint8Array(4), 'image/png'),
        /访问被拒绝/
    );
    assert.strictEqual(globalThis.__REQUEST_COUNT__, 1, `4xx 被重试了 ${globalThis.__REQUEST_COUNT__} 次`);
});

await testAsync('headObject 遇到取消会抛出，不会被当成「对象不存在」', async () => {
    const client = new hangModule.COSClient(() => FAST_SETTINGS);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    await assert.rejects(() => client.headObject('a.png', controller.signal), /已取消/);
});

console.log('回归：手机端无反馈的 bug');

test('预检弹窗之后必须重建 Notice（hide() 之后 setMessage 不会重新显示）', async () => {
    const { readFileSync } = await import('fs');
    const source = readFileSync('main.ts', 'utf8');

    const modalCall = source.indexOf('openAndWait()');
    assert.ok(modalCall > 0, '找不到预检弹窗调用');

    // 弹窗确认之后 600 字以内必须出现 new Notice(...)，否则进度提示永远不会显示
    const after = source.slice(modalCall, modalCall + 600);
    assert.ok(
        /notice = new Notice\(/.test(after),
        '预检弹窗之后没有重建 Notice：hide() 掉的 Notice 用 setMessage 是显示不出来的（手机端会完全没有进度反馈）'
    );
});

test('每个任务都有自己的 AbortController，超时能真正中断请求', async () => {
    const { readFileSync } = await import('fs');
    const source = readFileSync('main.ts', 'utf8');
    assert.ok(/new AbortController\(\)/.test(source), '任务级 AbortController 丢失');
    assert.ok(/controller\.abort\(\)/.test(source), '超时后没有 abort 底层请求');
});
console.log(`\n${passed} 项通过${process.exitCode ? '，存在失败项' : ''}`);
