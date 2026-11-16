# 一键装机（给 AI / 给不想手改配置的人）

在**包根目录**（本文件的上一级）打开 PowerShell（或让隔壁 AI 执行），跑：

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File setup\reinstall-team.ps1 -FromStep 3
```

它会：探测本机 DSH 安装（找不到就提示「本插件仅支持 DSH，请先装 DSH」并退出）→
把包内文件铺进 `~\.dsh\plugins\dsh-team\` → 注册 profile package.json 的两条
（`dependencies` + `dsh.profile.bundles`）→ `pnpm install` 建链接。

装完新建会话发 `team(status)` 出 JSON 即成（装了 HMR 的宿主不用重启；
没反应再完全退出重开，见 INSTALL.md 第 2d 节）。

- 想先看它要动哪些路径：加 `-ToStep 0`（只探测零修改）。
- 想只看探测结果不落任何东西：加 `-DryRun`。
- 数据默认落 `<插件目录>\.state`；想指别处装完后按 INSTALL.md 第 5 节加覆盖块，
  或设环境变量 `DSH_TEAM_STATE_DIR`。
- 手改注册文件的路线仍然有效：照 INSTALL.md 第 2 节做，两条一处都不能少。

## 脚本都是探测式的

本目录两个脚本**零写死路径**：

- `reinstall-team.ps1` —— DSH 根扫盘探测（`%USERPROFILE%\.dsh` → 各盘 `\.dsh` → `\<盘>\Users\<用户>\.dsh`）；
  node / pnpm 从探测到的 DSH 根里找；Harness exe 扫固定盘常见安装位。
- `reinstall-check.mjs` —— 重装后的机器化验收（插件 API 活着 / 新库长在 `<插件目录>\.state` /
  snapshot 是新机器形态）。
