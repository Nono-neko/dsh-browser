# 更新记录

## 0.4.1 - 2026-10-29

### 修复

- 修复 `browser_read` 始终报错 `INVALID_TOOL_OUTPUT: value is not lossless JSON`
  的问题：省略不可用的可选字段，不再返回值为 `undefined` 的属性。
- 保持无标题 HTML、缺少 Content-Type 响应，以及 HTTP 和传输错误的结构化输出。

### 开发

- 在工具执行边界补充无损 JSON 回归测试。
- 增加 GitHub Actions：PR 和 master 推送自动运行类型检查、host/client 构建及完整测试，
  使用 Node 24 和项目声明的 pnpm 版本。

兼容性要求不变：DSH v0.2.0-rc.1 或以上版本。

感谢 @JohnHaixin5777 提供修复，感谢 @3338682145 最早报告问题
（issues #2、#3；pull requests #4、#5、#6）。

## 0.4.0 - 2026-10-02

### 兼容性

- 浏览器设置与批注提交适配 DSH 当前的 ConfigForms、Session Controller
  和 UI Session 服务。
- 本版本要求 DSH v0.2.0-rc.1 及以上版本支持 volatile Config 和 ConfigForms API。仍使用旧版
  SettingsScope API 的部署请保留 0.3.0。

### 修复

- 将九项配置声明为实时字段，恢复内置浏览器设置页。
- 保存后即时更新路由、工具、更新检查与 Agent 功能公告，无需重启插件。
- 多项设置一次性保存，未被接受的修改保留为草稿。
- client 插件卸载时清理设置订阅。

### 开发与文档

- 分离 host、client 与测试的类型检查，避免两端服务类型冲突。
- 固定官方 SDK 版本并补齐新服务依赖，构建不再依赖本地源码链接。
- 补充配置投影、实时生效、原子保存与设置页恢复的回归测试。
- 更新中英文 README，说明 profile 配置持久化及字段继承行为。

验证：类型检查、双半区构建与全部 218 项测试通过。
