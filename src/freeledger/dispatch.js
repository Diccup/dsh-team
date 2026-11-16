/*
 * ============================================================================
 * 本文件由 AI 辅助生成（AI-generated / AI-assisted）。
 *
 * 免责声明：
 *   本项目不对正确性、稳定性、适销性或特定用途适用性作任何明示或默示担保。
 *   使用本插件造成的任何直接或间接损失，作者与团队均不承担责任。
 *   请自行评估风险，并优先遵守所在地区的法律法规与服务商协议。
 *   完整声明见仓库根目录的 DISCLAIMER.md。
 * ============================================================================
 */
// ---------------------------------------------------------------------------
// freeledger/dispatch — 派活：从台账里挑一条**现在真能干这活**的路由
//
// 2026-11-02 模块化改造：这一段原来整块躺在 index.js 的 apply() 里
// （maxCtxK / dispatchable / pickRoute）。派单是免费模型模块最敏感的一层 ——
// 白名单口径、共享池熔断、ctx 硬闸、评分排序全在这一个函数里交汇。以前它们
// 和采集、面板、消息路由混在 5800 行的 index.js 里，改一处派单规则要在巨文件里
// 上下来回翻，还漏过「六处 allow 硬闸只改一处」的事故。
//
// 现在拆开，派活层**只消费**、不重新定义任何判据：
//   · 条目从哪来          → collect.js（不关派单的事）
//   · 白名单口径          → dispatchable()（本文件唯一闸；whitelist.js 只管读/写名单）
//   · 整组熔断 / 有效退避 → pool.js 注入进来（effectiveBackoff / groupHalted）
//   · 档位阶梯 / ctx 换算 → gears.js / util.js 直接 import
//   · 可靠性四档          → score.js 的 TIER_ORDER（判据一份，客户端也读它）
//   · OFM 实测速度/失败率 → ofmstats.js 直接 import
//
// 逻辑与拆分前一字未改。形态只变两点：
//   1. 从 apply() 闭包搬进工厂 createDispatcher(deps)，闭包变量（routeOccupancy、
//      leadRouteKeys、routeScore、scoreTableNow、cfg、pool）改成显式注入；
//   2. dispatchable() 从闭包函数提到模块函数（入参加 ledger），仍是**唯一口径**。
// ---------------------------------------------------------------------------

import { ledger, members } from "../state.js";
import { ctxUsableK } from "../util.js";
import { sizeCtxK, sizeKey, ctxK, effortLadder, SIZE_CTX_K } from "../gears.js";
import { ofmRank, ofmSpeedRank, pct, ofmEtaSeconds, ofmEtaText } from "../ofmstats.js";
import { TIER_ORDER } from "../score.js";
import { whitelistFromPatch } from "../ledger.js";

/**
 * 「这条路由现在能不能进派单池」——唯一口径（2026-11-02 收口）。
 *   ① status 必须是 ok；
 *   ② whitelist 是 allow → 能；
 *   ③ whitelist 是 unknown（内核同步时白名单文件读不到，见 src/ledger.js
 *      syncFromKernel 的 wlKnown 分支）→ 只有**池里一条 allow 都没有**时才放行。
 *      这条是发包踩雷第 4 条的后半段：别人机器上 profile 没配 allowedModels 时，
 *      内核列出的全被标 unknown，硬闸会把它们全挡死 → 「一个模型都派不出去」，
 *      和台账空是同样的后果。网关真不放行时报错归「白名单未开」，台账跟着转
 *      closed、不再派它 —— 试错是有收口的，不会无限烧。
 *   以前这个判据散在六处（pickRoute / poolOk / 无 ctx 报错 / spawn 备选 /
 *   vision 候选 / 台账摘要），改一处忘一处就是事故现场。现在六个点全调这一个函数。
 */
