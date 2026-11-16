# Changelog

本文件记录 dsh-team 的显著变更。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.0.0] - 2026-11-16

首个公开发布版。

### 新增

- `team` 工具面：建队 / 派单 / 领单 / 汇报 / 结案 / 改派 / 换路由 / 问询 / 阅历史 等。
- 空闲自动补员（auto-claim）。
- 免费模型台账：被动真派记账、到期重探、自动同步 OFM catalog + 内核模型清单。
- 右侧栏 Team 面板（零上下文成本）。
- 跨会话信箱（leads-mail）与错误账本（errbook）。
- 一键装机脚本 `setup/reinstall-team.ps1` 与机器化验收 `setup/reinstall-check.mjs`。

### 变更

- **状态目录改为跟着安装位置走**：默认 `<插件安装目录>\.state`，
  可用环境变量 `DSH_TEAM_STATE_DIR` 或 profile 覆盖块改。
  （此前母本写死开发机路径，发布到别人机器上必然失败。）
- 成员工牌 `member-badge.md` 的环境段改为通用口径，不再引用开发机盘符。

### 移除

- 开发期自测脚本、备份与历史轮次（`Updating/`）不进发布包。
