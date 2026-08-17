# dsh-browser — 仓库规则

DSH Web GUI 的内置浏览器插件（单包独立仓库）。开发模式模仿 dsh-web-ui 全家桶
（https://github.com/zhu1090093659/dsh-web-ui）的单包形态：独立 cordis bundle，
经 `cordis.patch.yml` + profile 挂载，绝不修改 DSH 源码。

## 包形态

- **双半区**：`src/index.ts` 是 host 半区（dsh host 进程：agent 工具、路由、
  设置命名空间、系统提示词公告）；`src/client/` 是 browser 半区（Web GUI：
  侧边栏入口、浏览器面板、设置卡）；`src/core/` 是两侧共享的纯逻辑。
- **构建**：`tsdown.config.ts` 一次性产出两个半区 —— node 半区 `lib/index.js`
  （esm，`@deepseek-ai/cordis` external），browser 半区 `lib/client.js`
  （`window.__ModuleLoader__` 闭包工厂，externals 只允许平台种子表，其余全
  内联；CSS Modules 经 lightningcss 编译并自动注入 `<style data-plugin>`）。
  类型由 `tsc -p tsconfig.build.json` 产出到 `lib/types`。
- **类型来源**：只允许 `@deepseek-ai/*` 官方 NPM SDK（devDependencies），
  tsconfig 禁止指向任何 DSH 源码 checkout。
- **client 半区纯度门**：`@deepseek-ai/*` 只能 type-only 导入；值导入仅限
  平台种子表（react / react-dom / cordis / ui-slots / web-react /
  ui-primitives / schema-form）与 `dsh-client-runtime/client` 豁免。构建期
  违规直接报错。
- **client apply 失败只 log 不 throw**：插件 apply 抛错会让整个 Web GUI
  boot 失败，任何 DOM 挂载失败必须降级而不是抛出。

## 常用命令

```sh
pnpm install        # 依赖（@deepseek-ai/* 走官方 NPM SDK，registry 见 .npmrc/全局配置）
pnpm build          # tsc 类型 + tsdown 双半区产物
pnpm typecheck      # 类型检查
pnpm test           # vitest 全量单测
```

提交前至少跑 `pnpm typecheck && pnpm test`。

## 全局约定

- **禁止修改 DSH 源码**：挂载只走 `cordis.patch.yml` + profile（
  `dsh plugin --profile <name> add link:<repo>`）。
- **禁止 emoji**（含 Emoji_Presentation、U+FE0F、ZWJ、区域指示符、Dingbats
  等 Unicode Emoji 属性字符），覆盖代码、注释、文档、UI 文案与提交信息；
  需要装饰时用普通字符（`×`、`-`、`*`）。
- **提交规范（Conventional Commits）**：`type(scope): subject`，type 用
  `feat` / `fix` / `chore` / `docs` / `test` / `refactor` / `perf`，scope
  如 `host`、`client`、`core`、`build`、`docs`。
- **双语纪律**：README 中英配对（`README.md` + `README.zh.md` +
  `README.i18n.yaml`）；UI 文案 zh 字典为 key 源、en 键集完整对照，经
  `ctx.locale.register` 注册。
- **安全语义**：browser_read 的 SSRF 防线（内网地址默认拒绝、重定向逐跳
  复检）、/api/dsh-browser 路由的 loopback 围栏与 workspace 门禁是安全边界，
  修改必须同步更新 README 与测试。

## 分层

| 文件 | 作用 |
| --- | --- |
| 本文件 | 仓库规则，每个会话都需要 |
| `README.md` / `README.zh.md` | 用户文档（功能、安全模型、安装） |
| 代码内 JSDoc | 各模块的行为契约与边界说明 |
