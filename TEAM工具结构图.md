# TEAM 工具结构图 · dsh-team 实装形态

> 仿 `dsh-context-mode模块拆/桥结构图.md` 的口径画：全部按**真实接线代码**画，边是扫全部 `import` 语句实测出来的，不是设计稿。
> 扫描口径：dsh-team 插件本体（发布版），30 个 JS 文件、**772,172 B**。跑的是模块化后的这一档（index.js **416,748 B** + src/ **285,301 B** + client.js **70,123 B**）。
>
> **校准记录**：2026-11-16（04 项目）按磁盘实测全量重算 —— 上一版停在 2026-11-04，
> 之后 01/02/03 三轮改动都没记（累计 +175,897 B、index.js +94 行）。
> 本文件所有字节/行数由 `Updating\verify\verify-mirror.mjs` 的 ③-b/③-c/③-d 机检对拍。
> **校准记录 2**：2026-11-16（05 项目）client.js 删顶上三格统计条（StatStrip）+ 公告并入
> 「跨会话信息」区：65,706→62,890 B、921→852 行（node --check 过后 Get-Item 实测）。
> §一第 3 层框里 04 漏改的 49,347 B / 897 行一并修正。
> **校准记录 3**：2026-11-16（05 项目·看板改版）client.js 右栏面板退役、UI 改挂顶部整页
> tab（conversation.view，名字 dsh-Team）+ 头部按钮：hero 顶卡 / 胶囊计数 / 任务流看板四列，
> 删 TeamTitle/startAutoOpen 死代码：62,890→**66,968 B**、852→**920 行**（node --check 过后实测）。
> 同日补丁：看板溢出三修（TASK_LABEL 补 delivered、列 minmax 防撑破、Owner chip 截断）：66,779→66,968 B。
> 同日补丁 2：看板列高改版（每列固定露最近 3 单 + 「更多」悬浮窗看全量，维护方「发 20 个拉扯老高」）：66,968→**70,123 B**、920→**964 行**。
> 含补丁 3：TaskCard 两行版式（标题独占首行防 chip 挤压消失，维护方截图抓出）+ 看板收起态 compact 省派发时间行；拆「任务流」死控件 bOpen。

---

## 一、分层：谁管什么

```
┌───────────────────────────────────────────────────────────────────────┐
│ 第 0 层 · 宿主                                                        │
│                                                                       │
│ DSH · Cordis 插件总线                                                  │
│   inject = ["agents","subagents","tools","timer","sessionPersistence"] │
│   ctx.tools.register(teamTool)        ← 唯一面向模型的工具（一个）     │
│   ctx.subagents.startActivation(...)  ← 起成员（普通子代理激活）       │
│   ctx.on(agent/*, session/*, subagent/end, tools/pre|post-execute)    │
│   ctx.timer.interval(...)             ← 持久化 / 重探 两个节拍         │
│   ctx.inject(["webServer"], ...)      ← 面板快照 HTTP 通道             │
└───────────────────────────────────────────────────────────────────────┘
                              │ apply(ctx, config)
                              ▼
┌───────────────────────────────────────────────────────────────────────┐
│ 第 1 层 · 组装器  index.js   416,748 B · 6,020 行                       │
│                                                                       │
│ ★ 注意：这不是 context-mode 那种「零业务逻辑的薄桥」。                  │
│   它一个人扛了四件事：                                               │
│   ① 唯一 tool schema + switch 全量分派（25 个 action）                │
│   ② 成员路由瀑布 attachRouting / 被动记账 attachAccounting            │
│   ③ 派单·选路·补员·撞顶续写（业务主体，占文件大头）                   │
│   ④ 面板快照 HTTP + 自热重载入口                                       │
└───────────────────────────────────────────────────────────────────────┘
                              │ import 26 处
                              ▼
        ┌────────────────────────────────────────────────────────────┐
        │ 第 2 层 · 模块层  src/   28 文件 · 285,301 B                 │
        │                                                              │
        │ 底座     config.js · util.js · persist.js · state.js         │
        │ 选路     gears.js · ctxfacts.js · ledger.js + freeledger/   │
        │          ofmstats.js · score.js                              │
        │ 成员     memberpool.js · bans.js · workdir.js · locks.js     │
        │ 任务板   board.js                                            │
        │ 通信     mailbox.js · notify.js · announce.js · errpush.js   │
        │          errbook.js · lederr.js · accounting.js · health.js  │
        │ 自热     selfreload.js · errors.js                          │
        └────────────────────────────────────────────────────────────┘
                              │
        ┌───────────────────────┴──────────────────────────────────┐
        ▼                                                             ▼
┌─────────────────────────────────────────────┐   ┌──────────────────────────────┐
│ 第 3 层 · 浏览器件  client.js   70,123 B    │   │ 第 4 层 · 数据              │
│ 顶部整页 tab dsh-Team（React，964 行）      │   │ .state/*.json（一个目录）    │
│ 轮询 /api/dsh-team/snapshot 每 2.5s         │   │  ledger / roster / board /  │
│ 面板数据不进模型上下文（零 token 税）        │   │  scores / member-pool /     │
│ 自带 /reload 热重载入口                      │   │  bans / notices / mailbox…   │
└─────────────────────────────────────────────┘   │ runs/<队slug>/<成员名>/ 写根 │
                                                     └──────────────────────────────┘
```

