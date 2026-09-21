# dsh-image-inline

**Upstream:** vendored from
[condaThinker/dsh-image-inline](https://github.com/condaThinker/dsh-image-inline)
(MIT). Reviewed 2026-09-16 against DSH `0.1.1-rc.2`. Chosen over the other
community image plugins (dsh-show-image, dsh-inline-images, dsh-vision) because
it is the one that gives the model a `show_image` tool whose result renders an
image **inline in the web chat flow** — the image bytes never enter model
context, so text-only routes are unaffected. Zero build step: the browser half
is a `window.__ModuleLoader__.load` script served by the host's client-modules
service, and the host half registers the tool + two loopback image routes.

## English summary

`show_image(path)` → the host validates (extension, regular file, byte/pixel
caps), commits the bytes through the DSH attachment service, and returns
**text only** (path + metadata). The browser half registers
`tool.call.toolview` keyed slots for both `show_image` and the built-in
`read_image`. Each call renders a compact preview row at its own position in
the conversation. The browser does not request or decode the picture until the
person clicks **Load preview**; this browser-local toggle never adds another
model message or interrupts generation. Once loaded, the picture links to the
original and can be retried after a load failure. The plugin deliberately does
not replace the global single-occupant
details slot. Image bytes are
served through the plugin's own content-addressed route
(`GET /plugin/show-image/<sha256:id>`), with a path-addressed fallback route
(`GET /plugin/show-image-by-path?path=<abs>`) for nested `run_code` dispatches,
pre-meta log replays, and `read_image` results. The ref registry lives at
`$DSH_HOME/plugins/dsh-image-inline/registry.json`.

---

让 DeepSeek Harness (DSH) 的 Web UI 支持**模型主动把一张图片渲染进对话流**（QQ/微信聊天式：图片显示在会话里、可上翻、和对话同步）。

对话流消息内容里**只保留路径文本**，图片本身**不进入模型上下文**（模型上下文保持干净，纯文本模型路由不受影响）。

## 工作方式

模型调用新增的 `show_image` 工具（传入磁盘图片路径）时：

1. **host**（`dsh/index.js`）：校验路径/格式/大小 → 读取字节 → 通过附件服务 `saveImage` 存成内容寻址附件 → 返回**纯文本**结果（路径 + 元数据摘要）。图片的展示载荷（attachmentId/宽高/字节数）通过工具的 `presentationMeta` 放进 `tool/result` 事件的 `meta` 字段——**不进模型上下文、不进会话日志的 image 块**。
2. **client**（`dsh/client.js`）：注册 `tool.call.toolview` 键控槽位（key = `show_image`），在对话流中该工具调用的位置渲染图片卡片（复用官方 `MessageImage` 组件：缩略图、点击看原图、加载失败可重试）。图片 URL 走插件自己的内容寻址 HTTP 端点。

```
模型 → show_image(path) → 附件服务存图 → 纯文本结果（路径+摘要）
                                   │
                                   ├─ tool/result meta ─→ client toolview 渲染图片卡片
                                   └─ 注册表（$DSH_HOME/plugins/dsh-image-inline/registry.json）
                                        └─ GET /plugin/show-image/<attachmentId> → 图片字节
```

### 嵌套调用（run_code 内 `tools.show_image`）与旧回放

模型把 `show_image` 写进 `run_code` 的 JS 里（"Show key figures to user" 这类批量展示）时，调用变成**嵌套 code-dispatch**：宿主工具注册表只对顶层执行投影 `presentationMeta`，`tool/code-dispatch` 事件只携带文本结果、没有 attachmentId——客户端无法走内容寻址路由。

处理方式：**client 在 meta 缺失时解析结果文本里的 `<path>`，改走路径寻址路由** `GET /plugin/show-image-by-path?path=<绝对路径>`（host 按扩展名/regular file/字节上限校验后回字节，路径来自模型已写入会话的文本，同 loopback 信任模型）。因此嵌套调用与旧 schema 回放都能渲染图片；文件不存在/格式不对时 `onError` 自动退回原文本结果。`tool/result` 事件带 meta 的顶层调用不受影响，仍走内容寻址路由。

### read_image 对话卡片

浏览器半部分在官方 `tool.call.toolview` **键控槽位**下同时注册
`key = read_image`。已结算的调用直接在原工具调用位置显示图片；路径取调用参数
`file_path` 或结果文本里的 `<path>`，相对路径按会话 cwd 解析。点击卡片标题仍会
打开 DSH 内置 IN/OUT 详情面板查看原始内容。错误结果只显示错误文本，运行中的调
用显示紧凑占位；文件删除、格式不符或超限时显示加载失败提示。

这个实现不再替换 `conversation.details.tool` 单占用者槽位，因此不会和 DSH 内置
详情 renderer 竞争，也不会因为其它工具的详情渲染异常而整页退回原始文本。

### 为什么需要插件自己的 HTTP 端点？

DSH 内置的 `conversation.resolveImage` → `session.attachment` RPC 只服务"会话日志的 image 块里被引用的附件"（`api-proxy` 的 `referencedImage` 授权）。本插件的结果**故意不包含 image 块**（否则图片会进入模型上下文），因此附件永远不会被日志引用，必须由插件自己提供读取通道。

安全性：attachmentId 是 `sha256:<hex>` 内容哈希——**内容寻址 capability URL**，不知道图片内容就无法猜测；id 只出现在用户可读的会话日志与插件注册表中。服务默认绑定 loopback，与整个 Web UI 同一信任模型。

## 安装

Upstream install (from GitHub):

```bash
npx -p @deepseek-ai/dsh dsh plugin --profile web add github:condaThinker/dsh-image-inline
sudo systemctl restart dsh   # 或按你的方式重启 web profile
```

This box (llmhub): install from the vendored source with the G: path
(a user-profile path breaks under dsh's `shell:true` pnpm spawn):

```powershell
dsh plugin --profile web add G:\llmhub\integrations\dsh\dsh-image-inline
```

Unlike the other out-of-tree plugins here, this package declares
`dsh.bundle.patch`, so `dsh plugin add` reconciles it straight into
`dsh.profile.bundles` and its own `cordis.patch.yml` row is composed
automatically — no manual `- insert:` in the profile patch layer.
Verify with `dsh --profile web --dump-config | findstr image-inline`, then
restart `dsh web` (plugins load at process start; boot log shows the
`show_image` tool registration and the two `/plugin/show-image*` routes).

> 本插件零构建（纯 JS），GitHub 直接分发源码，安装时无需执行任何构建脚本。

卸载：

```bash
npx -p @deepseek-ai/dsh dsh plugin --profile web remove dsh-image-inline
sudo systemctl restart dsh
```

## 配置

`cordis.patch.yml` 中的 `config`（可覆盖）：

| 键 | 默认 | 说明 |
|---|---|---|
| `maxImageBytes` | `26214400` (25MiB) | 单张图片编码字节上限（实际生效值 = min(本配置, 附件服务配置)） |
| `maxImagePixels` | `40000000` (40MP) | 宽×高上限；`0` 关闭该检查 |
| `mediaTypes` | png/jpeg/webp/gif | 接受的格式白名单 |

## 使用

在会话中让模型显示一张图片，例如：

> 用 show_image 显示 /path/to/your/image.png

模型调用后，对话流里该工具调用处会出现图片卡片（缩略图，点击看原图），可上翻查看历史。若图片不存在/格式不支持/超限，卡片显示错误文案，会话不中断。

## 测试

```bash
cd dsh-image-inline
node --test tests/client.spec.mjs tests/host.spec.mjs   # 48 个用例（含 ReadImageCard 渲染覆盖）
```

client 渲染用例按以下顺序解析 react/react-dom：`DSH_HARNESS_NODE_MODULES` 环境变量指向的目录（需装有 react@18 + react-dom@18），或本仓库 `npm install` 后的本地 `node_modules`。找不到时该套件自动跳过并提示，host 用例不受影响。

## 已知限制

- **像素超限孤儿附件**：`saveImage` 先落盘后检查 `maxImagePixels`——若插件配置比部署默认（40MP）更严，超限图片会留下一个无引用的附件对象（内容寻址、无害）。
- **注册表单调增长**：每张展示的图在 `$DSH_HOME/plugins/dsh-image-inline/registry.json` 留一条记录（约 200 字节/条）。
- **无构建步骤**：host/client 均为纯 JS（modlens 同款零构建协议），`link:` 安装下改代码即生效，但**新增/修改 bundle 行需重启 profile**（HMR 覆盖不了 bundle 图变化）。
- 模型上下文纯净是设计目标：`show_image` 的结果永远是文本，图片只通过 `meta` + HTTP 端点到达浏览器。

## 开发者笔记（事故复盘）

- client bundle 必须遵循惰性 CJS 协议：`window.__ModuleLoader__.load({id, factory: (require) => {...; return module.exports}})`——`require` 是 factory 的注入参数，写成自由变量会在浏览器抛 `require is not defined`。
- host 注入服务只能通过注入作用域访问：`ctx.inject(['webServer'], (scope) => scope.webServer.register(...))`，在外层 ctx 上属性访问会抛 `cannot get property "webServer" without inject`。
- 注册表写入已串行化（进程内 promise 队列），并行 `show_image` 调用不会丢条目。
- `conversation.details.tool` 是 `single` 槽位（只有一个占用者）。不要用它为
  单个工具追加视图：新版 DSH 已有内置占用者，替换它会影响所有工具，而且插件
  runner 可能重写 priority。按工具名渲染必须走键控的 `tool.call.toolview`
  （本插件注册 `show_image` 和 `read_image` 两个 key）。
- 注册声明 `locale` 时组件会收到命名空间绑定的 `t`（locale 面未安装则
  渲染期抛 SlotAssemblyError——本 profile 已装）。
