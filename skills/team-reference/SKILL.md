---
name: team-reference
description: dsh-team（team 工具）完整参数手册。需要精确调用 team 的任意 action、查参数含义、走流程细节、看权限边界、排障或管理队伍档案时加载。
---

# team 工具完整手册

> 这是 `team` 工具的**按需参考**。常规四件事（goal / task create / announce / 跨会话）已写在工具定义里，直接照做即可；本手册覆盖**全部 action、全部参数、流程细节、权限边界与排障**。

## 0. 工具是什么

一个工具管一整队：定目标、拆单、派活、跟踪每张单的状态、跨会话协作。成员是普通子代理激活，插件按路由台账自动选派，并维护一套"未测/推荐/可用/不稳"的四级路由评分。

## 1. 核心流程

```
goal(总目标) → task create(拆单) → 插件自动选派 → 成员 claim → 成员 finish(交付)
     → 队长 accept(验收) → done
```

- **跳步会被拒**：goal 没写就建单、前置没完成就领单，当场报错。
- 每张单带 `trail`：谁、何时、从什么状态改到什么状态、为什么。`list` 行尾给最近一跳，`status` 看全。

## 2. action 总表

| action | 谁 | 干什么 | 关键参数 |
|---|---|---|---|
| `goal` | 队长 | 写总目标，重复覆盖；`text:""` 清空 | `text` |
| `task` | 队长建/改/结；成员只能 list/finish/fail | 任务板主入口，用 `action2` 细分 | `action2` + 见 §3.2 |
| `claim` | 成员 / 队长 | 认领一张单。不写 `to`=自己领（队长则自干）；写 `to` 只认本队成员名 | `tid`、`to` |
| `msg` | 队长→成员 | 追加指令，可带 `demand` | `to`、`text`、`demand` |
| `tell` | 队长 | 给**另一个会话**的 Leader 递话 | `to`、`text`、`wake` |
| `announce` | 队长 | 全体公告；不带 `text`=读最新 | `text`、`wake` |
| `peers` | 队长 | 看别的对话框 | — |
| `files` | 全员 | 查文件占用表；`path?` 查单个 | `path` |
| `history` | 成员/队长 | 某成员最近 8 条 | `to` |
| `status` | 队长 | 看本队全景 | — |
| `spawn` | 队长 | 手动加员（一般不用，插件自动派） | `name`、`provider`、`model`、`kind`、`size`、`effort`、`demand`、`caps`、`vision`、`task`、`workdir`、`teamName` |
| `retool` | 队长 | 换路由重派 | — |
| `kill` | 队长 | 叫停成员 | `to`、`ban`、`remove` |
| `unban` | 队长 | 解禁（成员名或会话 id） | `to` |
| `rule` | 队长 | 错误规则表：`match`+`errorClass`+`fix`；`ruleId` 删规则 | `match`、`errorClass`、`fix`、`ruleId` |
| `save` | 队长 | 存队伍档案 | `name2`、`compact` |
| `teams` | 队长 | 列/读队伍档案 | — |
| `adopt` | 队长 | 继承已有板 | `name2`、`force` |
| `disband` | 队长 | 收队 | — |
| `reload` | 维护 | 重载插件 | `dry`、`mode`、`extraBase` |
| `scan` | 维护 | 扫路由台账 | `reset` |
| `models` | 维护 | 看路由清单 | `filter` |
| `ofm` | 维护 | 读 OFM 面板实测用量（失败率/速度/首字延迟） | `filter`、`limit` |
| `continue` | 队长 | 输出撞顶自动续写状态；带 `to` 立刻催某成员接着写 | `to` |
| `score` | 队长 | 给产出品质打分 | `score` |

## 3. 参数手册

### 3.1 建单 `task create`

- `title` **必填**
- `body` = 本片边界
- `brief_path` = 任务书路径
- `blocked_by` = 前置 tid（csv）。**必须是板上真实存在的 tid**，不存在当场报错。有依赖必须逐条标，不写就并行开跑。
- `kind` = `grunt|code|design|probe`
- `size` = `s`（几个短文件）| `m`（一个模块）| `l`（整个仓库）。**注意：只有 s/m/l，没有 xl。**
- `demand` = `1|1+|2|3|max`（复杂度，默认 2）。写错的值当场报错，不静默夹取。
- `vision` = `true` 只派给台账里已知支持视觉的路由；`create/spawn/retool` 自动选型时生效。未知能力一律不派（未知 ≠ 支持）。
- `caps` = 标签 csv，有交集即领。
- `artifacts` = 本单必须落盘的文件（csv，可相对写根）。**默认不用填**：产出默认写在成员写根里，只有需要锁定"这单最终要对哪个文件负责"时才写，`finish` 会核对存在 + mtime。
- `no_artifact` = `true` 表示这单确实没有文件产物（probe/code 类免掉 `finish` 的"产物无法核对"警告）。不确定就别写。
- `owner` = 预指派成员
- `prio` = 越大越先，默认 0
- `tasks` = 一次建多张同结构的单。每项可给 `title/body/brief_path/artifacts/no_artifact/blocked_by/prio/kind/size/demand/caps/vision/owner`；本项没给的退回 action 顶层同名参数（共用默认）。`abbr` = 该项 key 的缩写（`ti`=title `bo`=body `ar`=artifacts）；`title/body` 里的 `{i}` 换序号（1 起）、`{prev}` 换上一张的 tid。