四层很薄，但第 1 层很重：**index.js 占全插件 55% 的字节**。真正"接线"的只有 apply() 开头那几十行，剩下 5,800 行全是它自己长的业务。跟 context-mode 的「桥 9 块 = 56 KB、引擎 675 KB」正好反过来——这里是「**一个胖入口 + 一圈小模块**」。

模块之间只有**底座**被横向共享（改一块不用碰另一块）：

| 底座 | 被谁读 | 扇入 |
|---|---|---|
| `src/util.js` | index + announce / ctxfacts / errbook / freeledger×3 / lederr / ledger / locks / mailbox / notify / ofmstats | 13 |
| `src/config.js` | index + accounting / announce / errbook / freeledger×2 / lederr / locks / mailbox / notify / workdir | 11 |
| `src/state.js` | index + board / collect / dispatch / ledger / workdir | 6 |
| `src/gears.js` | index + dispatch / ledger / util | 4 |

---

## 二、积木之间的线（真实 import 关系）

```
                               ⑧ index.js  ｜ 引 26 处
                                   │
        ┌──────────────────────────┴────────────────────────────────────────────┐
        ▼      ▼      ▼       ▼        ▼       ▼        ▼       ▼        ▼      ▼
   ┌──────────┐ ┌──────────┐ ┌────────┐ ┌─────────┐ ┌──────────┐ ┌─────────┐ ┌────────┐ ┌────────┐
   │ accounting│ │ announce │ │ bans   │ │ board   │ │ ctxfacts │ │ errbook  │ │ errors │ │errpush │
   │ .js      │ │ .js      │ │ .js    │ │ .js     │ │ .js      │ │ .js     │ │ .js    │ │ .js    │
   └──────────┘ └──────────┘ └────────┘ └─────────┘ └──────────┘ └─────────┘ └────────┘ └────────┘
   ┌──────────┐ ┌──────────┐ ┌────────┐ ┌─────────┐ ┌──────────┐ ┌─────────┐ ┌────────┐ ┌────────┐
   │ health   │ │ lederr   │ │ ledger │ │ locks   │ │ memberpool│ │ notify  │ │ofmstats│ │persist │
   │ .js      │ │ .js      │ │ .js    │ │ .js     │ │ .js       │ │ .js     │ │ .js    │ │ .js    │
   └──────────┘ └──────────┘ └────┬───┘ └─────────┘ └──────────┘ └─────────┘ └────┬───┘ └────────┘
                                   │ 引 collect+whitelist+gears+state+util        │ 引 util
                                   ▼                                              ▼
                            ┌───────────────────┐                            ┌────────┐
                            │ freeledger/collect│                            │ score  │
                            │ .js (最大模块)     │                            │ .js    │
                            └───────────────────┘                            └────────┘
                                   ▲                              ▲
                                   │                              │
                            ┌──────┴───────┐                 ┌──────┴───────┐
                            │ dispatch.js  │                 │  score.js    │
                            └──────────────┘                 └──────────────┘
                                     │
        ┌────────────────────────────┴───────────────────────────┐
        ▼                                                         ▼
  ┌───────────────────┐                           ┌───────────────────┐
  │ freeledger/pool   │                           │ selfreload.js     │
  │ .js  (组级熔断)    │                           │ (自热重载)        │
  └───────────────────┘                           └───────────────────┘

    横向 28 块彼此零引用 → 改一块不用碰另一块。
    全部只指向四个底座：util / config / state / gears。
    （errors.js 是被 index 引一次的叶子；collect.js 只有 ledger.js 引它。）
```

