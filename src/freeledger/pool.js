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
// freeledger/pool — 共享池与组级熔断（免费模型派单三层里的「池层」）
//
// 2026-11-02 模块化改造：这一段原来整块躺在 index.js 的 apply() 里（组级熔断区），
// 和派单、白名单、采集混在同一个大文件里，改一处要看五千行。现在按层拆开：
//   · collect.js   —— 采集：台账里这些条目从哪来（内核 / OFM / 探活）
//   · whitelist.js —— 判定之一：白名单读/写 + 免费特征识别
//   · pool.js      —— 判定之二：同账户共享池归组、整组熔断、探活恢复（本文件）
//   · dispatch.js  —— 派活：从台账里挑一条现在真能干活的路由
// 规矩：**判据只有一份**，别处一律 import/注入使用，不许复制第二份（六处 allow
// 硬闸改漏五处的事故就是这么发生的，2026-11-02 收口成 dispatchable 一个函数）。
//
// 逻辑与拆分前一字未改，只有三处形态变化：
//   1. 从 apply() 闭包搬进工厂 createGroupPool(deps)，闭包变量改成显式注入；
//   2. nextUtcMidnight / nextLocalMidnight / nextUtcMonday 原来从 errbook 解构，
//      现在由调用方注入（依赖方向：pool 不认识 errbook，只知道三个"算解禁时刻"的函数）；
//   3. touchRoute（脏键标记）注入 —— 组停时要把路由级 backoffUntil 一起抬上去。
// ---------------------------------------------------------------------------

import * as nodeFs from "node:fs";
import * as nodePath from "node:path";
import { stateDirPath } from "../config.js";
import { loadJson, saveJson } from "../util.js";

/** 组故障窗口/触发条数/默认停时 —— 全池共享额度时一条即熔断，普通故障要两条不同路由。 */
export const GROUP_FAULT_WINDOW_MS = 10 * 60 * 1000;
export const GROUP_TRIP_ROUTES = 2;
export const GROUP_HALT_MS = 24 * 60 * 60 * 1000;
/** 额度类故障 = **整池共享**（OPENCODE free 是同一个账户），一条撞上就代表全池没额度，
 *  不用等第二条不同路由也撞。时长按池子自己的重置节奏给，见 groupHaltUntil。
 *  注意：渠道暂停（eac 出口）不是额度类，不许进这个表 —— free 组和 eac 不联动封。 */
export const GROUP_QUOTA_CLASSES = new Set(["free-usage-limit-exhausted", "额度限流", "日限已满", "日限已满-本地0点", "模型账号池限流-有解禁时间"]);

/**
 * 建一套组级熔断器（每个插件实例一份内存 Map，跨实例靠 groups.json + mtime 同步）。
 *
 * @param deps {{
 *   nextUtcMidnight: (nowMs: number) => number,
 *   nextLocalMidnight: (nowMs: number) => number,
 *   nextUtcMonday: (nowMs: number) => number,
 *   touchRoute: (key: string) => void,   // 标记路由 dirty，落盘时该键覆盖磁盘
 * }} 由 index.js 注入（next* 来自 errbook）。
 */
