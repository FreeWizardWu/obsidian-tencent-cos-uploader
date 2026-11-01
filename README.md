# Obsidian Tencent COS Uploader

把笔记里的图片（本地图片 **和** 远程链接）上传到腾讯云 COS，并把链接替换成 COS 地址。专为「网页剪藏后一堆外链图片」的场景设计。

> **不需要 PicGo，也不需要任何本地服务。** 插件自己完成 COS 签名与上传：
> 在设置里填好 SecretId / SecretKey / Bucket / Region 就能直接用。
> **桌面端和手机端（iOS / Android）都支持。**

## 功能

- **桌面端 + 移动端（iOS / Android）**：不需要 PicGo 或任何本地服务，也不依赖 Node 运行时
- 支持本地图片与远程图片：`![](本地.png)`、`![](https://...)`
- 支持 4 种链接语法 + HTML 标签
  - 标准 Markdown：`![alt](url)`、`![alt](<url with space>)`、`![alt](url "title")`、URL 内含括号
  - 引用式：`![alt][ref]` + `[ref]: url`
  - Obsidian wiki：`![[image.png]]`、`![[image.png|alt]]`、`![[image.png|300]]`
  - 剪藏混合格式：`![[说明]](https://...)`
  - HTML：`<img src="https://...">`
- **支持代理下载**：海外图片（X/Twitter、GitHub、pixiv…）不再是「下载失败」
- **自动处理防盗链**：按图片域名推断 Referer，也可手工指定
- **内容哈希命名**：同一张图只存一份，重复运行零成本、不产生垃圾对象
- 并发下载/上传（可调）、失败自动重试、超时保护
- 内容类型校验：返回网页/验证码页时直接判定失败，不会把 HTML 当图片传上去
- 原子改写笔记（`vault.process`）：上传期间继续编辑不会丢字
- 状态栏实时进度，失败项汇总提示

## 安装

### 手机（iOS / Android）—— 推荐用 BRAT，只装这一个插件

手机端**不要**用「整库同步插件目录」的方式（官方 Sync 的插件同步是按类别，不能挑单个插件；
把所有桌面插件都搬到手机上会拖慢启动、也会把一堆用不上的东西带过去）。

1. 手机 Obsidian → 设置 → 第三方插件 → 浏览 → 搜 **BRAT**（Beta Reviewers Auto-update Tester）→ 安装并启用
2. BRAT → `Add Beta Plugin` → 填入仓库路径：
   ```
   FreeWizardWu/obsidian-tencent-cos-uploader
   ```
3. BRAT 会从最新 Release 下载 `manifest.json` / `main.js` / `versions.json` 并安装
4. 到 设置 → 第三方插件 里启用 **Tencent COS Uploader**
5. 打开插件设置，把 SecretId / SecretKey / Bucket / Region 填一遍（手机端建议用**单独的子账号密钥**，只给这个 Bucket 的 PutObject 权限）

以后桌面端改了代码：`npm run release` 推个新版本，手机 BRAT 里点一下就能更新。

> 如果你用的是官方 Obsidian Sync：把「已安装的插件」同步**关掉**，插件就只靠 BRAT 安装，
> 不会把桌面上一大堆插件带到手机上。代价是 `data.json`（密钥配置）也不会同步，需要在手机上填一次。

### 桌面端（手动）

```bash
npm install
npm run build      # 生产构建
```

把整个目录复制到 `<vault>/.obsidian/plugins/obsidian-tencent-cos-uploader/`，然后在
设置 → 第三方插件 中启用。

也可以装 BRAT，用同样的仓库路径安装，以后更新不用手动拷。

### 发版（给 BRAT 用）

```bash
npm run release:dry   # 只构建 + 校验版本，不提交不发布
npm run release       # 构建 → 校验 → 提交 → 打 tag → 建 Release 并附上三个产物
```

Release 必须附带 `main.js`、`manifest.json`、`versions.json` —— BRAT 就是从这里下载的。
`main.js` 是构建产物，不进 git，脚本会自动打包到 `release/<version>/` 并上传。

### 开发自测

```bash
npm test           # 纯逻辑自测：链接解析、替换、纯 JS 哈希、COS 签名
npm run test:live  # 真实 COS 连通性：上传→HEAD→GET→删除（需要真密钥）
```

`test:live` 三种传参方式任选：

```bash
npm run test:live -- --data /path/to/.obsidian/plugins/obsidian-tencent-cos-uploader/data.json
COS_DATA_JSON=/path/to/data.json npm run test:live
COS_SECRET_ID=... COS_SECRET_KEY=... COS_BUCKET=... COS_REGION=... npm run test:live
```

它会往 Bucket 里写一个 `__connectivity_test_live__.png` 然后删掉，不打印密钥内容。

## 配置

| 配置项 | 说明 | 示例 |
|--------|------|------|
| App ID | 腾讯云 App ID（仅备注） | 1250000000 |
| SecretId | 建议使用子账号密钥 | AKIDLXgmox... |
| SecretKey | 密钥（明文本地保存，勿外泄） | JctIjR9qX... |
| Bucket | 存储桶名称 | obsidian-1250000000 |
| Region | 地域 | ap-guangzhou |
| 路径前缀 | 对象 key 前缀 | picgo/ |
| 自定义 CDN 域名 | 可选 | cdn.example.com |
| **HTTP 代理** | 下载海外图片用，填代理软件的 HTTP 端口。**仅桌面端，手机端隐藏** | `http://127.0.0.1:7897` |
| 优先使用 Obsidian 网络栈 | 先用 `requestUrl`（自动走系统代理），失败再回退。**仅桌面端** | 开 |
| 自定义 User-Agent | 留空使用内置浏览器 UA | Mozilla/5.0 ... |
| 自定义 Referer | 留空按域名自动推断 | `https://x.com/` |
| 超时时间 | 单次请求超时（毫秒） | 30000 |
| 失败重试次数 | 0-5 | 2 |
| 文件命名方式 | 内容哈希 / 时间戳_文件名 / 原始文件名 | 内容哈希 |
| 哈希已存在时跳过上传 | 复用已有对象，不重复传 | 开 |
| 并发数 | 1-8 | 4 |
| 缓存时间 | Cache-Control max-age（秒） | 31536000 |