**切干净的判据**：28 个 src 模块彼此**零横向 import**，只吃四个底座。改 `locks.js` 不用碰 `dispatch.js`，改 `memberpool.js` 不用碰 `ofmstats.js`。

---

## 三、一条指令怎么走 ①：`team(action:"spawn")` 建一个成员

> 最绕的一条，跨「模型 → 插件 → 内核子代理」。

```
模型调用  team(action:"spawn", name:"w1", kind:"code", size:"m", task:"先待命")
  │
  ▼
┌─────────────────────────────────────────────────────────┐
│ index.js · 唯一 tool handler                            │
│  ① resolveLead(caller) 沿 parentSession 爬到队长        │
│  ② 队员调用？→ 直接拒（成员不许 spawn）                  │
│  ③ 板上无 open 可领单？→ 拒「板上无TASK」                 │
└─────────────────────────────────────────────────────────┘
  │
  ├─► 路由从哪来（三选一）
  │      ├─ 显式 provider+model → 用它
  │      └─ 没给 → pickRoute(kind,size,leadId,{vision})  → 台账选型
  │            └─ 回执带 routeSetBy:"插件选型" + pickedBecause（筛法/实测/无数据）
  │
  ├─► 四道闸门（全过才往下）
  │      ① leadRouteKeys() 正在被队长用 → 一律不派
  │      ② ledger.status === "invalid" → 拒，附 3 条可派候选
  │      ③ ledger.delisted === true（内核目录已下架）→ 拒，附 3 条可派候选
  │         ★ 2026-11-16 加（03 项目）：原来只有 ①②③(熔断) 三道，delisted 标记
  │         写了 14.9 天没人消费，mistral-large-4-1t-a52b 就这么被派出去撞
  │         UNSUPPORTED_REASONING_EFFORT。判据与 dispatchable() 同源，不另立口径。
  │      ④ 组级熔断 groupHalted / 退避 effectiveBackoff → 拒，附候选
  │
  │      ★ 注意 ②③ 的先后：**invalid 在前、delisted 在后**（先报更具体的 status）。
  │        而在 dispatchable()（唯一派单闸）里顺序**相反** —— delisted 必须在
  │        status 硬闸**之前**，否则 `status==="ok"` 那条会提前 return true
  │        把 delisted 放过去（本机 5 条 delisted 里恰好 2 条 status=ok）。
  │        两处顺序不同是**有意的**，不是笔误。
  │
  ├─► gear 定档 resolveGear(entry, effort, demand)
  │      └─ 显式 effort 是意图，但**永不超过实测封顶**；缺省 = demand 换算
  │
  ├─► 写根 createWorkdir → memberWorkdir(leadId,name) → ensureWriteRoot()
  │      └─ 写根 = 成员 cwd = 它的 workspace-write 边界（一人一目录）
  │
  ├─► members.set(childId, member)      ← 必须先登记，created 事件才找得到
  │
  ▼
  ┌─────────────────────────────────────────────────────────────────────┐
  │ ctx.subagents.startActivation({                                     │
  │   provider:"spawn", childId, label,                                 │
  │   parent:caller, cwd:workdir, prompt:[{text: taskText}],            │
  │   agentOptions:{provider,model,reasoningEffort},   ← 扁平（RC3 读） │
  │   request:{ parent:caller, cwd:workdir,                            │
  │            prompt:[{text: taskText}],                              │
  │            agentOptions:{provider,model,reasoningEffort} },         │
  │                                                  ← request.*（RC1）│
  │   delivery:"parent", signal:exec.signal })                          │
  └─────────────────────────────────────────────────────────────────────┘
  │
  │  ★ 2026-11-15（02 项目 · RC3 适配）：**扁平 + request.* 双挂**。
  │    DSH RC3 读扁平字段、RC1 读 request.*，两份都传才能同时兼容。
  │    改动前只传 request.*，RC3 环境下 `agentOptions` 读不到 ⇒
  │    成员一律回落默认路由/档位（实测 3 张 probe 单全部派错）。
  │    三处调用点都要双挂：autoFillOne / spawn / adopt（4761 行那处）。
  │
  ├─► 抛错 → members.delete(childId) 回滚
  │
  ├─► pinMemberMode(activation, childId, member)
  │      └─ 把成员钉 workspace-write（钉在它自己的 cwd 上，不是队长档）
  │
  ├─► persistAll()  → 名册落 .state/roster.json
  │
  ▼
  回 { spawned, id, route, effort, gearFrom, routeSetBy, team, workdir, sandbox, busyElsewhere? }
```

