> [!IMPORTANT]
> **本项目由 AI 辅助生成（AI-generated / AI-assisted）。**
> 代码与文档均经人工审阅与本机验证，但**可能**存在缺陷或不准确之处，使用前请自行复核。
>
> **免责声明：本项目不对正确性、稳定性、适销性或特定用途适用性作任何明示或默示担保。
> 使用本插件造成的任何直接或间接损失，作者与团队均不承担责任。
> 请自行评估风险，并优先遵守所在地区的法律法规与服务商协议。**
> 完整声明见 [DISCLAIMER.md](./DISCLAIMER.md)。

# dsh-team

DSH（DeepSeek Harness）的本地多智能体团队插件：**一个 `team` 工具** + 免费模型台账 + 右侧栏面板。

- 详细手册看 **[README.zh.md](./README.zh.md)**（权威）。
- 装机步骤看 **[INSTALL.md](./INSTALL.md)**。

## 装

三条路，任选：

1. **一键脚本**：在本目录开 PowerShell 跑
   ```powershell
   pwsh -NoProfile -ExecutionPolicy Bypass -File setup\reinstall-team.ps1 -FromStep 3
   ```
   自动探测 DSH 安装位置、铺文件、注册 profile `package.json` 的两条
   （`dependencies` + `dsh.profile.bundles`）、`pnpm install` 建链接。
   没装 DSH 的机器会直接提示退出，不会乱写。
2. **手改**：照 `INSTALL.md` 第 2 节（放文件夹 → 注册两条 → `pnpm install` → 重启保险）。
3. **DSH 插件市场**：按包名 `dsh-team` 装。

装完新会话发 `team(status)` 出 JSON 就成了。

## 目录

```
dsh-team/
├─ index.js            宿主：team 工具
├─ client.js           右栏 Team 面板
├─ package.json        name=dsh-team · version=1.0.0 · dsh.bundle/client 声明
├─ cordis.patch.yml    装载补丁（insert dsh-team，renderLedger:true）
├─ icon.svg            右栏图标
├─ src/                30 个 .js（配置、台账、信箱、评分、错误账…）
├─ locale/             en.json · zh.json
├─ skills/             team-reference 技能文档
├─ member-badge.md     工牌纪律（注入每个成员会话）
├─ setup/              一键装机脚本（探测式，零写死路径）
├─ INSTALL.md          装机决策树
├─ README.zh.md        中文手册
└─ README.md           本文件
```

## 数据落在哪

- 状态目录默认 **`<插件安装目录>\.state`**（跟着安装位置走，装完零配置可用）。
  想换地方：设环境变量 `DSH_TEAM_STATE_DIR`，或在 profile 的 `cordis.patch.yml` 里
  加 `- id: dsh-team` 覆盖块写 `stateDir`（**别写 `- insert`**，见 INSTALL 第 2c 节）。
- 队伍目录默认 `<.dsh 根>\team`，配置项 `teamDir` 可改。
- **成员写根**由派单消息第一行给出（成员 cwd 就是它的 workspace-write 边界）。

## 依赖

- 只支持 DSH（DeepSeek Harness）。没有 DSH 的机器装不了。
- 无 npm 依赖、无 `node_modules`。
- 需要 Node `^22.19 || >=24`（DSH 自带）。

## 许可

MIT，见 `LICENSE`。