export function createGroupPool(deps) {
	// --- 组级熔断（设计确定：）：OPENCODE 免费池是同一个第三方 /—— ledger 里 channel:"free" 那批
	//     （big-pickle/flint-40b-free/mimo-v2.6-flash-free/nemotron-*/jev/deepseek/glm/beam）。
	//     组内 2 条不同路由在窗口内撞墙 = 全组没额度，组内换模型纯空转；整组停 24 小时，
	//     到期只放**一条**路由去探活，探活成功才放全组回来。EAC/Kilo/acct 各是独立池，按模型算。
	const groupsPath = nodePath.join(stateDirPath(), "groups.json");
	const nextUtcMidnight = deps.nextUtcMidnight;
	const nextLocalMidnight = deps.nextLocalMidnight;
	const nextUtcMonday = deps.nextUtcMonday;
	const touchRoute = deps.touchRoute;

	function groupHaltUntil(errClass, nowMs, explicitMs) {
		// ① 最硬的一条：服务端明写的解禁时间（`将于 2026/11/2 00:00:00 解禁`）。
		//    2026-11-01 实测：qodercn 先报日限（本地 0 点），两小时后又报
		//    「账号池均在限流中，最近一个将于 2026/11/2 00:00:00 解禁」——
		//    是同一天解禁，但**这是服务端告诉我们的时间**，比实现方推算的可信。
		if (Number.isFinite(explicitMs) && explicitMs > nowMs) return explicitMs;
		if (errClass === "free-usage-limit-exhausted") return nextUtcMonday(nowMs); // 周配额
		// qodercn 日限是**本地** 0 点重置（上游原文 `00:00:00` 不带时区 = 本机时区）。
		if (errClass === "日限已满-本地0点") return nextLocalMidnight(nowMs);
		if (errClass === "额度限流" || errClass === "日限已满") return nextUtcMidnight(nowMs); // 日配额
		return nowMs + GROUP_HALT_MS;
	}
	const groupHalt = new Map(); // gid -> { until, faults:[{key,at,cls}], probe, strikes }
	for (const [gid, st] of Object.entries(loadJson(groupsPath, {}))) groupHalt.set(gid, st);
	// 组停状态在**文件里**是跨会话共享的，但插件每会话一个实例、各有一份内存 Map。
	// 维护方 10-29 改完文件重启用插件后，面板还显示旧的到期时间 —— 别的会话的实例
	// 内存里还是旧值。按 mtime 做正向同步：文件比内存新就整块重读（面板轮询会带出来）。
	let groupsMtime = (() => { try { return nodeFs.statSync(groupsPath).mtimeMs; } catch { return 0; } })();
	const syncGroupsFromDisk = () => {
		try {
			const m = nodeFs.statSync(groupsPath).mtimeMs;
			if (m === groupsMtime) return;
			groupsMtime = m;
			groupHalt.clear();
			for (const [gid, st] of Object.entries(loadJson(groupsPath, {}))) groupHalt.set(gid, st);
		} catch { /* 文件暂不可读就按内存里的走 */ }
	};
	const saveGroups = () => {
		saveJson(groupsPath, Object.fromEntries(groupHalt));
		try { groupsMtime = nodeFs.statSync(groupsPath).mtimeMs; } catch { /* ignore */ }
	};
	/** 组归属：channel==="free" = OPENCODE 免费池（9 条匿名路由），**成组禁用，本来就有**，
	 *  周配额一条即熔断整组停。EAC（channel:"eac"，GitHub star 解锁）是独立出口：
	 *  维护方 10-30 定「EAC 的不跟 OPENCODE 成组」——eac 路由撞墙（含 model 带 opencode 前缀那两条）
	 *  只按模型退避，不联动 OPENCODE 组停，也不自成一组。其余通道一律 model 级（null）。
	 *
	 *  2026-11-01 维护方抓到第二个共享池：`qodercn` 名下所有模型共享同一份额度 ——
	 *  「看来 QODERCN 下面的模型共享」。实录：同一天里 qfmodel / gfmodel / dfmodel
	 *  在 2 分钟内接连撞 `Billing daily count exceeded`，三条不同模型撞的是同一堵墙。
	 *  它们 channel 是 "acct"（不是 free），所以原来按 model 级退避 → 换一个 qodercn
	 *  模型接着撞，浪费一整轮。现在按 **provider** 成组，qodercn 下任一条撞日限就整组停
	 *  到本地 0 点。
	 *
	 *  只对 qodercn 生效，**不泛化到别的 acct provider**（cline/loomy/raccoon 是否共享额度
	 *  没有实测证据，猜错就会把好好的路由跟着一起封掉）。 */
	const SHARED_QUOTA_PROVIDERS = new Set(["qodercn"]);
	const groupIdOf = (entry) => {
		if (entry === undefined || entry === null) return null;
		if (entry.channel === "free") return "our-free-model/free";
		if (SHARED_QUOTA_PROVIDERS.has(String(entry.provider || ""))) return `provider/${entry.provider}`;
		return null;
	};
	/** 组停判定：停着就 true；到期后只放一条探活路由，其余继续停。 */
	function groupHalted(entry) {
		const gid = groupIdOf(entry);
		if (gid === null) return false;
		syncGroupsFromDisk();
		const st = groupHalt.get(gid);
		if (st === undefined) return false;
		const key = entry.provider + "/" + entry.model;
		if (st.until > Date.now()) return true;
		// 到期：单条探活。第一条来问的路由当探针，其它照停，免得整组同时再撞一遍。
		if (st.probe === null || st.probe === undefined) { st.probe = key; saveGroups(); return false; }
		return st.probe !== key;
	}
	/** 撞墙记账。触发：从未停过时需 ≥2 条不同路由；停过后再撞（探活失败）直接续停 24h。 */
	function noteGroupFault(entry, errClass, explicitMs) {
		const gid = groupIdOf(entry);
		if (gid === null) return "";
		const now = Date.now();
		const st = groupHalt.get(gid) || { until: 0, faults: [], probe: null, strikes: 0 };
		st.faults = (st.faults || []).filter((f) => now - f.at < GROUP_FAULT_WINDOW_MS);
		st.faults.push({ key: entry.provider + "/" + entry.model, at: now, cls: errClass });
		const distinct = new Set(st.faults.map((f) => f.key)).size;
		// 额度类：1 条即熔断 —— 整池共享额度，换组内别的模型撞上去只是再浪费一次请求。
		// 普通故障（路由 bug、地区封锁之类）：仍旧要 2 条不同路由才算全组坏。
		const quota = GROUP_QUOTA_CLASSES.has(errClass);
		if (st.until > 0 || distinct >= (quota ? 1 : GROUP_TRIP_ROUTES)) {
			st.until = groupHaltUntil(errClass, now, explicitMs);
			st.probe = null;
			st.strikes = (st.strikes || 0) + 1;
			groupHalt.set(gid, st);
			saveGroups();
			// 2026-11-01 维护方报「改好的东西凭空消失」：额度是**池级**的，但 `backoffUntil`
			// 是**路由级**的字段。组停一立，路由级那个 2 分钟短退避就没有任何意义 ——
			// 池子整组停着，它自己到期了也派不出去；面板和评分表却会读它，以为
			// 「再过两分钟就好了」。实测就出现过：磁盘上 backoffUntil 被别的实例
			// 按 2 分钟写回（16:02:23），面板却显示「组停到 11-02 00:05」——两个数打架。
			// 处置：组停生效时把这条路由的退避也拉到同一时刻。这是事实对齐，不是新判断。
			//
			// 但**光写字段不够**（2026-11-01 实测）：别的会话的插件实例各有旧内存台账，
			// 每 10 秒无条件写盘，这个字段会被它们按 2 分钟的短退避写回去。
			// 所以真正稳的做法是**读的时候也行**：见 `effectiveBackoff(entry)` ——
			// 组停在一律取两者的较大值。写是尽力，读才是保证。
			if (entry !== undefined && entry !== null && Number(entry.backoffUntil || 0) < st.until) {
				entry.backoffUntil = st.until;
				touchRoute(`${entry.provider}/${entry.model}`);
			}
			const when = new Date(st.until).toISOString().slice(0, 16).replace("T", " ");
			const why = quota ? "整池共享额度，1 条即熔断" : `${distinct} 条撞墙`;
			return `${gid} 组熔断（${errClass}，${why}）：整组停到 ${when}Z（约 ${Math.ceil((st.until - now) / 3600000)} 小时），到期单条探活；其它池不受影响`;
		}
		groupHalt.set(gid, st);
		saveGroups();
		return "";
	}
	/** 探活成功：整组恢复。 */
	function clearGroupHalt(entry) {
		const gid = groupIdOf(entry);
		if (gid === null) return "";
		const st = groupHalt.get(gid);
		if (st === undefined || st.until <= 0) return "";
		groupHalt.delete(gid);
		saveGroups();
		return `${gid} 组探活成功，整组恢复可派（之前停了 ${st.strikes} 轮）`;
	}

	/** **这条路由实际停到什么时候** —— 退避时刻的唯一读口。
	 *
	 *  为什么不能直接读 `entry.backoffUntil`（2026-11-01 维护方报「改好的东西凭空消失」）：
	 *  额度是**池级**的，`backoffUntil` 是**路由级**的字段。组停一立，路由级那个
	 *  2 分钟短退避就没有意义了 —— 池子整组停着，它自己到期也派不出去。
	 *  更麻烦的是**多个会话各有插件实例**，各持一份旧内存台账，每 10 秒无条件写盘；
	 *  刚对齐到「本地 0:05」的那个字段，几秒后就被别的实例按 2 分钟写回去
	 *  （实测：16:02:23 反复回潮，面板「组停到 11-02 00:05」和它打架）。
	 *
	 *  写字段是尽力，**读的时候取较大值才是保证**：组停生效时，这条路就停到组停那个时刻。
	 *  语义上也对 —— 「什么时候能派」本来就该由更长的那个约束说了算。 */
	function effectiveBackoff(entry) {
		if (entry === undefined || entry === null) return 0;
		const own = Number(entry.backoffUntil || 0);
		const gid = groupIdOf(entry);
		if (gid === null) return own;
		syncGroupsFromDisk();
		const st = groupHalt.get(gid);
		if (st === undefined || Number(st.until || 0) <= 0) return own;
		return Math.max(own, Number(st.until));
	}

	return {
		groupsPath,
		groupHalt,
		syncGroupsFromDisk,
		saveGroups,
		groupIdOf,
		groupHalted,
		noteGroupFault,
		clearGroupHalt,
		effectiveBackoff,
		groupHaltUntil,
	};
}