**和 context-mode 的关键区别**：这里没有 MCP 子进程、没有 JSON-RPC、没有自愈复活。成员就是宿主进程里的一个**普通子代理激活**（`ctx.subagents.startActivation`），路由覆盖走 DSH 公开的 `system-prompt/assemble` + `agent/request` 瀑布。**引擎全程不参与，没有 bundle 也没有 restart 日志。**

---

## 三之二、台账判死链（★ 2026-11-16 新增 · 03/04 项目）

**这条链回答一个问题：一条路由怎么被判死、判死之后谁会认、什么情况下能复活。**
改动前这里完全没画，而「判了死但没人消费」正是 mistral 事故的根因。

```
                    ┌──────────────────────────────────────┐
  每 15 分钟 tick ──►│ index.js · reprobeTick               │
  （reprobeEvery-   │  ① applyAvailability(ctx,cfg)        │
   Minutes: 15）    │  ② syncFromOfm(cfg)                  │
                    │  ③ syncFromKernel(ctx,cfg)  ← 判死在这 │
                    │  ④ annotateOfmLedger                 │
                    │  ⑤ refreshOfmRemote                  │
                    └──────────────────────────────────────┘
                                    │
        ┌───────────────────────────┴───────────────────────────┐
        ▼                                                       ▼
┌───────────────────────────┐                     ┌─────────────────────────────┐
│ ③ syncFromKernel 判死      │                     │ ① applyAvailability 复活路径 │
│ （collect.js）             │                     │ （collect.js:47-60）         │
│                            │                     │                             │
│ 条件：该 provider 本次      │                     │ manualResults/state =        │
│  asked 成功 且 seen 里没它  │                     │   "available"                │
│         ↓                  │                     │      ↓                      │
│ e.delisted = true          │                     │ ★ delisted===true → continue │
│ e.delistedAt = now         │                     │    （2026-11-16 加）          │
│         ↓                  │                     │      ↓                      │
│ whitelist==="allow" &&     │                     │ status==="invalid" 且        │
│ (status==="ok" ||          │                     │ realResult!=="fail"          │
│  status==="unknown")       │                     │      ↓                      │
│   ← unknown 也判死（03 修） │                     │ status = "ok"  ← 旧快照复活  │
│         ↓                  │                     └─────────────────────────────┘
│ e.statusBeforeDelist =      │
│   e.status  ← 记**实际值**  │   ★ 不加跳过会怎样：judgment 每 15 分钟被抹一次。
│ e.status = "invalid"        │     实证两条：liquid/lfm-2.5-2.6b:free（11-04 判死
│ note += "；内核目录已下架…" │     → 被 11-03 的 manual available 改回 ok）、
└───────────────────────────┘     deepseek-ai/deepseek-v4.1-flash（11-01 → 11-12 同）
        │
        │  ⚠ 2026-11-16 前：`if (e.delisted === true) continue;` 在这里
        │     —— 判死只做一次，之后谁改回 ok 都不再重判。
        │     现在改成 `already` 复核：note 不重复写，但每次都重判 status。
        ▼
┌──────────────────────────────────────────────────────────────┐
│ 消费点（谁会看 delisted）—— 03 之前**一个都没有**             │
│                                                              │
│  · dispatchable(e)          唯一派单闸（dispatch.js:44）      │
│      `if (e.delisted === true) return false;` ← 必须在        │
│      status 硬闸**之前**（否则 status=ok 会提前放行）          │
│  · pickRoute / maxCtxK      dispatch.js（经 dispatchable）    │
│  · alternatives()           index.js（经 filter(dispatchable)）│
│  · spawn 显式路由闸          index.js（单独一行，03 加）       │
└──────────────────────────────────────────────────────────────┘
        │
        ▼
┌──────────────────────────────────────────────────────────────┐
│ 解封两条路（**不许只有排除没有恢复** —— 维护方 2026-11-01 定的）  │
│                                                              │
│  ① 内核又列出它：syncFromKernel 的 inSeen 分支               │
│       delisted=false，status 按三档还原：                    │
│         statusBeforeDelist ∈ {ok,lead} → 照原样              │
│         realResult==="ok"/"fail" → ok / invalid              │
│         都不是且当前 invalid → **unknown**（让下次实测决定）   │
│                                                              │
│  ② 真跑成功：index.js · recordRealRun 判 ok 分支（03 加）     │
│       delisted=false + 清 delistedAt/statusBeforeDelist      │
│       + 抹掉 note 里"内核目录已下架"的尾巴                    │
│       + 追加历史行「下架解封」                                │
│     ★ 不留这条路 = 模型真回来了也用不上（反向死锁）            │
└──────────────────────────────────────────────────────────────┘
```