### 3.2 改单收尾 `task action2`

`action2` = `create|list|finish|fail|set|reopen|remove|accept|reject`，默认 `list`。

- `finish` = 交付（转 `delivered` 等队长验收）。**只有 claimed 单的持有者能结**；队长结无人单要 `force:true`。
- `fail` = 判失败，带 `text`=原因。
- `set` = 原位改字段。**仅 `open` 能改 `owner`/`blocked_by`**，且必须真给字段（空 set 会被拒）。给 `tids` 就是批量改同一组参数。
- `reopen` = `failed|delivered|done` → `open` 重干。
- `remove` = 删单。`tid` 或 `tids` 批量；`tid` 支持 `"t3-t7"` / `"t3,t5"` / `">=t5"`；claimed 的要 `force:true`。
- `accept` = 队长验收通过（`delivered` → `done` 并解锁下游）。
- `reject` = 队长打回（`delivered` → `open`，下游继续挡着）。
- `ban_member`（配合 reject）= `true` 表示打回的理由是**这个成员乱了**（不是活干得糙）→ 禁用他的会话 + 同路由干净新会话对照重跑；不加则维持普通打回记路由差评。

### 3.3 批量 tid

`tids` = csv 或区间：`"t3,t5,t7"` / `"t3-t7"` / `"t3~t7"` / `">=t5"`；也能传数组。**只用于 `remove`（批量删）和 `set`（同一组参数批量改）**。不在板上的 tid 不会静默吞掉，会列进 `skipped`（连续编号折成区间，不逐条铺开）。

### 3.4 spawn（手动加员）

> **2026-11-06 维护方定（方案 B）**：工具 schema 只保留定义正文点名的 24 个参数
> （`action, kind, size, demand, caps, vision, to, ban, remove, text, title, body, brief_path,
> blocked_by, artifacts, no_artifact, tid, match, errorClass, fix, action2, tids, tasks, path`）。
> 其余参数已移出 schema、不再带描述文本，但 `additionalProperties: true`，照样能传、行为不变——
> 用之前先查本节和 §3.4b，别凭记忆猜键名。

- `name` 成员名（唯一，兼文件夹名）
- `provider` 路由 id（`models` 里 `/` 之前）
- `model` 模型 id（`/` 之后整段）
- `effort` = `low|medium|high|xhigh|max|none`
- `task` 首任务文本/任务书，省略=待命
- `workdir` 写根，绝对路径或 `"team"`
- `teamName` 队目录名；**只在本会话第一次建队时生效**，之后一队一个目录改不了

> ⚠️ **写根必须在沙盒内**。`workdir` 落到沙盒边界外时，成员所有真实落盘都会被拒，并触发 auto-repair 补员循环反复烧额度。

### 3.4b 其余已移出 schema 的参数（照此传，别猜）

| 参数 | 用在哪 | 含义 |
|---|---|---|
| `owner` | `task create` / `set` | 预指派成员；`set` 改 `owner` 只对 `open` 单生效 |
| `prio` | `task create` | 数字越大越先，默认 0 |
| `wake` | `tell` / `announce` | 默认叫醒；`false` = 只投递，等对方下次调 team 拉取 |
| `ban_member` | `task action2=reject` | `true` = 打回理由是"这成员乱了"（判乱换干净会话重跑）；普通活糙别加 |
| `force` | `adopt` / `remove` / `finish` | 覆盖已有板 / 强删 claimed 单 / 队长结无人单 |
| `filter` | `models` / `ofm` | 按路由 id 子串过滤 |
| `limit` | `ofm` | 每档最多列几条，默认 20、上限 80 |
| `scope` | `status` 等 | `mine`（默认）/ `all` 加别队 |
| `reset` | `scan` | 只认 `"efforts"`：清实测封顶 |
| `score` | `score` | 1~5；不传 = 只读当前平均分 |
| `name2` | `save` / `adopt` | 队伍档案文件名 |
| `compact` | `save` | `true` = 只存精简档案，供新会话 `adopt` 继承 |
| `dry` | `reload` | `true` = 只干跑探针，一个字节不动 |
| `mode` | `reload` | `auto`（默认）/ `self` / `kernel` |
| `extraBase` | `reload` | Junction/link 装的包根，字面路径与 realpath 都对不上时才用 |
| `ruleId` | `rule` | 删除这条登记规则 |

传这些键**不会被引擎拒**（`additionalProperties: true`），但也**不会被自动纠正**——键名严格照上表，拼错等于没传。