export function dispatchable(e) {
	if (e === undefined || e === null) return false;
	// ★ 2026-11-16 修（Updating\03）：「内核目录已下架」= 已经判过死的路由，
	//   **不看 status 直接出局**。
	//   位置必须在下面那条 status 硬闸**之前**：放在后面会被 `status==="ok"`
	//   那条提前 return true 掉 —— 台账里 5 条 delisted 里正好 2 条是 ok
	//   （liquid/lfm-2.5-2.6b:free、deepseek-ai/deepseek-v4.1-flash）。
	//   为什么非补不可：delisted 是 2026-11-01 立的标记，**当时没有任何一处消费它** ——
	//   检查机制在、消费环节断了 14.9 天；mistral-large-4-1t-a52b 就是这样在
	//   下架 14.9 天后仍被派出去，撞内核 UNSUPPORTED_REASONING_EFFORT。
	if (e.delisted === true) return false;
	// 硬闸只留「确证的死」：invalid（实测判废）/ lead（队长路由）/ 白名单闸。
	// ★ status==="unknown"（待实测）**不再一票否决**（2026-11-02 维护方抓死锁）：
	//   unknown 翻成 ok 的唯一通道是 realResult==="ok"，而 realResult 只能靠真派
	//   一次攒出来。旧写法把 unknown 挡在池外 =「没派过→没证据→永远不许派」——
	//   本机 31 条 allow 的路由（cline 全家 16 条、loomy/spark-x2.6、raccoon 等）
	//   全冻死在这行上；别人机器没有 OFM 实测兜底，池子直接空，表现成
	//   「装完台账灰一片、插件永远不派成员」。unknown 是「没证据」不是「死了」，
	//   和 ctx 未实测同性质 —— 处置也照 ctx 试跑的规矩：排序压后、跑废一次
	//   realResult=fail → status=invalid，试错有收口，不会无限烧。
	if (e.status !== "ok" && e.status !== "unknown") return false;
	if (e.whitelist === "allow") return true;
	if (e.whitelist !== "unknown") return false;
	for (const x of ledger.values()) if (x.whitelist === "allow" && (x.status === "ok" || x.status === "unknown")) return false;
	return true;
}

/**
 * 任务的合法 kind 枚举 = 下面 KIND_HINT 的档位表。
 * 2026-11-02 e2d599f2 压测发现 kind 拼错被静默接受（查不到落回通配正则，
 * 名字偏好整层失效还看不出来）—— 校验必须和消费端同源，所以枚举住在这里，
 * index.js 的建单/set 校验 import 它，不再手写第二份清单。
 */
export const TASK_KINDS = new Set(["grunt", "code", "design", "probe"]);

/**
 * 建派单器（每个插件实例一份；依赖由 index.js 注入）。
 *
 * @param deps {{
 *   cfg: object,
 *   routeOccupancy: () => Map<string, unknown[]>,     // 每条路由当前被几个成员占
 *   leadRouteKeys: () => Set<string>,                 // 队长在用的路由（规矩上不派给成员）
 *   routeScore: (route: string, effort: string, kind: string) => number | null,
 *   scoreTableNow: () => { table: Map<string, { tier: string }> },
 *   effectiveBackoff: (entry: object) => number,      // ← pool.js
 *   groupHalted: (entry: object) => boolean,          // ← pool.js
 * }}
 */