**档位的假绿灯（04 项目 · 遗留 1 修掉的那条）**：
`syncModelInfo()` 原来「ctx/out/efforts/vision 四项都有值就 `continue`」，
于是**首遇快照永久生效**。mistral 从 2026-10-31 起一直挂 `light/balanced/deep`，
而它目录外 ⇒ 内核 `reasoning: undefined` ⇒ 发任何档位词都抛
`UNSUPPORTED_REASONING_EFFORT`。现在两条口子放行重查：`delisted===true`
或距上次复核超过 `EFFORTS_RECHECK_DAYS`（7 天）；内核**明确答无 reasoning 元数据**时，
台账 efforts 改成「无思考开关（内核不给档位）」—— 假档位比没档位更坏。

---

## 四、一条指令怎么走 ②：空闲自动领单 → 干活 → finish

```
队长：task(action2:"create", title:"抓竞品定价页", brief_path:"...")
  │
  ▼
┌─────────────────────────────────────────────────────────┐
│ index.js · case "task" · action2="create"               │
│  校验 → boards.get(lead).tasks.set(tid, record)          │
│  → 队内所有 idle 成员被触发 maybeDispatch()              │
└─────────────────────────────────────────────────────────┘
  │
  ▼
成员 agent 进入 idle（agent/status 不是 running）
  │
  ▼
maybeDispatchInner(member, agent)
  ├─ autoClaim 关？→ 停
  ├─ member.currentTask !== null？→ 已经在干，停
  ├─ 并发闸：本队 running < maxConcurrent(8)；同 provider/model < maxPerRoute(1)
  ├─ 从板里筛 open + 依赖已结算(accept 过) + caps 匹配
  └─ 排序取 prio 最高一张 → 发派单消息给成员（lead 作 authorizer）
        │
        ▼
  ┌─────────────────────────────────────────────┐
  │ attachRouting 的 system-prompt/assemble      │
  │   每步重算 [当前任务] 上下文，历史旧任务一律作废 │
  │   variables.provider/model 覆盖成成员路由      │
  └─────────────────────────────────────────────┘
        │
        ▼
  成员跑工具 / 写文件（只写自己写根）
        │
        ▼
  成员调 team(action:"task", action2:"finish", tid)
  ├─ 只有 claimed 单的持有者能结（队员结自己那单）
  ├─ 核对 artifacts 存在 + mtime（没声明就警告）
  └─ 状态 → delivered（**不是 done**）
        │
        ▼
  队长 action2:"accept" → delivered → done，下游 blocked_by 解锁
  队长 action2:"reject" → delivered → open（下游继续挡着）
        │
        ▼
  兜底：subagent/end 事件
  ├─ error/aborted/max-tokens 且没有续写机会 → 单退回 open + 记原因
  └─ max-tokens 且有续写机会 → 单**留在它名下**，插件发「继续」
```

**为什么 finish 是 `delivered` 而不是 `done`**：这是一道验收门。队员交完不能立刻解锁下游，队长必须显式 `accept` 才算结案（`reject` 直接打回 open）。`subagent/end` 异常结束时任务自动退回 open 并写明原因，不会永久锁死下游（前置 `failed` 视为已结算）。

---

## 五、启动时序（DSH 装载这个插件时，一次走完）