### 3.5 跨会话

- `tell(to,text)`：给另一个会话 Leader 递话。`wake` 默认就叫醒（写了 `to` 就算指名）；`wake:false` 才纯投递。
- `announce(text)`：全体公告。默认叫醒空闲的顶层会话；`wake:false` = 只投递（等它下次调 team 拉取）。
- `peers`：看别的对话框。
- **消息纪律**：能说清问题的前提下尽可能短；没问内容不发。唤醒=插话直达对方上下文，回执类只写一句结论；怎么修的/改了哪些文件/怎么验证的都是自己这边留着，对方没问不发。

### 3.6 排障

- `kill(to, ban?, remove?)`：叫停成员。`ban:true` = 队长判定该成员产出混乱 → 禁用这个子会话（永不复用）并退回其单；补员钉在同一条路由上**新起干净会话**做对照。同路由第 2 次判乱 = 模型不行，那时才记模型差评。`remove:true` = 叫停并移出名册（腾名额），默认只叫停。
- `unban(to)`：解禁（成员名或会话 id）。
- `rule`：错误规则表。`match` 错误特征串（子串；`/正则/` 也行）、`errorClass` 分类名（自定）、`fix` = `backoff|downshift|rotate|dead|retry|none`、`ruleId` 删这条登记规则。
- `retool`：换路由重派。

### 3.7 档案与收队

- `save(name2?, compact?)`：存队伍档案。`compact:true` = 只存"目标+拆单+完成状态"的精简档案，给新对话 `adopt` 继承用。
- `teams`：列/读队伍档案。
- `adopt(name2?, force?)`：继承已有板。`force:true` 覆盖已有板。
- `disband`：收队。

### 3.8 运维

- `reload(dry?, mode?, extraBase?)`：重载插件。`dry:true` 只干跑探针（报能不能重载、会清掉哪些缓存键、几个 src 模块），一个字节不动——**先看再动手**。`mode` = `auto`（默认，能自热就自热，否则退回内核）| `self`（强制自热，连 src/ 一起换）| `kernel`（只用内核 pluginManager，只换 index.js）。`extraBase` 额外当作包根的目录（Junction/link 装的，字面路径与 realpath 都对不上时才用）。
- `scan(reset?)`：扫路由台账。`reset:"efforts"` 清实测封顶。
- `models(filter?)`：看路由清单，按 id 子串过滤。
- `ofm(filter?, limit?)`：读 OFM 面板实测用量（失败率/速度/首字延迟）。`limit` 每档最多列几条（默认 20，上限 80）。
- `continue(to?)`：输出撞顶自动续写的状态；带 `to` 立刻催某个成员接着写。
- `score(score?)`：队长给产出品质打分。`score` 1~5（1=胡编乱造 2=有明显错 3=合格(基准) 4=好 5=很好）。不写 = 只读当前平均，不记分。评分公式里品质乘数 = `0.6 + (平均分−1)×0.2`，3 分恰好 ×1.00。
- `scope` = `mine|all`，默认 `mine`，`all` 加别队。

## 4. 权限边界

- **队长**：建单 / 改单 / 删单 / 验收 / 存档 / 收队 / 换路由 / 发公告 / 手动加员 / 打分 / 运维。
- **成员**：只能 `task(list/finish/fail)`、`claim`、`msg`、`tell`、`files`、`history`、`status`。
- 成员调用队长活**一律拒**，并说明找谁办。判"是不是队员"不能只看 members：成员被回收/移出名册后会话还活着，那时 `members.get(它) === undefined`，老代码会把它当队长放行——这是已修过的坑（2026-10-31 隔壁 b080dbbf 实测）。

## 5. 路由评分（选派依据）

四级：`未测(0) < 推荐(1) < 可用(2) < 不稳(3)`。选派时先按 tier 升序，再按 trust、eta 等。

- 未测路由不一定会被选：**ctx 硬闸**会过滤掉 ctx 不足的候选。例如 `size=m` 的 `needCtx=256K`，44 条未测路由经 ctx 闸后可能幸存 0 条，于是第一名必然是推荐/可用——这是"不烧额度"的设计取舍，不是 bug。
- `size=s` 时 needCtx 低，未测候选会排在前面。

## 6. 常见坑

1. **`size` 只有 `s|m|l`**，README 里写的 `xl` 不存在，传了会报"size 只能是 s/m/l"。
2. **`workdir` 必须在沙盒边界内**，否则成员写盘全被拒 + auto-repair 循环。
3. **`blocked_by` 的 tid 必须已在板上**，不存在当场报错。
4. **空 `set` 会被拒**，必须真给字段。
5. **`artifacts` 默认不用填**；没有产物就写 `no_artifact:true`，别写 `artifacts`。
6. **`teamName` 只在第一次建队生效**，之后改不了队目录名。
7. **消息要短**，唤醒即插话直达对方上下文。
