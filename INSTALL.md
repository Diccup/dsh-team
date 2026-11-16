# dsh-team 安装说明

> 2026-11-02 更新（晚）：注册口径对着内核源码修正为 **`package.json` 里的正规两条
> （`dependencies` + `dsh.profile.bundles`），光拷文件夹没用**；
> `cordis.patch.yml` 降级为「想改配置才动」的可选覆盖块。
> 上一版把 profile patch 的 insert 块当成了注册必需——错，本版整节重写。

## 1. 放进去

整个 `dsh-team` 文件夹拷到：

```
C:\Users\<你的用户名>\.dsh\plugins\dsh-team\
```

放完长这样：

```
C:\Users\<你的用户名>\.dsh\plugins\dsh-team\
├─ index.js
├─ client.js
├─ package.json
├─ cordis.patch.yml
├─ src\            22 个 .js
├─ locale\
├─ icon.svg
├─ member-badge.md
├─ INSTALL.md
└─ README.zh.md
```

**不要拷这两样**（如果对方给你的包里带了的话）：

- `.state\` —— 那是别人机器上的运行数据（台账、名册、板子、报错历史、信箱）。
  账号和 provider 都不一样，拷过去反而全是错的。
- `Updating\` —— 开发自测脚本和备份，跑起来用不到。

不用 `npm install`。没有依赖，没有 `node_modules`。

## 2. 注册（正规两条，都在 profile 的 `package.json` 里）

> 2026-11-02 晚对着内核源码改过口径：**上一版这份说明把 `cordis.patch.yml` 的 insert 块
> 当成了第二条注册，那是错的。** 内核（`dsh-app-boot` 的 `readBundlePatches`）只把
> **`dsh.profile.bundles` 里列出的包**自带的 `cordis.patch.yml`（本插件目录里那份）读进组合树；
> 开发机本机 profile 的 patch 里**根本没有** dsh-team 块，插件一直在跑——这就是实证。

**光把文件夹放进 `plugins\` 再重启是没用的**——DSH 不扫这个目录。
注册在**你的 profile 目录**里（`C:\Users\<你>\.dsh\profiles\<你的profile名>\`，
profile 名看 `profiles\` 下有哪些文件夹，通常就一个），改 `package.json` 的两处：

### 2a. `dependencies` —— 加一行

```json
"dsh-team": "link:C:/Users/<你的用户名>/.dsh/plugins/dsh-team"
```

（正斜杠反斜杠都行；这一行让 pnpm 把插件包装进 profile。加完在
`<profile>` 目录里跑一次 `pnpm install`，让它建好 `node_modules` 链接。）

### 2b. `dsh.profile.bundles` —— 数组末尾补 `"dsh-team"`

```json
"dsh": {
  "profile": {
    "bundles": ["@deepseek-ai/dsh-base", "...其它已有项...", "dsh-team"]
  }
}
```

**这两处少一处都不加载**：只有文件夹 → 内核看不见；只加 dependencies 不加 bundles →
包能 resolve 但没进组合树，没人 `apply()` 它；只加 bundles 不加 dependencies →
bundle patch 读得到、包解析不到，同样加载失败。

### 2c. `cordis.patch.yml` —— 想改配置才动（可选，不是注册必需）

配置（`stateDir` / `workspaceRoot` 这些）有两个合法写法，任选其一：

- **改插件目录自带的 `cordis.patch.yml`**（那份是 bundle patch，本来就在组合树里）；
- **在你 profile 的 `cordis.patch.yml` 里加一条「覆盖块」**——注意是 `- id:` 打头的覆盖，
  **不是** `- insert:`：

  ```yaml
  - id: dsh-team
    config:
      renderLedger: true
      stateDir: "C:\\Users\\<你>\\.dsh\\plugins\\dsh-team\\.state"
      workspaceRoot: "D:\\work"
  ```

  内核语义（`applyEntryPatches`）：同 id 的 `- id:` 块 = 覆盖已有条目的字段，后读的赢；
  而 `- insert:`（无 id 顶层）= **往树里追加一条新条目**——在 profile 里再写一遍 insert
  会造成同插件双份注册，绝对不要这样写。插件已经由 bundles 注册时，条目已存在，
  覆盖块找不到目标只会 warn 跳过，不会崩。

### 2d. 重启 DSH（保险动作——本机实测常常不用）

改完注册**最迟下次启动一定生效**；但 2026-11-02 真机重装演练实测：手改 package.json
+ 跑完 `pnpm install` 之后**没重启，插件两秒后自己起来了**（装了 HMR 的宿主会当场
重新组合 profile 树）。所以正确姿势：

1. `pnpm install` 跑完，先新建会话发 `team(status)` —— 出 JSON 就直接能用，不用重启；
2. 没反应再完全退出重开（托盘右键退出，不是关窗口）——兜底，不是必然步骤。

> 为什么 OFM 装和更新都不用重启？因为它走的是内核 `dsh-plugin-manager` 的官方接口
> （`installBundle` → `publishAndReload`，「New bundle dependencies activate
> automatically」），当场重组树。**换成本插件走同一个接口（GUI 插件市场里装）也一样
> 免重启**——要重启的是「手改文件」这条路，不是插件本身。
> 代码更新（index.js/src/*）两边都免重启：文件换入后 HMR 当场检出，本插件还有
> `POST /api/dsh-team/reload` 自热重载。内核里唯一躲不掉的重启是包的物理位置变了
> （`restartReason: "package-moved"`）。

> 插件面板里**不会**出现一个"dsh-team 待启用"的按钮——bundles 没列它就没有这一行。
> 用 GUI 的插件管理开关（`writePluginEnabled`）改的是 profile patch 里的
> `- id: dsh-team` + `disabled` 覆盖，那是第 3 层的事，跟注册无关。

## 3. 确认装上了

新建会话，发：

```
team(status)
```

返一个 JSON（`members: []`、`open: {…}` 之类）就是装上了。右栏 `Ctrl+Alt+B` 能看到 Team tab。

## 4. 第一次要跑一次同步

```
team(scan)
```

它做的事：从内核 llm 服务 `listProviders` + `listModels` 拿模型清单 → 读 OFM catalog
→ 读 availability 探活结果 → 挂上 OFM 实测账。结果里 `scan: "kernel"`、`providers`
是问到的 provider 数。**不调 python**，不需要装 python。

第一次扫描后，**台账里全部模型是 `whitelist:"unknown"` 状态（面板上灰点，不参与派单）**。
这是正常的一半：内核列出的模型插件都收进来了，但「哪些允许子智能体用」是
`cordis.patch.yml` 里 `allowedModels` 决定的，你还没配。放行方式：

- **GUI 里点**：设置 → 子智能体模型选择，把你要的模型勾上（这会写进 `allowedModels`），重启 DSH。
  认免费模型可以找模型名里带 `free` / `免费` / 单价 `0.00` 特征的。

配好之前的兜底：如果一条 allow 都没有，unknown 模型允许**试跑派单**（能跑就直接跑起来，
被网关拒的自动转 closed 不再派）。配好 allowedModels 后这层兜底自动失效。

## 5. 想改配置时（不改也能用）

默认值全部**按插件自己的安装位置推导**，所以装完就落在你自己 `.dsh` 下面，
不用改文件。推导规则：

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `stateDir` | `<插件目录>\.state` | 所有运行数据都在这一个目录里 |
| `ofmPkgDir` | 先找 `<.dsh 根>\plugins\dsh-our-free-model`，再找 `<profile>\node_modules\dsh-our-free-model` | 两处都没有才报「没装 OFM」 |
| `ofmDataDir` | `<.dsh 根>\our-free-model` | |
| `availabilityPath` | `<.dsh 根>\our-free-model\availability.json` | 读不到就跳过探活 |
| `profileDir`（`ofmProfileDir` / `whitelistPatchPath` 跟着它走） | 自动探测 `profiles\` 下**声明了 dsh-team、且 cordis.patch.yml 里有 allowedModels** 的那个目录 | 探测不到退回 `profiles\desktop`；白名单读不到时全收标 unknown（见第 4 节），不会把台账弄空 |
| `workspaceStatePath` | `<.dsh 根>\storages\workspace.json` | 读不到就按「没有归档会话」处理 |
| `memberBadgePath` | `<插件目录>\member-badge.md` | |
| `workspaceRoot` | `<.dsh 根>` | **成员写根的边界**，见下 |
| `teamDir` | `<.dsh 根>\team` | 队伍档案和成员写根放哪 |
| `ledgerHistoryPath` | `<.dsh 根>\team\ledger-history.md` | |

其中 `<.dsh 根>` = 你 `~\.dsh` 那一级（插件装对位置就自动认出来）。

**只有 `workspaceRoot` 值得改**：成员的 cwd 就是它的 `workspace-write` 边界，
成员只能在这个目录里面写。默认落在 `.dsh` 根下面也能跑，但你大概希望成员写进
自己的工程目录。改法两种任选（详见第 2 节 2c 的说明）：**改插件目录自带的
`cordis.patch.yml`**（那份就是 bundle patch，发包版已写好注释），或者在 profile 的
`cordis.patch.yml` 里加一条 `- id:` **覆盖块**（注意不是 `- insert:`，insert 会双份注册）：

```yaml
# 放进 <profile>\cordis.patch.yml（或插件目录自带那份）末尾
- id: dsh-team
  config:
    renderLedger: true
    workspaceRoot: "D:\\work"          # 成员的写根边界
    teamDir: "D:\\teams"               # 队伍档案/写根放哪
    # 想放别处也可以显式指定（不给就用上面推导出来的默认）
    # stateDir: "D:\\teams\\.state"
    # profile 名很特别、探测猜错时才需要钉：
    # whitelistPatchPath: "C:\\Users\\<你>\\.dsh\\profiles\\<你的profile>\\cordis.patch.yml"
```

**别去改 `src\config.js` 里的默认值**——发包版那个文件在打包时已经被改写过一次，
再手改会打架；所有配置都走上面 profile 那条 `config:`，改完重启生效。

## 6. 已知限制

**provider 组名是照开发这台机器写的。** `qodercn`、`our-free-model`、`cline`、
`loomy`、`raccoon` 这几个名字在 `index.js` 里有硬编码判断（日限、整组停用、
免费池）。你那边没这些 provider 不会崩，只是认不出来、面板上不显示。

## 7. 卸载

删掉 `C:\Users\<你>\.dsh\plugins\dsh-team\` 整个文件夹；profile 的 `package.json` 里去掉
`dependencies` 那行 `dsh-team` 和 `bundles` 数组里的 `"dsh-team"`（在 profile patch 里加过
`- id: dsh-team` 覆盖块的话一并删掉），重启。
它自己建的 `<插件目录>\.state`（或你在配置里指定的 `stateDir`）一起删。

---

这个文件夹里**没有** `.state`、没有 `Updating`、没有备份。别去找 —— 那些是
开发机的运行数据和开发过程物，故意没带。