```
DSH 启动 / 插件装载
  │
  ▼
apply(ctx, config)
  ├─ 1  setStateDir(cfg.stateDir) + mkdir  ← 必须先定，后面 8 个模块拼路径跟着走
  ├─ 2  loadNotices() / loadMail()          ← 读 .state/notices.json / leads-mail.json
  ├─ 3  createWorkdir(cfg)                 ← 写根解析
  ├─ 4  createErrbook(cfg)                 ← 报错账本 + 用户规则
  ├─ 5  createAnnounce({ctx})              ← 全局公告板 + kernelSessions
  ├─ 6  建路径：ledger / roster / board / member-pool / bans / scores
  ├─ 7  createMemberPool(...) + loadPool() ← 退役成员池
  ├─ 8  createBanList(...) + load()        ← 禁用名单
  ├─ 9  restore persisted state            ← 从 .state 回灌板/名册/台账（best effort）
  ├─ 10 createGroupPool(...)               ← 组级熔断
  ├─ 11 createDispatcher({...})            ← pickRoute / maxCtxK
  ├─ 12 createLeadErrors(...)              ← 队长报错暂存
  ├─ 13 createHealth(cfg)                  ← derived health
  ├─ 14 attachRouting + attachAccounting   ← agent/created 事件 + 已活 agent 补挂
  ├─ 15 createAccounting(...) + 三级全局兜底监听（root / ctx / global）
  ├─ 16 persistTimer = ctx.timer.interval  ← 节流落盘
  ├─ 17 teamTool schema 定义（index.js:2909）
  ├─ 18 reprobeTick = ctx.timer.interval   ← OFM + 内核清单 + 探活（唯一发现通道）
  ├─ 19 kernelSyncTimer = setTimeout 5s     ← 补 syncModelInfo
  ├─ 20 ctx.inject(["webServer"]) → 注册 /api/dsh-team/snapshot + /reload
  ├─ 21 ctx.tools.register(teamTool)       ← 唯一工具上线
  └─ 22 return dispose：撤监听 + 计时器 + 「内存比磁盘新才落盘」
```

`dispose` 里有条血泪规矩：**退出时无条件 `persistAll()` 会拿内存旧值覆盖磁盘新值**。现在判据是 `diskMtime < lastPersistAt` 才写——外部（人改 / 别的实例）动过盘就不覆盖。

---

## 六、队长板 vs 队员板（权限边界）

```
调用 team(...)  →  resolveLead(caller)
                     │
                     ▼
            沿 parentSession 往上爬
                     │
        ┌────────────┴────────────┐
        ▼                         ▼
   顶层会话（队长）              子会话（队员）
   拿到自己那块板               拿到**队长那块板**
   create/claim/set/           只能 list / finish / fail
   accept/reject/reopen        （建单/改单/删单/验收
   /remove/spawn 等全权         全部推给队长）
        │                         │
        └────────────┬────────────┘
                     ▼
        只有 claimed 单的持有者能 finish/fail
        队长对没人认领的单 → 必须 force:true
```

历史事故（2026-10-31 隔壁实测）：队员 `auto2` 自己跑了全套队长动作，把队长的板当场换血。根因是插件从没问"调用方是不是队员"，而且老代码 `members.has(String(caller))` 恒为假（`members` 按子会话 UUID 索引，`String(agent)` 恒等于 `"[object Object]"`）。现在的修法：认人**按会话 id 不按名字**，每个 `case` 先查 `members.get(caller.session.id)`。

---

## 七、数据层：一个目录 + 一排写根

```
<插件目录>/.state/
  ledger.json        台账（provider/model -> {status, ctx, out, efforts, 实测封顶, 退避…}）
  roster.json        成员名册（childSessionId -> MemberRecord）
  board.json         任务板（leadSessionId -> {seq, tasks:{tid -> TaskRecord}}）
  scores.json        战绩账（按 route@effort|kind 聚合 + 14 天半衰）
  member-pool.json   退役成员池（补员冷唤醒复用）
  bans.json          禁用名单（永不复用）
  notices.json       通知队列
  leads-mail.json    Lead↔成员信箱（+ 日志）
  errors/           报错账本（按日/月归档）
  hook-status.json / reload-log.json / swept.json …  诊断件

<workspaceRoot>/runs/<队slug>-<MMDD-HHmm>/<成员名>/   ← 成员写根（= 沙盒边界）
```

**写根 = 沙盒边界**：DSH 的 `workspace-write` 边界是会话 cwd，所以插件给每个成员单独 cwd 并钉 `workspace-write`。成员之间天然不越界；**读不受限，只限写**。`outsideWorkspace()` 越界时在 status 打 `(外)` 并留痕。