export function createDispatcher(deps) {
	const cfg = deps.cfg;
	const routeOccupancy = deps.routeOccupancy;
	const leadRouteKeys = deps.leadRouteKeys;
	const routeScore = deps.routeScore;
	const scoreTableNow = deps.scoreTableNow;
	const effectiveBackoff = deps.effectiveBackoff;
	const groupHalted = deps.groupHalted;

	/** Largest catalog ctx in the pool, for honest "no route is big enough" errors. */
	function maxCtxK() {
		let max = 0;
		for (const e of ledger.values()) {
			if (!dispatchable(e)) continue;
			const c = ctxUsableK(e);
			if (c !== null && c > max) max = c;
		}
		return max;
	}

	/** D2 step 1: pick a route for a task. ctx is the HARD gate; out only decides how
	 *  many batches to write in. Anything the catalog does not state is "不可承诺":
	 *  such routes are allowed for size s only, and the reason says so. */
	function pickRoute(kind, size, leadId, exclude, opts) {
		const opt = opts === undefined || opts === null ? {} : opts;
		// needCtx 可以被子任务实测抬起来（opt.needCtx / task.ctxMin）：压缩次数是硬证据，
		// 它一旦抬了门槛，所有派单入口都必须照它筛，否则换了人又挑回一条同样小的路由。
		// 2026-10-31（隔壁实测 + 设计确定：）：必须由调用方把 task 传进来，不再让各入口各自算。
		const raised = Number(opt.needCtx);
		const needCtx = Number.isFinite(raised) && raised > 0 ? raised : sizeCtxK(size);
		// 需要读图：只有台账里明确 vision===true 的路由能接。`null`（未知）一律不派 ——
		// 未知派出去就是 400/图像被静默丢弃，比派不出去更坏。
		const needVision = opt.vision === true;
		const occ = routeOccupancy();
		const leadKeys = leadRouteKeys();
		const skip = new Set(Array.isArray(exclude) ? exclude : []);
		// 同路由同时只跑 1 个是硬约束，所以这里自己错开：本队成员已经占着的路由不再选，
		// 否则连着 spawn 两个会挑到同一条（描述里已不再要求 Lead 手动错开）。
		for (const m of members.values()) if (m.parentSessionId === leadId) skip.add(`${m.provider}/${m.model}`);
		const KIND_HINT = {
			code: /code|coder|dev|qwen|deepseek|gpt-oss|glm/i,
			design: /glm|nemotron|super|reason|vl/i,
			probe: /mini|nano|small|flash|lightning|solar|lfm/i,
			grunt: /.*/,
		};
		const kk = String(kind === undefined || kind === null ? "grunt" : kind).trim().toLowerCase();
		const hint = KIND_HINT[kk] === undefined ? /.*/ : KIND_HINT[kk];
		// 白名单闸统一走 dispatchable()（2026-11-02 收口：以前这里、池空报错、
		// spawn 备选、vision、摘要各写一遍，改一漏一）。
		const rows = [];
		for (const e of ledger.values()) {
			if (!dispatchable(e)) continue;
			const key = e.provider + "/" + e.model;
			if (skip.has(key)) continue;
			if (leadKeys.has(key)) continue; // 队长在用：规矩上不派给成员
			// 「什么时候能派」取路由退避和组停的**较大值** —— 池子整组停着的时候，
			// 路由级那个 2 分钟短退避毫无意义（见 effectiveBackoff 的注释）。
			if (effectiveBackoff(e) > Date.now()) continue;
			if (groupHalted(e)) continue; // free 组熔断：组内换模型是空转，直接跳到别的池
			if (needVision && e.vision !== true) continue; // 读图的活：未知/不支持都不派
			const ctx = ctxUsableK(e);
			// ------------------------------------------------------------------
			// ctx 闸（2026-11-01 维护方报「为啥未测还有 6 个？隔壁调用了好几次了」）。
			//
			// 老写法 `if (ctx === null || ctx < needCtx) continue;` 把两件**性质不同**的
			// 事并成一个判据，结果是**证据采集的第二重死锁**（第一重是排序，上面那大段）：
			//
			//   ① `ctx === null` —— 目录没写标称、也没测过。这是「不可承诺」，不是
			//      「不够」。老写法把它和「太小」一起 continue 掉，可它**唯一拿到
			//      实测数据的办法就是被派一次**。绝不派 → 永远 null → 永远不派。
			//      文件末尾那个 `blind` 兜底救不了它：那条兜底只在「一条候选都没有」
			//      时才走（本机 24 条 ok+allow 里 17 条有 ctx，永远轮不到）。
			//   ② `ctx < needCtx` —— 有数据但不够。这里还要再分一层：
			//      `capK`（撞顶原文给出的硬上限）是真上限，不够就**真的别派**，
			//      派了必然撞 400，纯浪费一轮。
			//      而 `seenMax` 只是「正常跑完过的最大输入」，那是**下界**不是上限
			//      —— 17K 只证明「17K 能跑」，不证明「20K 跑不了」。老写法拿它当
			//      上限用，于是这条路由永远被挡在 s(128K) 门外，也就永远不可能跑出
			//      比 17K 更大的 seenMax。自我锁定，和 ① 一模一样的形状。
			//      （本机实例：cline/nvidia/nemotron-3.5-super-vl:free，seenMax=17693）
			//
			// 新判据：真硬顶（capK）不够 → 不派；其余「没有可信上限」的 → 允许**试跑**。
			// 试跑不是无条件放行，有两个闸：
			//   · `ctxTry` 只有 size=s 才给（128K 是这套插件认的最小档，维护方原话
			//     「从小派」）；更大的活试跑就是拿一趟必然撞顶的请求烧额度。
			//   · 试跑的路由**排在同档最后**（sort 里 tierOf 后面那一段），有可信
			//     数据的路由永远先被挑中。试跑是「没人的时候给它一次机会」，
			//     不是「和推荐路由平起平坐」。
			// 试跑跑完，`recordRealRun` 会把这一轮的 inputTokens 写进 seenMax、
			// 把撞顶写进 capK —— 两条腿都落地，下一次就有可信数据了。
			// 硬顶有两个来源，都算「真上限」，不够就真别派：
			//   · `capK`   —— 运行时撞顶，服务端原文给出的数字（recordRealRun 自学习写进去的）；
			//   · `ctxRaw` —— 目录标称不可信、人工/实测确认过的上限（applyMeasuredCtx 写的，
			//                台账里显示成 `64K` 这种确定值，不是 `未advertised`）。
			// 反例（别搞混）：`seenMax` 是「正常跑完过的最大输入」，那是**下界**。它不在
			// 这个名单里，因为它只证明「这么大能跑」，不证明「再大跑不了」。
			const capCandidates = [Math.floor(Number(e.capK) || 0), Math.floor((Number(e.ctxRaw) || 0) / 1024)];
			const hardCap = capCandidates.reduce((m, v) => (v > 0 && (m === null || v < m) ? v : m), null);
			if (hardCap !== null && hardCap < needCtx) continue; // 实测硬顶不够：真别派
			const ctxTrustworthy = ctx !== null && ctx >= needCtx;
			if (!ctxTrustworthy && needCtx > SIZE_CTX_K.s) continue; // 只有 s 档允许试跑
			// 打分表消费端：按**同类 kind**的历史通过率给优先级（null = 样本不足不表态）。
		// 用该路由在台账里的候选档位来查账本（账本键含 @effort，档位要尽量对上才有数据）。
		const gradeFor = (e) => {
			if (cfg.scoreWeighted !== true) return null;
			const ladder = effortLadder(e);
			const cands = ladder.length === 0 ? [String(opt.effort || "medium")] : ladder;
			let best = null;
			for (const g of cands) {
				const v = routeScore(e.provider + "/" + e.model, g, kk);
				if (v !== null && (best === null || v > best)) best = v;
			}
			return best;
		};
		// L24 修③（2026-11-16 维护方演示轮实录）：auto7/auto8 相隔 32ms 起给两条 cline :free
		// 路由，双双撞「额度已用尽 HTTP 402」报废。回查台账：两条的 realAt 都停在 **11-15**
		// —— 两天前的旧"ok"。免费池按日重置，昨天的 ok 对今天没有任何承诺力，
		// 而 pickRoute 只看 dispatchable（status ok/unknown），证据新旧完全不看。
		// 处置：**同档内证据过旧（>24h）的押后**，新证据的先上。只动顺序、不动候选
		// —— 设计确定：的红线照旧（历史实测是证据，不是可用性开关），未测仍排最前。
		const stale = e.realResult === "ok" && Date.now() - Number(e.realAt || 0) > 24 * 3600 * 1000;
		rows.push({ e, key, ctx, trust: ctxTrustworthy, out: ctxK(e.out), busy: (occ.get(key) || []).length, hinted: hint.test(e.model), grade: gradeFor(e), ofm: ofmRank(e), eta: ofmSpeedRank(e), stale });
		}
		if (rows.length > 0) {
			// 2026-11-01 修：tierOf 原来读的是快照处理函数里的局部 `scoreTable`（那个 const 在
			// snapshot 分支里，根本不在本函数作用域内），所以任何一次**真正走到选路**的调用
			// （autoFillOne / create 预指派 / spawn）都会抛 `scoreTable is not defined`。
			// 之前的真派全发生在这个四档改造之前，所以一直没暴露；兜底的 catch 又把这个名字
			// 错误当成「表算不出来」静默吞掉，表现成「插件不发人」而不是报错。
			// 现在在函数作用域里取一次（内部 30 秒缓存，不会因为排序比较器多次调用就读盘）。
			const scoreTable2 = scoreTableNow();
			// =====================================================================
			// 派活顺序（维护方 2026-11-01 两次修正后的最终版，和右侧显示顺序**故意不同**）：
			//
			//   未测 → 推荐 → 可用 → 被占（押后）→ 不稳
			//
			// 「未测」为什么要排最前（维护方原话）：「先派未测，再派推荐-可用-不稳，
			//   否则未测永远是未测，除非前面的全挂了。」
			// 这是**证据采集的死锁**，不是排序偏好：未测 = 样本 < MIN_RUNS，
			//   而样本只能靠真派增长。只要永远从推荐开始挑，未测就永远轮不到，
			//   永远攒不到样本，永远判未测。想让它转正，就得先给它上场的体力。
			//   跑够 MIN_RUNS 次它自然落进推荐/可用/不稳，之后按老顺序走。
			//
			// 「被占」为什么押后：那条正被别的成员占着（同一路由不许并发），
			//   再派就是重复占用。占用是**当前状态**不是可靠性，所以不进评分，
			//   只在排序时压到「可用」与「不稳」之间（空闲的先用完再轮到它）。
			//
			// 「不稳」永远最后但**永远是候选**：不稳 = 能用但经常出问题，
			//   不是不可用。前面全挂了照样派得出去（这是设计确定：的红线）。
			//
			// 每一档的判据**只有一份**，在 src/score.js 的 tierOf（客户端和这里都读它）。
			// 档位号由 TIER_ORDER 定义（未测 0 / 推荐 1 / 可用 2 / 不稳 3）。
			// =====================================================================
			// 2026-11-01 维护方报的 BUG：「插件派人顺序要改改，要先派未测，再派推荐-可用-不稳，
			// 否则未测永远是未测，除非前面的全挂了。」—— TIER_ORDER 已经把未测排到最前
			// （见 src/score.js 那段注释：这是证据采集的死锁，不是排序偏好）。
			// 这里只保留「被占」的临时压后：占用不是可靠性，压到「可用」和「不稳」之间 ——
			// 既让空闲的未测/推荐先上，也不至于把被占的路由扔到跟「不稳」同一档去。
			const tierOf = (row) => {
				const e = row.e;
				const s = scoreTable2.table.get(`${e.provider}/${e.model}`);
				const base = s === undefined ? TIER_ORDER["未测"] : TIER_ORDER[s.tier];
				// 0 未测 / 1 推荐 / 2 可用 / 3 不稳；被占 → 2.5（可用与不稳之间）
				if (row.busy > 0 && base < 2.5) return 2.5;
				return base;
			};
			// 排序优先级（2026-10-31 加打分表）：先按**同类战绩**，再按上面的五档，
			// 最后是速度/名字偏好/ctx。战绩只在本 kind 内比较，样本不足（null）当并列。
			// 2026-11-01（拆 OFM）两层 OFM 实测做平手裁决：
			//   ① 可靠性（失败率判档）已在 tierOf 里体现；
			//   ② 速度（预计干完要几秒）：**同档内快的优先**。
			// 为什么要有② —— 说明：「一个稳定的16TOK/S跟一个比较稳定100TOK/S，你觉得你应该知道选哪个吧」。
			// 真机里 16tok/s 要 93 秒、151tok/s 只要 9 秒，差 10 倍却靠运气。
			// 速度按「首字延迟 + 1000token / tok/s」折算成秒，不是裸 tok/s ——
			// 首字才是差距最大的那段（30.5s vs 2.6s），只比 tok/s 会选出慢开局的路由。
			// 这些都**只影响顺序、不影响候选**：不稳的仍然可以被派到，只是排在最后。
			// 这是设计确定：的红线：历史实测是证据，不是可用性开关（QODER 只排除不恢复的坑）。
			rows.sort((a, b) => tierOf(a) - tierOf(b)
				|| (b.trust ? 0 : 1) - (a.trust ? 0 : 1)   // 可信 ctx 的永远先于试跑的
				|| (a.stale ? 1 : 0) - (b.stale ? 1 : 0)   // L24 修③：同档内证据 >24h 的押后（只排序不淘汰）
				|| (b.grade === null ? 0.5 : b.grade) - (a.grade === null ? 0.5 : a.grade)
				|| a.eta - b.eta
				|| (b.hinted ? 1 : 0) - (a.hinted ? 1 : 0)
				|| a.ctx - b.ctx);
			const b = rows[0];
			const ctxSrc = ctxK(b.e.ctx) !== null ? "标称" : "实测下限";
			// 同档里最快的那个差多少 —— 让队长看得见"为什么不是别人"。
			const fastest = rows.slice().sort((x, y) => x.eta - y.eta)[0];
			const why = (b.trust
				? `ctx ${ctxSrc} ${b.ctx}K ≥ 需要 ${needCtx}K（size ${sizeKey(size)}）`
				: `ctx 未实测（没有可信上限，不是不够）—— 按 size ${sizeKey(size)} **试跑一次**，跑出实测再判能不能接`)
				+ (b.e.realResult === "ok" ? "，真派过" : "，未真派验证")
				+ (b.busy === 0 ? "，当前无人占用" : `，有 ${b.busy} 个占用`)
				+ (b.e.ofm === undefined || b.e.ofm === null
					? ""
					: `，OFM 实测 ${b.e.ofm.calls}次/错${pct(b.e.ofm.failRate)}（${b.e.ofm.state}）`
						+ (ofmEtaSeconds(b.e.ofm) === null ? "" : `，预计 ${ofmEtaText(b.e.ofm)}`)
						+ (fastest === undefined || fastest.eta === b.eta ? "，本组最快" : `，比最快的 ${fastest.e.provider}/${fastest.e.model} 慢 ${Math.round((b.eta - fastest.eta) * 10) / 10}s`))
				+ (b.hinted && kk !== "grunt" ? `，kind=${kk} 名字偏好匹配（按模型名猜，无实测分）` : "");
			return { entry: b.e, why, out: b.out };
		}
		// 走到这里说明**一条候选都没有**。以前这里只有一条「blind」兜底，而且被
		// `needCtx > SIZE_CTX_K.s` 挡着 —— 那条兜底的本意是「池子里没有任何带 ctx
		// 数据的路由时，拿一条无数据的试试」，但它要求 size>s，而 s 恰恰是最常见的档。
		// 加上上面那个新 ctx 闸（s 档已经允许试跑），`rows.length > 0` 在 s 档几乎
		// 必然成立，这条兜底实际上**从来走不到**。留着它是死代码，删掉换成一条
		// 说得清楚的错误：真的没有可派路由了，把原因分清楚。
		//
		// 分四种情况报错，因为队长要做的动作完全不同：
		//   ① 台账是空的         → 内核没列出任何东西，team(scan) 都救不了 → 重启/查内核
		//   ② 有条目但全不是 ok   → 待实测/失效，去 team(models) 看具体哪条、或 scan 刷新
		//   ③ 全被白名单关在外面 → 读白名单去的是 cfg.whitelistPatchPath，
		//      报出这个路径 —— 别人机器上 profile 名不对时，这是唯一的线索（2026-11-02 踩雷第 4 条）
		//   ④ 有路由但全在退避/熔断 → 等解禁，不用动手
		const poolOk = Array.from(ledger.values()).filter(dispatchable);
		if (poolOk.length === 0) {
			if (ledger.size === 0) {
				return { error: `台账是空的（一条模型都没有）。内核 llm 没列出任何路由 —— 先 team(action:"scan")；还不行就是内核刚启动没就绪，等 8 秒再 scan 一次` };
			}
			const wlPath = String(cfg.whitelistPatchPath || "");
			const wlReadable = whitelistFromPatch(cfg) !== null;
			const closedN = Array.from(ledger.values()).filter((e) => e.whitelist === "closed").length;
			if (wlReadable && closedN > 0) {
				return { error: `可派路由池是空的：${wlPath} 里 allowedModels 一条都没放行这台机器上要用的路由（台账 ${ledger.size} 条、${closedN} 条被白名单关着）。要么在该 profile 的 cordis.patch.yml 加进 allowedModels（改完要重启，内核只在启动时读这个文件），要么 team(action:"scan") 重收一遍` };
			}
			return { error: `可派路由池是空的（${ledger.size} 条台账里没有一条 status=ok 且白名单放行的）；先 team(action:"scan") 同步模型目录，再 team(models) 看状态` };
		}
		const cooling = poolOk.filter((e) => effectiveBackoff(e) > Date.now() || groupHalted(e));
		if (cooling.length >= poolOk.length) {
			// 整池都在冷却：这不是队长能解决的问题
			return { error: `可派路由全在退避/组熔断（${cooling.length}/${poolOk.length} 条），等解禁；要提前试就 team(action:"models", reset:"efforts") 之后重派` };
		}
		return { error: `没有 ctx 能满足 ${needCtx}K（size ${sizeKey(size)}）的可派路由；s 档试跑也找不到人（冷却 ${cooling.length}/${poolOk.length} 条，其余被占、队长在用或 ctx 被排除）` };
	}

	return { maxCtxK, pickRoute, dispatchable };
}
