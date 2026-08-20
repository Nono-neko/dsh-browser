# DSH 内置浏览器
  
[English](README.md) | 中文

> DSH Web GUI 的内置浏览器：在聊天界面里浏览网页与工作区文件——多标签、地址栏、
> 标签页按工作区持久化——并提供 agent 工具（`browser_open`、`browser_read`）。

DeepSeek Harness（DSH）的外部插件包，单包双半区 cordis bundle：host 半区拥有
agent 工具、`/api/dsh-browser` 路由族（SSE 打开事件流 + 工作区文件列表/读取）、
设置命名空间与系统提示词公告；browser 半区渲染侧边栏入口、多标签面板与插件设置
卡。热插拔挂载——`dsh plugin --profile <name> add link:<repo>`，不改 DSH 源码。

## 功能

- **入口**：侧边栏「浏览器」一行，位于新建会话按钮下方。
- **面板**：接管中心列，包含标签栏、工具栏（后退 / 前进 / 刷新 / 主页 /
  在系统浏览器中打开）、地址栏（网址或搜索词，回车打开）与 iframe 内容区。
  非活动标签保持挂载、状态不丢；iframe 首次激活时才加载，避免恢复大量标签
  时一次性发请求。
- **按工作区持久化**：标签集按项目根目录存入 localStorage（防抖写入 +
  页面隐藏时冲刷）。切换会话即切换整个标签集，切回自动恢复。可配置上限
  （默认 10），超出丢弃最旧的未激活标签。
- **工作区浏览**：新标签页列出当前工作区目录（文件夹可进入、面包屑导航、
  上一级按钮）；点击文件经宿主文件路由在面板中打开。HTML 预览注入 `<base>`
  使相对图片/样式可解析，并以 CSP `sandbox` 头保证被预览文件绝不能在 GUI
  源中执行脚本。
- **agent 工具**：`browser_open` 把网页推送到面板（新开标签并聚焦面板）；
  `browser_read` 由宿主抓取网页并返回可读正文文本（静态 HTML 近似提取，
  不执行 JS）。
- **设置卡**：官方设置页「插件」区新增「内置浏览器」卡片（启用开关、agent
  播报、主页地址、标签上限、内网访问开关），编辑暂存、保存/放弃、继承/恢复
  默认语义齐全。
- **agent 公告**：系统提示词段落向每个 agent 说明本插件、工具与限制（与
  dsh-ssh 同一机制）。

## 安装

```sh
# 本地 checkout（开发模式）
dsh plugin --profile <name> add link:<repo>

# npm（发布后）
dsh plugin --profile <name> add @nono-neko/dsh-browser
```

重启 `dsh web` 后侧边栏出现入口。web profile 需具备 bundle 注入的
`@deepseek-ai/*` 客户端包（任何 rc.6 web 部署都自带）。

## 开发

```sh
pnpm install    # @deepseek-ai/* SDK 包已在 npm 公开（或走镜像）
pnpm build      # tsc 出类型 + tsdown 产出双半区（lib/index.js + lib/client.js）
pnpm typecheck  # tsc --noEmit
pnpm test       # vitest
```

一份配置产出两个产物：node 半区 `lib/index.js`（esm）与 browser 半区
`lib/client.js`（`window.__ModuleLoader__` 闭包工厂，经
`/plugins/dsh-browser/client.js` 提供给 GUI）。CSS Modules 由 lightningcss
编译进 client bundle；client bundle 带纯度门——`@deepseek-ai/*` 的值导入仅
允许平台种子模块，其余必须内联或经 cordis 服务协作。

## 安全模型

- **Loopback 围栏**：所有 `/api/dsh-browser` 路由（含 SSE）拒绝非 loopback
  客户端（套接字地址 + Host 头 + 同源标记）。LAN 暴露的 dsh web 无法向未
  配对设备提供工作区文件或事件流。
- **工作区门禁**：文件列表与读取先对请求根做 realpath 规范化并要求其为已
  注册工作区（或位于其内）；每个请求路径解析后再次校验，符号链接无法逃逸。
- **预览 HTML 沙箱**：预览 HTML 以 `Content-Security-Policy: sandbox` 头提供
  ——脚本绝不在持有会话 loopback API 权限的 GUI 源中执行。
- **browser_read 的 SSRF 防线**：请求发出前先经 DNS 解析目标主机名，每个
  地址都必须是公网地址（内网/回环/链路本地/保留段一律拒绝）。重定向逐跳
  手动跟随并复检，公网 URL 跳转到内网地址无法绕过。设置中的
  `allowPrivateAccess` 是显式豁免，风险自负。
- **大小与超时上限**：响应体超过 2 MB 在读入前即报错；超过 64 MB 的工作区
  文件拒绝提供；每次抓取 15 秒超时。

## 限制

- 面板以 iframe 嵌入网页：发送 `X-Frame-Options` / CSP `frame-ancestors`
  的站点拒绝加载。这类站点仍可用起始页、地址栏与 `browser_read`。
- 后退/前进只覆盖地址栏发起的导航；跨源 iframe 内的页面内点击对面板不可见
  （父页面无法读取 iframe 的 location）。
- `browser_read` 只能看到静态 HTML：JS 渲染的页面拿不到客户端渲染内容，
  也无法使用你的登录态。
- 浏览会消耗真实网络流量。

## 许可证

Apache-2.0