---

## 八、积木清单（含字节数）

| # | 文件 | 字节 | 职责 |
|---|---|---|---|
| ① | `index.js` | 416,748 | 组装器 + 唯一 tool + 成员路由/派单/补员/撞顶续写/面板快照 |
| ② | `client.js` | 70,123 | 顶部整页 tab dsh-Team（React），零上下文税 |
| ⓪ | `src/util.js` | 4,298 | 落盘 / fmtTok / 短号（被 12 块读） |
| ⓪ | `src/config.js` | 21,446 | 路径探测 + 默认值 + stateDir（被 10 块读） |
| ⓪ | `src/persist.js` | 5,709 | 原子写 / appendLine / 诊断 |
| ⓪ | `src/state.js` | 2,033 | 进程内活态五 Map（members/boards/goals/ledger/retired） |
| ③ | `src/gears.js` | 8,577 | demand/effort/size→ctx→档位换算 + 实测封顶 |
| ④ | `src/ctxfacts.js` | 5,052 | 实测 ctx 上下限回填台账 |
| ⑤ | `src/errors.js` | 1,720 | classifyError + 路由故障类 |
| ⑥ | `src/errbook.js` | 20,322 | 报错账本 + 用户规则 + 撞墙/静默计时 + 日/周上限 |
| ⑦ | `src/errpush.js` | 16,854 | 报错投递：认人 + 定路 + 推送 |
| ⑧ | `src/lederr.js` | 10,760 | 队长报错暂存 |
| ⑨ | `src/accounting.js` | 4,924 | 被动真实运行记账 + 全局兜底监听 |
| ⑩ | `src/health.js` | 1,843 | derived health |
| ⑪ | `src/board.js` | 3,916 | boardFor / countParallelism |
| ⑫ | `src/mailbox.js` | 8,387 | Lead↔成员信箱 |
| ⑬ | `src/notify.js` | 2,893 | notices 通知队列 |
| ⑭ | `src/announce.js` | 4,125 | 全局公告板 + 内核会话清单 |
| ⑮ | `src/memberpool.js` | 9,085 | 退役成员池，补员冷唤醒复用 |
| ⑯ | `src/bans.js` | 4,355 | 禁用名单（永不复用） |
| ⑰ | `src/workdir.js` | 5,344 | 写根解析 / slug / teamMeta |
| ⑱ | `src/locks.js` | 11,557 | 文件锁 + 队内互斥 |
| ⑲ | `src/ledger.js` | 7,034 | 台账渲染 / applyAvailability / 历史（转引 collect） |
| ⑳ | `src/ofmstats.js` | 18,445 | OFM 面板实测统计（失败率/首字/TPS/ETA） |
| ㉑ | `src/score.js` | 15,637 | 战绩打分 / 置信 / 分级 |
| ㉒ | `src/selfreload.js` | 14,610 | 自热重载（清 ESM 缓存换 src/） |
| ㉓ | `src/freeledger/collect.js` | 36,731 | OFM catalog + 内核同步 + 探活 + 白名单 + **下架判死**（**最大模块**） |
| ㉔ | `src/freeledger/dispatch.js` | 22,583 | 派单可派性（`dispatchable` 唯一闸）+ createDispatcher 选路/撞顶换路 |
| ㉕ | `src/freeledger/pool.js` | 12,516 | 组级熔断 |
| ㉖ | `src/freeledger/whitelist.js` | 4,545 | 白名单 fromPatch + 免费特征猜测 |

- `src/` 28 块 = **285,301 B**；加上 ①② = **772,172 B**。
- **index.js 占 54.0%**——它不是薄桥，是"胖入口 + 一圈小积木"。这跟 context-mode「桥 9 块 56 KB、引擎 675 KB（11.9 倍）」正好相反：dsh-team 没有引擎子进程，重活全在入口里。
- 没有 bundle、没有 JSON-RPC、没有自愈复活：**成员就是宿主进程内的普通子代理激活**，跟 context-mode 那套 MCP stdio 桥完全是两条技术路线。
- **数字口径**：本表为 2026-11-16 实测（04 项目校准）。**再改动代码请同步本表**，
  `Updating\verify\verify-mirror.mjs` 的 ③-b/③-c/③-d 会逐项对拍，不同就红。
