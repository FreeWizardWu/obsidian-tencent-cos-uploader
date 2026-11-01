#!/usr/bin/env node
/**
 * 发布脚本：npm run release
 *
 * 做四件事：
 *   1. 生产构建（tsc 类型检查 + esbuild 打包）
 *   2. 校验 manifest.json / package.json / versions.json 版本号一致
 *   3. 提交源码、打 tag、推到 GitHub
 *   4. 创建 GitHub Release，并把 main.js / manifest.json / versions.json 作为附件上传
 *
 * 为什么附件必须有这三个文件：
 *   - BRAT 安装插件时，是从「最新 Release 的附件」里下载 manifest.json 和 main.js；
 *   - Obsidian 社区插件安装器还需要 versions.json。
 *   main.js 不进 git（构建产物），所以只能靠 Release 附件分发。
 *
 * 用法：
 *   npm run release            # 用 manifest.json 里的版本号发布
 *   npm run release -- --dry   # 只构建+校验，不提交不发布
 */
import { execSync } from 'child_process';
import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';

const DRY_RUN = process.argv.includes('--dry');
const ASSETS = ['main.js', 'manifest.json', 'versions.json'];

function run(command, options = {}) {
    console.log(`$ ${command}`);
    return execSync(command, { stdio: 'inherit', ...options });
}

function runQuiet(command) {
    return execSync(command, { encoding: 'utf8' }).trim();
}

const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const versions = JSON.parse(readFileSync('versions.json', 'utf8'));
const version = manifest.version;

/* ---------------------------- 1. 版本一致性校验 ---------------------------- */

const problems = [];
if (pkg.version !== version) problems.push(`package.json 是 ${pkg.version}，manifest.json 是 ${version}`);
if (!versions[version]) problems.push(`versions.json 里缺少 "${version}" 条目（应为 "版本": "最低 Obsidian 版本"）`);
if (!manifest.isDesktopOnly && manifest.minAppVersion === undefined) {
    problems.push('manifest.json 缺少 minAppVersion');
}
if (problems.length > 0) {
    console.error('版本校验失败：');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
}

console.log(`发布版本：${version}（最低 Obsidian ${manifest.minAppVersion}）\n`);

/* -------------------------------- 2. 构建 -------------------------------- */

run('npm run build');

for (const asset of ASSETS) {
    if (!existsSync(asset)) {
        console.error(`缺少发布产物：${asset}`);
        process.exit(1);
    }
}

// 备份一份到 release/，方便手动拖到手机上
const outDir = path.join('release', version);
mkdirSync(outDir, { recursive: true });
for (const asset of ASSETS) copyFileSync(asset, path.join(outDir, asset));
console.log(`\n产物已复制到 ${outDir}/`);

if (DRY_RUN) {
    console.log('\n--dry 模式：到此为止，未提交也未发布。');
    process.exit(0);
}

/* ---------------------------- 3. 提交并打 tag ---------------------------- */

const tag = version;
const branch = runQuiet('git rev-parse --abbrev-ref HEAD');

run('git add -A');
try {
    run(`git commit -m "release: ${version}"`);
} catch {
    console.log('（没有需要提交的改动，继续）');
}

const existingTag = (() => {
    try {
        return runQuiet(`git tag -l ${tag}`);
    } catch {
        return '';
    }
})();
if (existingTag) {
    console.error(`tag ${tag} 已存在。如果确实要重发，先执行：git tag -d ${tag} && git push origin :refs/tags/${tag}`);
    process.exit(1);
}

run(`git tag ${tag}`);
run(`git push origin ${branch}`);
run(`git push origin ${tag}`);

/* ---------------------------- 4. 创建 Release ---------------------------- */

const notes = `## 1.4.1

### 修复：前几张图片成功后彻底卡死（1.4.0 及更早）
- 根因是单域名并发限流器 HostLimiter 的计数泄漏：名额「直接转交」时不递减，被唤醒者又 +1，
  每次转交漂高 1。第一批请求结束后计数停在 limit 上，之后同域名的新请求会永久等待。
  典型表现：并发 4 / 单域名上限 2 → 前 4 张成功，第 5 张开始永远不动。
- 已修复计数，并让排队等待也支持取消（不会再有排队中无法中断的情况）。

### 改进：域名级通道记忆
- 某域名上次靠哪条通道成功（requestUrl / 代理 / 直连），后续同域名图片直接走它。
- requestUrl 在桌面端只试一次，失败后该域名本次会话内不再尝试它（它无法真正取消，超时后连接仍占着）。
- 26 张 twitter 图片从「每张都踩 30 秒超时」变成只踩一次。

### 验证
- 48 项自测通过，新增 4 项直接复刻这次的死锁场景（第 5 个请求必须在有限时间内拿到名额）。
- 真实 COS 连通性测试通过；26 张真实 twitter 图片全量下载 7 秒完成。`;

// 用文件传 notes，避免命令行转义把 \n 当成字面量
const notesFile = path.join(outDir, 'RELEASE_NOTES.md');
writeFileSync(notesFile, notes, 'utf8');

run(`gh release create ${tag} ${ASSETS.join(' ')} --title ${tag} --notes-file ${notesFile}`);

console.log(`\n完成：https://github.com/${runQuiet('gh repo view --json nameWithOwner -q .nameWithOwner')}/releases/tag/${tag}`);
console.log('BRAT 里的仓库路径就是上面的 用户名/仓库名。');
