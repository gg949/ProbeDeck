# ProbeDeck 第三方主题开发 API 文档

> 面向第三方主题开发作者的 API 参考。
>
> 本文档适配 ProbeDeck（CF-Server-Monitor 的 Docker / VPS 自托管移植版，当前版本 v2.13）：公开 API 与 WebSocket 协议与原版保持一致，并新增了若干面板级动态设置（在线判定阈值、访客历史范围、历史档位扩展至 30 天、每台最多 24 个探测点等）——相关数值请通过 `/api/config` 动态读取，不要写死。
>
> 本文档只保留第三方主题可用的公开 API、WebSocket 和静态目录约定，不介绍后台管理接口。
>
> 管理后台固定由默认主题接管；主题中的管理入口只能跳转到 `/admin#admin`。

**Base URL**：`https://<你的面板地址>`

**统一响应头**：

- `Content-Type: application/json`（除特别说明外）

***

## 目录

- [0. 运行时配置、构建产物与版本升级提示](#0-运行时配置构建产物与版本升级提示)
  - [0.1 API Base 配置](#01-api-base-配置)
  - [0.2 主题构建产物约定](#02-主题构建产物约定)
  - [0.3 版本升级提示](#03-版本升级提示)
  - [0.4 面板运行时设置（主题适配要求）](#04-面板运行时设置主题适配要求)
  - [0.5 更新主题后如何生效](#05-更新主题后如何生效)
- [1. 鉴权与 Turnstile 流程](#1-鉴权与-turnstile-流程)
  - [1.1 鉴权机制](#11-鉴权机制)
  - [1.2 Turnstile 人机验证流程](#12-turnstile-人机验证流程)
- **[2. 公开 API](#2-公开-api)**
  - **[2.1 获取站点配置](#21-获取站点配置)**
  - **[2.1.1 保存第三方主题配置](#211-保存第三方主题配置)**
  - **[2.2 获取服务器列表](#22-获取服务器列表)**
  - [2.3 获取服务器详情](#23-获取服务器详情)
  - [2.4 获取历史指标](#24-获取历史指标)
- [3. WebSocket 实时推送](#3-websocket-实时推送)
- [4. 错误处理](#4-错误处理)
- [5. 类型定义](#5-类型定义)
- [6. 常见问题](#6-常见问题)
- [7. 附：踩坑记录与自查清单（移植适配）](#7-附踩坑记录与自查清单移植适配)
  - [7.1 数据与名字](#71-数据与名字)
  - [7.2 实现与构建](#72-实现与构建)
  - [7.3 验证与缓存](#73-验证与缓存)
  - [7.4 从 CF-Server-Monitor 原版主题搬过来时的差异](#74-从-cf-server-monitor-原版主题搬过来时的差异)

***

## 0. 运行时配置、构建产物与版本升级提示

### 0.1 API Base 配置

`config.json` 已废弃，当前前端不会请求或读取 `config.json`。

默认情况下，前端使用当前页面同源地址作为 API Base，即 `window.location.origin`。面板与主题同域部署时无需额外配置。

纯静态主题（例如 GitHub Pages）通过 HTML meta 标签配置后端地址：

```html
<meta name="apiBase" content="https://<你的面板地址>,https://<面板地址2>">
```

多个地址用英文逗号分隔。前端会按 `apiBase` 创建对应的 HTTP 请求和 WebSocket 连接，多站模式下每个后端只处理自己返回的服务器 ID。

跨域部署主题时，还需要在面板服务器上添加环境变量 `CORS_ALLOWED_ORIGINS`（Docker 部署通过 `-e CORS_ALLOWED_ORIGINS=...` 传入；直接运行源码时以同名环境变量导出）。把本地开发地址和最终上线域名加入白名单；如果 `API_BASE` 配置了多个面板地址，每个都要添加这一项。

```
https://localhost:5173,https://[你的github用户名].github.io
```

该值只填写 origin，多个值用英文逗号分隔，不要包含路径、查询参数或结尾 `/`。如果线上主题域名不是面板同源域名，也必须加入这里，否则浏览器会拦截 API 请求和 WebSocket 连接。

使用项目内置静态主题构建脚本时，需要在主题项目 `.env` 中配置：

| 环境变量 | 说明 | 默认值 |
| --- | --- | --- |
| `API_BASE` | 后端地址，多个地址用英文逗号分隔 | 必填 https://<你的面板地址> |
| `TITLE` | 静态页面标题 | 选填 |
| `BACKGROUND_IMAGE` | 静态页面背景图（桌面端） | 选填 |
| `BACKGROUND_IMAGE_MOBILE` | 静态页面背景图（移动端） | 选填 |

运行：

```bash
npm run build:github-page
```

纯静态构建时，`API_BASE`、`TITLE`、`BACKGROUND_IMAGE`、`BACKGROUND_IMAGE_MOBILE` 会写入 HTML 运行时配置。

另外注意：通过面板加载的主题页面（面板配置了主题链接 / 主题商店启用主题时）由面板统一注入 CSP 响应头，主题页面需要加载的外部资源域名（字体、图片、外部 API / WebSocket 等）应由站点管理员在后台外观设置中登记到 `csp_static` / `csp_api`，否则会被浏览器拦截；纯静态部署（如 GitHub Pages）的主题页面不受面板 CSP 约束。

### 0.2 主题构建产物约定

主题完成后提交到 [gg949/ProbeDeck-themes](https://github.com/gg949/ProbeDeck-themes) 的 `themes.json`（提 PR 或 issue 均可）。新条目追加在现有主题后面，不要改已有条目的 `id` / 顺序 / `url`。内置 Mikus 不在此列表。

主题构建产物仅需要：

- `index.html`
- `assets/` 目录

**产物必须直接放在所用分支的根目录**。面板按 `https://raw.githubusercontent.com/<owner>/<repo>/<ref>/index.html` 读取主题：`<ref>` 是**分支名或 commit**（如 `.../main/index.html`、`.../build/index.html`），文件路径直接拼在后面，**没有「自动去找 `dist/` 子目录」这种逻辑**——分支根目录下没有 `index.html` 就会 404 / 白屏。

目录结构示例（这里的 `my-theme/` 指分支根目录，不是仓库里的某个子文件夹）：

```
my-theme/            ← 分支根目录
├── index.html
└── assets/
    ├── app.css
    ├── app.js
    └── logo.webp
```

常见错误：构建工具默认输出到 `dist/`（Vite 等），直接把源码分支填进主题链接——面板拿到的就是仓库根目录（没有 `index.html`），或拿到 Vite 开发模板。**正确做法 = 新建一个只放产物的分支**（惯例命名 `build` / `dist` / `theme-dist`，只提交 `index.html` + `assets/`，不带源码），主题链接与商店条目都指向这个分支。（手动填主题链接时也可以带子目录，如 `tree/main/dist`；但商店条目的 `branch` 字段只能表达分支名、不能带子目录。）

**推荐仓库结构：`main` 放源码 + 一个产物分支放构建结果**（`build` / `dist` / `theme-dist`）。建法二选一：

1. 本地：`git checkout --orphan build` → 把 `index.html` 与 `assets/` 放到仓库根目录 → `git add index.html assets && git commit -m "build" && git push origin build`
2. 网页：在仓库里新建分支 `build`，把构建产物（`index.html` + `assets/`）直接上传到该分支的**根目录**

⚠️ **仓库里只有 `main` 一个分支（源码在根、产物在 `dist/`）时，主题商店读不到主题**——面板只会按 `<分支>/index.html` 直接取文件，**不会**自动去找 `dist/` 子目录。

`themes.json` 条目示例（`url` 指向主题仓库，`branch` 指向存放构建产物的分支——**只能是分支名**；商店安装时会把该分支解析成固定 commit 再读取）：

```json
{
  "id": "my-theme",
  "title": "My Theme",
  "cover": "https://raw.githubusercontent.com/<owner>/<repo>/<branch>/docs/preview.png",
  "tags": ["Minimal"],
  "description": {
    "zh-CN": "主题简介（中文）",
    "en": "Theme description (English)"
  },
  "url": "https://github.com/<owner>/<repo>",
  "branch": "build",
  "author": "<作者名>"
}
```

主题开发注意事项：

- 主题提交目录只能生成 `index.html` 和 `assets/`；不要依赖其他主题目录或根目录文件
- 静态资源应放在主题目录的 `assets/` 下，并在 HTML/JS/CSS 中使用 `/assets/...` 或相对 `assets/...`
- 旗帜和 OS 图标走默认皮肤静态文件，不要打包进主题：旗帜使用 `/flags/<code>.svg`，OS 图标使用 `/os-icons/<filename>`
- 站点标题、背景图、自定义 `<head>`、自定义脚本由用户后台外观设置控制，主题不要把这些配置写死
- 在线判定阈值、访客历史范围等面板设置请通过 `/api/config` 动态读取（见 [0.4](#04-面板运行时设置主题适配要求)），不要写死具体数值
- 主题不可用时应让页面暴露加载错误，不要在主题内静默跳转到其他页面
- 署名规则：页脚不要出现指向其他项目的 `Powered by XXX` / 「适配于 XXX」署名。**从其他主题改来的**（原本带这类署名）必须改成 `Powered by ProbeDeck` 并链接到 [https://github.com/gg949/ProbeDeck/](https://github.com/gg949/ProbeDeck/)（可附 `/api/config` 返回的 `version`，例如 `Powered by ProbeDeck v2.13.0`）；**全新主题**不要额外加署名行，也不要加「移植自 XXX」。「主题源码」链接指向主题自己的仓库即可。

路由约定：

- 首页：`/#/` 或 `/#`
- 详情页：`/#/server/:id`
- 管理后台：链接到 `/admin#admin`，由内置默认主题接管，第三方主题不得实现管理页

### 0.3 版本升级提示

`GET /api/config` 会返回当前面板版本 `version`。当请求带有有效 JWT 时，后端还会查询远程最新版并额外返回：

- `last_workers_version`：最新面板版本（字段名沿用上游兼容命名）
- `last_agent_version`：最新探针 Agent 版本（GitHub Release tag，形如 `v1.0.18`）

第三方主题可以将 `version` 与 `last_workers_version` 做字符串比较，自行决定是否展示版本升级提示。`last_agent_version` 仅在登录后返回，可用于可选的 Agent 版本提示。

未登录访问 `/api/config` 时不会返回 `last_workers_version` / `last_agent_version`，自定义主题不要依赖匿名请求展示升级提示。

### 0.4 面板运行时设置（主题适配要求）

面板的部分设置会直接影响主题前端行为。以下值全部通过 `GET /api/config` 获取，主题必须动态读取，不要写死：

| 设置 | 说明 | 主题应如何使用 |
| --- | --- | --- |
| `online_threshold_seconds` | 在线判定阈值（秒），默认 `300` | 判定服务器在线状态：`Date.now() - last_updated < online_threshold_seconds * 1000`；不要写死 5 分钟 |
| `public_history_hours` | 访客（未登录）可查询的历史范围上限（小时），默认 `24` | 访客的历史档位按它动态限制：超出该值的档位置灰 / 隐藏，或点击时提示登录；不要写死 24 小时 |
| `frontend_ws_timeout_minutes` | 实时订阅单次连接时长（分钟），`0` 表示不按时间断开 | 达到对应分钟数后关闭连接，并由用户明确选择是否续订 |
| `long_history_points` | 长历史查询返回的采样点数（`60` / `120` / `180` / `240`） | 历史图表按实际返回点数渲染 |
| `latency_window` | `ping` / `loss` 窗口参数（`points` 点数、`hours` 回看小时数） | 展示延迟小图时作为窗口参考 |
| `site_title`、`display_mode`、`preferred_theme`、`default_language`、`custom_*_name`、`node_*_name` | 站点标题、默认展示模式、主题与语言、自定义显示名 | 用于页面标题与指标命名，不要写死 |
| Ping 线路 | 最多 **24 条**：`ct` / `cu` / `cm` / `bd` + `node_1` … `node_20`（2.13+ 每台可启用扩展点；旧面板只有前 8 条） | 窗口点与当前值都带已启用槽位的字段；显示名优先取服务器对象上的 `custom_*_name` / `node_*_name`（2.13+ 含扩展点，本机自定义名优先），站点级 `/api/config` 只有前 8 槽名字；未配置的线路值为 `false` 或缺失，主题应不显示 |
| `theme_options` | 主题自身的配置（配合 `POST /api/theme_options` 保存） | 作为主题自身设置的读写入口 |

### 0.5 更新主题后如何生效

面板会缓存主题资源。推了新版本却看不到变化时，优先查缓存，不要先怀疑自己写错。

主题文件的 raw 地址 = `https://raw.githubusercontent.com/<owner>/<repo>/<ref>/<产物内相对路径>`：`<ref>` 是分支名或 commit，与文件路径**直接拼接**，不会自动加 `dist/` 等子目录——产物要放在分支根目录（见 [0.2](#02-主题构建产物约定)）。

| 主题链接形态 | 面板内存缓存 | 浏览器 `Cache-Control` |
| --- | --- | --- |
| 分支引用（`/tree/main`、`/tree/build` 等） | 3600 秒（1 小时） | `public, max-age=3600` |
| 固定 commit（`/tree/<40 位 sha>`） | 86400 秒（内容不可变） | `public, max-age=31536000, immutable`（换 commit 即换 URL，旧缓存不影响新版本） |

正式发布建议用固定 commit 的 `https://github.com/<owner>/<repo>/tree/<commitid>` 链接。换 commit 后 URL 变了，面板立刻拉新文件。

注意：`<commitid>` 必须是**完整 40 位 sha**（如 `a1b2c3d4e5f6…`，`git rev-parse HEAD` 或 GitHub 提交页地址栏可复制）；填 7 位短 sha 会被面板当成「分支名」处理，走分支那行的缓存规则（1 小时）。

分支 URL 最多等 1 小时，或重启面板容器清内存缓存。浏览器请 `Ctrl+Shift+R` 硬刷新。

面板前面如果挂了 Cloudflare：主题静态资源会被边缘缓存。commit 引用带 `immutable`，CF 可能一直吐旧文件。排查顺序：① `curl` GitHub raw 确认源文件已更新 ② `curl -sI <面板>/assets/<文件>` 看 `cf-cache-status` ③ Cloudflare 清除缓存 → 无痕窗口复测。

***

## 1. 鉴权与 Turnstile 流程

### 1.1 鉴权机制

项目使用以下鉴权机制：

| 机制         | 使用位置            | 方式                                           |
| ---------- | --------------- | -------------------------------------------- |
| JWT Bearer | 非公开站点读取公开 API；访客查看超过 `public_history_hours` 的历史；保存第三方主题配置 | `Authorization: Bearer <jwt>`              |
| WebSocket JWT | 非公开站点连接 `/api/ws` | `Authorization: Bearer <jwt>`、`cfsm_auth=<token>` 或查询参数 `token` / `auth_token` / `ws_token` |
| Turnstile  | 公开 API（当启用时）    | `X-Turnstile-Token` 或 `X-Turnstile-Verified` |

浏览器原生 WebSocket 不能自定义 `Authorization` Header。第三方主题在私有站点中连接 `/api/ws` 时，同域走登录后的 `cfsm_auth` Cookie，跨域走 WebSocket URL 查询参数 `token=<jwt>`。查询参数 token 可能出现在访问日志中，请只通过 HTTPS 使用。

### 1.2 Turnstile 人机验证流程

```
1. 首次访问 → GET /api/config → 获取 turnstile_site_key
2. 渲染 Turnstile 组件 → 获取一次性 token
3. 后续请求 → 携带 X-Turnstile-Token 头
4. 验证成功 → /api/config 响应体返回 turnstile_verified（加密凭证，有效期 1 小时）
5. 后续请求 → 可复用 X-Turnstile-Verified，省略 X-Turnstile-Token
```

**相关 Header**：

| Header                 | 方向              | 说明                        |
| ---------------------- | --------------- | ------------------------- |
| `X-Turnstile-Token`    | Client → Server | 当次 Turnstile token（明文）    |
| `X-Turnstile-Verified` | Client → Server | AES-GCM 加密的已验证凭证，客户端应缓存复用 |

**注意**：

- `/api/ws`、`/api/config`（不带 Turnstile Header 时）无需验证
- `/api/config` 带 `X-Turnstile-Token` 或 `X-Turnstile-Verified` 时会进入验证流程，并通过 `verified` / `turnstile_verified` 返回验证结果
- `/api/ws` 不参与 Turnstile 验证，但非公开站点仍需要通过 WebSocket JWT 认证
- `turnstile_enabled` 是全局 API 验证开关，`turnstile_login_enabled` 是内置后台登录页验证开关；第三方主题不实现登录页，管理入口跳转 `/admin#admin`

***

## 2. 公开 API

> 若站点非公开（`is_public !== 'true'`），所有接口需携带 JWT。
> 启用 Turnstile 时需携带 `X-Turnstile-Token` 或 `X-Turnstile-Verified`。
> `POST /api/theme_options` 是写接口，无论站点是否公开都需要 JWT。

### 2.1 获取站点配置

**Request**

```
GET /api/config
Headers: (可选) Authorization: Bearer <jwt>, X-Turnstile-Token / X-Turnstile-Verified
```

**Response**

```json
{
  "version": "2.13.0",
  "last_workers_version": "2.13.0",
  "last_agent_version": "v1.0.19",
  "is_public": true,
  "authorization": true,
  "turnstile_enabled": false,
  "turnstile_login_enabled": false,
  "turnstile_site_key": "1x00000000000000000000AA",
  "custom_ct_name": "电信",
  "custom_cu_name": "联通",
  "custom_cm_name": "移动",
  "custom_bd_name": "BGP",
  "node_1_name": "Node 1",
  "node_2_name": "Node 2",
  "node_3_name": "Node 3",
  "node_4_name": "Node 4",
  "site_title": "My Server Monitor",
  "display_mode": "ring",
  "preferred_theme": "auto",
  "default_language": "auto",
  "theme_options": {
    "a": 1,
    "b": 2
  },
  "verified": false,
  "turnstile_verified": null,
  "frontend_ws_timeout_minutes": 0,
  "long_history_points": 120,
  "online_threshold_seconds": 300,
  "public_history_hours": 24,
  "latency_window": { "points": 20, "hours": 2 }
}
```

**字段说明**：

| 字段                   | 类型           | 说明              |
| -------------------- | ------------ | --------------- |
| `version`            | string       | 当前面板版本号 |
| `last_workers_version` | string\|null | 最新面板版本，仅登录后返回 |
| `last_agent_version` | string\|null | 最新 Agent 版本，仅登录后返回 |
| `is_public`          | boolean      | 是否公开站点             |
| `authorization`      | boolean      | 当前请求是否已通过登录验证       |
| `turnstile_enabled`  | boolean      | 是否启用全局 API 人机验证 |
| `turnstile_login_enabled` | boolean | 是否启用登录页人机验证 |
| `turnstile_site_key` | string       | Turnstile 前端公钥  |
| `custom_ct_name` / `custom_cu_name` / `custom_cm_name` / `custom_bd_name` | string | Ping 指标显示名称；分别用于 CT、CU、CM、BGP |
| `node_1_name` / `node_2_name` / `node_3_name` / `node_4_name` | string | 自定义延迟节点显示名；未配置时分别为 `Node 1` ~ `Node 4` |
| `site_title`         | string       | 站点标题 |
| `display_mode`       | string       | 面板默认展示模式：`bar` 条形图 / `ring` 环形图 / `table` 列表 |
| `preferred_theme`    | string       | 默认外观：`auto` 跟随系统 / `dark` 深色 / `light` 浅色 |
| `default_language`   | string       | 默认语言：`auto` 按浏览器语言自动选择中文或英文 / `zh` 中文 / `en` 英文 |
| `theme_options`      | object       | 第三方主题自定义配置；未配置时为空对象 |
| `verified`           | boolean      | 当前请求是否已验证       |
| `turnstile_verified` | string\|null | 已验证凭证，缓存复用 1 小时 |
| `frontend_ws_timeout_minutes` | number | 前端实时订阅连接超时分钟数，范围 `0`-`1440`；默认 `0` 表示不超时 |
| `long_history_points` | number      | 长历史查询返回的采样点数，可选 `60`、`120`、`180`、`240` |
| `online_threshold_seconds` | number  | 在线判定阈值（秒），默认 `300`；主题据此判定在线状态（见 2.2） |
| `public_history_hours` | number     | 访客（未登录）可查询的历史范围上限（小时），默认 `24`；主题据此限制访客历史档位（见 2.4） |
| `latency_window` | object | `/api/servers` 的 `servers[].ping` / `servers[].loss` 窗口参数，`points` 为最多真实点数，`hours` 为回看小时数 |

`theme_options` 是第三方主题的运行时配置。读取时使用 `/api/config`，保存主题自身配置时使用 `POST /api/theme_options`；不要在第三方主题内调用 `save_settings` 或其他管理端接口。

**示例**：

```js
const res = await fetch('/api/config');
const config = await res.json();
```

***

### 2.1.1 保存第三方主题配置

第三方主题如需要保存自身配置，使用独立接口 `POST /api/theme_options`。该接口只更新 `appearance_options.theme_options`，不会修改 `site_options`，也不会覆盖 `appearance_options` 中的站点标题、背景图、CSP、自定义脚本等其他外观设置。

**Request**

```
POST /api/theme_options
Headers: Authorization: Bearer <jwt>, Content-Type: application/json, X-Turnstile-Token / X-Turnstile-Verified
```

启用全局 Turnstile 时需要携带 `X-Turnstile-Token` 或 `X-Turnstile-Verified`；未启用时只需要 JWT。`theme_options` 必须是非数组对象，传数组、字符串或 `null` 会返回 `400 invalidThemeOptionsFormat`。

```json
{
  "theme_options": {
    "layout": "compact",
    "accent": "green"
  }
}
```

**Response**

```json
{
  "success": true,
  "theme_options": {
    "layout": "compact",
    "accent": "green"
  },
  "message": "updateSuccess"
}
```

**示例**：

```js
async function saveThemeOptions(themeOptions, token, turnstileVerified) {
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  };
  if (turnstileVerified) {
    headers['X-Turnstile-Verified'] = turnstileVerified;
  }

  const res = await fetch('/api/theme_options', {
    method: 'POST',
    headers,
    body: JSON.stringify({ theme_options: themeOptions })
  });
  const result = await res.json();
  if (!res.ok) throw new Error(result.error || 'saveThemeOptionsFailed');
  return result.theme_options;
}
```

***

### 2.2 获取服务器列表

**Request**

```
GET /api/servers
Headers: (按需) Authorization: Bearer <jwt>, X-Turnstile-Token/Verified
```

**Response**

```json
{
  "servers": [ /* Server[] */ ],
  "latestReportUpdates": [
    {
      "serverId": "9b2c...",
      "reportTs": 1737638405000,
      "reportAgeMs": 1200,
      "samples": [
        {
          "ts": 1737638400000,
          "data": {
            "cpu": 12.34,
            "ram_used": 3700,
            "net_in_speed": 1024,
            "net_out_speed": 512
          }
        }
      ]
    }
  ],
  "stats": {
    "total": 10,
    "online": 8,
    "offline": 2,
    "globalSpeedIn": 1234.5,
    "globalSpeedOut": 567.8,
    "globalNetTx": 1234567890,
    "globalNetRx": 9876543210
  },
  "regionStats": { "US": 3, "JP": 2, "CN": 5 },
  "sysConfig": {
    "show_price": true,
    "show_expire": true,
    "show_tf": true,
    "show_three_net_details": true,
    "custom_ct_name": "电信",
    "custom_cu_name": "联通",
    "custom_cm_name": "移动",
    "custom_bd_name": "BGP",
    "display_mode": "ring",
    "latency_window": { "points": 20, "hours": 2 }
  }
}
```

**字段说明**：

| 字段            | 说明                          |
| ------------- | --------------------------- |
| `servers`     | 服务器列表（含最新指标），未登录用户自动过滤隐藏服务器；`tags` 始终随服务器返回（英文逗号分隔；后台保存时按逗号切分，每个标签只保留字母/数字/空格/`._-`，单个 ≤32 字符、最多 12 个） |
| `latestReportUpdates` | 最近一次上报的实时样本（回放用），按服务器聚合；为空数组表示当前无可用回放，形状与 2.3 一致 |
| `stats`       | 聚合统计；在线 / 离线按面板「在线判定阈值」（`online_threshold_seconds`，默认 300 秒）在服务端统计 |
| `regionStats` | 按区域统计服务器数量                  |
| `sysConfig`   | 站点开关与显示配置；主题自身配置请从 `/api/config` 的 `theme_options` 读取 |

**在线判定**：面板的在线判定阈值可在后台调整（`/api/config` 的 `online_threshold_seconds`，默认 `300` 秒）。主题在客户端判定单台服务器在线状态时，应读取该值，不要写死 5 分钟：

```js
const online = Date.now() - server.last_updated < config.online_threshold_seconds * 1000;
```

**访客字段剥离**：未登录访客请求时，服务端按站点开关剥离受限字段（不能只靠前端隐藏）——`show_price` 关闭时 `price` / `currency` / `billing_cycle` / `auto_renewal` 不返回；`show_expire` 关闭时 `expire_date` 不返回；`show_tf` 关闭时 `traffic_limit` 不返回。主题需要兼容这些字段缺失，不要假设字段一定存在。

`servers[].ping` / `servers[].loss` 仅在列表接口返回。2.13 起点里带**已启用槽位**的字段：前 8 槽 `{ ct, cu, cm, bd, node_1 … node_4 }`，已配置的扩展点 `node_5` … `node_20`（值为数字 / `false` / `null`，仅在有数据时出现）；只读前 8 条字段的主题不受影响。ProbeDeck 2.13+ 另有 `servers[].probes`（最多 24，含每台自定义名称）：

```js
// 首页 ping 芯片：有 probes 就按数组画，没有走原来 8 个旧字段
const probes = Array.isArray(server.probes) && server.probes.length
  ? server.probes
  : [
      { id: 'ct', name: config.custom_ct_name || '电信', ping: server.ping_ct },
      { id: 'cu', name: config.custom_cu_name || '联通', ping: server.ping_cu },
      { id: 'cm', name: config.custom_cm_name || '移动', ping: server.ping_cm },
      { id: 'bd', name: config.custom_bd_name || 'BGP', ping: server.ping_bd }
    ];

probes.forEach(p => {
  if (p.ping === false || p.ping === undefined) return; // 未配置，不显示
  // 详情历史 / WS 数值仍是扁平字段 ping_${id} / loss_${id}
  const ping = historyRow[`ping_${p.id}`] ?? p.ping;
  const loss = historyRow[`loss_${p.id}`] ?? p.loss;
});
```

未适配主题忽略 `probes` 即可，最多仍显示 8 个。判断一条线路是否启用以 `probes[]` 为准（`host` 非空且不是 `"0"` 的槽位才会出现）；后台把某一行清空后，该槽位的历史数值可能残留到 agent 下一次上报（默认 60 秒一次）之前，**不要按「有数值」把已经删掉的扩展点线路继续画出来**。前 8 槽例外：host 可能来自站点级默认（`probes[]` 里没有），有 `ping_*` 值就该显示。扩展点的显示名必须用 `probes[].name`（本机自定义名优先），不要回退成 `NODE_5` / `node_5`。颜色按数组下标循环 24 色（与内置主题 `PING_SLOT_COLORS` 一致）：`#00d4aa #ffb870 #4da6ff #b392f0 #ff7b72 #79c0ff #7ee787 #ffa657 #d2a8ff #ffa198 #56d4dd #f2cc60 #bc8cff #58a6ff #3fb950 #e3b341 #f85149 #a5d6ff #39d353 #ffc680 #2f81f7 #d29922 #db61a2 #6e7681`。未配置的线路值为 `false` 或缺失，主题应不显示该条。只有后台开启三网详情（`sysConfig.show_three_net_details === true`）时，后端才会从历史库最近 2 小时抽取这些窗口数据；关闭时为节省服务端资源，数组为空。

**示例**：

```js
const res = await fetch('/api/servers', {
  headers: { 'Authorization': 'Bearer ' + token }
});
const { servers, stats, sysConfig } = await res.json();
```

***

### 2.3 获取服务器详情

**Request**

```
GET /api/server?id=<uuid>
Headers: (按需) Authorization, X-Turnstile-Token/Verified
```

**Response**

```json
{
  "id": "9b2c...",
  "name": "HK-01",
  "server_group": "HK",
  "tags": "prod,edge",
  "price": "30.00",
  "billing_cycle": "month",
  "auto_renewal": "0",
  "currency": "¥",
  "expire_date": "2026-12-31",
  "traffic_limit": "1TB",
  "traffic_calc_type": "total",
  "reset_day": 1,
  "report_interval": 60,
  "wss_report_interval": 2,
  "is_hidden": "0",
  "sort_order": 0,
  "cpu": 12.34,
  "load_avg": "0.10 0.20 0.30",
  "net_in_speed": 1024,
  "net_out_speed": 512,
  "net_rx": 12345678,
  "net_tx": 87654321,
  "net_rx_monthly": 1073741824,
  "net_tx_monthly": 536870912,
  "processes": 256,
  "tcp_conn": 32,
  "udp_conn": 4,
  "ping_ct": 23, "ping_cu": 25, "ping_cm": 30, "ping_bd": 40,
  "ping_node_1": 12, "ping_node_2": 18, "ping_node_3": false, "ping_node_4": false,
  "loss_ct": 0, "loss_cu": 0, "loss_cm": 0, "loss_bd": 0,
  "loss_node_1": 0, "loss_node_2": 0, "loss_node_3": false, "loss_node_4": false,
  "ram_total": 8192, "ram_used": 3700,
  "swap_total": 2048, "swap_used": 100,
  "disk_total": 102400, "disk_used": 32000,
  "disk": {
    "read_bps": 4096,
    "write_bps": 2048,
    "read_iops": 12,
    "write_iops": 8,
    "await_ms": 1.5,
    "util": 3.2
  },
  "cpu_cores": 4, "cpu_info": "Intel Xeon",
  "gpu_info": "[{\"id\":\"0\",\"name\":\"NVIDIA RTX 3060\",\"info\":12.5}]",
  "arch": "x86_64", "os": "Ubuntu 22.04",
  "kernel_version": "6.8.0-36-generic",
  "region": "HK",
  "ip_v4": "1", "ip_v6": "1",
  "boot_time": "1700000000000",
  "last_updated": 1737638400000,
  "timestamp": 1737638400000,
  "latestReportUpdates": [
    {
      "serverId": "9b2c...",
      "reportTs": 1737638405000,
      "reportAgeMs": 1200,
      "samples": [
        {
          "ts": 1737638400000,
          "data": {
            "cpu": 12.34,
            "ram_total": 8192,
            "ram_used": 3700,
            "swap_total": 1024,
            "swap_used": 64,
            "net_in_speed": 1024,
            "net_out_speed": 512
          }
        }
      ]
    }
  ],
  "sysConfig": { "long_history_points": 120 }
}
```

`tags` 为英文逗号分隔字符串。后台保存时按英文逗号切分 → 每个标签剔除字母/数字/空格/`._-` 以外的字符 → 单个 ≤32 字符 → 最多 12 个，再拼回逗号串。主题不要依赖颜色标记（如 `标签<red>`）或分号分隔——后端会清成纯文本。`note`、`bandwidth`、`auto_update`、`traffic_snapshots` 属于管理端内部字段，不从 dashboard 公共接口返回。`disk` 为可选磁盘 IO 指标对象：`read_bps` / `write_bps` 单位为 B/s，`read_iops` / `write_iops` 为 IOPS，`await_ms` 为毫秒，`util` 为百分比；旧探针、旧数据缺失，或者 6 个子字段全为 0 时，API / WebSocket 不返回该对象，主题不应展示依赖磁盘 IO 的图表。`latestReportUpdates` 与 `/api/servers` 同名字段形状一致，REST 样本统一为 `{ ts, data }` 并按探针批量采样包透传；内置探针默认只在普通采样点上报 `cpu`、`ram_total`、`ram_used`、`swap_total`、`swap_used`、`net_in_speed`、`net_out_speed`，每次报告最后一个样本可能额外携带 `disk` 等报告级字段；回放状态保留约 5 分钟，允许为空数组。`gpu` 已废弃，主题应使用 `gpu_info`；新版上报和 WebSocket 实时数据为 `[{ id, name, info }]` 数组，历史/详情 REST 响应中可能是同结构的 JSON 字符串。

未登录访客请求详情接口时，同样受 2.2 的「访客字段剥离」影响。

`ping` / `loss` 窗口数组仅在 `/api/servers` 的 `servers[]` 中返回，`/api/server` 详情接口不返回新增窗口数组。主题可从 `/api/config` 的 `latency_window` 读取当前窗口参数。只有后台开启三网详情时才会查询窗口数据；关闭时后端仍返回 `ping: []` / `loss: []`，主题不应展示三网小图。开启后，窗口从历史表最近 2 小时按时间范围抽样，最多 20 个真实样本点；点里前 8 槽为 `{ ct, cu, cm, bd, node_1 … node_4 }`，2.13 起已配置的扩展点（`node_5` … `node_20`）同样带在点里。ProbeDeck 2.13+ 首页 ping 芯片优先读 `servers[].probes`（最多 24，含每台自定义名称）；详情历史 / WS 数值仍是扁平 `ping_${id}` / `loss_${id}`。未适配主题继续读旧 8 字段即可。显示名优先 `probes[].name`，没有再从 `/api/config` 的 `custom_*_name` / `node_*_name` 读。时间间隔目标约 6 分钟，但 `ts` 保留真实上报时间，不会强制对齐为等差序列；历史不足、上报中断或某个时间段无数据时不会用最近点补齐，数组可能少于 20 个。该抽样结果在服务端缓存约 5 分钟。

**失败返回**：

- `400 { "error": "Missing ID" }`
- `404 { "error": "Server not found" }`

**示例**：

```js
const res = await fetch(`/api/server?id=${serverId}`);
const server = await res.json();
```

***

### 2.4 获取历史指标

**Request**

```
GET /api/history/all?id=<uuid>&hours=<number>
Headers: (按需) Authorization: Bearer <jwt>, X-Turnstile-Token/Verified
```

**参数**：

- `id`（必填）：服务器 UUID
- `hours`（可选，默认 `24`）：查询时长，可选 `0.167`（10 分钟）、`0.5`（30 分钟）、`1`、`6`、`12`、`24`、`48`、`96`、`168`（7 天）、`336`（14 天）、`720`（30 天）；**上限固定为 30 天（720 小时）**。不在列表内的值返回 `400 Invalid hours parameter`

**Response**

```json
[
  {
    "timestamp": 1737600000000,
    "cpu": 12.3,
    "gpu_info": "[{\"id\":\"0\",\"name\":\"NVIDIA RTX 3060\",\"info\":12.5}]",
    "ram_used": 3700,
    "disk_read_bps": 4096,
    "disk_write_bps": 2048,
    "disk_read_iops": 12,
    "disk_write_iops": 8,
    "disk_await_ms": 1.5,
    "disk_util": 3.2,
    "disk": {
      "read_bps": 4096,
      "write_bps": 2048,
      "read_iops": 12,
      "write_iops": 8,
      "await_ms": 1.5,
      "util": 3.2
    },
    "kernel_version": "6.8.0-36-generic"
  },
  {
    "timestamp": 1737600600000,
    "cpu": 13.1,
    "gpu_info": "[{\"id\":\"0\",\"name\":\"NVIDIA RTX 3060\",\"info\":13.0}]",
    "ram_used": 3712,
    "disk": {
      "read_bps": 5120,
      "write_bps": 1024,
      "read_iops": 15,
      "write_iops": 4,
      "await_ms": 1.2,
      "util": 2.8
    },
    "kernel_version": "6.8.0-36-generic"
  }
]
```

**注意**：

- **访客（未登录）**：可查询的最大跨度为 `/api/config` 的 `public_history_hours`（面板「访客历史范围」，默认 `24` 小时）。`hours` 超过该值返回 `401`。主题不要写死 24 小时，应读取 `public_history_hours` 动态限制访客可选档位：超出该值的档位置灰 / 隐藏，或点击时提示登录；收到 `401` 时也应回退到允许范围内并提示登录
- **登录用户**：所有档位可用。服务端只返回实际保留范围内的数据，请求跨度超过保留范围时不会报错，只是更早的部分没有数据
- 服务端按后台 `long_history_points` 配置返回采样点，默认 120 个点
- 历史行有磁盘 IO 数据时会返回 `disk` 对象；为兼容历史存储，也可能同时包含 `disk_read_bps`、`disk_write_bps`、`disk_read_iops`、`disk_write_iops`、`disk_await_ms`、`disk_util` 平铺字段。主题只需要读取 `disk`；缺失时不应展示磁盘 IO 图表
- Ping / 丢包为扁平字段 `ping_ct` … `ping_node_20` / `loss_*`；2.13 扩展点数值可能同时出现在 `extra_probes`（JSON 字符串，`{"ping_node_5": 43, "loss_node_5": 0}`）里。两种形态都兜底：`row[`ping_${id}`] ?? JSON.parse(row.extra_probes || `{}`)[`ping_${id}`]`
- 数据库字段缺失且需要升级时可能返回 `409 { "message": "databaseUpgradeRequired" }`

**示例**：

```js
const res = await fetch(`/api/history/all?id=${serverId}&hours=24`);
const rows = await res.json();
```

***

## 3. WebSocket 实时推送

**Request**

```
GET /api/ws?subscribe=<all|serverId>
Headers: Upgrade: websocket, Connection: Upgrade
```

**参数**：

| 参数 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `subscribe` | 否 | `all` | `all` 订阅所有服务器，`<serverId>` 只订阅指定服务器 |
| `token` / `auth_token` / `ws_token` | 否 | - | 非公开站点可用的 JWT 查询参数认证；公开站点不需要 |

**鉴权**：

- 公开站点：无需 JWT。
- 非公开站点：连接 `/api/ws` 必须通过 WebSocket JWT 认证，支持 `Authorization: Bearer <jwt>`、`cfsm_auth=<jwt>`、查询参数 `token` / `auth_token` / `ws_token`。
- 浏览器主题通常不能设置 WebSocket `Authorization` Header；同域部署使用 `cfsm_auth` Cookie，跨域或纯静态主题在 WebSocket URL 上追加 `token=<jwt>`。

**过滤机制**：

- `subscribe=all` + 通道内发送 `subscribe` 消息：仅接收 `ids` 列表中的服务器更新
- `subscribe=all` + 未发送 `subscribe` 消息：**不返回任何更新**
- `subscribe=<serverId>`：始终只接收该服务器更新，不需要发送 `ids`
- `ids` 最多 500 个，每个 ID 长度 1-64，仅允许字母、数字、`.`、`_`、`:`、`-`
- `scope` 或 `ids` 格式非法时服务端会关闭 WebSocket 连接（close code `1008`）
- `ids` 是客户端订阅过滤，不是服务端鉴权

**多 apiBase 注意事项**：

当配置了多个 `apiBase` 时，前端会为每个 apiBase 创建独立的 WebSocket 连接。每个连接发送的 `ids` 应只包含该 apiBase 返回的服务器 ID，而非全部服务器 ID。每个面板实例只知道自己的服务器，传入不属于它的 ID 不会产生任何效果。

**推荐流程（首页/列表页）**：

1. 调用 `GET /api/servers` 获取服务器列表（已按登录状态过滤隐藏服务器）
2. 提取返回的 `servers[].id` 数组
3. 连接 WebSocket：`?subscribe=all`
4. 建连后通过 WebSocket 通道发送 `{ type: "subscribe", scope: "all", ids }`

**推荐流程（详情页）**：

详情页只展示单台服务器时，应使用单服务器接口和单服务器 WebSocket 订阅，以降低后端推送量、前端渲染压力和额度消耗：

- HTTP 初始数据：`GET https://example.com/api/server?id=<id>`
- WebSocket 实时订阅：`wss://example.com/api/ws?subscribe=<id>`

非公开站点同域部署时直接使用 Cookie 认证；跨域或纯静态主题无法依赖同域 Cookie 时，再使用查询参数认证：`wss://example.com/api/ws?subscribe=<id>&token=<jwt>`。

详情页不要使用 `GET https://example.com/api/servers` 拉全量列表，也不要使用 `wss://example.com/api/ws?subscribe=all` 订阅全量更新后再在前端过滤。

**页面可见性建议**：

为实现前端展示效果并节省额度消耗，主题应监听 `document.visibilitychange`，页面进入后台或隐藏时主动关闭 WebSocket，页面重新可见时再按当前页面类型重新连接并恢复订阅。关闭连接后可保留最后一次数据用于静态展示；重新可见时建议先按当前页面补一次 REST 数据，再恢复 WebSocket 实时更新。

主题还应读取 `/api/config` 的 `frontend_ws_timeout_minutes`。值为 `0` 时不按连接时长断开；值为正整数时，应在单次连接达到对应分钟数后主动关闭，并由用户明确选择是否继续连接。继续后应建立新连接并重新开始计时，不应在用户选择关闭后静默重连。

**心跳建议**：主题应每隔 30–60 秒发送 `{ type: "ping", ts: Date.now() }`。服务端会自动回复 `{ type: "pong" }`（不唤醒业务逻辑）。长时间无消息时，中间反代（nginx / Cloudflare）可能掐断空闲连接。

**推送策略**：

| 订阅类型 | 推送方式 | 消息类型 | 说明 |
| -------- | ----- | ----- | --- |
| `subscribe=all` | 批量合并，每 5 秒一次 | `batchUpdate` | 减少消息数量，降低前端渲染压力 |
| `subscribe=<serverId>` | 实时推送 | `batchUpdate` | 单台服务器详情页，低延迟，统一消息格式 |

**消息格式**：

| 类型 | 方向 | 数据结构 |
| --- | --- | --- |
| `hello` | S → C | `{ type: "hello", ts: number, subscribed: string }` |
| `subscribe` | C → S | `{ type: "subscribe", scope: string, ids: string[] }` |
| `subscribed` | S → C | `{ type: "subscribed", ts: number, subscribed: string, count: number }` |
| `ping` | C → S | `{ type: "ping", ts: number }` |
| `pong` | 双向 | `{ type: "pong", ts: number }` |
| `error` | S → C | `{ type: "error", ts: number, error: string, code: number }` |
| `batchUpdate` | S → C | `{ type: "batchUpdate", ts: number, updates: Array<{serverId, samples: Array<{ts, data?: Partial<Server>, payload?: Partial<Server>, metrics?: Partial<Server>}>}> }` |

订阅参数非法（如 `ids` 格式错误）时，服务端会**先发一条 `error` 再关闭连接**（close code `1008`）——主题把 `msg.error` 打出来即可定位原因。服务端还可能发出 `ack` / `config` 消息，那是**探针（Agent）连接**的上报应答与配置下发，主题连接不会收到，忽略即可。

`batchUpdate.samples[]` 的指标对象可能出现在 `data`、`payload` 或 `metrics` 中，主题应按 `sample.data || sample.payload || sample.metrics` 读取。Ping / 丢包数值为扁平字段 `ping_ct` … `ping_node_20` / `loss_*`（2.13+ 扩展点同样推送；扩展点值可能是字符串数字如 `"49"`，按数字解析要容错；未配置槽为 `false`，超时为 `null`）。该对象是增量字段：批次内的高频采样点主要包含 CPU、内存、Swap、网速和时间字段；每次上报的最后一个样本会额外携带本次完整报告状态，用于同步磁盘容量、磁盘 IO、GPU、进程、连接数、探针、Ping/丢包等报告级数据。`disk` 缺失、格式无效或所有子字段全为 0 时，WebSocket 样本不会携带 `disk`。

**示例（subscribe=all，带 ID 过滤）**：

```js
// 1. 获取服务器列表
const { servers } = await (await fetch('/api/servers')).json();
const ids = servers.map(s => s.id);

// 2. 连接 WebSocket，并通过通道消息提交订阅 ID 列表
const url = new URL('wss://status.example.com/api/ws');
url.searchParams.set('subscribe', 'all');
const sameHost = url.host === location.host;
if (!sameHost) {
  const token = localStorage.getItem('jwt_token');
  if (token) url.searchParams.set('token', token);
}
const ws = new WebSocket(url.toString());
ws.onopen = () => {
  ws.send(JSON.stringify({ type: 'subscribe', scope: 'all', ids }));
};
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.type === 'batchUpdate') {
    for (const u of msg.updates) {
      for (const s of u.samples || []) {
        updateServer(u.serverId, s.data || s.payload || s.metrics || {});
      }
    }
  }
};
```

**示例（subscribe=serverId，实时推送）**：

```js
const url = new URL('wss://status.example.com/api/ws');
url.searchParams.set('subscribe', 'server-001');
const sameHost = url.host === location.host;
if (!sameHost) {
  const token = localStorage.getItem('jwt_token');
  if (token) url.searchParams.set('token', token);
}
const ws = new WebSocket(url.toString());
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.type === 'batchUpdate') {
    for (const u of msg.updates) {
      for (const s of u.samples) {
        updateServer(u.serverId, s.data || s.payload || s.metrics || {});
      }
    }
  }
};
```

***

## 4. 错误处理

### 统一响应格式

**成功响应**：

成功响应直接返回业务对象或数组，具体结构见各接口；没有统一的 `success: true` 包装字段。

**错误响应**：

```json
{ "error": "human readable message", "code": 400 }
```

### 错误码速查表

| code | 含义             | 处理建议                 |
| ---- | -------------- | -------------------- |
| 400  | 参数错误           | 检查参数格式和必填项           |
| 401  | 未授权            | 非公开站点未登录，或访客请求超过 `public_history_hours` 的历史；重新登录或检查 JWT |
| 403  | Turnstile 验证失败 | 重新获取 Turnstile token |
| 404  | 资源不存在          | 检查服务器 ID             |
| 409  | 数据库需升级        | 提示管理员执行数据库升级      |
| 500  | 服务器内部错误        | 联系管理员                |
| 503  | WebSocket 不可用  | 降级为轮询                |

常见 `400` 错误字符串：

- `invalidThemeOptionsFormat`：`theme_options` 不是非数组对象
- `Invalid hours parameter`：`hours` 不在允许列表内（见 2.4）

***

## 5. 类型定义

```typescript
interface DiskIoMetrics {
  read_bps: number;   // B/s
  write_bps: number;  // B/s
  read_iops: number;
  write_iops: number;
  await_ms: number;
  util: number;       // %
}

interface LatencyWindowPoint {
  ts: number;
  ct?: number | null | false;
  cu?: number | null | false;
  cm?: number | null | false;
  bd?: number | null | false;
  node_1?: number | null | false;
  node_2?: number | null | false;
  node_3?: number | null | false;
  node_4?: number | null | false;
  [key: `node_${number}`]?: number | null | false; // ProbeDeck 2.13+ 第 9–24 条，未适配主题可忽略
}

interface Probe {
  id: string;          // ct / cu / cm / bd / node_1 … node_20
  name: string;        // 该服务器最终显示名（本机覆盖优先，空则站点默认）
  host: string;        // 该机配置的探测地址；"0"=显式禁用；空串=该机未单独配置（前 8 槽此时可能继承站点级默认地址）
  ping: number | null | false;
  loss: number | null | false;
}

> **哪些槽位算「启用」，只看 `probes[]`**：只有 `host` 非空且不是 `"0"` 的槽位才会出现在 `probes[]` 里，所以 `probes[]` 是「这条线路在这台机器上是否启用」的唯一权威来源。`servers[]` 上同时保留原始 host 字段（`custom_ct` … `custom_bd`、`node_1` … `node_20`）：空串 = 该机未单独配置（前 8 槽此时可能继承站点级默认地址，公开接口看不到真实 host，只能靠有没有 `ping_*` 值判断），`"0"` = 显式禁用（不探测、也不该显示）。

interface Server {
  id: string;
  name: string;
  server_group: string;
  tags: string; // 英文逗号分隔；后台清洗后纯文本，单个 ≤32 字符、最多 12 个
  price: string; // "0" 或 "-1" 表示免费，空白表示未设置
  billing_cycle: string;
  auto_renewal: string;
  currency: string;
  expire_date: string;
  traffic_limit: string;
  traffic_calc_type: string;
  reset_day: number;
  report_interval: number;
  wss_report_interval: number;
  is_hidden: '0' | '1';
  sort_order: number;
  cpu: number;
  load_avg: string;
  net_in_speed: number;
  net_out_speed: number;
  net_rx: number;
  net_tx: number;
  net_rx_monthly: number;
  net_tx_monthly: number;
  processes: number;
  tcp_conn: number;
  udp_conn: number;
  ping_ct: number | null | false;
  ping_cu: number | null | false;
  ping_cm: number | null | false;
  ping_bd: number | null | false;
  ping_node_1: number | null | false;
  ping_node_2: number | null | false;
  ping_node_3: number | null | false;
  ping_node_4: number | null | false;
  loss_ct: number | null | false;
  loss_cu: number | null | false;
  loss_cm: number | null | false;
  loss_bd: number | null | false;
  loss_node_1: number | null | false;
  loss_node_2: number | null | false;
  loss_node_3: number | null | false;
  loss_node_4: number | null | false;
  // ProbeDeck 2.13+：每台服务器解析后的显示名（本机自定义名优先，空则站点默认）。旧版本不返回，主题必须兜底。
  custom_ct_name?: string;
  custom_cu_name?: string;
  custom_cm_name?: string;
  custom_bd_name?: string;
  node_1_name?: string;
  node_2_name?: string;
  node_3_name?: string;
  node_4_name?: string;
  [key: `node_${number}_name`]?: string; // node_5_name … node_20_name（扩展点，2.13+）
  probes?: Probe[]; // ProbeDeck 2.13+：本机启用的探测点（最多 24）。外部 CF 主题可忽略，继续读 ping_ct…ping_node_4
  ping?: LatencyWindowPoint[]; // 仅 /api/servers 的列表项返回；三网详情关闭时为空数组
  loss?: LatencyWindowPoint[]; // 仅 /api/servers 的列表项返回；三网详情关闭时为空数组
  ram_total: number;
  ram_used: number;
  swap_total: number;
  swap_used: number;
  disk_total: number;
  disk_used: number;
  disk?: DiskIoMetrics; // 磁盘 IO；旧数据可能缺失
  cpu_cores: number;
  cpu_info: string;
  gpu_info: Array<{ id: string; name: string; info: number | null }> | string;
  arch: string;
  os: string;
  kernel_version: string;
  region: string;
  ip_v4: '0' | '1'; // 公共 REST 接口仅返回 IPv4 可达性
  ip_v6: '0' | '1'; // 公共 REST 接口仅返回 IPv6 可达性
  boot_time: string;
  agent_version?: string;
  last_updated: number;
  timestamp: number;
  sysConfig?: SysConfig;
}

interface HistoryMetricRow extends Partial<Server> {
  timestamp: number;
  disk_read_bps?: number;
  disk_write_bps?: number;
  disk_read_iops?: number;
  disk_write_iops?: number;
  disk_await_ms?: number;
  disk_util?: number;
  disk?: DiskIoMetrics;
}

interface SysConfig {
  show_price?: boolean;
  show_expire?: boolean;
  show_tf?: boolean;
  show_three_net_details?: boolean;
  custom_ct_name?: string;
  custom_cu_name?: string;
  custom_cm_name?: string;
  custom_bd_name?: string;
  display_mode?: string;
  long_history_points?: number;
  latency_window?: { points: number; hours: number };
}

interface SiteConfig {
  version: string;
  last_workers_version?: string | null;
  last_agent_version?: string | null;
  is_public: boolean;
  authorization: boolean;
  turnstile_enabled: boolean;
  turnstile_login_enabled: boolean;
  turnstile_site_key: string;
  custom_ct_name: string;
  custom_cu_name: string;
  custom_cm_name: string;
  custom_bd_name: string;
  node_1_name: string;
  node_2_name: string;
  node_3_name: string;
  node_4_name: string;
  site_title: string;
  display_mode: string;
  preferred_theme: string;
  default_language: string;
  theme_options: Record<string, unknown>;
  verified: boolean;
  turnstile_verified: string | null;
  frontend_ws_timeout_minutes: number;
  long_history_points: number;
  online_threshold_seconds: number;
  public_history_hours: number;
  latency_window: { points: number; hours: number };
}

interface LatestReportUpdate {
  serverId: string;
  reportTs: number;
  reportAgeMs?: number;
  samples: Array<{ ts: number; data: Partial<Server> }>;
}

interface ServersResponse {
  servers: Server[];
  latestReportUpdates: LatestReportUpdate[];
  stats: {
    total: number;
    online: number;
    offline: number;
    globalSpeedIn: number;
    globalSpeedOut: number;
    globalNetTx: number;
    globalNetRx: number;
  };
  regionStats: Record<string, number>;
  sysConfig: SysConfig;
}

interface ThemeOptionsSaveResponse {
  success: true;
  theme_options: Record<string, unknown>;
  message: 'updateSuccess';
}

interface WsMessage {
  type: 'hello' | 'subscribe' | 'subscribed' | 'ping' | 'pong' | 'batchUpdate';
  ts?: number;
  subscribed?: string;
  scope?: string;
  ids?: string[];
  count?: number;
  serverId?: string;
  updates?: Array<{
    serverId: string;
    samples: Array<{
      ts: number;
      data?: Partial<Server>;
      payload?: Partial<Server>;
      metrics?: Partial<Server>;
    }>;
  }>;
}
```

延时与丢包字段的展示约定：`false`（或 REST/历史字段缺失时归一化的 `false`）表示节点未配置/未上报/未取样，前端应不显示；`null` 表示该轮明确探测超时/未取到有效 RTT，详情页可显示为 “Timeout/超时”，不应把 `null` 当“无数据”从指标区和图表图例中隐藏。数值 `0`（包括 `0%` 丢包）是有效数据，必须正常显示。自定义节点显示名：2.13+ 直接读 `servers[]` 对象上的 `custom_*_name` / `node_*_name`（含 `node_5_name` … `node_20_name`，本机自定义名优先、空则站点默认）；站点级 `/api/config` 只有前 8 槽名字（`node_1_name` 至 `node_4_name`，未配置时为 `Node 1` … `Node 4`）。

***

***

## 6. 常见问题

**页面白屏 / 资源 404**

面板只服务当前启用主题的 `index.html` 和 `/assets/*`。资源必须放在 `assets/` 下，路径用 `/assets/...` 或相对 `assets/...`。主题链接要指向**存放构建产物的分支**——`tree/` 后面是**分支名**（如 `tree/build`、`tree/dist`，这里的 `build` / `dist` 是分支名，不是文件夹路径）；面板按 `raw.githubusercontent.com/<owner>/<repo>/<分支名>/index.html` 直接读取，**产物必须在分支根目录**。指到源码分支会拿到 Vite 开发模板。

**改了主题为什么不生效**

见 [0.5](#05-更新主题后如何生效)。先确认 GitHub raw 已是新文件，再查面板缓存 / Cloudflare 边缘缓存 / 浏览器硬刷新。

**访客看不到长历史**

未登录用户受 `/api/config` 的 `public_history_hours` 限制，超出返回 401。档位置灰 / 隐藏，或提示登录；不要写死 24 小时。

**详情页不要拉全量列表**

详情页用 `GET /api/server?id=<id>` + `wss://…/api/ws?subscribe=<id>`。不要先拉 `/api/servers` 再前端过滤。

***

## 7. 附：踩坑记录与自查清单（移植适配）

> **这一节是「踩坑记录」，不是必读规则**——全新开发主题只需要看 0–6 节。
>
> 如果你是在已有主题的基础上移植 / 改造（包括从 CF-Server-Monitor 原版主题、其他监控面板的主题搬过来的情况），按这份清单逐条自查可以省掉大部分返工：下面每条都是把第三方主题接到 ProbeDeck 上时实际踩过的坑，写清了症状和正确做法。

### 7.1 数据与名字

1. **前 8 槽用并集，扩展槽只认 `probes[]`。** 两条相反的坑要同时避开：
   - 不能写成「有 `probes` 就全用 `probes`」——真实部署里前 8 槽可以「有数值、没 host」（host 来自站点级默认，公开接口看不到），只看 `probes[]` 会丢掉前 8 槽。
   - 也不能写成「有 `ping_*` / `loss_*` 值就收」——扩展槽（`node_5` … `node_20`）的 host 被清空（后台删掉那一行）后，历史数值还会残留一小段时间（agent 下一次上报前，默认 60 秒一次），按「有值就收」会把已经删掉的线路继续画出来，等数据被清掉又自己消失。

   正确做法按槽位分开：**前 8 槽**（`ct`/`cu`/`cm`/`bd`/`node_1..4`）在 `probes[]` 里有**或**有 `ping_*` / `loss_*` 值就收（`false` 除外，host 为 `"0"` 的不画）；**扩展槽**（`node_5` … `node_20`）**只认 `probes[]`**——不在 `probes[]` 里就当作未配置，即使还有残留数值也不画。
2. **名字逐级回退。** `probes[].name`（本机自定义名，优先）→ 服务器对象的 `custom_*_name` / `node_*_name`（2.13+ 含扩展点）→ 站点级 `/api/config` 的 `custom_*_name` / `node_1..4_name` → `Node N` 兜底。只读站点 config 会让扩展点显示 `node_5` 这类裸 id 或空白。
3. **「按节点展示」的位置用该服务器自己的名字。** 首页卡片线路名、切换线路弹窗等要读 `servers[]` 对象上的 `node_*_name`（含扩展点）；站点名字表没有扩展点，否则卡片显示空白 / `Node N`。
4. **图例、颜色、图表 series 都要覆盖到 24 槽（三个不同的漏法）。** ① **键要对齐**：有的主题内部把 `ping_ct` 记成 `pingCt`、扩展点是 `ping_node_5`——图例按前者生成、数据按后者读取，症状是「图上有线、图例缺项」或反之。② **颜色表要扩到 24 个**：主题自带写死的 8 色表时，扩展点取不到颜色，症状是「名字对了、但那条线没颜色 / 颜色重复」——按第 4 节的 24 色表按下标循环。③ **图表 series 也要按并集生成**：series 只按旧 8 字段建时，扩展点在详情图里根本没有线（症状是「名字对了、图表缺」）——series、图例、颜色三者都按「前 8 槽 ∪ `probes[]`」的同一份列表生成，才不会再漏。
5. **数字 id 与字符串 id 要映射。** 内部任务 id 常是 1..N，而 `probes[].id` 是 `ct` / `node_1`；名字查找要做 `1→ct`、`5→node_1`、`9→node_5` 的映射，否则图例停在 `Node N`。
6. **任务 id 用固定槽位编号，不要按可见数量顺序重排。** 顺序编号会随可见槽位数量漂移（同一探测点在不同时间范围 id 不同），导致隐藏状态错位、图例与数据错配。固定映射：`ct=1, cu=2, cm=3, bd=4, node_1=5 … node_20=24`。
7. **历史行扩展点数值有两种形态**：扁平 `ping_node_5` 字段（新构建）或只在 `extra_probes` JSON（旧构建）。两种都兜底读取。
8. **实时 WS 样本是扁平字段、不带名字**：`ping_node_5` 可能是字符串数字（`"49"`），未配置槽是 `false`。不要拿 WS 样本对象当 server 对象去解析名字——这是「一有实时数据名字就变回 node_5」的经典原因；合并实时数据时要保留原 server 对象上的名字 / `probes` 字段。
9. **压缩产物的短名会重名**（`function ji` 可能既是 fetch helper 又是别的函数），定位代码要用唯一长串（如完整 URL 字符串），不要拿短名全库 grep。

### 7.2 实现与构建

10. **别写冻结对象。** 在 `Object.freeze({ct,cu,cm,bd,node_1..4})` 上加 `node_5` 会抛 `Cannot add property node_5, object is not extensible`，整页加载失败。标签表用拷贝。
11. **静态任务表（模块加载时求值的默认名）要扩到 24 槽**，且名字要能在运行时被覆盖：union 非空就用 union；静态项标记后名字优先取运行时名字表。
12. **内部模型要保留原始 server 对象。** 列表 fetch 后把 raw server（带名字 / `probes`）缓存起来（如挂 `window.__pdXxxRaw[id]`），因为详情图 / 任务构建函数拿到的往往只是 uuid 字符串，store 里归一化后的对象没有 `probes`。
13. **helper 插到压缩产物文件头**，不要插进逗号表达式中间（`},me=[...]` 前插 `function` 会 SyntaxError）；改完 `node --check`（ESM 拷成 `.mjs`）。
14. **实时管线 / 静态任务表可能有多份副本**（同一主题两套 Instance chunk、不同 chunk 各有一份 helper），都要改；改前用浏览器 performance 里实际加载的 chunk 确认哪份在跑。
15. **隐藏集合的剪枝要防空。** 切时间范围时任务列表会瞬态为空，`useEffect` 剪枝逻辑会把「已隐藏」集合清空（症状：切范围后隐藏的端点又出现）。空列表时直接 return。

### 7.3 验证与缓存

16. **必须模拟实时 WS 推送**，只喂历史数据测不出实时路径的 bug（名字覆盖、管线漏槽都是这样漏掉的）。
17. **主题资源有浏览器缓存**：分支引用 1 小时、固定 commit 为 `immutable`（见 [0.5](#05-更新主题后如何生效)），改完强刷（Ctrl+Shift+R）再验；排查「传了没变化」先 `curl` 部署地址比 hash，再查面板内存缓存 / CF 边缘缓存。
18. **详情页截图注意双图表容器**：负载图与 Ping 图两套 DOM，隐藏的那套宽度为 0，滚动 / 截图选错会误判「图表没画」。

### 7.4 从 CF-Server-Monitor 原版主题搬过来时的差异

> 为原版（CF Workers 版）写的主题接到 ProbeDeck 上**不会少数据**（公开 API 是上游超集），但下面 4 处会表现出差异，移植时逐条确认：

1. **历史范围**：原版上限 168 小时（请求 336 / 720 直接 400），访客写死「超过 24 小时要登录」；ProbeDeck 支持到 720 小时，访客范围由面板设置 `public_history_hours` 决定。原版主题的时间档位写死在产物里（通常只到 7 天），要支持 14 / 30 天必须改档位表。
2. **在线判定**：原版硬编码 300 秒；ProbeDeck 由面板设置（`/api/config` 的 `online_threshold_seconds`，默认 300、可调 60–3600）——主题写死的话，页面上的在线状态可能与面板不一致。
3. **访客字段**：原版只在前端隐藏价格 / 到期 / 流量，接口照发；ProbeDeck 在后台关闭对应开关时**服务端直接剥离字段**（字段可能整个不存在）——主题必须兼容缺失，不能假设它一定在。
4. **`/api/config` 字段**：原版有 `github_oauth_enabled`（ProbeDeck 没有）；ProbeDeck 多出 `online_threshold_seconds`、`public_history_hours`（原版主题忽略即可）。其余接口、WebSocket 消息、鉴权方式与上游完全一致。