## 为什么海外图片会下载失败？

Node 的 `http` / `https` 模块**既不读 `http_proxy`、`https_proxy` 环境变量，也不读系统代理**。
所以在国内网络环境下，像 `pbs.twimg.com`（X/Twitter 图片）这样的域名直连会直接
`ECONNRESET`，表现就是「下载失败」。

本插件的下载策略是三段式（手机端只有第 1 段）：

1. **Obsidian `requestUrl`** —— 走 Chromium / 原生网络栈，自动使用系统代理、自动跟随重定向、处理 gzip，且不受 CORS 限制。**桌面端和手机端都走这条路。**
2. **Node 请求 + 设置里的 HTTP 代理** —— 自己实现 `CONNECT` 隧道，用于「只配了系统代理但 Obsidian 没吃到」或需要强制指定代理的场景（仅桌面端）。
3. **Node 直连** —— 最后兜底（仅桌面端）。

因此桌面端只要你的代理软件（Clash / Surge / V2Ray…）开了系统代理，或把 HTTP 端口填进设置页，就能正常下载；
手机端则取决于手机本身的网络（是否开了系统级代理 / VPN）。

> 注意：不支持 `socks5://` 地址，请填代理软件的 **HTTP（混合）端口**。

## 上传是怎么实现的（不需要 PicGo）

- 上传走 **COS 原生 REST API + TC3-HMAC-SHA256 签名**，签名用纯 JS 实现（`hash.ts` + `cos-client.ts`），
  请求用 Obsidian 的 `requestUrl` 发出：桌面端走 Electron 网络栈，手机端走原生 HTTP，两端都能用，并且绕过 CORS，
  不需要给 Bucket 配置跨域规则。
- 内容指纹（`hash` 命名模式）用纯 JS MD5，**与旧版本 `cos-nodejs-sdk-v5` 生成的 key 完全一致**，
  升级后不会重复上传已有图片。
- 桌面端仍保留 Node 直连 / HTTP 代理作为下载兜底，相关代码隔离在 `node-network.ts`，用动态 import 惰性加载，
  手机上永远不会执行到 `require('http')`。

## 上传卡住 / 取消不掉怎么办？

1.3.0 之前有一个真实的死锁场景：

- 上传请求没有硬超时（旧版直接用 `cos-nodejs-sdk-v5` 的 `putObject`），
  网络半断开时 Promise 可能一直不 settle；
- 整轮上传靠 `activeRun` 锁控制，锁只在流程正常结束时才释放，于是后续每次上传都会提示
  “上一次上传还没结束”；
- 而取消只对**下载**生效（上传请求不认 `AbortSignal`），所以看起来“取消也取消不掉”。
- 另一个坑：图片较多时弹出的预检确认框如果在等待中，取消也不会关掉它，流程就一直停在等点击。

现在这三处都改了：

| 保护 | 说明 |
|------|------|
| 请求硬超时 | 上传/HEAD/DELETE 都按设置里的「超时时间」强制执行，超时后重试一次就放弃 |
| 可取消 | 取消会立即中断上传、下载、预检弹窗，不再干等 |
| 任务超时 | 单张图片最多处理 3 分钟，卡死的那张会被记入失败，不影响其他图片 |
| 强制复位 | 取消后 15 秒内流程仍未结束，插件自动释放上传锁，不会永久卡在“上一次上传还没结束” |
| 4xx 不重试 | 密钥/权限/桶名错误直接报错，不做无意义的重试 |

## 使用方法

1. 命令面板（`Cmd/Ctrl + P`）
   - `Upload local images in current note` —— 只处理库里的本地图片
   - `Upload all images (local + remote) in current note` —— 本地 + 远程全上传
   - `Test COS connection` —— 验证密钥 / Bucket / Region
2. 左侧功能区图片图标：一键上传当前笔记所有图片
3. 文件列表右键 → 上传笔记图片到 COS

上传时状态栏会显示进度；笔记链接会在全部结束后一次性原子写回。

## 示例

上传前：

```markdown
![example](images/pic.png)
![截图](https://pbs.twimg.com/media/HS5uLj4bkAA_6il?format=jpg&name=large)
![[image.png|300]]
```

上传后：

```markdown
![example](https://obsidian-1250000000.cos.ap-guangzhou.myqcloud.com/picgo/9f2c1a7be3d54a01.png)
![截图](https://obsidian-1250000000.cos.ap-guangzhou.myqcloud.com/picgo/6b1d0c9a5e7f2a33.jpg)
![](https://obsidian-1250000000.cos.ap-guangzhou.myqcloud.com/picgo/2ac7e5f10b9d3c48.png)
```

## 安全提示

- 密钥以明文保存在插件 `data.json` 中，请勿把该文件同步到公开仓库。
- 强烈建议使用**子账号密钥**，并只授予该 Bucket 的 `PutObject` / `GetObject` / `HeadObject` / `DeleteObject` 权限。
- 手机上使用同一个 `data.json`，即手机也持有这份密钥；如果手机丢失，请在腾讯云控制台禁用该子账号密钥。
- 插件同时支持桌面端与移动端（`isDesktopOnly: false`）。
