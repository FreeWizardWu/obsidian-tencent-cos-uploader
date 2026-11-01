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

const notes = `## 1.3.1

### 变更
- 设置页与 README 里的示例值改为通用示例（1250000000 / my-bucket-1250000000），不再使用真实 App ID 与桶名
- 说明：设置页里灰色的 AKIDxxxx… 只是**占位提示**，不是已填内容；实际值只来自 data.json

### 注意
- 插件本体不包含任何密钥。手机端首次使用需自己填写 SecretId / SecretKey / Bucket / Region`;

// 用文件传 notes，避免命令行转义把 \n 当成字面量
const notesFile = path.join(outDir, 'RELEASE_NOTES.md');
writeFileSync(notesFile, notes, 'utf8');

run(`gh release create ${tag} ${ASSETS.join(' ')} --title ${tag} --notes-file ${notesFile}`);

console.log(`\n完成：https://github.com/${runQuiet('gh repo view --json nameWithOwner -q .nameWithOwner')}/releases/tag/${tag}`);
console.log('BRAT 里的仓库路径就是上面的 用户名/仓库名。');
