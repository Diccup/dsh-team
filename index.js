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
// dsh-team — local agent-team runtime with live model routing and a
// self-maintaining free-model ledger. One `team` tool, no per-member tax.
//
// Design ground (all source-verified against the shipped packages, see
// PLAN.md §1): members are plain in-process subagent activations
// (`ctx.subagents.startActivation`); route overrides ride `agent.model.select()`
// — the kernel's own selection channel — written ahead of every dispatch, plus the
// `system-prompt/assemble` waterfall for the prompt variables, so a cold-resumed
// descriptor snapshot can never beat the roster's target route; passive
// real-run accounting comes from `agent/request-error` and `subagent/end`.
//
// 2026-11-07（0.2.2-rc.1）：内核在 prepareRequest 里加了硬校验 —— `agent/request`
// 返回的 provider/model/reasoningEffort 必须与 step 开始时定下的 selection 完整段
// 相等，否则抛 "after step preparation fixed …; use agent.model.select() before
// step preparation"。旧写法（在 agent/request 里强行改写）在旧内核上可用、新内核上
// 必炸，故改为写 model/selection；旧内核（无 agent.model.select）仍保留原覆写。
//
// No external imports on purpose: profile-linked bundles cannot assume
// @deepseek-ai/* resolves, and a plain tool definition object is what
// `tools.register` consumes (verified against dsh-context-mode).
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import * as nodeFs from "node:fs";
import * as nodePath from "node:path";
import * as nodeZlib from "node:zlib";
import { CONFIG_DEFAULTS, stateDirPath, setStateDir } from "./src/config.js";
import { dayStamp, ledgerMdPathOf, loadJson, saveJson, fmtTok, fmtUsed, ctxUsableK, shortOf } from "./src/util.js";
import { EFFORT_RANK, DEMAND_DEFAULT, SIZE_CTX_K, CTX_TIERS_K, demandRank, sizeCtxK, sizeKey, nextCtxTierK, taskNeedCtx, ctxK, gearTokens, measuredGears, effortLadder, gearAt, effortCapRank, effortFor } from "./src/gears.js";
import { MEASURED_CTX_MIN, MEASURED_CTX, applyMeasuredCtxMin, applyMeasuredCtx, applySeenMax } from "./src/ctxfacts.js";
import { classifyError, ROUTE_FAULT_CLASSES } from "./src/errors.js";
import { members, retiredMembers, rememberRetired, boards, goals, ledger } from "./src/state.js";
// 2026-11-02 设计确定：「每次起一个成员都是新调用一个子智能体，完全没有复用」——
// 退役成员的会话登记进「成员池」，补员优先冷唤醒复用；头注释写了内核依据。
import { createMemberPool } from "./src/memberpool.js";
// 2026-11-02 设计确定：「成员混乱 → 禁用这个成员，新开一个」（内核无真清空上下文原语）。
import { createBanList } from "./src/bans.js";
// 原 index.js 的顶层导出：模块化后逐项转发（老调用方按名字 import 不变）。
export { classifyError } from "./src/errors.js";
export { sizeCtxK, sizeKey, nextCtxTierK, taskNeedCtx, ctxK, gearTokens, effortLadder, effortCapRank, effortFor } from "./src/gears.js";
export { renderLedgerMd } from "./src/ledger.js";
import { createLocks } from "./src/locks.js";
import { createErrbook } from "./src/errbook.js";
import { boardFor, countParallelism } from "./src/board.js";
import { saveMail, deliverMail, saveMailFull, drainMail, mentions, mailBox, mailLog, mailLogPath, loadMail, clearMailLog, MAIL_PANEL_MAX } from "./src/mailbox.js";
import { createWorkdir } from "./src/workdir.js";
import { noticesPath, notices, loadNotices, saveNotices, pushNotice } from "./src/notify.js";
import { createAnnounce } from "./src/announce.js";
import { createAccounting } from "./src/accounting.js";
import { createHealth } from "./src/health.js";
import { createLeadErrors } from "./src/lederr.js";
import { applyAvailability, syncFromOfm, inferVision, LEDGER_HISTORY_KEEP, appendLedgerHistory, whitelistFromPatch, syncFromKernel, ofmVersionState, refreshOfmRemote, OFM_MANIFEST_URLS, STATUS_TEXT, ledgerNote, renderLedgerMd, setPersist as setLedgerPersist, EFFORTS_RECHECK_DAYS, EFFORTS_ABSENT_TEXT } from "./src/ledger.js";
// 2026-11-01 拆 OFM：把它的自热重载和实测统计搬过来（详见两个模块的头注释）。
import { probeReload, selfReload, isReloading, lastReload } from "./src/selfreload.js";
import { readOfmStats, ofmVerdict, ofmRowText, annotateOfmLedger, ofmDataDir, pct, ofmRank, ofmBadge, ofmSpeedRank, ofmEtaSeconds, ofmEtaText, OFM_SAMPLE_OUTPUT_TOKENS } from "./src/ofmstats.js";
import { buildScoreTable, bucketByRoute, faultBucket, MIN_RUNS, CONF_RECOMMEND, CONF_USABLE, RISK_POOL_LIMIT, TIER_ORDER, wilsonLower } from "./src/score.js";
import { createGroupPool } from "./src/freeledger/pool.js";
import { createDispatcher, dispatchable, TASK_KINDS } from "./src/freeledger/dispatch.js";
import { persistDiagnostics } from "./src/persist.js";
// 2026-11-01 设计确定：「有报错直接发给报错模块处理，报错模块根据实际情况推送，
// 这样也不用这里改一点那里改一点」。认人（按会话 id，不按名字）+ 定路（推给谁）都归它。
import { whoAmI as whoAmIBySession, pushFault, pluginCanHandle } from "./src/errpush.js";

export const name = "dsh-team";
export const inject = ["agents", "subagents", "tools", "skills", "timer", "sessionPersistence"];


// ---------------------------------------------------------------------------
// shared mutable state (process-local; persisted to JSON for restart)
// ---------------------------------------------------------------------------

/** @typedef {{name:string,parentSessionId:string,provider:string,model:string,effort:string,caps:string[],currentTask:string|null,spawnedAt:number,lastResult:string|null,lastError:string|null,lastEvent:string|null,lastEventAt:number|null,lastStreamAt:number|null}} MemberRecord */




/** @typedef {{tid:string,title:string,briefPath:string,prio:number,caps:string[],status:"open"|"claimed"|"done"|"failed",owner:string|null,revision:number}} TaskRecord */
/** @typedef {{provider:string,model:string,status:"ok"|"invalid"|"unknown"|"lead",ctx:string,out:string,efforts:string,whitelist:"allow"|"closed"|"unknown"|"-",expiry:string,note:string,realResult:"ok"|"fail"|null,realAt:number|null,errClass:string|null,lastProbeAt:number|null,failStreak:number,backoffUntil:number,updatedStr:string,channel:string}} LedgerEntry */





// ---------------------------------------------------------------------------
// plugin entry
// ---------------------------------------------------------------------------

export function apply(ctx, config = {}) {
	const cfg = { ...CONFIG_DEFAULTS, ...config };
	// ★ 2026-11-01 晚：状态目录**必须**在这里先定下来，后面所有模块拼路径才跟着它走。
	// 为什么要在最前面：locks / notify / mailbox / announce / errbook / lederr / ledger /
	// accounting 这 8 个模块的路径都从 stateDirPath() 取，而 notify / mailbox 还会在
	// 「第一次用到」时把盘上的文件读进内存 —— 要是先读了盘再改目录，读进来的就是旧目录的数据。
	// 目录不存在时这里顺手建出来（别人装到新机器上第一次启动就是这么把 .state 建出来的）。
	const STATE_DIR = setStateDir(cfg.stateDir);
	try { nodeFs.mkdirSync(STATE_DIR, { recursive: true }); } catch { /* 建不出来留给各写入点自己报 */ }
	loadNotices();
	loadMail();
	// 写根解析：模块化后由 src/workdir.js 提供（原来是这里的闭包，逻辑未变）。
	const workdirApi = createWorkdir(cfg);
	const { WORKSPACE_ROOT, runsRoot, slugify, teamMeta, writeBaseOf, rememberWriteBase, memberWorkdir, ensureWriteRoot, outsideWorkspace } = workdirApi;
	// 报错账本：模块化后由 src/errbook.js 提供（原来是这里的闭包，逻辑未变）。
	const errbook = createErrbook(cfg);
	const { errorsPath, errorsDir, ARCHIVE_MAX, appendErrorLog, archiveError, errorRulesPath, ruleMatcher, wallHealAt, stallNoticeAt, BUILTIN_ERROR_RULES, errorRules, saveErrorRules, matchTextOf, matchErrorRule, FIX_VALUES, diagnoseError, parseRouteFromError, DAILY_CAP_RE, BILLING_DAILY_RE, nextUtcMidnight, nextLocalMidnight, WEEKLY_CAP_RE, nextUtcMonday, RESUME_AT_RE, explicitResumeMs, WALL_ROTATE_MS, wallUntil } = errbook;
	// 全局公告板 + 内核会话查询：模块化后由 src/announce.js 提供（原来是这里的闭包，逻辑未变）。
	const announceApi = createAnnounce({ ctx });
	const { announcePath, ANNOUNCE_GAP_MS, ANNOUNCE_KEEP, ANNOUNCE_WAKE_MAX, loadAnnounce, saveAnnounce, announceWaitSec, pullAnnounce, kernelSessions } = announceApi;

	const ledgerPath = cfg.ledgerPath || nodePath.join(stateDirPath(), "ledger.json");
	const rosterPath = nodePath.join(stateDirPath(), "roster.json");
	const boardPath = nodePath.join(stateDirPath(), "board.json");
	// 2026-11-02 成员池（复用退役成员的子会话，见 src/memberpool.js 头注释）。
	const memberPoolPath = nodePath.join(stateDirPath(), "member-pool.json");
	const memberPool = createMemberPool({ loadJson, saveJson, poolPath: memberPoolPath, cfg, logger: ctx.logger });
	memberPool.loadPool();
	// 2026-11-02 禁用名单：队长判产出混乱的会话，永不复用、不许带着旧上下文换模型续毒。
	const bansPath = nodePath.join(stateDirPath(), "bans.json");
	const banList = createBanList({ loadJson, saveJson, bansPath, logger: ctx.logger, max: Number(cfg.banListMax || 50) });
	banList.load();
	// D2 step 3: 战绩账本 —— 防膨胀是硬要求，所以三件事一起做：
	//  1) 聚合而非流水：每个 key 只存三个数（加权成功、加权样本、最后使用时间），
	//     不存逐次记录，所以条目数上限 = 路由数 × 档位数 × kind 数，天然有限；
	//  2) 半衰期：写入时把旧值乘 0.5^(间隔/半衰期)，旧战绩自己变淡，不需要翻旧账；
	//  3) 两道裁剪：先丢「衰减后样本 <0.2」的死键，再按最后使用时间丢最旧的。
	const scoresPath = nodePath.join(stateDirPath(), "scores.json");
	const scores = new Map(); // `${provider}/${model}@${effort}|${kind}` -> {ok, n, at}
	function scoreDecay(row, now) {
		const hl = Math.max(1, Number(cfg.scoreHalfLifeDays || 14)) * 86400000;
		return Math.pow(0.5, Math.max(0, now - Number(row.at || now)) / hl);
	}
	function trimScores() {
		const max = Math.max(50, Number(cfg.scoreMaxKeys || 1500));
		if (scores.size <= max) return;
		const now = Date.now();
		for (const [k, r] of Array.from(scores)) if (r.n * scoreDecay(r, now) < 0.2) scores.delete(k);
		if (scores.size <= max) return;
		const rows = Array.from(scores).sort((a, b) => Number(a[1].at || 0) - Number(b[1].at || 0));
		for (const [k] of rows.slice(0, scores.size - max)) scores.delete(k);
	}
	function bumpScore(route, effort, kind, ok) {
		if (cfg.scoreRecord !== true) return;
		const key = `${route}@${effort}|${String(kind || "grunt")}`;
		const now = Date.now();
		const row = scores.get(key) || { ok: 0, n: 0, at: now };
		const d = scoreDecay(row, now);
		row.ok = row.ok * d + (ok ? 1 : 0);
		row.n = row.n * d + 1;
		row.at = now;
		scores.set(key, row);
		trimScores();
	}
	/** 2026-10-31 打分表**消费端**（采纳某次实测 建议，实现由实现方定）：
	 *  把"战绩"从只记账变成**参与选路**。原则：
	 *   - 只在**同类任务（kind）**内比较：code 强的模型不等于 probe 也强（隔壁实测
	 *     nemotron-3.5-lightning-free 在 code 3/3、probe 0/3 —— 混着算就会两头都错）。
	 *   - 用**加权通过率** `ok/n`（已带 14 天半衰，老战绩自己变淡），不硬砍"最近 10 单"。
	 *   - **样本太少不判**：n < MIN_SAMPLES 时返回 null（"没意见"），避免一次差评定死。
	 *   - 返回 -1..1 的优先分：通过率越高越高；连续差评（通过率 < 0.34 且样本够）直接沉底。
	 *  `cfg.scoreWeighted === false` 时返回 null，即恢复"只记账不参与"的老行为。 */
	const SCORE_MIN_SAMPLES = 3;
	function routeScore(route, effort, kind) {
		if (cfg.scoreWeighted !== true) return null;
		const key = `${route}@${effort}|${String(kind || "grunt")}`;
		const row = scores.get(key);
		if (row === undefined) return null;
		const now = Date.now();
		const d = scoreDecay(row, now);
		const n = row.n * d;
		if (n < SCORE_MIN_SAMPLES) return null; // 样本不足：不表态
		const rate = (row.ok * d) / n;
		return rate < 0.34 ? -1 : rate; // 连续差评沉底
	}
	/** 给面板/status 看的人话版：某路由在指定 kind 上的战绩。 */
	function scoreLabel(route, effort, kind) {
		const key = `${route}@${effort}|${String(kind || "grunt")}`;
		const row = scores.get(key);
		if (row === undefined) return null;
		const now = Date.now();
		const d = scoreDecay(row, now);
		const n = row.n * d;
		const rate = n === 0 ? 0 : (row.ok * d) / n;
		return `${Math.round(rate * 100)}%（样本 ${Math.round(n)}）`;
	}

	/** 队长换模型后的即时路由：`session/event` 的 model/selection 一提交就写这里。
	 *  只靠 routeOf（durable requestHeader）不行 —— 它是"上一次请求用过什么"，
	 *  维护方切了模型但还没发话时它仍是旧值，面板就一直显示旧队长路由（实测报过）。 */
	const liveRoutes = new Map(); // sessionId -> "provider/model"
	/** 归档会话 id 集合（2026-10-29 维护方指出：DSH 的「归档」对话还算队长）。
	 *  GUI 把会话归档后，内核并不销毁它 —— `sessionController.list()` 照样列出来、
	 *  `ctx.agents.roots()` 照样挂在树上，于是它用过的模型被 leadRouteKeys 永久占成队长
	 *  （维护方开着 2 个对话却看到 5 个队长）。归档名单只落在内核 storages/workspace.json
	 *  的 `global.archivedSessionIds`，这里以它为准。
	 *  读不到就返回空集 = 不排除任何会话（宁可多算队长，也不能把真队长的路由放出去）。
	 *  30 秒缓存：归档是低频操作，不值得每个面板轮询都读盘。 */
	let archivedCache = { at: 0, ids: new Set() };
	function archivedSessions() {
		const nowMs = Date.now();
		if (nowMs - archivedCache.at < 30000) return archivedCache.ids;
		let ids = new Set();
		try {
			const j = JSON.parse(nodeFs.readFileSync(String(cfg.workspaceStatePath || ""), "utf8"));
			const list = j !== null && typeof j === "object" && j.global !== null && typeof j.global === "object" && Array.isArray(j.global.archivedSessionIds)
				? j.global.archivedSessionIds
				: [];
			ids = new Set(list.map((x) => String(x)));
		} catch { /* 文件不在 / 格式变了：不排除任何会话 */ }
		archivedCache = { at: nowMs, ids };
		return ids;
	}
	/** 队长存活核对（2026-10-29 设计确定："我就开着 2 个对话，怎么 5 个队长？"）。
	 *  关窗口 ≠ 会话销毁 —— `ctx.agents.roots()` 里那些早就不动的 agent 还挂着，
	 *  它们用过的路由就被永久占成「队长」，可派池白少几条。
	 *  markLiveUsage 每 15 秒问一次内核清单，这里只留「非空白 + 非子会话 + 未归档」的顶层会话。
	 *  2026-10-30 维护方纠错：**不许再用「agent 热不热」和「30 分钟内有活动」当存活判据** ——
	 *  开着但没说话的对话（agent 是 cold 的，updatedAt 也不会再动）会被这两条踢出去，
	 *  队长的路由于是掉回可派池，隔壁直接派了它。存活 = 还在工作区会话清单里、没归档、
	 *  不是子会话。真 ghost（删掉/归档的对话）由归档名单和清单本身负责，不靠活跃时间猜。
	 *  null = 还没问过（保守：先全算）。 */
	let liveLeadSessions = null; // Map<sessionId, updatedAt> | null
	/** "provider/model" route an agent actually ran last (durable header), if any. */
	function routeOf(agent) {
		try {
			const id = agent && agent.session ? String(agent.session.id || "") : "";
			const live = liveRoutes.get(id);
			if (live !== undefined) return live;
			const header = agent && agent.session && agent.session.requestHeader ? agent.session.requestHeader() : undefined;
			const config = header && header.config;
			return config && config.provider && config.model ? config.provider + "/" + config.model : undefined;
		} catch { return undefined; }
	}
	/** Routes of every live Lead = 队长在用, off-limits to members. */
	function leadRouteKeys() {
		const keys = new Set();
		const archivedForParents = archivedSessions();
		for (const member of members.values()) {
			if (archivedForParents.has(String(member.parentSessionId))) continue; // 归档队的成员不再占队长路由
			const key = routeOf(ctx.agents.get(member.parentSessionId));
			if (key !== undefined) keys.add(key);
		}
		// 只知道「成员的父亲」不够：本队一个成员都没有时这个集合是空的，队长的模型就被
		// 当成可派候选，派下去跟队长抢同一条路（raccoon/sn-deepseek-v4-1-flash-1017
		// 实测：台账绿着、能派，其实正被队长用着）。顶层会话一律算队长——但要做存活核对：
		// 内核清单到手后，只把「agent 在线且最近 ACTIVE_LEAD_MS 有过活动」的顶层会话算队长，
		// 早就不动的 ghost 会话把路由放回可派池。
		try {
			const archived = archivedSessions();
			for (const root of ctx.agents.roots()) {
				const sid = root && root.session ? String(root.session.id || "") : "";
				// 归档的对话不算队长：它还挂在内核树上，但它不该再占一条可派路由
				if (sid !== "" && archived.has(sid)) continue;
				if (liveLeadSessions !== null && sid !== "" && !liveLeadSessions.has(sid)) continue;
				const key = routeOf(root);
				if (key !== undefined) keys.add(key);
			}
		} catch { /* roots 不可用时退化为只认成员父亲 */ }
		return keys;
	}
	/** 队长自己的路由健不健康 —— 报错盒子用它决定「递到队长」还是「往下递一层」。
	 *  返回 "wall"（退避中/撞墙）| "halt"（所属组熔断）| "ok"。
	 *  读不到队长/台账一律算 "ok"：宁可把错递给他一次，也不要因为查不到就丢给别人。 */
	function leadHealthOf(leadId) {
		try {
			const id = String(leadId || "");
			if (id === "") return "ok";
			const agent = ctx.agents && typeof ctx.agents.get === "function" ? ctx.agents.get(id) : undefined;
			const key = agent === undefined ? undefined : routeOf(agent);
			if (key === undefined) return "ok"; // 这条对话没跑过（或路由未知）：没法判，当他好
			const e = ledger.get(key);
			if (e === undefined) return "ok";
			if (groupHalted(e)) return "halt";
			if (wallUntil(e) !== null) return "wall";
			return "ok";
		} catch { return "ok"; }
	}
	/** 别的队**空闲**的队长 —— 设计确定：的兜底目标池：「他的队长不行的推给其他队空闲的队长」。
	 *  「空闲」= 在册（boards/goals 里有它）且 agent 不在跑回合。
	 *  拿不到内核 agent 时按"空闲"算：这时候只有板还活着，把信递过去是他唯一的机会。 */
	function idleLeadSessions(excludeId) {
		const out = [];
		try {
			const ex = String(excludeId || "");
			const cands = new Set([...boards.keys(), ...goals.keys()]);
			for (const m of members.values()) if (m.parentSessionId !== "") cands.add(String(m.parentSessionId));
			for (const lid of cands) {
				const id = String(lid);
				if (id === ex || id === "") continue;
				const a = ctx.agents && typeof ctx.agents.get === "function" ? ctx.agents.get(id) : undefined;
				// 正在跑的另一个对话不该被打断；它空闲才接得住这条错
				if (a !== undefined && a !== null && String(a.status) === "running") continue;
				if (leadHealthOf(id) !== "ok") continue; // 自己也在墙上的不算「能接住的」
				out.push(id);
			}
		} catch { /* 清单不可用：没有兜底池 */ }
		return out;
	}
	/** 台账标注：队长正在用的路由必须写回台账 md（设计确定：的规矩——占用了就要标）。
	 *  以前只有 scan 会写，所以 raccoon/sn-deepseek-v4-1-flash-1017 正被队长用着、
	 *  台账里却一直是绿的。现在每次调用顺手同步，15 秒节流。 */
	let lastMarkAt = 0;
	/** 维护方在界面删掉一个对话框，插件的板/名册还冻在 .state 里 → 变成"幽灵板"，
	 *  peers/status 的「其他队」永远列着一个已经不存在的短号。这里按内核会话清单收尸。
	 *  保守两条：① 内核清单拿不到就完全不删；② 只是这一轮不在清单里、但 5 分钟内有活的
	 *  不删（新建会话可能还没进清单）。
	 *  未结单（open/claimed）照样删 —— 会话都没了，没人能结单，留着只是永久幽灵；
	 *  但删之前先存档一份，证据不随着一起消失。 */
	function pruneDeadTeams(knownIds) {
		const nowMs = Date.now();
		let changed = false;
		for (const key of Array.from(boards.keys())) {
			if (knownIds.has(String(key))) continue;
			if (goals.has(key) === true) { goals.delete(key); changed = true; }
			if (boards.has(key) !== true) continue;
			const board = boards.get(key);
			const ts = Array.from(board.tasks.values());
			const recent = ts.some((t) => {
				const last = Math.max(Number(t.claimedAt || 0), Number(t.finishedAt || 0), Number(t.createdAt || 0));
				return nowMs - last < 5 * 60 * 1000;
			});
			if (recent) continue;
			const unfinished = ts.filter((t) => t.status === "claimed" || t.status === "open");
			const names = Array.from(members.values()).filter((m) => m.parentSessionId === key).map((m) => m.name);
			let archived;
			if (unfinished.length > 0) {
				try { archived = writeCompactTeamFile(key, `prune-${shortOf(key)}-${dayStamp()}`); } catch { archived = undefined; }
			}
			for (const [sid, m] of Array.from(members.entries())) if (m.parentSessionId === key) { members.delete(sid); rememberRetired(sid, m); memberPool.drop(sid); } // 会话已经不在内核里了，池条目一并销账
			memberPool.dropTeam(key);
			boards.delete(key);
			goals.delete(key);
			changed = true;
			const tail = unfinished.length > 0
				? `；其中 ${unfinished.length} 个未结单（${unfinished.map((t) => `${t.tid}:${t.status}`).join(",")}）已存档 ${archived === undefined ? "失败" : nodePath.basename(String(archived))}`
				: "";
			pushNotice(key, "队已收尸", `会话已不在内核里，本队 ${names.length} 个成员名额与板已清理${tail}`);
		}
		if (changed) persistAll();
		return changed;
	}
	function markLiveUsage() {
		const now = Date.now();
		if (now - lastMarkAt < 15000) return;
		lastMarkAt = now;
		// 顺手收尸：会话被删 → 它的板/成员一起清掉（内核清单异步拿，失败就这轮不动）
		void kernelSessions().then((ks) => {
			if (ks === undefined || !Array.isArray(ks)) return;
			try { pruneDeadTeams(new Set(ks.map((s) => String(s.id)))); } catch { /* 收尸失败不影响本次调用 */ }
			// 2026-11-02 成员池对账：池里登记的会话在内核清单上已经没有 = 维护方删了那个对话，
			// 销账，补员不再尝试唤醒它（唤醒会抛 NOT_RESUMABLE，销了省一次撞）。
			try { memberPool.pruneTo(new Set(ks.map((s) => String(s.id)))); } catch { /* 对账失败下轮再来 */ }
			// 队长存活快照：还在这个工作区的会话清单里、未归档、不是子会话、不是空白。
			// 2026-10-30 维护方纠错：**agent 是不是热的不算判据** —— 开着没说话的对话 agent
			// 本来就是 cold 的，把它踢掉等于把队长路由放出去给隔壁派。也不再按 30 分钟活跃
			// 时间剪：维护方可能开着对话几小时不动，那照样是他的队长。只用清单+归档作权威。
			try {
				const live = new Map();
				const archived = archivedSessions();
				for (const s of ks) {
					if (s.sub === true || s.blank === true) continue;
					if (archived.has(String(s.id))) continue; // 归档对话不参与队长核对
					live.set(String(s.id), Number(s.updatedAt || 0));
				}
				// 清单一条不剩也照写（空集 = 没有队长），不要保留旧值 —— 保留旧值会让
				// 已经删掉的对话继续顶着「队长」占路由，那是另一个方向的错。
				liveLeadSessions = live;
			} catch { /* 清单解析失败就保持原样 */ }
		}).catch(() => { /* 内核不给清单 */ });
		const leadKeys = leadRouteKeys();
		let changed = false;
		for (const [key, entry] of ledger) {
			const want = leadKeys.has(key) ? "lead" : entry.status === "lead" ? "ok" : entry.status;
			if (entry.status !== want) { entry.status = want; changed = true; }
		}
		if (!changed) { stampLeadRows(leadKeys); return; }
		persistAll();
		stampLeadRows(leadKeys);
		if (cfg.renderLedger === true && ledgerMdPathOf(cfg) !== null) {
			try { renderLedgerMd(cfg); } catch { /* md 不可写：内存状态仍然正确 */ }
		}
	}

	/** 队长换模型立刻重标：不等下一次 team 调用、也不等发出第一个请求。
	 *  维护方的观察是「切换队长以后信息不变」——因为标记只在 team 调用里刷，而且 routeOf
	 *  读的是上一次请求头。现在监听会话提交的 model/selection，两条路一起治。 */
	const unbindModelSelection = ctx.on("session/event", (session, event) => {
		if (!ctxAlive()) return;
		if (event === null || event === undefined) return;
		const type = String(event.type || "");
		if (type !== "model/selection") return;
		const data = event.data || {};
		const id = String(session !== null && session !== undefined && session.id !== undefined ? session.id : "");
		if (id === "") return;
		if (data.provider !== undefined && data.model !== undefined) liveRoutes.set(id, `${data.provider}/${data.model}`);
		else liveRoutes.delete(id);
		lastMarkAt = 0; // 跳过 15s 节流：换模型就要马上体现
		try { markLiveUsage(); } catch { /* 台账写不进去不影响会话本身 */ }
	});

	/** 直接从内核 llm 服务读模型元数据（就是 UI 里显示的那份）：contextWindow、
	 *  defaultMaxTokens、reasoning.efforts。以前只靠扫描器 + 台账，catalog 不报就记成
	 *  "未advertised"，于是 1MB 的模型在台账里看着像没数据。 */
	const fmtCtx = (n) => {
		const v = Number(n);
		if (!Number.isFinite(v) || v <= 0) return undefined;
		return v >= 1024 * 1024 ? `${(v / (1024 * 1024)).toFixed(2).replace(/\.?0+$/, "")}M` : `${Math.round(v / 1024)}K`;
	};
	async function syncModelInfo(filter) {
		const llm = ctx.get ? ctx.get("llm", false) : ctx.llm;
		if (llm === undefined || llm === false || typeof llm.resolveModelInfo !== "function") return 0;
		let n = 0;
		for (const [key, entry] of ledger) {
			if (filter !== undefined && filter !== "" && !key.includes(filter)) continue;
			const missingCtx = ctxK(entry.ctx) === null;
			const missingOut = ctxK(entry.out) === null;
			// 目录与实测冲突时也算"不知道"：不然这条永远跳过同步，台账一直挂着假档位。
			const meas = measuredGears(entry);
			const cat = gearTokens(entry.efforts);
			const missingEff = effortLadder(entry).length === 0 || (meas.length > 0 && cat.every((g) => meas.indexOf(g) < 0));
			// 视觉能力未知也算"不知道"：内核 `inputModalities` 是权威来源，比目录/名字推断都准。
			const missingVision = entry.vision !== true && entry.vision !== false;
			// ★ 2026-11-16（Updating\04 · 遗留 1）：四项填满就 continue 会让**首遇快照永久生效**。
			//   实证：mistral-large-4-1t-a52b 从 2026-10-31 首遇起一直挂着 `light/balanced/deep`，
			//   而它 2026-11-01 就下了内核目录 ⇒ 内核 `reasoning: undefined` ⇒ 发任何档位词都抛
			//   UNSUPPORTED_REASONING_EFFORT。**假档位比没档位更坏**：选路器照它挑词。
			//   两条**窄口子**放行重查（不放开"每轮全量查"，那会把几百条路由每 15 分钟问一遍内核）：
			//     ① 已判内核下架（delisted）—— 死路由的档位最不可信，正是本次事故的直接来源；
			//     ② 档位从未复核过、或距上次复核超过 EFFORTS_RECHECK_DAYS 天。
			const effCheckedAt = Number(entry.effortsCheckedAt || 0);
			const effStale = effCheckedAt === 0 || Date.now() - effCheckedAt > EFFORTS_RECHECK_DAYS * 86400000;
			const mustRecheck = entry.delisted === true || effStale;
			if (!missingCtx && !missingOut && !missingEff && !missingVision && !mustRecheck) continue;
			try {
				const info = await llm.resolveModelInfo(entry.provider, entry.model, AbortSignal.timeout(8000));
				const cw = info && info.context ? info.context.contextWindow : undefined;
				const ot = info ? info.defaultMaxTokens : undefined;
				const eff = info && info.reasoning && Array.isArray(info.reasoning.efforts)
					? info.reasoning.efforts.map((e) => String(e.id).toLowerCase()) : [];
				let touched = false;
				if (missingCtx && cw && entry.ctxRaw === undefined) { entry.ctx = fmtCtx(cw); touched = true; }
				if (missingOut && ot) { entry.out = fmtCtx(ot); touched = true; }
				// 视觉能力：`inputModalities` 里有 "image" 就是能读图（内核声明，最可信）。
				// 内核没给这个字段时保持未知，**不要**猜成 false —— 未知和不支持是两回事。
				const mods = info && Array.isArray(info.inputModalities) ? info.inputModalities.map((x) => String(x)) : [];
				if (mods.length > 0) {
					const sees = mods.indexOf("image") >= 0;
					if (entry.vision !== sees || entry.visionSrc !== "kernel") {
						entry.vision = sees;
						entry.visionSrc = "kernel";
						touched = true;
					}
				}
				// 推理档位以内核为准 —— 但实测优先：内核目录对某些路由是错的
				// （raccoon/sn-deepseek-v4-1-flash-1017 目录 high/none、真实 on/off），
				// 照目录派单就每次 400 does not support reasoning effort "none"。
				if (eff.length > 0) {
					const measured = measuredGears(entry);
					const clash = measured.length > 0 && eff.every((g) => measured.indexOf(g) < 0);
					const effText = clash ? measured.join("/") : eff.join("/");
					if (clash && entry.note !== undefined && !/档位以实测为准/.test(String(entry.note))) {
						entry.note = `${entry.note}${entry.note === "" ? "" : "；"}档位以实测为准（内核目录 ${eff.join("/")} 与请求头不符）`;
						touched = true;
					}
					if (entry.efforts !== effText) { entry.efforts = effText; touched = true; }
					// 模型又有了真档位 ⇒ 撤掉"内核不给档位"的一次性标记
					if (entry.reasoningAbsent === true) { delete entry.reasoningAbsent; touched = true; }
				} else {
					// ★ 2026-11-16（Updating\04 · 遗留 1）：内核**成功返回了**但没有 reasoning 元数据。
					//   注意这与"查询失败"是两回事 —— 失败走 catch，一个字都不改（见函数尾部）；
					//   能走到这里说明 resolveModelInfo 真答了，且答的是"这模型没有档位菜单"。
					//   这正是 mistral 那条报错的根因：内核 `resolveCallWithInfo` 对
					//   `reasoning === undefined` 的模型**发任何档位词都抛
					//   UNSUPPORTED_REASONING_EFFORT**。台账再挂着旧档位就是假绿灯。
					if (entry.efforts !== EFFORTS_ABSENT_TEXT) {
						entry.efforts = EFFORTS_ABSENT_TEXT;
						entry.reasoningAbsent = true;
						touched = true;
					}
				}
				// 复核时间戳：只在**真的问到了**（没抛异常）时写 —— 查询失败不算复核过，
				// 否则一次网络抖动就把这条路由的档位锁 7 天。
				// ★ 时间戳本身也算"台账变了"：它是落盘字段（重启后靠它判断该不该重查），
				//   所以必须进 touched —— 否则问到了、判定了，但没落盘，下次启动又从 0 开始。
				entry.effortsCheckedAt = Date.now();
				touched = true;
				n += 1;
			} catch { /* provider 没注册 / 查询失败：保持原样 */ }
		}
		if (n > 0) { persistAll(); try { stampLeadRows(leadRouteKeys()); } catch { /* 标注失败无妨 */ } }
		if (n > 0) { try { stampModelInfo(); } catch { /* md 写不进去：内存与面板仍是新值 */ } }
		return n;
	}
	/** 把内核查到的 ctx / 推理档位补进台账 md 的空列（只在原值是"未 advertised/—"时写，
	 *  不覆盖维护方手工填的数）。out 台账没有独立列，只留在 ledger 与面板里。 */
	function stampModelInfo() {
		const mdPath = ledgerMdPathOf(cfg);
		if (mdPath === null) return;
		let text;
		try { text = nodeFs.readFileSync(mdPath, "utf8"); } catch { return; }
		const blank = (v) => v === undefined || v === null || String(v).trim() === "" || /未\s*advertised|^—$/i.test(String(v).trim());
		let n = 0;
		const out = text.split(/\r?\n/).map((line) => {
			if (!/^\|/.test(line)) return line;
			const cells = line.split("|");
			if (cells.length < 9) return line;
			const entry = ledger.get(cells[2].trim() + "/" + cells[3].trim());
			if (entry === undefined) return line;
			let touched = false;
			if (blank(cells[4]) && ctxK(entry.ctx) !== null) { cells[4] = ` ${entry.ctx} `; touched = true; }
			if (blank(cells[5]) && effortLadder(entry).length > 0) { cells[5] = ` ${entry.efforts} `; touched = true; }
			if (touched) { n += 1; return cells.join("|"); }
			return line;
		});
		if (n === 0) return;
		try { nodeFs.writeFileSync(mdPath, out.join("\n")); } catch { /* 只读就留在内存 */ }
	}
	/** 问内核要「UI 上那几档」的真实 id。UI 的推理强度选项就是
	 *  `llm.resolveModelInfo().reasoning.efforts` 渲染出来的，所以这是唯一不用派活、
	 *  也不用维护方手发一句就能拿到真档位名的路子。`filter` 为空不查，避免每次 models
	 *  都拉几十条（每条一次 provider 往返）。 */
	async function kernelEffortRows(filter) {
		const llm = ctx.get ? ctx.get("llm", false) : ctx.llm;
		if (llm === undefined || llm === false || typeof llm.resolveModelInfo !== "function") return [];
		const rows = [];
		for (const [key, entry] of ledger) {
			if (filter === "" || !key.includes(filter)) continue;
			if (rows.length >= 40) { rows.push("…（命中太多，收窄 filter）"); break; }
			try {
				const info = await llm.resolveModelInfo(entry.provider, entry.model, AbortSignal.timeout(8000));
				const list = info && info.reasoning && Array.isArray(info.reasoning.efforts) ? info.reasoning.efforts : [];
				if (list.length === 0) { rows.push(`${key}｜内核不给档位（UI 上应该没有思考开关）｜台账=${entry.efforts || "无"}`); continue; }
				const ids = list.map((e) => String(e.id).toLowerCase());
				const shown = list.map((e) => (e.name && String(e.name) !== String(e.id) ? `${e.id}(${e.name})` : String(e.id)));
				const cat = gearTokens(entry.efforts);
				const missing = ids.filter((g) => cat.indexOf(g) < 0);
				const alien = ids.filter((g) => EFFORT_RANK[g] === undefined);
				const tags = [];
				if (missing.length > 0) tags.push(`台账缺 ${missing.join("/")}`);
				if (alien.length > 0) tags.push(`插件暂不认 ${alien.join("/")}`);
				rows.push(`${key}｜内核=${shown.join(" / ")}｜台账=${entry.efforts || "无"}${tags.length === 0 ? "（一致）" : `｜注意：${tags.join("；")}`}`);
			} catch (err) {
				rows.push(`${key}｜内核查询失败：${String((err && err.message) || err).replace(/\s+/g, " ").slice(0, 90)}`);
			}
		}
		return rows;
	}

	// --- restore persisted state (best effort; live agents are re-adopted by events)
	/** 只改台账 md 里「队长在用」这一列的那几行：不动备注、不动时间、不动别的行。
	 *  renderLedger 默认关着（维护方手工维护台账，插件不擅自全表同步），所以这里单独写。 */
	function stampLeadRows(keys) {
		if (keys === undefined || keys.size === 0) return;
		const mdPath = ledgerMdPathOf(cfg);
		if (mdPath === null) return;
		let text;
		try { text = nodeFs.readFileSync(mdPath, "utf8"); } catch { return; }
		let n = 0;
		const out = text.split(/\r?\n/).map((line) => {
			if (!/^\|/.test(line)) return line;
			const cells = line.split("|");
			if (cells.length < 8) return line;
			const key = cells[2].trim() + "/" + cells[3].trim();
			if (!keys.has(key)) return line;
			// 列序：0空 1排序 2provider 3模型 4ctx 5推理强度 6状态 7备注 8更新时间
			if (cells[6].trim() === "⚠️ 队长在用") return line;
			cells[6] = " ⚠️ 队长在用 ";
			n += 1;
			return cells.join("|");
		});
		if (n === 0) return;
		try { nodeFs.writeFileSync(mdPath, out.join("\n")); } catch { /* md 只读：内存状态仍然正确 */ }
	}
	/** 本实例最后一次**读到或写出**台账文件的时刻，以及"我改过哪些路由"。
	 *
	 *  这个插件**每会话一个实例**（GUI 开 N 个对话 = N 个实例），各持一份台账内存副本，
	 *  各自每 10 秒 `persistAll()` 一次。任何一个活着的实例都会用自己内存里那份把磁盘
	 *  覆盖掉 —— 而且它察觉不到，因为它的内存从来没"错"过。
	 *
	 *  实测（2026-11-01，三次同一现象）：改好 ledger.json（backoffUntil=次日00:05）→
	 *  触发自热重载 → 等 25 秒（跨两个 tick）→ 文件变回旧值（16:02）。
	 *  ① 先怀疑 dispose，加了守卫仍被覆盖；
	 *  ② 再怀疑 10 秒 tick，加了守卫仍被覆盖；
	 *  ③ 才想明白：改的那个实例守规矩了，但**别的会话实例还在跑旧代码**（它们没重载）。
	 *
	 *  所以解法不能是"让写的人守规矩"，得是"写之前先并一次磁盘"：
	 *  **字段级三方合并** —— 本实例改过的路由用内存的，其余一律听磁盘的。
	 *  这样旧实例哪怕无脑覆盖，只要它自己的代码是新的（重载过一次），就不会踩掉别人。 */
	let lastSeenDiskAt = 0;
	const dirtyKeys = new Set();
	/** 磁盘上台账文件的 mtime；读不到返回 0（文件还没建）。 */
	function ledgerDiskMtime() {
		try { return nodeFs.statSync(ledgerPath).mtimeMs; } catch { return 0; }
	}
	/** **字段级三方合并**：只让磁盘版本"输"给本实例**真改过的**字段。
	 *
	 *  为什么不是"整条覆盖/整条放弃"：前者会把别人的修正踩掉（本次维护方抓的 bug），
	 *  后者会把本实例刚记下的一笔真派结果丢掉（另一个方向的 bug）。台账的字段
	 *  彼此独立 —— `backoffUntil` 归出事的那次失败所有，`realResult` 归最近一次
	 *  真派所有，`ctx` 归内核同步所有。所以该按字段比，不该按行比。
	 *
	 *  判据：dirtyKeys。本实例**改过**的那个路由 × 那些字段，用内存的；其余用磁盘的。
	 *  只记"改了哪些键"，不记值 —— 值本来就在 ledger 里，比值更省事也更不容易错。 */
	/** 标记某条路由本实例改过（下一次落盘时它的字段会盖过磁盘那份）。 */
	function touchRoute(key) {
		if (typeof key === "string" && key !== "") dirtyKeys.add(key);
	}
	/** 磁盘上台账文件的 mtime；读不到返回 0（文件还没建）。 */
	function ledgerDiskMtime() {
		try { return nodeFs.statSync(ledgerPath).mtimeMs; } catch { return 0; }
	}
	/** 磁盘是否被别人改过（比本实例最后见到的那次更新）。 */
	function diskIsNewer() {
		const m = ledgerDiskMtime();
		return m > 0 && m > lastSeenDiskAt;
	}
	/** 落盘前把磁盘上"别人改的"那些字段并回内存：除本实例改过的路由外，一律以磁盘为准。
	 *  这样「别的实例/人工修正」不会被本实例的旧副本抹平，本实例自己的改动也不会丢。 */
	function mergeDiskIntoMemory() {
		const fresh = loadJson(ledgerPath, {});
		if (fresh === null || typeof fresh !== "object") return false;
		for (const [key, diskRow] of Object.entries(fresh)) {
			if (diskRow === null || typeof diskRow !== "object") continue;
			if (dirtyKeys.has(key)) {
				// 本实例改过这条：保留内存版，但把磁盘上**本实例没碰**的字段补进来
				// （ctx/seenMax/displayName 这些是内核同步来的，内存里可能是旧的）。
				// 只补"内存里没有的"：内存有的就是本实例写的，不能被磁盘反盖。
				const mine = ledger.get(key) || {};
				for (const [f, v] of Object.entries(diskRow)) {
					if (mine[f] === undefined) mine[f] = v;
				}
				ledger.set(key, mine);
				continue;
			}
			applyMeasuredCtx(diskRow, key);
			applyMeasuredCtxMin(diskRow, key);
			applySeenMax(diskRow, key);
			ledger.set(key, diskRow);
		}
		// 磁盘上没有、内存里有的（本实例新建的路由）：只有当它被改过才保留
		for (const key of Array.from(ledger.keys())) {
			if (Object.prototype.hasOwnProperty.call(fresh, key)) continue;
			if (!dirtyKeys.has(key)) ledger.delete(key);
		}
		return true;
	}
	/** 磁盘更新时把台账从文件重新读回来（放弃内存里的过期副本）。
	 *  注意和 mergeDiskIntoMemory 的区别：这个是**全盘重读**（丢掉本实例所有改动），
	 *  只在明确要"以磁盘为准"时用（比如当前实例刚启动、还没有任何改动）。 */
	function reloadLedgerFromDisk() {
		try {
			const fresh = loadJson(ledgerPath, {});
			if (fresh === null || typeof fresh !== "object") return false;
			ledger.clear();
			for (const [key, entry] of Object.entries(fresh)) {
				applyMeasuredCtx(entry, key);
				applyMeasuredCtxMin(entry, key);
				applySeenMax(entry, key);
				ledger.set(key, entry);
			}
			dirtyKeys.clear();
			lastSeenDiskAt = ledgerDiskMtime();
			return true;
		} catch { return false; }
	}

	for (const [key, entry] of Object.entries(loadJson(ledgerPath, {}))) {
		applyMeasuredCtx(entry, key);
		applyMeasuredCtxMin(entry, key);
		applySeenMax(entry, key);
		ledger.set(key, entry);
	}
	lastSeenDiskAt = ledgerDiskMtime();
	for (const [key, member] of Object.entries(loadJson(rosterPath, {}))) {
		// restore cold members too: claim/finish/board lookups and route re-attach
		// on resume (agent/created) all need them; live-ness is checked at use time.
		member.lastEvent = member.lastEvent ?? null;
		member.lastEventAt = typeof member.lastEventAt === "number" ? member.lastEventAt : null;
		member.lastStreamAt = typeof member.lastStreamAt === "number" ? member.lastStreamAt : null;
		members.set(key, member);
	}
	for (const [leadId, board] of Object.entries(loadJson(boardPath, {}))) {
		const tasks = new Map((board.tasks || []).map((t) => [t.tid, t]));
		boards.set(leadId, { seq: board.seq || tasks.size, tasks, meta: board.meta || null });
		if (board.goal && board.goal.text) goals.set(leadId, board.goal);
	}
	// 战绩账本恢复：只信任形状对得上的行，脏数据直接丢（账本不该因为一行坏数据起不来）
	for (const [key, row] of Object.entries(loadJson(scoresPath, {}))) {
		if (row === null || typeof row !== "object") continue;
		const n = Number(row.n);
		if (!Number.isFinite(n) || n <= 0) continue;
		scores.set(key, { ok: Math.max(0, Number(row.ok) || 0), n, at: Number(row.at) || Date.now() });
	}
	trimScores();


	/** 自动回收（设计确定：8 人上限；空闲回收是「从名册移除」，不是只打断）。
	 *  Removal, not interrupt — a slot has to actually free up. Only when the board has
	 *  no open task left (there is nothing to wait for) and the member is neither running
	 *  nor holding a task, and it has been quiet for recycleIdleSec. */
	const isDeadWeight = (m) => {
		const e = ledger.get(`${m.provider}/${m.model}`);
		return e !== undefined && (wallUntil(e) !== null || groupHalted(e));
	};
	function recycleIdleMembers() {
		if (cfg.autoRecycle !== true) return;
		const now = Date.now();
		const after = Math.max(60, Number(cfg.recycleIdleSec || 600)) * 1000;
		for (const [leadId, board] of boards) {
			const openLeft = Array.from(board.tasks.values()).filter((t) => t.status === "open").length;
			for (const member of Array.from(members.values())) {
				if (member.parentSessionId !== leadId) continue;
				// 手动 spawn 的成员不自动回收（手动优先）；只有插件自己补的人才是临时工。
				// cfg.recycleManual=true 才连手动起的一起收。
				if (member.autoSpawned !== true && cfg.recycleManual !== true) continue;
				if (member.currentTask !== null) continue;
				const agent = ctx.agents.get(sessionIdOf(member));
				if (agent !== undefined && agent.status === "running") continue;
				const idleSince = Math.max(Number(member.lastEventAt || 0), Number(member.spawnedAt || 0));
				// 2026-11-02 维护方抓 14 人堆名额：撞墙/组停的空闲临时工**不等板上清空**，
				// 60 秒宽限（给路由自愈）后直接回收腾位 —— 它是零兵，留着只会把 able 名额
				// 越占越满，逼着补员绕过闸堆人（老闸 dead.length===0 那个洞就是这么炸的）。
				// 来活时 autoFill 按当前门槛重新挑一条能干活的路由，比留一个干等的强。
				const dead = isDeadWeight(member);
				const need = dead ? Math.min(60000, after) : after;
				if (openLeft > 0 && !dead) continue; // 还有活排队：正常人不算"浪费"，继续等领单
				if (idleSince === 0 || now - idleSince < need) continue;
				const sid = sessionIdOf(member);
				members.delete(sid);
				rememberRetired(sid, member);
				// 2026-11-02 设计确定：「补员优先复用同一个子智能体」：回收只腾名额，不扔人 ——
				// 会话进成员池，来活挑到同一条路由时优先把它唤醒（内核 coldResume），
				// 不再每次新起一个子会话。队长 remove/disband 说过不要的走不到这里。
				memberPool.remember(sid, member);
				pushNotice(leadId, dead ? "已回收撞墙成员" : "已回收成员", `${member.name}（${member.provider}/${member.model}）${dead ? "路由撞墙/组停且空闲" : `空闲 ${Math.round((now - idleSince) / 60000)} 分钟、板上无 open 任务`}，已从名册移除腾出名额；来活会先唤醒它复用（不再新起）`);
			}
		}
	}

	// --- D2 step 2: 自动补员
	// 触发条件（全满足才补）：板上有一条可领的 open 活、本队没有空闲成员（有人闲着就该他领）、
	// 名额没到 maxMembers、距上次补员超过冷却。补出来的人打 autoSpawned 标记，
	// 空闲后由 recycleIdleMembers 回收；手动 spawn 的成员一律不碰。
	// 路由与档位仍走 pickRoute/resolveGear —— 补员不绕过台账，选不出来就不补并留一句话。
	const autoFillAt = new Map(); // 按队记冷却：全局一个闸会挡别的队的 create 补员
	// 2026-11-01：按队的**补员在途锁**。判据（空着的人够不够）和落子（spawn）之间隔着 await，
	// 并发调进来会双双读到同一个"人手不够"然后各补一个（实测串行链起了 2 个人）。
	// ★ 锁必须挂 globalThis，不能放这里：热重载会让每个实例各持一份，等于没锁。
	//   （真跑过：实例内 Map 版本上线后照样起 2 个，换成 globalThis 才彻底收住。）
	const fillLockKey = (leadId) => "dsh-team:filllock:" + leadId;
	/** 磁盘名册（共享事实）。补人前读一次，把**别的实例已经补进去**的人也算进人手，
	 *  否则实例 A 补了 auto1、实例 B 内存里还没有它，B 照样认为"没人"再补一个。
	 *  读失败返回 null（调用方按内存判断，宁可多补也不能因为读不到盘一个人都不补）。 */
	function readDiskRoster() {
		try {
			const raw = loadJson(rosterPath, null);
			if (raw === null || typeof raw !== "object") return null;
			return new Map(Object.entries(raw));
		} catch { return null; }
	}
	function nextAutoName(leadId) {
		for (let i = 1; i < 100; i++) {
			const nm = "auto" + i;
			let used = false;
			for (const m of members.values()) if (m.parentSessionId === leadId && m.name === nm) { used = true; break; }
			if (!used) return nm;
		}
		return "auto" + Date.now().toString(36);
	}
	/** 2026-11-02 设计确定：（「现在有个问题，你看你的子智能体现在是56个了……每次起一个成员，
	 *  都是让你新调用一个子智能体，完全没有复用这一说，是否可以复用，除非队长选择不用这个子智能体」）：
	 *  补员先查成员池 —— 同队同路由有退役旧成员，就把那个子会话**唤醒复用**，不新起。
	 *  内核依据：dsh-subagent/lib/index.js 的 coldResume（:2141）会把已从内存卸载、日志还在
	 *  盘上的本地子级原样重建（persona/路由从 `subagent/descriptor` 还原），且
	 *  `agents.resume → announce(agent, "resume")` 会重发 agent/created
	 *  （dsh-agent/lib/index.js:581）→ 插件挂在 agent/created 上的 attachRouting / badge /
	 *  AGENTS.md 抑制 / 任务上下文对复活成员**照样重新装好**；冷恢复快照压不过名册，
	 *  因为 agent/request 覆盖读的是 members 里的当前记录（文件头设计依据那段）。
	 *  规矩：队长 kill remove / disband 明确不要的人**从不入池**（见 src/memberpool.js），
	 *  所以这里捡回来的只会是"回收腾位、没人说过不要"的。
	 *  返回 undefined = 池里没人 / 全都唤不醒 → 调用方照旧新起，补员不因此卡住。 */
	/** 唤醒池里一个旧会话（复用核心，补员/adopt 共用）。rec 是 claim 抢到的池记录；
	 *  成功返回登记进名册的 member，失败返回 undefined（会话/池条目已清理干净）。
	 *  ★ 2026-11-02 实测教训（直接唤醒一个退役僵尸 67b0d508 验证）：会话能被 coldResume
	 *  拉起来（turn/start 有记录），但**第一次模型请求就死在 UNSUPPORTED_REASONING_EFFORT**
	 *  ——  descriptor 重放的是当年那个档位（balanced），路由现在早不支持。所以档位/需求
	 *  必须在**登记名册那一刻**就是最终值（attachRouting 的 agent/request 覆盖读的就是
	 *  member.effort），唤醒后再改就晚了 —— 第一个请求已经发出去了。opts 里给的
	 *  provider/model/effort/demand 是调用方算好的最终值，缺省回退池记录。 */
	async function wakePoolMember(sid, rec, leadId, leadAgent, wakeText, opts = {}) {
		const provider = opts.provider !== undefined ? String(opts.provider) : rec.provider;
		const model = opts.model !== undefined ? String(opts.model) : rec.model;
		const effort = opts.effort !== undefined ? String(opts.effort) : rec.effort;
		const demand = opts.demand !== undefined ? String(opts.demand) : rec.demand;
		const workdir0 = rec.workdir !== "" && rec.workdir !== undefined ? rec.workdir : memberWorkdir(leadId, rec.name, "");
		const mkErr = ensureWriteRoot(workdir0);
		const workdir = mkErr === undefined ? workdir0 : memberWorkdir(leadId, rec.name, "");
		if (mkErr !== undefined) ensureWriteRoot(workdir);
		const member = { name: rec.name, parentSessionId: leadId, provider, model, effort: effort !== "" ? effort : "medium", demand: demand !== "" ? demand : String(DEMAND_DEFAULT), effortWhy: opts.effortWhy !== undefined ? String(opts.effortWhy) : "复用唤醒", routeSource: rec.routeSource || "plugin", autoSpawned: rec.autoSpawned === true, caps: Array.isArray(rec.caps) ? rec.caps : [], currentTask: null, spawnedAt: Number(rec.spawnedAt || 0) || Date.now(), lastResult: null, lastError: null, lastErrorClass: null, lastEvent: null, lastEventAt: Date.now(), lastStreamAt: Date.now(), toolErrStreak: 0, lastToolError: null, lastToolErrorAt: null, loopAt: null, workdir, sandboxMode: "pending", outOfWorkspace: outsideWorkspace(workdir), deniedCount: 0, deniedPaths: [] };
		// ★ 必须先登记进名册再唤醒：coldResume 在 sendMessage 里面就重发 agent/created，
		//   attachRouting / memberTaskContext 拿 `members.get(sessionId)` 查人，查不到就按路人装。
		members.set(sid, member);
		try {
			await ctx.subagents.sendMessage(leadAgent, sid, [
				{ type: "text", text: wakeText },
			], { signal: AbortSignal.timeout(30000) });
		} catch (error) {
			members.delete(sid);
			// 唤不醒（会话被删/归档/内核拒绝）：这人真没了，销账，调用方改新起
			memberPool.drop(sid);
			if (ctx.logger) ctx.logger.warn("dsh-team: 复用唤醒失败，改新起：" + String(error).slice(0, 120));
			return undefined;
		}
		// 唤醒路径不经过 startActivation，拿不到 activation 句柄；补钉一次 workspace-write
		//（原来 pinMemberMode 挂在 activation 上；重放的会话日志里本来有那笔 sandbox/mode，这层是保险）。
		try {
			const revived = ctx.agents.get(sid);
			if (revived !== undefined && revived.session !== undefined && typeof revived.session.append === "function") revived.session.append("sandbox/mode", { mode: "workspace-write" });
			member.sandboxMode = "workspace-write";
		} catch { member.sandboxMode = "inherited"; /* 钉不住照旧跑 */ }
		return member;
	}
	async function tryReuseMember(leadId, leadAgent, provider, model, effort, task) {
		if (Number(cfg.memberPoolMax === undefined ? 24 : cfg.memberPoolMax) <= 0) return undefined;
		const liveIds = new Set(members.keys());
		const usedNames = new Set(Array.from(members.values()).filter((m) => m.parentSessionId === leadId).map((m) => m.name));
		const archived = archivedSessions();
		const cands = memberPool.candidates(leadId, provider, model, liveIds, usedNames);
		for (const c of cands) {
			if (archived.has(c.sessionId)) { memberPool.drop(c.sessionId); continue; } // 维护方把那个对话归档了 = 也不再复用
			if (banList.isBanned(c.sessionId)) { memberPool.drop(c.sessionId); continue; } // 队长判过混乱/说过不要 = 永不复用
			const rec = memberPool.claim(c.sessionId, leadId);
			if (rec === undefined) continue; // 别的实例先复用走了（claim 里重读盘）
			const member = await wakePoolMember(c.sessionId, rec, leadId, leadAgent,
				`回岗：队伍补员把你唤醒（写根 ${rec.workdir || memberWorkdir(leadId, rec.name, "")}）。板上 ${task.tid}《${task.title}》在排队，先待命，收到领单消息就开工；只做当前任务里的这一单，历史里没结的旧任务一律作废、不碰它们的文件。`,
				{ provider, model, effort, demand: String(task.demand || DEMAND_DEFAULT), effortWhy: `复用唤醒（补员按 d${demandRank(task.demand)}，档位按台账重新压过）` });
			if (member === undefined) continue; // 唤不醒，试下一个候选人
			pushNotice(leadId, "复用旧成员", `${rec.name} 从成员池唤醒复用（${provider}/${model}@${effort}，退役 ${Math.max(1, Math.round((Date.now() - Number(rec.retiredAt || 0)) / 60000))} 分钟），没有新起子智能体；它会自己领板上最优先的单（补员时看到的是 ${task.tid}《${task.title}》）`);
			return member;
		}
		return undefined;
	}
	async function autoFillOne(leadId, opts = {}) {
		if (cfg.autoFill !== true) return { skipped: "autoFill 已关" };
		// bypass：队长刚拆完单，人手必须马上到位，不排队等冷却（10-30 实录：
		// 冷却挡了补员、队长看不见人，就自己抢先 spawn 造出空转的三个人）。
		const lastAt = autoFillAt.get(leadId) || 0;
		if (opts.bypass !== true && Date.now() - lastAt < Math.max(10, Number(cfg.autoFillCooldownSec || 30)) * 1000) return { skipped: "冷却中" };
		const board = boards.get(leadId);
		if (board === undefined) return { skipped: "没有任务板" };
		const team = Array.from(members.values()).filter((m) => m.parentSessionId === leadId);
		const leadAgent = ctx.agents.get(leadId);
		if (leadAgent === undefined) return { skipped: "队长不在" };
		// 2026-10-30 维护方纠错（隔壁 T7→T8→T9→T10 只有一个人从头干到尾）：
		// 老判据是「队里有一个人手上没活 → 直接跳过补员」。后果是**永远只有一个人干活**：
		// 哪怕板上躺着 3 条能并行的独立单，也只会补出第一个成员，之后所有单排队等它一个。
		// 拆单的意义就是并行；串行干的话队长自己干更快。
		// 新判据：**按「同时可领的单数」对比「队里的人数」** —— 可领单比人数多才补人，
		// 人数够就等现有的人去领（不浪费名额，也不会派同一单给两个人）。
		const ready = Array.from(board.tasks.values())
			.filter((t) => t.status === "open" && (t.owner === null || t.owner === ""))
			.filter((t) => t.blockedBy.every((d) => taskSettled(board.tasks.get(d))))
			.sort((a, b) => (b.prio || 0) - (a.prio || 0) || (a.createdAt || 0) - (b.createdAt || 0));
		if (ready.length === 0) return { skipped: "没有可领的 open 活（其余单被依赖挡住或已预指派）" };
		// 2026-10-30 设计确定：（第三次，最关键的一次）：**补员按"能干活的人数"算，不按名册人数**。
		// 实录：隔壁 t9 一直 open、队里 auto1 一直闲着，插件却一次都没补人 —— 因为
		//   ready=1（只有 t9）、team.length=1（auto1）→ 1<=1 判定"人够了"。
		// 可 auto1 那条路由撞了 14 小时墙，它**一分钟都干不了**：有效兵力是 0。
		// 判据必须先把"撞墙/组熔断/正在墙上"的成员扣掉，剩下的才叫能使的人。
		// 设计说明：「跟队长说有什么用？是插件派人。」—— 撞墙不许甩给队长，插件自己补。
		// isDeadWeight 已提到 recycleIdleMembers 旁（同一判据，回收和补员共用）。
		const able = team.filter((m) => !isDeadWeight(m));
		// 2026-11-01 修（维护方报「5 个并行任务就给 2 个人？」的真实根因）：
		// 老判据是 `ready.length <= able.length` —— able 里**包含正在跑的人**。
		// 5 条独立单、已有 3 个人都在忙、剩 2 条 open 时：ready=2，able=3 → 2<=3 判「人够了」，
		// 插件就再也不补人，剩下 2 条单一直躺在板上等那 3 个人跑完。并行度被饿死。
		// 判据必须是「**手上空着**、且不是废兵的人」对上「还没人领的单」：
		//   空着的人够分 → 等它们自己去领（不浪费名额、不会两人抢同一单）；
		//   空着的人不够 → 补人。
		// 收敛性：补出来的新成员一 idle 就进 freeAble，下一轮 ready 减少或 freeAble 增加，
		// 最多补到 ready 条就停，不会无限加人。
		// 每单只能一个人干，所以 freeAble 个人最多同时吃 freeAble 单。
		const freeAble = able.filter((m) => m.currentTask === null);
		if (ready.length <= freeAble.length) {
			return { skipped: freeAble.length > 0 ? `${freeAble[0].name} 手上没活，先等它领` : `人够了（${freeAble.length} 人空着，吃 ${ready.length} 单）` };
		}
		// 2026-11-01 第二重保护：**落子前再读一次别人已经落下的子**。
		// 在途锁只能挡住同进程的并发；真正让「串行链起 2 人」反复出现的是
		// **多个插件实例各自持有一份内存名册**：实例 A 补了 auto1，实例 B 的 members 里
		// 还没有它，B 照样读到「空着的人 = 0」，再补一个 auto2。
		// 内存名册是缓存，磁盘 roster.json 才是共享事实。补人前把磁盘上已经存在的、
		// 属于本队且手上空着的人也算进 freeAble，缺几个就只补几个。
		// 读盘失败就当没有（宁可多补一个，也不能因为读不到盘就一个人都不补）。
		let extraFree = 0;
		try {
			const diskRoster = readDiskRoster();
			if (diskRoster !== null) {
				const memIds = new Set([...members.entries()].filter(([, m]) => m.parentSessionId === leadId).map(([sid, m]) => String(sid) + "|" + String(m.name)));
				for (const [sid, m] of diskRoster) {
					if (m.parentSessionId !== leadId) continue;
					if (memIds.has(String(sid) + "|" + String(m.name))) continue; // 已在内存里算过
					if (m.currentTask !== null && m.currentTask !== undefined && m.currentTask !== "") continue;
					const e = ledger.get(`${m.provider}/${m.model}`);
					if (e !== undefined && (wallUntil(e) !== null || groupHalted(e))) continue;
					extraFree += 1;
				}
			}
		} catch { /* 读不到盘：按内存里的判断走 */ }
		if (extraFree > 0 && ready.length <= freeAble.length + extraFree) {
			return { skipped: `别处已经补了 ${extraFree} 人空着（吃 ${ready.length} 单），不再重复补` };
		}
		// 走不下去就是"兵力不够、必须补人"，把原因说清楚（撞墙的成员在这里被点名，
		// 而不是让队长看着一个不动的人干猜）。
		const dead = team.filter(isDeadWeight);
		const deadNote = dead.length === 0 ? "" : `（${dead.map((m) => `${m.name} 撞墙/组停→换人`).join("、")}）`;
		// 名额闸（2026-11-02 维护方抓「一下子开了 14 个？上限不是 8 吗」后重写）。
		// 老写法 `team.length >= cap && dead.length === 0` 有个洞：只要有**一个**撞墙成员，
		// 整个闸就失效 —— 本意是「撞墙的不占名额」，执行成了「有墙=不设限」，实测堆到 14。
		// 新口径两层，都封死：
		//   ① 占名额的只数**能使的人**（able）：able 到 cap 就拒，撞墙的另计；
		//   ② 在册总数硬顶 cap×2 —— 死兵靠回收腾位（见 recycleIdleMembers 的 dead 分支），
		//      绝不允许「全员撞墙→无限补人」的 runaway。
		const capNow = Math.max(1, Number(cfg.maxMembers || 8));
		if (able.length >= capNow) return { skipped: `名额已满（能使的 ${able.length}/${capNow}${dead.length > 0 ? `，另有 ${dead.length} 个撞墙的等回收腾位` : ""}）` };
		if (team.length >= capNow * 2) return { skipped: `在册 ${team.length} 已到硬顶 ${capNow * 2}（撞墙成员先回收再来补，不无限堆人）` };
		// 并发上限：on_the_fly 的 agent 数不能超过 maxConcurrent。
		{
			let running2 = 0;
			for (const m of team) {
				const a = ctx.agents.get(sessionIdOf(m));
				if (a !== undefined && String(a.status) === "running") running2 += 1;
			}
			if (running2 >= Math.max(1, Number(cfg.maxConcurrent || 8))) return { skipped: `并发已满（${running2}/${cfg.maxConcurrent || 8}）` };
		}
		const task = ready[0];
		// 补员按**这单实测抬起来的门槛**挑路由（task.ctxMin）：不然 kill 掉小路由上的成员之后，
		// 补员又会挑一条同样小的，把同一个压缩死循环原样重开一遍。
		// 2026-11-02 设计确定：「判乱第一次先归因到成员会话」：这单被 banAndReplace 钉在
		// cloneRoute 上 → 补员**必须**用同一条路由（对照实验只动「上下文干净与否」一个
		// 变量），且**禁止复用池里的旧会话** —— 乱的上下文换个马甲还是乱的，只能新起。
		const pinned = String(task.cloneRoute || "");
		let provider; let model;
		if (pinned !== "" && pinned.includes("/")) { provider = pinned.slice(0, pinned.indexOf("/")); model = pinned.slice(pinned.indexOf("/") + 1); }
		else {
			const pk = pickRoute(task.kind || "grunt", task.size || "m", leadId, Array.isArray(task.ctxTried) ? task.ctxTried : [], { vision: task.vision === true, needCtx: taskNeedCtx(task) });
			if (pk.error !== undefined) return { skipped: `选不出路由：${pk.error}` };
			provider = pk.entry.provider;
			model = pk.entry.model;
		}
		const gearInfo = resolveGear(ledger.get(`${provider}/${model}`), "", String(task.demand || DEMAND_DEFAULT));
		const effort = gearInfo.gear;
		// 2026-11-02 设计确定：先复用，池里没有（或队长说过不要）才新起子智能体。
		const reused = pinned === "" ? await tryReuseMember(leadId, leadAgent, provider, model, effort, task) : undefined;
		if (reused !== undefined) {
			autoFillAt.set(leadId, Date.now());
			try { saveJson(rosterPath, Object.fromEntries(members)); } catch { /* 落盘失败不阻断补员 */ }
			persistAll();
			sweepIdle(leadId);
			return { reused: reused.name, tid: task.tid, route: `${provider}/${model}@${effort}` };
		}
		const name2 = nextAutoName(leadId);
		// 补员必须继承队基底（隔壁实录根因：auto 成员全落在 Teamstate\runs 下，产物写歪）
		const workdir = memberWorkdir(leadId, name2, "");
		const mkErr = ensureWriteRoot(workdir);
		if (mkErr !== undefined) return { skipped: `写根建不出来：${workdir}` };
		const meta = teamMeta(leadId, name2);
		const body0 = `待命。板上 ${task.tid}（${task.title}）在排队，收到领单消息就开工；产物写在写根。`;
		const taskText = `写根（默认产出目录；${WORKSPACE_ROOT} 外会被拒）：${workdir}\n写根父目录（不是任务编号）：${nodePath.dirname(workdir)}\n` + body0;
		const childId = randomUUID();
		const member = { name: name2, parentSessionId: leadId, provider, model, effort, demand: String(task.demand || DEMAND_DEFAULT), effortWhy: `补员按 d${demandRank(task.demand)}`, routeSource: "plugin", autoSpawned: true, caps: splitCsv((task.caps || []).join(",")), currentTask: null, spawnedAt: Date.now(), lastResult: null, lastError: null, lastErrorClass: null, lastEvent: null, lastEventAt: null, lastStreamAt: null, toolErrStreak: 0, lastToolError: null, lastToolErrorAt: null, loopAt: null, workdir, sandboxMode: "pending", outOfWorkspace: outsideWorkspace(workdir), deniedCount: 0, deniedPaths: [] };
		members.set(childId, member);
		autoFillAt.set(leadId, Date.now());
		// 2026-11-01 第四重（也是最后一块）：**先把名册落盘，再 spawn**。
		// 原来 persistAll() 在 startActivation **之后**（第 797 行），中间隔着一次网络往返。
		// 两个实例重叠时，A 还没写盘、B 读盘自然看不到 auto1 → B 也补一个。
		// 现在先把 member 写进磁盘名册（只写 roster，不做整套 persistAll，避免多余 IO），
		// 别的实例下一次读盘就能看见这个"已在途"的人。
		// 激活失败那条路径会把 member 从内存删掉并再落一次盘，不会留下幽灵条目。
		try { saveJson(rosterPath, Object.fromEntries(members)); } catch { /* 落盘失败不阻断补员 */ }
		try {
			// 2026-11-15 修（DSH RC1→RC3 破坏性接口变更）：RC3 的 startActivation 读扁平字段
			// spec.parent / spec.cwd / spec.prompt / spec.agentOptions，不再读 spec.request.*
			// （旧内核 RC1 读的是 spec.request.parent 等）。两份都传：RC3 走扁平，RC1 走 request，互不干扰。
			const activation = await ctx.subagents.startActivation({ provider: "spawn", childId, label: `${name2} 补员`, parent: leadAgent, cwd: workdir, prompt: [{ type: "text", text: taskText }], agentOptions: { provider, model, reasoningEffort: effort }, request: { parent: leadAgent, cwd: workdir, prompt: [{ type: "text", text: taskText }], agentOptions: { provider, model, reasoningEffort: effort } }, delivery: "parent", signal: new AbortController().signal });
			pinMemberMode(activation, childId, member);
		} catch (error) {
			members.delete(childId);
			// 删了就得再落一次盘：上面为了防重复已经先写过一次名册，不清掉会留幽灵成员
			try { saveJson(rosterPath, Object.fromEntries(members)); } catch { /* ignore */ }
			return { skipped: `激活失败：${String(error).slice(0, 100)}` };
		}
		persistAll();
		// 2026-10-31 隔壁问题 7：回执写「去领 t1」，可队长读到它时 t1 早就 done 了 ——
		// 那句话是按补员那一刻的板子写的，不是此刻的板子。改成"它会自己领最优先的单"，
		// 当时看到的那单只作参考并带上标题，免得队长照着过期的 tid 指挥。
		pushNotice(leadId, "自动补员", `${name2} 起了（${provider}/${model}@${effort}），它会自己领板上最优先的单（补员时看到的是 ${task.tid}《${task.title}》）${deadNote}；它空闲后会被回收进成员池，下次来活优先唤醒它复用（不新起）`);
		// 补员后立刻扫一遍空闲成员：新成员一 idle 就能抢单，不必等下一次人肉 team 调用。
		sweepIdle(leadId);
		return { spawned: name2, tid: task.tid, route: `${provider}/${model}@${effort}` };
	}
	// 2026-11-01 维护方报「5 个并行任务就给 2 个人？」—— 除了上面的判据 bug（把正在忙的人算成
	// "能干活"），还有第二个原因：autoFillOne **一次只补一个人**，而它补完就设了 30 秒冷却，
	// 下一次 tick（10 秒一轮）照样被冷却挡住。于是 5 条独立单要等两三分钟才慢慢凑齐人手，
	// 中间的并行度白白空着。拆单是为了并行，补员却按串行节奏走。
	// 现在 tick 里直接**补到够**：同一个 tick 内反复调动 autoFillOne（bypass 绕开 30 秒冷却），
	// 直到它返回的不是 spawned（人够了 / 名额满 / 并发满 / 选不出路由）。
	// 安全：轮次封顶 maxMembers，且每轮过后新成员已进 members，下一轮 freeAble 立刻 +1，
	// 所以 ready <= freeAble 一到就停，绝不会无限加人。
	async function autoFillToSatisfy(leadId) {
		// 2026-11-01 维护方报「不对，怎么出来 2 个了？」—— 串行链只该起 1 个人，却起了 2 个。
		// 根因：**补员这件事本身不是原子的**。
		//   autoFillToSatisfy 是 async 的，第一次 await autoFillOne 期间控制权交还事件循环；
		//   这时 create 分支和 tick 分支会并发调进来，两边都读到「空着的人 = 0」，
		//   于是各补一个 → 2 个人。判据本身没错，是判据和落子之间有个 await 窗口。
		// 修法（两重）：
		//   ① 按队加**在途锁**，同一队同时只允许一个补员流程在跑，后来的立即返回不排队；
		//   ② 锁挂在 **globalThis** 上，不放在实例闭包里 —— 热重载/多实例时每个实例各一份
		//      小 Map，锁等于没加（实测：加了实例内锁照样起 2 个）。同进程内必须共享同一把锁。
		// 锁在 finally 里释放，异常路径不会把队锁死。
		const lockKey = fillLockKey(leadId);
		if (globalThis[lockKey] === true) return { skipped: "补员已在途（同队只跑一个）" };
		globalThis[lockKey] = true;
		// 2026-11-01 第三重保护：**磁盘锁**。
		// 前两重（globalThis 在途锁 + 落子前重读 roster）都堵不住这个窗口：
		// 两个插件实例在同一个进程里被加载两遍（hook-status 的 via 里同一组三个 hook 出现两次
		// 就是证据），各自持有自己的 members 内存名册。
		//   实例 A：判据说没人 → spawn auto1 → **然后才 persistAll() 写盘**
		//   实例 B：几乎同时判据说没人（它读盘时 A 还没写）→ spawn auto2
		// 两个 spawn 只差 2 秒（实测 19:35:02 / 19:35:04），正是这个重叠。
		// globalThis 的锁在**同一个管道里**有效，但两个实例的 await 落点可能不同步；
		// 磁盘文件才是跨实例真正互斥的东西。用 O_EXCL 建锁文件：
		//   wx = 已存在就失败 → 天然 CAS，不需要额外加锁逻辑。
		// 抢不到锁的一方直接放弃（前面那个会把人数补到够），不排队。
		// 锁文件带进程/时间戳，超过 30 秒视为死锁自动清掉（插件崩了不会永久挡住补员）。
		const lockFile = nodePath.join(stateDirPath(), ".filllock-" + shortOf(leadId));
		let lockFd = null;
		try {
			nodeFs.mkdirSync(nodePath.dirname(lockFile), { recursive: true });
			// 先判死锁：锁文件 mtime 超过 30 秒 = 上一个持有者崩了
			try {
				const st = nodeFs.statSync(lockFile);
				if (Date.now() - st.mtimeMs > 30000) nodeFs.unlinkSync(lockFile);
			} catch { /* 没有锁文件，正常路径 */ }
			lockFd = nodeFs.openSync(lockFile, "wx");
			nodeFs.writeSync(lockFd, String(Date.now()));
		} catch {
			// 别人正持有磁盘锁：这一轮直接让出去
			if (lockFd !== null) { try { nodeFs.closeSync(lockFd); } catch { /* ignore */ } }
			globalThis[lockKey] = false;
			delete globalThis[lockKey];
			return { skipped: "别处正在补员（磁盘锁被持有）" };
		}
		try {
			const cap = Math.max(1, Number(cfg.maxMembers || 8));
			const out = [];
			for (let i = 0; i < cap; i += 1) {
				const r = await autoFillOne(leadId, { bypass: true });
				// 2026-11-02：复用那条路返回 {reused}，和 {spawned} 一样是"补到人了"，
				// 判停必须两个都认，否则复用第一次成功就退出循环、后面几条单没人补。
				if (r.spawned === undefined && r.reused === undefined) {
					if (i === 0) return r;
					return { spawned: out.join(","), last: r.skipped || "" };
				}
				out.push(r.spawned !== undefined ? r.spawned : r.reused + "(复用)");
			}
			return { spawned: out.join(",") };
		} finally {
			delete globalThis[lockKey];
			if (lockFd !== null) { try { nodeFs.closeSync(lockFd); } catch { /* ignore */ } }
			try { nodeFs.unlinkSync(lockFile); } catch { /* 已被死锁清理删掉 */ }
		}
	}
	// 2026-11-01 返回 promise：tick 里要**等补员真的跑完**再落盘。
	// 原来这里是 fire-and-forget（`void autoFillToSatisfy(...)`），紧接着就 persistAll()，
	// 于是把**还没补到人的内存快照**写回磁盘，覆盖掉 autoFillOne 刚写的那份名册。
	// 后果：下一轮 tick 的实例读盘看不到刚补出来的人 → 又补一个（实测同一队起 2 个，
	// 精确相隔 10.5 秒 = 一个 tick 周期）。这不只是"多一个人"，是**判据读的盘是错的**。
	async function autoFillTick() {
		if (cfg.autoFill !== true) return;
		for (const leadId of boards.keys()) {
			try { await autoFillToSatisfy(leadId); } catch { /* 补员失败不该影响主循环 */ }
		}
	}

	const persistTimer = ctx.timer ? ctx.timer.interval(() => {
		// a tick can land while the plugin is being unloaded: touch nothing then
		try {
			if (ctxAlive()) {
				// 落盘的闸门在 persistAll 里（它会先并一次磁盘，只写本实例改过的那些路由）。
				// 这里不再自己判 mtime：判两遍反而会在"刚合并完"时误把正常写盘跳掉。
				// 补员必须 **await 完再落盘**：顺序反了就会拿旧快照覆盖掉刚补出来的人。
				sweepBoards(); sweepStalls(); recycleIdleMembers();
				Promise.resolve(autoFillTick())
					.catch(() => { /* 补员异常不影响落盘 */ })
					.finally(() => { try { persistAll(); } catch { /* dead ctx */ } });
			}
		} catch { /* dead ctx: nothing to save */ }
	}, 10000) : null;

	// Silent-hang watch (#21). A member can sit in "running" forever when the
	// provider accepts the request and then never produces a token: the kernel's
	// stream watchdog aborts at 300s, `llm-retry` silently re-sends the same
	// route (up to 5 times), and the board just sees "running". Nothing is
	// logged because no step ever fails. Warn the Lead once per episode, then
	// escalate; never kill on our own — a slow route is the Lead's call.
	function sweepStalls() {
		const now = Date.now();
		for (const member of members.values()) {
			const agent = ctx.agents.get(sessionIdOf(member));
			if (agent === undefined || String(agent.status) !== "running") {
				member.stallNoticeAt = null;
				member.stallEscalateAt = null;
				continue;
			}
			const last = Math.max(
				typeof member.lastStreamAt === "number" ? member.lastStreamAt : 0,
				typeof member.lastEventAt === "number" ? member.lastEventAt : 0,
				typeof member.spawnedAt === "number" ? member.spawnedAt : 0,
			);
			const idleSec = Math.round((now - last) / 1000);
			if (idleSec < cfg.stallNoticeSec) {
				member.stallNoticeAt = null;
				member.stallEscalateAt = null;
				continue;
			}
			const route = `${member.provider}/${member.model}@${member.effort}`;
			const tid = member.currentTask ? ` tid:${member.currentTask}` : "";
			if (member.stallNoticeAt === null || member.stallNoticeAt === undefined) {
				member.stallNoticeAt = now;
				pushNotice(member.parentSessionId, "成员静默",
					`${member.name} @${route}${tid}｜已 ${Math.round(idleSec / 60)} 分钟无任何流/事件（内核 5 分钟流空闲判 TIMEOUT 并自动重试，重试期就是"running 不动"）｜不自动停，要停 team(kill,to:"${member.name}")`);
				archiveError({ at: now, kind: "stall", route: member.provider + "/" + member.model, effort: member.effort, by: member.name, class: "静默无输出", raw: `idle ${idleSec}s, lastEvent=${member.lastEvent || "-"}, tid=${member.currentTask || "-"}` });
			} else if ((member.stallEscalateAt === null || member.stallEscalateAt === undefined) && idleSec >= cfg.stallEscalateSec) {
				member.stallEscalateAt = now;
				pushNotice(member.parentSessionId, "成员静默",
					`仍未恢复：${member.name} @${route}${tid} 已 ${Math.round(idleSec / 60)} 分钟无输出，建议 team(kill,to:"${member.name}") 换路由重派`);
			}
		}
	}

	function sweepBoards() {
		// tasks posted while all members slept: wake each lead's idle/cold member.
		for (const [leadId, board] of boards) {
			// 2026-10-30 自愈：板上已有「预指派给不存在成员」的脏单（历史 bug 留下的，
			// 比如 owner=某次实测 那种会话短号）。新校验只能挡住新单，救不了旧单 ——
			// 它会永远等一个不存在的人。这里每 tick 收一次：owner 不是本队成员名 → 清成可领。
			// 顺带给队长一条 notice，不静默改数据。
			for (const task of board.tasks.values()) {
				if (task.status !== "open") continue;
				if (task.owner === null || task.owner === undefined || task.owner === "") continue;
				const known = Array.from(members.values()).some((m) => m.parentSessionId === leadId && m.name === task.owner);
				if (known) continue;
				const bad = task.owner;
				task.owner = null;
				task.preassigned = false;
				task.revision += 1;
				persistAll();
				pushNotice(leadId, "预指派已自愈", `${task.tid} 原预指派 owner="${bad}" 不是本队成员名（历史 bug 留下的），已清成任何成员可领；要指定人请 task(action2:"set", tid:"${task.tid}", owner:"<成员名>")`);
			}
			// 成员路由自愈：成员钉在一条「长墙」路线上（上游给了明确解禁时刻、还早）时，
			// 老规矩会让它一直等到点 —— 整队停摆。新报错的路径已经在 recordFailure 里换了，
			// 这一条管**已经卡住的存量成员**：每 tick 检查一次，撞长墙就当场换一条能跑的。
			// 2026-10-30 实录：auto1 撞 cline 14 小时墙，插件只看"退避中不派"就整队等到次日。
			// 短退避（< WALL_ROTATE_MS）不动 —— 那点时间里换路由纯属白烧选路。
			// 每个「成员@路由」只试一次，5 分钟内不重试：池子里真没有能跑的路由时，
			// 不节流就等于每 10 秒往队长那里推一条「换路由失败」。
			for (const member of members.values()) {
				if (member.parentSessionId !== leadId) continue;
				const routeKey = member.provider + "/" + member.model;
				const wall = wallUntil(ledger.get(routeKey));
				if (wall === null || wall - Date.now() < WALL_ROTATE_MS) continue;
				const healKey = sessionIdOf(member) + "|" + routeKey;
				const triedAt = wallHealAt.get(healKey) || 0;
				if (Date.now() - triedAt < 5 * 60 * 1000) continue;
				// 只救「真正的闲置」：正跑着的不打断（它可能马上就结束，换路由会让它下次请求突变）
				const agent = ctx.agents.get(sessionIdOf(member));
				if (agent !== undefined && String(agent.status) === "running") continue;
				wallHealAt.set(healKey, Date.now());
				const mins = Math.max(1, Math.round((wall - Date.now()) / 60000));
				const moved = rotateMemberRoute(member, `这条路由要停 ${mins} 分钟，成员不能干等（自愈）`);
				if (moved !== undefined) {
					persistAll();
					// 换完立刻让它去领活，不等下一次人肉 team 调用
					if (member.currentTask === null) dispatchSafely(member, agent);
				}
			}
			if (!Array.from(board.tasks.values()).some((task) => task.status === "open")) continue;
			for (const member of members.values()) {
				if (member.parentSessionId !== leadId || member.currentTask !== null) continue;
				const agent = ctx.agents.get(sessionIdOf(member));
				if (agent === undefined || agent.status === "idle") dispatchSafely(member, agent);
			}
		}
	}
	/** leadSessionId -> team file name; teams here are mirrored every persist tick. */
	const savedTeams = new Map();
	function teamFilePayload(leadId, name) {
		const board = boards.get(leadId);
		return {
			team: name, leadSessionId: leadId, savedAt: Date.now(), goal: (goals.get(leadId) || {}).text || null,
			members: Array.from(members.values()).filter((m) => m.parentSessionId === leadId)
				.map((m) => ({ name: m.name, provider: m.provider, model: m.model, effort: m.effort, demand: m.demand || null, caps: m.caps, currentTask: m.currentTask, workdir: m.workdir || null })),
			tasks: board ? Array.from(board.tasks.values()) : [],
		};
	}
	function writeTeamFile(leadId, name) {
		const dest = nodePath.join(cfg.teamDir, name.replace(/[\\\/:*?"<>|]/g, "_") + ".json");
		if (saveJson(dest, teamFilePayload(leadId, name))) { savedTeams.set(leadId, name); return dest; }
		return undefined;
	}
	/** 精简过继档案：只留「总目标 + 拆单清单 + 完成状态 + 产物/失败原因」，
	 *  不带 notice、成员、台账、走位细节。会话被删/收队时写一份，新对话用 adopt 继承。 */
	function writeCompactTeamFile(leadId, name) {
		const board = boards.get(leadId);
		const tasks = board === undefined ? [] : Array.from(board.tasks.values()).map((t) => ({
			tid: t.tid,
			title: t.title,
			status: t.status,
			kind: t.kind || "grunt",
			size: t.size || "m",
			demand: t.demand === undefined ? "2" : t.demand,
			prio: Number(t.prio || 0),
			owner: t.owner || null,
			artifacts: Array.isArray(t.artifacts) ? t.artifacts : [],
			...(t.error === undefined ? {} : { error: String(t.error).slice(0, 300) }),
			...(t.lastReport ? { lastReport: String(t.lastReport).slice(0, 240) } : {}),
			createdAt: t.createdAt || null,
			finishedAt: t.finishedAt || null,
		}));
		const goalText = String(((goals.get(leadId) || {}).text || (board === undefined ? "" : (board.goal || {}).text) || "")).trim();
		const payload = {
			leadSessionId: String(leadId),
			name,
			compact: true,
			savedAt: Date.now(),
			savedAtStr: new Date().toLocaleString("zh-CN", { hour12: false }),
			goal: { text: goalText },
			tasks,
			summary: `目标：${goalText.slice(0, 60) || "(无)"}｜单 ${tasks.length}：done ${tasks.filter((t) => t.status === "done").length} / failed ${tasks.filter((t) => t.status === "failed").length} / open ${tasks.filter((t) => t.status === "open").length} / claimed ${tasks.filter((t) => t.status === "claimed").length}`,
		};
		const dest = nodePath.join(cfg.teamDir, name.replace(/[\\\/:*?"<>|]/g, "_") + ".json");
		return saveJson(dest, payload) ? dest : undefined;
	}
	/** A team is locked while its Lead Session exists at all (live in memory OR on disk). */
	async function leadExists(leadId) {
		if (ctx.agents.get(leadId) !== undefined) return true;
		try { return (await ctx.sessionPersistence.stat(leadId)) !== undefined; } catch { return false; }
	}
	/** 本实例最后一次成功落盘的时刻。dispose 用它判断「内存比磁盘新吗」——
	 *  磁盘被外部改过（mtime 更晚）就说明磁盘才是最新的，退出不许覆盖。 */
	let lastPersistAt = 0;
	/** 落盘。**闸门不放在这里**，放在两个"周期性/退出"调用点（tick 和 dispose）——
	 *  因为 persistAll 也承担"刚记了一笔真派结果、马上要落盘"的职责：那种时候磁盘
	 *  哪怕更新也不能丢我们这一笔。定时刷盘没有这个包袱（它没有专属改动），
	 *  磁盘更新就该让位给磁盘那份。 */
	function persistAll() {
		// **先并后写**：磁盘上有别人改的东西，不能拿我们这份旧副本盖掉。
		// 只并「本实例没改过」的路由；改过的那些保留内存版（否则刚记的一笔就没了）。
		if (diskIsNewer()) mergeDiskIntoMemory();
		saveJson(ledgerPath, Object.fromEntries(ledger));
		saveJson(rosterPath, Object.fromEntries(members));
		saveJson(boardPath, Object.fromEntries(Array.from(boards, ([leadId, board]) => [leadId, { seq: board.seq, tasks: Array.from(board.tasks.values()), goal: goals.get(leadId) || null, meta: board.meta || null }])));
		saveJson(scoresPath, Object.fromEntries(scores));
		for (const [leadId, name] of savedTeams) writeTeamFile(leadId, name);
		lastPersistAt = Date.now();
		// 我们刚写过，磁盘就是"我们见到的"这个版本了 —— 记下来，别让下一 tick 误判成外部改动。
		lastSeenDiskAt = ledgerDiskMtime();
		// 已经落盘了，这些改动不再是"悬着的"：清掉标记，下次就完全听磁盘的。
		dirtyKeys.clear();
	}
	setLedgerPersist(persistAll); // 台账模块通过这个钩子落盘（模块化后依赖方向反过来）
	/** 声明产物的落地绝对路径（写根相对路径 / 绝对路径两种写法都算）。
	 *  派单时回显给成员、结单时核对，都用这一份解析，避免两处规则不一致。
	 *  #5：写根逃逸三例（workspace 根、LongMem 直下、缺项目段）都是成员自己拼路径拼歪。 */
	function artifactAbs(task, member) {
		const list = Array.isArray(task.artifacts) ? task.artifacts : [];
		if (list.length === 0) return [];
		const root = member === undefined ? "" : String(member.workdir || member.root || "");
		return list.map((raw) => (nodePath.isAbsolute(raw) ? raw : (root !== "" ? nodePath.join(root, raw) : raw)));
	}
	/** 产物路径归一：同一个文件在「相对写根 / 绝对路径 / 反斜杠 / 尾随斜杠 / ./ 前缀」几种写法下
	 *  必须认成同一个东西，否则「两个人改同一个文件」判不出来（隔壁 t2-t5 实录）。 */
	function artifactKey(raw) {
		return String(raw || "")
			.trim()
			.replace(/\\/g, "/")
			.replace(/\/+$/, "")
			.replace(/^\.\//, "")
			.toLowerCase();
	}
	/** 目录产物里「新」的文件：递归找 mtime 不早于领单的那个。返回 null = 目录里没有可认的产物。
	 *  2026-10-30 隔壁实测：artifacts 写 `.tmp/` 被当单文件核对，判「不是文件」拒收 ——
	 *  成员干完了活却结不了单，只能让队长 force。cap 防止往巨型目录里深挖。 */
	function newestFileIn(dir, sinceMs, cap = 400) {
		let seen = 0;
		let best = null;
		const walk = (d, depth) => {
			if (depth > 6 || seen >= cap) return;
			let ents;
			try { ents = nodeFs.readdirSync(d, { withFileTypes: true }); } catch { return; }
			for (const ent of ents) {
				if (seen >= cap) return;
				const p = nodePath.join(d, ent.name);
				if (ent.isDirectory()) {
					if (/^(node_modules|\.git)$/.test(ent.name)) continue;
					walk(p, depth + 1);
					continue;
				}
				if (!ent.isFile()) continue;
				seen += 1;
				let st;
				try { st = nodeFs.statSync(p); } catch { continue; }
				if (sinceMs > 0 && st.mtimeMs + 1000 < sinceMs) continue;
				if (best === null || st.mtimeMs > best.mtimeMs) best = { path: p, mtimeMs: st.mtimeMs };
			}
		};
		walk(dir, 0);
		return best;
	}
	/** 2026-10-31 验收门（评审采纳某次实测 13:49:55 的建议，实现由实现方定）：
	 *  问题：`finish` 之后任务直接 `done` + 立刻解锁下游。而插件**只能验"文件在不在"**
	 *  （存在性 + mtime），验不了"内容真不真" —— 隔壁实测 t1/t8/t10 三次空心交付
	 *  （json 全空字段）全部通过检查并解锁下游，每次连锁返工。
	 *  做法：`finish` → **`delivered`（待验收）**，下游不解锁；队长用 `task(action2:"accept")`
	 *  验收通过才 `done` 并放行下游；`reject` 打回 → 任务回 `open`，下游继续挡着。
	 *  三处解锁判据统一收进 `taskSettled()`，不许各处各写一套（漏一处就等于没做）。
	 *  `cfg.acceptGate === false` 可关掉（老行为：finish 即 done），给不想验收的队留后门。 */
	const taskSettled = (x) => x === undefined
		|| x.status === "done"          // 真结案
		|| x.status === "failed"        // 失败也算"已定局"，下游不该被它永久挡住
		// acceptGate 关掉时 delivered 也只是个中间态，要当作已结（否则整板死锁）
		|| (cfg.acceptGate === false && x.status === "delivered");

	/** 状态流水（2026-10-31 某次实测 实测：「t2 从 claimed 变 delivered，变化无日志/提示，
	 *  难定位原因」）。板子上原来只有一个当前状态：谁改的、什么时候、为什么，全都没有。
	 *  验收门之后状态更多（open/claimed/delivered/done/failed），一条单向箭头根本还原不出
	 *  中途被谁退回过、退回了几次。所以每处状态赋值前先记一笔，随任务一起落盘。
	 *  调用约定：**先 noteStatus 再赋值**（helper 自己读的是赋值前的 from）。
	 *  - 同一状态 3 秒内重复（自动派单/收尾两条路径撞车）合并，不刷屏；
	 *  - 只留 20 条，板子不因为trail 膨胀；
	 *  - by 写"谁"（成员名 / 队长短号 / plugin），why 一句话说原因。 */
	function noteStatus(task, to, by, why) {
		if (task === undefined || task === null) return task;
		const from = task.status;
		const list = Array.isArray(task.trail) ? task.trail : (task.trail = []);
		const now = Date.now();
		const last = list.length === 0 ? undefined : list[list.length - 1];
		if (last !== undefined && last.to === to && now - Number(last.at || 0) < 3000) {
			last.at = now; // 同一跳重复记录：刷新时间，不新增一条
			return task;
		}
		list.push({ at: now, from, to, by: String(by === undefined || by === null ? "-" : by), why: String(why || "").slice(0, 120) });
		while (list.length > 20) list.shift();
		return task;
	}
	/** trail 的压缩显示：list 行只放最近一跳，status 里可看全。 */
	function trailLine(task) {
		const list = Array.isArray(task.trail) ? task.trail : [];
		if (list.length === 0) return "";
		const last = list[list.length - 1];
		const ago = Math.round((Date.now() - Number(last.at || 0)) / 1000);
		const when = ago < 0 ? "?" : ago < 60 ? `${ago}s前` : `${Math.round(ago / 60)}min前`;
		return `|轨迹 ${last.from}→${last.to}@${last.by} ${when}${last.why === "" ? "" : "（" + last.why + "）"}`;
	}

	function verifyArtifacts(task, member) {
		// 2026-10-31 维护方提问「不填产出的单会不会被自己拦一次」时实测出来的矛盾：
		// no_artifact:true + artifacts:"out.md"（文件不存在）→ 照样拒收。两个开关互相打脸，
		// 声明了"本单没有文件产物"反倒比不声明更容易被卡。以 no_artifact 为准，先返回。
		if (task.noArtifact === true) return [];
		const list = Array.isArray(task.artifacts) ? task.artifacts : [];
		if (list.length === 0) return [];
		const root = member === undefined ? "" : String(member.workdir || member.root || "");
		const since = Number(task.claimedAt || task.createdAt || 0);
		const bad = [];
		// 模型 token 残留绝不可能是正常产出：出现就拒收（思考文本本身不拦，会误伤）。
		const TOKEN_RESIDUE = /<\|(?:end|im_end|eot_id|start_header_id|endoftext)\|>|<\/s>|<s>/;
		for (const raw of list) {
			const p = nodePath.isAbsolute(raw) ? raw : (root !== "" ? nodePath.join(root, raw) : raw);
			let st;
			try { st = nodeFs.statSync(p); } catch { bad.push({ path: raw, why: "不存在" }); continue; }
			if (st.isDirectory()) {
				const fresh = newestFileIn(p, since);
				if (fresh === null) {
					bad.push({ path: raw, why: since > 0 ? "目录里没有 mtime 晚于领单的文件（空目录或只有旧文件）" : "目录里没有任何文件" });
					continue;
				}
				continue;
			}
			if (!st.isFile()) { bad.push({ path: raw, why: "不是文件也不是目录" }); continue; }
			if (since > 0 && st.mtimeMs + 1000 < since) bad.push({ path: raw, why: "mtime 早于领单，像是旧文件" });
			try {
				const head = nodeFs.readFileSync(p, "utf8").slice(0, 4000);
				if (TOKEN_RESIDUE.test(head)) bad.push({ path: raw, why: "含模型 token 残留（如 <|end|>），清掉再 finish" });
			} catch { /* 二进制或不可读：跳过内容检查，不当作失败 */ }
		}
		return bad;
	}

	// --- crash guard (crash-2026-10-28T05-15-33Z-host.log): the host may reload or
	//     unload this plugin while member agents are still alive. Their listeners hang
	//     off the AGENT context, not this one, so they keep firing after this plugin's
	//     context is dead; a raw `ctx.agents` access then throws "cannot get required
	//     service ... in inactive context", cordis escalates that to a fatal load
	//     failure, and the whole desktop host exits (维护方 sees 关闭/重启/关闭第三方插件).
	//     Every agent-level callback bails out here first; every async dispatch swallows.
	function ctxAlive() {
		try {
			// `get` is the safe read (returns undefined instead of throwing on a live but
			// not-yet-ready context); fall back to the property access, which throws when
			// the context is inactive — and that throw is exactly what we swallow.
			if (typeof ctx.get === "function") return ctx.get("agents") !== undefined;
			return ctx.agents !== undefined;
		} catch { return false; }
	}
	function dispatchSafely(member, agent) {
		if (!ctxAlive()) return;
		void maybeDispatch(member, agent); // never rejects, see wrapper below
	}

	// --- member route override: same public shape as installModelSelection.
	//     Outermost post-processing wins, so a cold-resumed descriptor snapshot
	//     can never beat the roster value. Read the member live (retool mutates
	//     the record; the listener must see the current route, not a snapshot).
	function attachRouting(agent) {
		const sessionId = agent.session.id;
		// AGENTS.md suppression: instruction messages enter each step as user-role
		// messages tagged source.kind === "agent-instructions"; drop them for members
		// and swap in the team badge (read fresh every step →维护方改文件即时生效).
		const member0 = members.get(sessionId);
		if (cfg.suppressAgentsMd === true && member0 !== undefined) {
			// badge: official runtime-context channel (string text, proven shape)
			const badge = badgeText();
			if (badge !== undefined) {
				try {
					const prompt = typeof agent.ctx.get === "function" ? agent.ctx.get("systemPrompt", false) : agent.ctx.systemPrompt;
					if (prompt !== undefined && prompt !== false) prompt.context({ name: "dsh-team:badge", order: 1, text: badge });
				} catch (error) {
					if (ctx.logger) ctx.logger.warn("dsh-team: badge context failed (degraded): " + String(error));
				}
			}
			// AGENTS.md suppression: instruction messages carry source.kind
			// "agent-instructions"; pure removal is order-safe and adds nothing.
			agent.ctx.on("agent/pre-step", (_payload, next) => {
				if (!ctxAlive()) return next();
				return next().then((decision) => {
					const incoming = decision.messages || [];
					const kept = incoming.filter((m) => !(m && m.source && m.source.kind === "agent-instructions"));
					return kept.length === incoming.length ? decision : { ...decision, messages: kept };
				});
			}, { prepend: true });
		}
		agent.ctx.on("system-prompt/assemble", async (assembly, _context, next) => {
			if (!ctxAlive()) return next();
			const member = members.get(sessionId);
			const result = await next();
			if (member === undefined) return result;
			// 复活/续跑的成员会把历史里的旧任务当活接着干：板上是 t1 冒烟单，手上在改上一单
			// 已交付的 cf.py。派单消息在历史里只占一行，压不过最早的旧指令；系统提示每步重算
			// 的这条上下文才压得住 —— 当前任务之外的历史任务一律作废。
			const contexts = result.contexts.filter((c) => c.name !== CONTEXT_TASK);
			return {
				...result,
				contexts: [...contexts, { name: CONTEXT_TASK, text: memberTaskContext(member) }],
				variables: { ...result.variables, provider: member.provider, model: member.model },
			};
		}, { prepend: true });
		// 旧内核对证：0.2.2-rc.1 的 prepareRequest 会完整段比对 agent/request 的返回值
		// 与 step 开始时定下的 selection，改写即抛 "after step preparation fixed …"。
		// 新内核（有 agent.model.select）一律不装这条覆写，改由 syncMemberSelection 写 selection。
		if (!kernelHasModelSelect(agent)) {
			agent.ctx.on("agent/request", async (_payload, next) => {
				if (!ctxAlive()) return next();
				const member = members.get(sessionId);
				const resolved = await next();
				if (member === undefined) return resolved;
				const { reasoningEffort: _inherited, ...withoutEffort } = resolved;
				return { ...withoutEffort, provider: member.provider, model: member.model, reasoningEffort: member.effort };
			}, { prepend: true });
		}
		// 新内核：挂载/复活时就把名册路由写进 selection，首个请求即走对路由
		// （冷恢复的 descriptor 快照可能停在退役时的档位，写 selection 才压得住它）。
		syncMemberSelection(agent, members.get(sessionId));
	}

	// --- 0.2.2-rc.1 起的换路由通道：`agent.model.select()`。
	function kernelHasModelSelect(agent) {
		return agent !== undefined && agent !== null && agent.model !== undefined && agent.model !== null && typeof agent.model.select === "function";
	}
	/** 把名册里的目标路由同步进内核 selection。幂等：与当前 selection 完全一致时不落事件。 */
	function syncMemberSelection(agent, member) {
		if (!kernelHasModelSelect(agent) || member === undefined || member === null) return false;
		const effort = member.effort === undefined || member.effort === null || String(member.effort) === "" ? undefined : String(member.effort);
		const want = { provider: String(member.provider), model: String(member.model), ...(effort === undefined ? {} : { reasoningEffort: effort }) };
		let have;
		try { have = typeof agent.model.current === "function" ? agent.model.current() : undefined; } catch { have = undefined; }
		const haveEffort = have === undefined || have === null || have.reasoningEffort === undefined || have.reasoningEffort === null ? undefined : String(have.reasoningEffort);
		if (have !== undefined && have !== null && String(have.provider) === want.provider && String(have.model) === want.model && haveEffort === effort) return true;
		try {
			agent.model.select(want);
			return true;
		} catch (error) {
			if (ctx.logger) ctx.logger.warn("dsh-team: model.select 失败（降级：该成员仍跑旧路由）：" + String(error));
			return false;
		}
	}
	/** 名册改完路由/档位立刻调一次：活着的成员下一步就走新路由；冷成员等复活时 attachRouting 补。 */
	function syncMemberSelectionOf(member) {
		if (member === undefined || member === null) return;
		if (!ctxAlive()) return;
		let agent;
		try { agent = ctx.agents.get(sessionIdOf(member)); } catch { agent = undefined; }
		syncMemberSelection(agent, member);
	}

	function badgeText() {
		try { return nodeFs.readFileSync(cfg.memberBadgePath, "utf8").trim(); } catch { return undefined; }
	}
	// 每步重算的"当前任务"上下文。成员手上只认这一条；历史里其它未完成任务全部作废。
	const CONTEXT_TASK = "dsh-team:task";
	function memberTaskContext(member) {
		const board = boards.get(member.parentSessionId);
		const task = member.currentTask !== null && member.currentTask !== undefined && board !== undefined
			? board.tasks.get(member.currentTask)
			: undefined;
		const prior = (() => {
			const t = member.lastTask;
			if (t === undefined || t === null) return "";
			return `\n你上一条 ${t.tid}《${t.title}》已${t.status === "done" ? "交付" : "作废"}：不要续做，不要再读/改它的文件。`;
		})();
		if (task === undefined) {
			return `【当前任务】无（待命）：等派单消息，不要自己找活干。历史里没结的旧任务一律作废，不续做、不碰它们的文件。${prior}`;
		}
		return `【当前任务｜只做这一单】${task.tid}《${task.title}》状态 ${task.status}\n`
			+ "本单范围只在派单消息与任务书里；历史里其它任务（含你上次没做完的）一律作废，不续做、不读改它们的文件。\n"
			+ `干完调 team(action:"task", action2:"finish", tid:"${task.tid}")，三行头写在最后一条文本里。${prior}`;
	}
	// --- passive real-run accounting: every DSH run of a known ledger route
	//     is a free probe. agent/error → fail (+classify); clean idle → ok.
	const errorSeen = new WeakMap(); // agent -> boolean since last running
	function attachAccounting(agent) {
		const sessionId = agent.session.id;
		/** 一次失败的记账 + 成员自愈。队长和成员共用。 */
		const recordFailure = (raw0) => {
			errorSeen.set(agent, true);
			const header = agent.session.requestHeader ? agent.session.requestHeader() : undefined;
			const member = members.get(sessionId);
			const raw = String(raw0 === undefined || raw0 === null || raw0 === "" ? "request failed (no message)" : raw0);
			// ★ 2026-11-16（Updating\04 · 遗留 2）：与 noteAttemptFailure 同一处病灶。
			//   这里更要紧——它决定**记到哪条路由**（recordRealRun → 台账判活/判死）
			//   以及**成员该降档还是换路**（diagnoseError 的 routeKey 影响规则匹配）。
			//   用登记的 header.config 记，会把 mistral 的失败记到 cline 名下：
			//   真凶（下架路由）逃掉，无辜路由被记一笔失败。
			const parsedRoute = parseRouteFromError(raw);
			const effProvider = parsedRoute !== null ? parsedRoute.provider : (header && header.config ? header.config.provider : undefined);
			const effModel = parsedRoute !== null ? parsedRoute.model : (header && header.config ? header.config.model : undefined);
			const effKey = effProvider !== undefined && effModel !== undefined ? `${effProvider}/${effModel}` : undefined;
			if (effProvider !== undefined && effModel !== undefined) recordRealRun(effProvider, effModel, "fail", raw, header && header.config ? header.config.reasoningEffort : undefined, member === undefined ? null : member.name, sessionId);
			if (member !== undefined) {
				// 设计确定：的恢复顺序：先降档（同一模型换低档）；降到底还报档位不支持，
				// 才换路由（换模型）。路由级故障降档没用，直接换。限流和网关抖动不换
				// ——那是退避的事，换了也一样撞。处理方式由**规则表**给出（fix 字段）。
				// 传 routeKey：规则可以只对这条路由生效（匹配文本带 `[route] provider/model` 前缀）
				const verdict = diagnoseError(raw, effKey !== undefined ? effKey : (header && header.config ? `${header.config.provider}/${header.config.model}` : undefined));
				member.lastError = raw.slice(0, 160);
				member.lastErrorClass = verdict.class;
				member.lastErrorRule = verdict.ruleId;
				// 报错盒子的「插件能不能自己兜住」判据要读 fix：downshift/rotate/backoff/retry
				// = 插件已经办掉了（不必惊动队长）；dead/none = 只能由人决定（往上递）。
				member.lastErrorFix = verdict.fix === undefined ? "" : String(verdict.fix);
				let rotated = false;
				if (verdict.fix === "downshift" && downshiftMember(member) === undefined) {
					rotateMemberRoute(member, "降到最低档仍报档位不支持");
					rotated = true;
				} else if (verdict.fix === "rotate") {
					rotateMemberRoute(member, `路由级故障 ${verdict.class}`);
					rotated = true;
				}
				// 成员撞的是**长墙**（上游给了明确解禁时刻，且还早）→ 换一条现在就能跑的路由。
				// 2026-10-30 维护方抓到：auto1 撞 cline 14 小时账号池墙，插件按「限流只退避」办事，
				// 成员就一直钉在一条到点前绝不会被派的路由上，整队停摆 14 小时。
				// 「限流只退避不换」那条规矩对**队长**成立（队长换不换由设计确定：），对成员不成立：
				// 成员的活必须有人干，换一条能跑的就是它该做的事。
				// 短退避（抖动、限流几分钟）不换 —— 换了也一样撞，还白烧一次选路。
				if (!rotated) {
					const walled = wallUntil(ledger.get(`${member.provider}/${member.model}`));
					if (walled !== null && walled - Date.now() >= WALL_ROTATE_MS) {
						const mins = Math.max(1, Math.round((walled - Date.now()) / 60000));
						rotateMemberRoute(member, `这条路由要停 ${mins} 分钟（${verdict.class}），成员不能干等`);
					}
				}
			}
		};
		/** 请求级失败：只记账 + 学 ctx 真实上限，**不动路由健康度、不换成员路线**
		 *  ——这一层包含会被自动重试的临时错误，终态交给 agent/error 处理。 */
		const noteAttemptFailure = (raw0, payload) => {
			const header = agent.session.requestHeader ? agent.session.requestHeader() : undefined;
			// ★ 2026-11-16（Updating\04 · 遗留 2）：route 归属错位。
			//   原来一律用 `header.config.model`（**本次请求登记的**路由），但内核报错文本里
			//   经常写着**另一个**模型。实测 mistral 那次：
			//     route 记成 cline/thinkingmachines/inkling-2-small:free
			//     raw   写 provider "our-free-model" model "mistralai/mistral-large-4-1t-a52b" …
			//   看 route 会去查 cline，真正的凶手（下架路由）逃掉 —— 归因、规则匹配、
			//   面板统计全挂错对象。
			//   判据：**报错自己说的最可信** —— 先从 raw 解析，解析不到才退回 header。
			const rawText = String(raw0 === undefined || raw0 === null ? "" : raw0);
			const parsedRoute = parseRouteFromError(rawText);
			const regProvider = (payload && payload.provider) || (header && header.config && header.config.provider);
			const regModel = header && header.config ? header.config.model : undefined;
			const provider = parsedRoute !== null ? parsedRoute.provider : regProvider;
			const model = parsedRoute !== null ? parsedRoute.model : regModel;
			if (provider === undefined || model === undefined) return;
			const key = `${provider}/${model}`;
			const raw = String(raw0 || ((payload && payload.failure && payload.failure.code) || "request failed (no message)"));
			const verdict = diagnoseError(raw, key);
			const holder = members.get(sessionId);
			// 登记值与真凶不一致时**两个都记**，不静默吞掉 —— 面板/日志能看出
			// "这次是登记错，还是请求中途换过路由"。
			const regKey = regProvider !== undefined && regModel !== undefined ? `${regProvider}/${regModel}` : undefined;
			const mismatch = regKey !== undefined && regKey !== key;
			archiveError({ at: Date.now(), route: key, effort: header && header.config ? header.config.reasoningEffort : null, by: holder === undefined ? null : holder.name, class: verdict.class, attempt: true, raw: raw.replace(/\s+/g, " ").slice(0, 600), ...(verdict.ruleId === null ? {} : { rule: verdict.ruleId }), ...(mismatch ? { routeRequested: regKey } : {}) });
			const entry = ledger.get(key);
			if (entry !== undefined && learnCtxCap(entry, key, raw)) persistAll();
			// 队长侧（非成员）的报错当场就落进队长报错文件，不等 agent/error：
			// 有的失败只在这一层出现（10-29 那次 400 就是），等终态可能永远等不到。
			// 认不认得都记 —— 维护方拿大输入对话专门撞各模型上限，每条都是证据。
			if (holder === undefined) {
				recordLeadError(provider, model, header && header.config ? header.config.reasoningEffort : null, raw, { cap: capFromMessage(raw) });
				// 2026-10-29 维护方抓到：big-pickle 撞 `Free usage limit reached`（明明命中
				// `free-usage-limit-exhausted` 规则 = 额度限流），请求级这层照样唤醒隔壁队长
				// 待判 —— 隔壁一看是软故障当然不判死，白吵一次。recordRealRun 那边早有
				// `!verdict.known` 门，这里漏了：只有**没登记**的错才值得问人。
				if (!verdict.known) maybeAskLiveCaptain(sessionId, key, raw);
			}
		};
		// 内核的正名是 agent/request-error（waterfall，payload: {agent, turn, step, provider, failure{LlmFailure}}）：
		// 这是**每次请求失败**都会走的事件，队长的 400（10-29 poolside 超限那次）走这里，而
		// agent/error（emit）只在整轮失败时报。必须 `next()` 把链传下去——不传等于告诉内核
		// 「这条失败是终态」，别的插件（dsh-purge 的自动重试）就收不到了。
		agent.ctx.on("agent/request-error", async (payload, next) => {
			if (ctxAlive()) {
				const failure = (payload && payload.failure) || {};
				noteAttemptFailure(failure.message || (failure.error && failure.error.message) || "", payload);
			}
			return typeof next === "function" ? next() : undefined;
		});
		agent.ctx.on("agent/error", ({ error }) => {
			if (!ctxAlive()) return;
			recordFailure(error instanceof Error ? error.message : String(error));
		});
		// durable-event heartbeat: every committed session event proves the member is moving.
		agent.ctx.on("session/event", (session, event) => {
			if (!ctxAlive()) return;
			// 压缩发生（维护方 2026-10-30 定稿）：只听内核事实，不做任何预测。
			// 内核（dsh-compaction-basic）压缩时先 append `compaction/start`，成功后 append
			// `compaction/end`（带 compactionId + turn）；**失败收尾时也会 append end，但带
			// `error` 字段**。所以这里必须按 error 分流：只有「没有 error 的 end」才代表
			// 原作真被换掉、成员真的丢了记忆。压缩失败时上下文原样还在，去提醒它「你被压缩了」
			// 就是纯误报 —— 需求方要的是「不出现压缩压根不要提醒」，失败不算发生压缩。
			if (String(event.type || "") === "compaction/end") {
				const data = event.data === null || event.data === undefined ? {} : event.data;
				if (data.error === undefined) {
					try { onCompacted(sessionId, members.get(sessionId)); }
					catch (error) { if (ctx.logger) ctx.logger.warn("dsh-team: compaction notice failed: " + String(error)); }
				}
				// 不 return：压缩事件之后它可能还有别的状态要记
			}
			// 输出截断（不是报错、也不是干净完成）—— 队长和成员都要记。以前这里
			// `if (member === undefined) return;` 把队长的截断直接吞了，维护方看到的
			// 「现在都没反应，也不算错误，也不算正确」就是这个洞。
			if (String(event.type || "") === "turn/end") {
				const reason = event.data && event.data.reason ? event.data.reason : null;
				const kind = reason === null ? "" : String(reason.kind || "");
				if (kind === "max-tokens") {
					const h = agent.session.requestHeader ? agent.session.requestHeader() : undefined;
					const who = members.get(sessionId);
					if (h && h.config) {
						noteTruncated(h.config.provider, h.config.model, {});
						if (who === undefined) {
							// 队长侧：它自己就是被截断的那个，提醒它怎么继续，别让它以为撞了墙
							pushNotice(String(sessionId), "输出撞顶", `${h.config.provider}/${h.config.model} 这一轮输出到上限被截断（**不是**限流/网络/模型坏，不用换路由）：插件 ${Math.max(1, Number(cfg.autoContinueDelaySec || 10))} 秒后自动发「继续」，你不用手敲；长活本来就要分批写文件。`);
						}
					}
					// 自动续写（维护方 2026-11-01 定）：不管队长还是成员都排一次。
					// 只对「本插件认得的会话」排 —— 队伍成员，或建过板的队长会话；
					// 维护方别的闲聊对话框撞顶不该被插件插手。
					if (who !== undefined || boards.has(String(sessionId))) {
						const sched = scheduleAutoContinue(sessionId, {
							tid: who !== undefined && who.currentTask !== null ? who.currentTask : null,
							leadId: who !== undefined ? who.parentSessionId : String(sessionId),
							name: who !== undefined ? who.name : null,
						});
						if (sched !== null && sched.skipped !== undefined) {
							const leadId = who !== undefined ? who.parentSessionId : String(sessionId);
							pushNotice(leadId, "撞顶不续写", `${who !== undefined ? who.name + " " : ""}连续撞顶 ${continueRunsOf(sessionId)} 次仍没写完，插件不再自动发「继续」（上限 ${Math.max(1, Number(cfg.autoContinueMaxRuns || 3))} 次）：这活对它的输出上限来说太大，拆小或换 out 更大的路由。`);
						}
					}
				} else if (continueState.has(String(sessionId))) {
					// 这一轮不是撞顶结束 = 续写生效了（或它自己收尾了），连续计数清零，
					// 下次再撞顶还是完整的 ${autoContinueMaxRuns} 次机会。
					continueState.delete(String(sessionId));
				}
			}
			const member = members.get(sessionId);
			if (member === undefined) return;
			const type = String(event.type || "");
			const detail = event.data && (event.data.name || event.data.toolName) ? "@" + String(event.data.name || event.data.toolName) : "";
			member.lastEvent = type + detail;
			member.lastEventAt = Date.now();
			// any committed event proves the member is alive: clear the silent-hang flags
			member.stallNoticeAt = null;
			member.stallEscalateAt = null;
			// tool-level failures never reach agent/error: a sandbox denial or a
			// rejected command returns as a tool result. Count them so a stuck
			// member turns into a visible loop instead of an eternal "running".
			if (type === "tool/result") {
				const data = event.data || {};
				const text = contentText(data.message && data.message.content);
				const denied = /\[sandbox: file access denied/.test(text);
				const failed = data.error !== undefined || denied || /^Error[:\s]/i.test(text.trim());
				if (failed) {
					member.toolErrStreak = (member.toolErrStreak || 0) + 1;
					member.lastToolError = (denied ? "沙盒越界: " : "") + text.replace(/\s+/g, " ").slice(0, 140);
					member.lastToolErrorAt = Date.now();
					if (denied) {
						// keep the denied path: the Lead decides between widening the write
						// root (ask 维护方) and narrowing the task. Never auto-escalate here.
						member.deniedCount = (member.deniedCount || 0) + 1;
						const paths = member.deniedPaths || (member.deniedPaths = []);
						for (const hit of text.matchAll(/([A-Za-z]:\\[^\s"'<>|]+)/g)) {
							const p = hit[1];
							if (paths.includes(p)) continue;
							paths.push(p);
							if (paths.length > 8) paths.shift();
						}
					}
					if (member.toolErrStreak >= 3) member.loopAt = Date.now();
				} else {
					member.toolErrStreak = 0;
					member.loopAt = null;
				}
			}
		});
		// streaming liveness: model frames flowing = healthy; a stuck stream shows
		// running with a stale lastStreamAt (the failure mode list_agents hides).
		agent.ctx.on("agent/assistant-stream", () => {
			if (!ctxAlive()) return;
			const member = members.get(sessionId);
			if (member !== undefined) {
				member.lastStreamAt = Date.now();
				member.stallNoticeAt = null;
				member.stallEscalateAt = null;
			}
		});
		agent.ctx.on("agent/status", ({ status }) => {
			if (!ctxAlive()) return;
			if (status === "running") errorSeen.set(agent, false);
			if (status === "idle" && errorSeen.get(agent) !== true) {
				const header = agent.session.requestHeader ? agent.session.requestHeader() : undefined;
				const member0 = members.get(sessionId);
				if (header && header.config) {
					// 2026-10-29 维护方抓到：输出被截断（max-tokens）的回合，agent 同样回到 idle，
					// 于是被当成「干净完成」记成真派 ok —— `loomy/spark-x` 就是这么被打上
					// realResult:"ok" 的，可它两次截断 outputTokens 都是 0，一次活都没干成。
					// 截断不是成功：最近 90 秒内刚记过截断就不记 ok（recordRealRun 的 ok 分支会跳过）。
					recordRealRun(header.config.provider, header.config.model, "ok", "", header.config.reasoningEffort, member0 === undefined ? null : member0.name);
				}
			}
			const member = members.get(sessionId);
			if (member === undefined) return;
			if (status === "idle") dispatchSafely(member, agent);
		});
	}

	// --- 组级熔断（设计确定：）：判据现在在 freeledger/pool.js（组归属 / 停时口径 /
	//     单条探活 / 有效退避，整块原样搬过去，一字未改），这里只是实例化点。
	//     next* 解禁时刻来自 errbook 的解构，touchRoute 是脏键标记 —— 显式注入。
	const groupPool = createGroupPool({ nextUtcMidnight, nextLocalMidnight, nextUtcMonday, touchRoute });
	const { groupHalt, groupIdOf, groupHalted, noteGroupFault, clearGroupHalt, effectiveBackoff } = groupPool;

	/** 从第三方 /400 原文里抠真实输入上限（tokens），抠不到返回 null。 */
	function capFromMessage(message) {
		const capM = /(?:maximum allowed input length of|maximum context length(?: is| of)?|maximum context window(?: is| of)?)[\s:]*(\d{3,9})/i.exec(String(message || ""));
		if (capM === null) return null;
		const tokens = Number(capM[1]);
		return Number.isFinite(tokens) && tokens > 0 ? tokens : null;
	}
	/** 学真实输入上限并改台账，返回实测 tokens（没命中/不比原值小 → 0）。
	 *  只落**这一条路由**的实测值，不做同类外推（维护方 10-29 明确要求）。 */
	function learnCtxCap(entry, key, message) {
		const tokens = capFromMessage(message);
		if (tokens === null) return 0;
		const measuredK = Math.floor(tokens / 1024);
		const knownK = ctxK(entry.ctx);
		if (knownK !== null && knownK <= measuredK) return 0;
		const before = entry.ctx;
		entry.ctx = `${measuredK}K`;
		entry.ctxRaw = tokens;
		entry.ctxMeasuredAt = Date.now();
		entry.note = `${entry.note ? entry.note + "；" : ""}输入上限实测 ${tokens} tokens（原记 ${before || "无数据"} 不可信）`;
		for (const m of members.values()) pushNotice(m.parentSessionId, "实测ctx上限", `${key} 真实输入上限 ${tokens} tokens（≈${measuredK}K），目录写的是 ${before || "无数据"}；已按实测改台账，别再往这条派超过 ${measuredK}K 输入的活`);
		return tokens;
	}

	/** 记一条「正常完成」的输入规模 —— 不靠报错也能拿到的实测下界。
	 *  来源是会话日志里成功回合的 `assistant/message.usage.inputTokens`：
	 *  模型真的把这么多 token 吃下去并回了话，这就是证据。
	 *  只登记台账已有的路由（和 recordRealRun 同一条规矩：不往台账里灌陌生路由）。 */
	function recordSeenUsage(provider, model, tokens, at, turn, sessionId) {
		if (provider === undefined || provider === null || model === undefined || model === null) return 0;
		const n = Number(tokens);
		if (!Number.isFinite(n) || n <= 0) return 0;
		const key = `${provider}/${model}`;
		const entry = ledger.get(key);
		if (entry === undefined) return 0;
		if (n <= Number(entry.seenMax || 0)) return 0;
		const first = !(Number(entry.seenMax || 0) > 0);
		entry.seenMax = n;
		entry.seenMaxAt = Number(at) || Date.now();
		entry.seenMaxTurn = turn === undefined || turn === null ? null : Number(turn);
		if (sessionId !== undefined && sessionId !== null) entry.seenMaxSession = String(sessionId);
		applySeenMax(entry, key);
		entry.updatedStr = dayStamp();
		persistAll();
		if (first) {
			// 每条路由只推一次「下界」——这是情报，不是告警，别刷屏。
			const k = Math.floor(n / 1024);
			appendLedgerHistory(cfg, provider, model, "实测下界", `正常跑完 ${fmtTok(n)} tokens 输入（≈${k}K${entry.seenMaxTurn === null ? "" : "，turn " + entry.seenMaxTurn}）`);
			const leads = new Set([...boards.keys(), ...goals.keys()]);
			for (const m of members.values()) leads.add(m.parentSessionId);
			const tail = entry.seenMaxTurn === null ? "" : `，turn ${entry.seenMaxTurn}`;
			for (const lid of leads) pushNotice(lid, "实测下限", `${key} 正常跑完 ${fmtTok(n)} tokens 输入（≈${k}K${tail}）—— 没报错，所以这只是**下界**（「这么大能跑」，不是「再大跑不了」），上限仍未知；派单不会拿它当上限把人挡在门外，只用来判断「这条至少装得下多大」`);
		}
		return n;
	}

	/** 累计「正常干活时长」：成功回合 request→response 的时间差。
	 *  只统计真跑完的回合（失败/重试/空转不算），所以它是"这条路由真扛过多久活"，
	 *  而不是"挂在上面的时长"。展示成 `00Y00D00H`。 */
	function recordUsedTime(provider, model, ms) {
		if (provider === undefined || provider === null || model === undefined || model === null) return 0;
		const dur = Number(ms);
		if (!Number.isFinite(dur) || dur <= 0 || dur > 3600000) return 0; // 单轮 >1h 视为脏数据
		const key = `${provider}/${model}`;
		const entry = ledger.get(key);
		if (entry === undefined) return 0;
		entry.usedMs = Number(entry.usedMs || 0) + dur;
		touchRoute(key);
		entry.usedRuns = Number(entry.usedRuns || 0) + 1;
		persistAll();
		return dur;
	}

	/** 输出被截断（`turn/end` 的 `reason.kind === "max-tokens"`）—— 2026-10-29 维护方报的真洞：
	 *  GUI 上写着「已达到输出 token 上限，回答被截断……发送“继续”可让模型接着输出」，
	 *  但插件既不记 ok（这一轮不该算干净完成），也不记 fail（这不是报错），于是面板上
	 *  「没反应」。它不是故障：路由活着、额度也真花出去了，只是这一条回复写不完。
	 *  处置：记次数 + 时间（够面板标出来、够我判断这条路由适合多大的活），
	 *  **绝不判死、绝不退避**。队长自己撞了推一条提醒（发“继续”或拆小/换 out 大的路由）；
	 *  成员撞了的上层处理（任务退回 open + 说明）在 subagent/end 里。 */
	function noteTruncated(provider, model, opts) {
		if (provider === undefined || provider === null || model === undefined || model === null) return false;
		const key = `${provider}/${model}`;
		const entry = ledger.get(key);
		if (entry === undefined) return false;
		const meta = opts === undefined || opts === null ? {} : opts;
		const nowMs = Date.now();
		entry.truncatedAt = nowMs;
		entry.truncatedN = Number(entry.truncatedN || 0) + 1;
		touchRoute(key);
		const outTok = Number(meta.outTokens);
		if (Number.isFinite(outTok) && outTok > 0 && outTok > Number(entry.outSeenMax || 0)) entry.outSeenMax = outTok;
		entry.updatedStr = dayStamp(new Date(nowMs));
		persistAll();
		return true;
	}

	function recordRealRun(provider, model, result, message, effort, who, selfSessionId) {
		if (provider === undefined || model === undefined) return;
		const key = `${provider}/${model}`;
		const entry = ledger.get(key);
		if (entry === undefined) return; // only routes the scan already know: no ledger pollution by paid/lead models
		// 谁撞的？**一律按会话 id 认人，不按名字** —— 判据和投递都交给 src/errpush.js。
		// 这里只保留「调用方需要知道是谁」的那一份结果（ctx 换路由/组熔断要用）。
		// 名字（who）只作**唯一命中**时的兜底：跨队同名（auto1..auto9 每队都有）一律不认。
		const byId = whoAmIBySession(selfSessionId, { members, retiredMembers });
		const byName = who === null || who === undefined ? [] : Array.from(members.values()).filter((m) => m.name === who);
		const ownerOfCaller = byId !== undefined ? byId : byName.length === 1 ? byName[0] : undefined;
		/** 取「撞错的那个成员」—— ctx 换路由/组熔断这些地方用，和上面同一套判据。 */
		const memberFor = () => ownerOfCaller;
		/** 这条报错的投递口：认人 + 定级 + 定路 + 去重全在 src/errpush.js，这里不自己判。 */
		const errpushDeps = {
			members,
			retiredMembers,
			agentsGet: (id) => (ctx.agents && typeof ctx.agents.get === "function" ? ctx.agents.get(id) : undefined),
			resolveLead,
			pushNotice,
			// 队长自己的路由健不健康：撞墙/组停 = 他也干不了 → 盒子会自动往下递一层。
			leadHealth: (leadId) => leadHealthOf(leadId),
			// 别的队**空闲**的队长（设计确定：的第四层兜底：「他的队长不行的推给其他队空闲的队长」）
			idleOtherLeads: (excludeId) => idleLeadSessions(excludeId),
		};
		if (result === "fail") {
			const verdict = diagnoseError(message, key);
			// 2026-10-29 维护方递来的一条真报错：OpenRouter 免费额度的 **每日请求数上限**
			// （`Daily limit reached for x:free ... limit_rpd/...`，头里写着 X-RateLimit-Limit: 1000）。
			// 它不是限流抖动、更不是模型死亡：退避 3 分钟再试还是 429，得等到次日 UTC 0 点重置。
			// 单独成类，退避直接拉到那个时刻，别的（临时 429）照旧短退避。
			const dailyCap = DAILY_CAP_RE.test(String(message || ""));
			// qodercn 的日限原文不带 "Daily limit"（`qoder: Billing daily count exceeded`），
			// DAILY_CAP_RE 认不出 —— 单列一条，而且它按**本地** 0 点重置，不是 UTC 0 点。
			const billingDaily = !dailyCap && BILLING_DAILY_RE.test(String(message || ""));
			const errClass = dailyCap ? "日限已满" : billingDaily ? "日限已满-本地0点" : verdict.class;
			if (billingDaily) verdict.class = "日限已满-本地0点";
			appendLedgerHistory(cfg, provider, model, "真派失败", `${errClass}｜${String(message || "").replace(/\s+/g, " ").slice(0, 180)}`);
			const firstOfKind = entry.errClass !== errClass; // one report per new kind, not per retry
			archiveError({ at: Date.now(), route: key, effort: effort || null, by: who || null, class: errClass, raw: String(message || "").replace(/\s+/g, " ").slice(0, 600), ...(verdict.ruleId === null ? {} : { rule: verdict.ruleId }) });
			// 第三方 /400 会把真实输入上限写在报错里（"...maximum allowed input length of 262112 tokens"）。
			// 目录/UI 显示的是标称值（这条写着 1M，实测只有 256K）——以实测为准，
			// 否则派出来的大活必然 400，而且压缩请求同样超限 → 永远「压缩不出摘要」。
			const learnedCap = learnCtxCap(entry, key, message);
			const failOwner = ownerOfCaller;
			// ---- 报错投递：全部交给 src/errpush.js（维护方 2026-11-01 定的盒子）----
			// 这里只组「报错事实」，不判推给谁。判据（四层兜底）和身份证拼装都在盒子里。
			// ★ 成员撞错**不再额外推一遍「成员模型故障」**：收尾的 subagent/end 已经有一条
			//   完整版（带 tid、带战绩入账）。同一条错推两遍正是维护方看到的「发的到处都是」。
			//   例外照旧：成员已离册时收尾那条推不出去，这里补（同类只补一次，firstOfKind）。
			const subInfo = (() => {
				try {
					const cid = selfSessionId === undefined || selfSessionId === null ? "" : String(selfSessionId);
					if (cid === "") return { isSub: false, rootId: "" };
					const a = ctx.agents && typeof ctx.agents.get === "function" ? ctx.agents.get(cid) : undefined;
					if (a === undefined || a === null) return { isSub: false, rootId: "" };
					const root = String(resolveLead(a) || "");
					return { isSub: root !== "" && root !== cid, rootId: root };
				} catch { return { isSub: false, rootId: "" }; }
			})();
			const faultBase = {
				sessionId: selfSessionId,
				memberName: failOwner === undefined ? null : failOwner.name,
				fix: verdict.fix,
				rootId: subInfo.rootId,
				isSub: subInfo.isSub,
				leads: [...new Set([...boards.keys(), ...goals.keys(), ...Array.from(members.values()).map((m) => m.parentSessionId)])],
				route: key,
				effort: effort || "",
				errClass,
			};
			if (failOwner === undefined) {
				// 队长（或任何非成员会话）撞错：先留证据，再由盒子决定递到谁。
				// 注意队长这里**不套成员规则**（换模型/换档一直是维护方手动），只留证据 + 实测上限。
				recordLeadError(provider, model, effort, message, { cap: learnedCap });
				const capText = learnedCap > 0 ? `，实测输入上限 ${learnedCap} tokens（≈${Math.floor(learnedCap / 1024)}K）` : "";
				pushFault(faultBase, {
					kind: "队长报错",
					text: `队长侧报错${capText}｜换不换模型由维护方决定，插件不会自动动｜原文：${String(message || "").replace(/\s+/g, " ").slice(0, 300)}`,
				}, errpushDeps);
				// 2026-10-29：只在**未登记**的错上去问活队长。以前队长撞任何错都问，
				// 结果一条 429 日限（明明有规则命中）也去打扰隔壁对话 —— 那是刷屏，不是求助。
				if (!verdict.known) maybeAskLiveCaptain(selfSessionId, key, message);
			} else {
				if (!verdict.known && firstOfKind) {
					// 成员撞未知错：把积压的队长报错一起带上（那些坑可能正是它换到现在的理由）。
					// 判不了的那些会在这一次里升级成「问维护方」。
					pruneLeadErrors();
					const leadRows = deliverLeadErrors(failOwner.parentSessionId, 5);
					const leadPart = leadRows.length === 0 ? "" : `｜另外 ${leadRows.length} 条队长自己撞的报错（问它没用，一起判）：\n` + leadRows.join("\n");
					const tail = `\n｜判完用 team(action:"rule", match:"<特征串>", errorClass:"额度限流|档位不支持|路由bug|白名单未开|地区封锁|上下文超限|网关共性", fix:"backoff|downshift|rotate|dead|retry|none") 登记，同类以后自动办；判不了的把原文发给维护方。`;
					pushFault(faultBase, {
						kind: "新报错",
						text: `报错未登记（成员 ${failOwner.name}）｜原文：${String(message || "").replace(/\s+/g, " ").slice(0, 400)}${leadPart}${tail}`,
					}, errpushDeps);
				}
				if (failOwner.retired === true && firstOfKind && failOwner.parentSessionId !== "") {
					pushFault(faultBase, {
						kind: "成员模型故障",
						text: `已离册的会话撞错｜原文：${String(message || "").replace(/\s+/g, " ").slice(0, 200)}`,
					}, errpushDeps);
				}
				// 插件已经自己兜住的那一类（降档/换路由/退避/重试）：**不给队长推告警**，
				// 但给一句「已自愈」—— 否则队长看着一个换了模型的人在跑，还以为跑的是原来那个。
				// 盒子判 selfHeal=true 时默认静默，所以这里 force:true 才发得出去。
				if (firstOfKind) {
					const can = pluginCanHandle(verdict.fix, failOwner.name);
					if (can.selfHeal === true) {
						pushFault(faultBase, {
							kind: "已自愈",
							text: `插件已自己处理（${verdict.fix}），不用你动手；原文：${String(message || "").replace(/\s+/g, " ").slice(0, 160)}`,
							force: true,
						}, errpushDeps);
					}
				}
			}
			// 上下文超限 = **输入太大**，不是路由坏：绝不因此降级/判死路由，
			// 但 2026-10-30 设计确定：的规矩是"实测不足就收回成员、换模型继续"：
			//   · 记下这条路由**实测能吃到的**输入上限（seenMax 取最大值，只增不减）；
			//   · 如果撞顶的是**本队成员正在跑的那一单**，把这单退回 open 并把成员换到
			//     一条 ctx 更大的路由上，让它在原地重领（队长不用管）；换不动才报队长。
			// （维护方 10-29 用大输入扫描时 468 条报错差点把 laguna/flint/xingchen 全标 invalid，
			//  所以这里**绝不**改 status，只改 seenMax 和单的归属。）
			if (errClass === "上下文超限") {
				entry.errClass = errClass;
				entry.updatedStr = dayStamp();
				// 从原文里解析"你请求了 N tokens / 上限是 M tokens"，把 M 记成这条路由实测能吃到的上限。
				// 这不是猜测：是上游自己说的硬数字。
				const capped = (() => {
					const cap = /maximum (?:context|allowed input) length is (\d+) tokens|maximum allowed input length is (\d+)/i.exec(String(message || ""));
					if (cap !== null) {
						const v = Number(cap[1] || cap[2]);
						return Number.isFinite(v) && v > 0 ? v : null;
					}
					const req = /requested about (\d+) tokens/i.exec(String(message || ""));
					if (req !== null) {
						const v = Number(req[1]);
						return Number.isFinite(v) && v > 0 ? v : null;
					}
					return null;
				})();
				if (capped !== null) {
					// capK = 上游原文给出的**硬上限**（K），压过标称；seenMax = 实际跑过的最大输入。
					// 两者分开记：capK 说"最多能给你这么多"，seenMax 说"你真给过这么多还活着"。
					const capKValue = Math.floor(capped / 1024);
					const prevCap = Number(entry.capK || 0);
					if (prevCap === 0 || capKValue < prevCap) entry.capK = capKValue; // 只允许往下压，不会越撞越松
					const prev = Number(entry.seenMax || 0);
					if (capped > prev) entry.seenMax = capped;
					entry.note = `实测输入上限 ≈${capKValue}K（撞顶原文给出，压过标称 ${entry.ctx || "无"}）`;
				}
				persistAll();
				// 撞顶的是不是本队正在跑的单？是就把成员换到更大的路由上继续（需求方要的"收回再派"）
				if (who !== null && who !== undefined) {
					const holder = memberFor();
					if (holder !== undefined) {
						const board = boards.get(holder.parentSessionId);
						const task = holder.currentTask === null || board === undefined ? undefined : board.tasks.get(holder.currentTask);
						if (task !== undefined) {
							const needCtx = taskNeedCtx(task);
							// 撞顶说明这条路由实际可用输入比标称小：把 need 抬到"实际要的"那个数量级，
							// 换路由时按它来找，才不会换到另一条同样不够的。
							const effectiveNeed = Math.max(needCtx === null ? 0 : needCtx, capped === null ? 0 : Math.ceil(capped / 1024));
							// 撞顶是同一类硬证据（和反复压缩等价）：把门槛记在单上，换人重派也不会再挑小路由。
							if (effectiveNeed > Number(task.ctxMin || 0)) { task.ctxMin = effectiveNeed; task.revision += 1; }
							const switched = rotateForCtx(holder, task, effectiveNeed);
							if (switched !== undefined) {
								task.lastReport = `实测撞顶（${key} 上限 ${capped === null ? "?" : Math.floor(capped / 1024) + "K"}）：已把 ${holder.name} 换到 ${switched} 继续跑`;
								pushNotice(holder.parentSessionId, "实测 ctx 不足已换模型", `${task.tid} 在 ${key} 上撞了输入上限（${capped === null ? "原文未给数字" : Math.floor(capped / 1024) + "K"}），已自动把 ${holder.name} 换到 ${switched} 继续；这单不用重派`);
							} else {
								reportCtxExhausted(holder.parentSessionId, task, effectiveNeed);
								task.lastReport = `实测撞顶且没有更大路由可换（${key} 上限 ${capped === null ? "?" : Math.floor(capped / 1024) + "K"}）；已上报队长`;
							}
							persistAll();
						}
					}
				}
				return;
			}
			if (verdict.fix === "downshift" || errClass === "档位不支持") {
				// The ROUTE is healthy; only this gear is rejected. Remember it per
				// gear (TTL-bound) so the next dispatch drops one step instead of
				// losing the route (#11: one rejection is not a ceiling).
				const gear = String(effort || "?").toLowerCase();
				entry.effortBad = { ...(entry.effortBad || {}), [gear]: Date.now() };
				entry.badEfforts = { ...(entry.badEfforts || {}), [gear]: Date.now() }; // legacy field, still shown
				const ladder = effortLadder(entry);
				if (ladder.length > 0 && gear === ladder[0]) {
					// Even the lowest gear is refused: this is not a gear problem.
					entry.status = entry.status === "lead" ? entry.status : "invalid";
					entry.errClass = "档位不支持";
					entry.note = `最低档 ${gear} 也不支持 → 判坏路由`;
					// nothing will downshift here, so the Lead would never hear about it
					const owner = who === null || who === undefined ? undefined : memberFor();
					if (owner !== undefined) pushNotice(owner.parentSessionId, "路由判坏", `${key} 连最低档 ${gear} 都不支持 → 已标 invalid；换路由重派，别在这里再试`);
					else for (const m of members.values()) pushNotice(m.parentSessionId, "路由判坏", `${key} 连最低档 ${gear} 都不支持 → 已标 invalid`);
				} else {
					entry.note = `档位不支持：${gear} 实测报错`;
				}
				entry.updatedStr = dayStamp();
				persistAll();
				return;
			}
			// collapse one storm per minute (a retried wall is one incident, not five)
			const stamp = Math.floor(Date.now() / 60000);
			if (entry.errClass === errClass && entry.realAt !== null && Math.floor(entry.realAt / 60000) === stamp) return;
			entry.realResult = "fail"; entry.realAt = Date.now(); entry.errClass = errClass;
			entry.failStreak = (entry.failStreak || 0) + 1;
			touchRoute(key);
			// 周限（OPENCODE 免费池）：停到下周配额刷新，退避几分钟纯属空转。
			// 日限：退避到次日 UTC 0 点（短退避只会一次又一次撞同一堵墙）；其余按指数退避，封顶 30 分钟。
			const errRaw = String(message || "");
			const resumeMs = explicitResumeMs(errRaw);
			entry.backoffUntil = resumeMs !== null
				? resumeMs
				: WEEKLY_CAP_RE.test(errRaw)
					? nextUtcMonday(Date.now())
					: billingDaily
						? nextLocalMidnight(Date.now())
						: DAILY_CAP_RE.test(errRaw)
							? nextUtcMidnight(Date.now())
							: Date.now() + Math.min(1800000, 60000 * 2 ** Math.min(entry.failStreak, 5));
			if (resumeMs !== null) entry.note = `上游给定解禁时间：${new Date(resumeMs).toLocaleString("zh-CN")}（退避到点前不派）`;
			// 日限没有"上游给的时间"可解析时，把**插件自己定的**解禁点写进 note ——
			// 否则面板上只看到一条绿路由被退避，没人知道为什么、停到几点。
			else if (billingDaily) entry.note = `qodercn 整池日限已满（Billing daily count exceeded）：按本地 0 点重置，停到 ${new Date(entry.backoffUntil).toLocaleString("zh-CN")}`;
			else if (DAILY_CAP_RE.test(errRaw)) entry.note = `日限已满：按 UTC 0 点重置，停到 ${new Date(entry.backoffUntil).toLocaleString("zh-CN")}`;
			// 额度限流/网关抖动是**临时**的：只退避，不判死。以前这里无条件 invalid，一次 429
			// 就把路由从可派集合里抹掉、要等每天 8 点 scan 才回生 —— 整池看着像被自己判死。
			const softClass = verdict.fix === "backoff" || errClass === "额度限流" || errClass === "日限已满" || errClass === "日限已满-本地0点" || errClass === "gateway-ratelimit" || errClass === "网关共性";
			if (!softClass && errClass !== "白名单未开" && entry.status !== "lead") entry.status = "invalid";
			const gmsg = noteGroupFault(entry, errClass, resumeMs);
			if (gmsg !== "") {
				const owner2 = who === null || who === undefined ? undefined : memberFor();
				if (owner2 !== undefined) pushNotice(owner2.parentSessionId, "组熔断", gmsg);
				else for (const m of members.values()) pushNotice(m.parentSessionId, "组熔断", gmsg);
			}
		} else {
			// A clean run at gear G is the A/B evidence that G works (#11): record it
			// before the one-signal-per-epoch guard so a same-minute ok still counts.
			const gearOk = String(effort || "").toLowerCase();
			let gearRecorded = false;
			if (EFFORT_RANK[gearOk] !== undefined) {
				const known = entry.effortOk || {};
				if (known[gearOk] === undefined) { entry.effortOk = { ...known, [gearOk]: Date.now() }; gearRecorded = true; }
			}
			// a clean idle right after a previous ok is one signal per epoch
			if (entry.realResult === "ok" && entry.realAt !== null && Date.now() - entry.realAt < 60000) {
				if (gearRecorded) persistAll();
				return;
			}
			// **撞顶不是干净完成**（注释里写了这条规矩，代码里一直漏着 —— 2026-11-01 补上）：
			// 输出被截断的回合，agent 照样回到 idle，于是被记成真派 ok。`loomy/spark-x` 就是
			// 这么被打上 realResult:"ok" 的，可它两次截断 outputTokens 都是 0，一次活都没干成。
			// 判据：最近 2 分钟内这条路由刚被记过截断 → 这一轮不算 ok，也不算 fail（路由没坏），
			// 只是不给它"干净跑通"的加分，等它真写完那一轮再说。
			if (entry.truncatedAt !== undefined && entry.truncatedAt !== null && Date.now() - Number(entry.truncatedAt) < 120000) {
				if (gearRecorded) persistAll();
				return;
			}
			entry.realResult = "ok"; entry.realAt = Date.now(); entry.failStreak = 0;
			entry.backoffUntil = 0; entry.errClass = null;
			// ★ 2026-11-16（Updating\03）：真跑成功是「这条路由活着」的**最硬证据**——
			//   内核真发了请求、真回来了。所以顺手撤掉「内核目录已下架」的判死标记。
			//   为什么必须在这里解封：dispatchable() 现在见 delisted 就出局，
			//   若没有一条"硬证据可解封"的通道，就是**反向死锁**（模型真回来了也用不上），
			//   正撞维护方 2026-11-01 定的「别跟 QODER 似的只排除不恢复」。
			//   注意：这里改的是台账自己的判定，不改内核目录 —— 下一轮 syncFromKernel
			//   如果内核仍不列它，会把 delisted 重新贴上（那条通道一直是双向的）。
			if (entry.delisted === true) {
				entry.delisted = false;
				delete entry.delistedAt;
				delete entry.statusBeforeDelist;
				entry.note = String(entry.note || "").replace(/；内核目录已下架（[^；]*）/g, "");
				appendLedgerHistory(cfg, provider, model, "下架解封", `真派跑通（档位 ${effort || "?"}），撤掉内核下架标记`);
			}
			touchRoute(key);
			if (entry.status !== "lead") entry.status = "ok";
			appendLedgerHistory(cfg, provider, model, "真派成功", `档位 ${effort || "?"}${gearRecorded ? "（首次验证该档）" : ""}`);
			const omsg = clearGroupHalt(entry);
			if (omsg !== "") {
				const owner2 = who === null || who === undefined ? undefined : memberFor();
				if (owner2 !== undefined) pushNotice(owner2.parentSessionId, "组恢复", omsg);
				else for (const m of members.values()) pushNotice(m.parentSessionId, "组恢复", omsg);
			}
		}
		entry.updatedStr = dayStamp();
		persistAll();
	}

	// --- gear resolution (#11): one place decides what gear a member runs at.
	// Spawn/retool pin a gear, but every dispatch recomputes it from the task's
	// `demand` and the route's measured ceiling, so a member never carries a stale
	// gear into a job it can't do.
	function resolveGear(entry, effortArg, demandArg) {
		const ladder = effortLadder(entry);
		const cap = entry === undefined ? -1 : effortCapRank(entry, cfg.effortCapTtlHours);
		const explicit = String(effortArg || "").trim().toLowerCase();
		if (explicit !== "" && EFFORT_RANK[explicit] === undefined) throw new Error(`effort ${explicit} 不是合法档位（low/medium/high/xhigh/max/none）`);
		if (ladder.length === 0) {
			// no advertised ladder: trust the caller, fall back to 常规
			return { gear: explicit !== "" ? explicit : "medium", cap, capped: false, short: false, known: false };
		}
		const base = explicit !== "" ? EFFORT_RANK[explicit] : demandRank(demandArg);
		const want = base === EFFORT_RANK.max ? EFFORT_RANK[ladder[ladder.length - 1]] : base;
		const ceiling = cap < 0 ? want : Math.min(want, cap);
		const gear = gearAt(ladder, ceiling);
		const catalogGear = gearAt(ladder, want);
		return { gear, cap, capped: gear !== catalogGear, short: EFFORT_RANK[gear] < want, known: true };
	}

	/** Recompute a member's gear for one task; returns what actually runs. */
	function applyDemand(member, task) {
		if (member === undefined || member === null) return undefined;
		const raw = task !== undefined && task !== null && task.demand !== undefined && task.demand !== null && String(task.demand) !== "" ? task.demand : (member.demand === undefined ? String(DEMAND_DEFAULT) : member.demand);
		const entry = ledger.get(`${member.provider}/${member.model}`);
		const pick = effortFor(entry, raw, cfg.effortCapTtlHours);
		member.demand = String(raw);
		if (pick.gear !== undefined && pick.gear !== member.effort) member.effort = pick.gear;
		member.effortWhy = pick.capped ? `d${demandRank(raw)}→压到 ${member.effort}` : pick.short ? `d${demandRank(raw)}→上限 ${member.effort}` : `d${demandRank(raw)}`;
		// 2026-11-07：档位也是 selection 的一部分（新内核对 reasoningEffort 单独比对），
		// 改完立刻写进去，否则成员下一步必抛 "proposed reasoning effort …"。
		syncMemberSelectionOf(member);
		return { gear: member.effort, demand: demandRank(raw), capped: pick.capped, short: pick.short, capGear: pick.capGear };
	}

	// ---------------------------------------------------------------------------
	// 派单层（freeledger/dispatch）——2026-11-02 模块化：maxCtxK / pickRoute 整块
	// 原样搬进 src/freeledger/dispatch.js，这里只是实例化点。唯一的白名单口径
	// dispatchable() 从同模块顶层 import（六个消费点共用一份判据）。
	// 池熔断/退避读口来自 freeledger/pool.js 注入 —— 选路逻辑一字未改。
	// ---------------------------------------------------------------------------
	const { maxCtxK, pickRoute } = createDispatcher({
		cfg,
		routeOccupancy,
		leadRouteKeys,
		routeScore,
		scoreTableNow,
		effectiveBackoff,
		groupHalted,
	});

	/** #11 A/B step: a rejected gear is not a ceiling. Drop exactly one gear and let
	 *  the same member retry (subagent/end already returned the task to open); the
	 *  clean run at the lower gear is what writes effortOk. Bounded by the ladder. */
	function downshiftMember(member) {
		const entry = ledger.get(`${member.provider}/${member.model}`);
		const ladder = effortLadder(entry);
		if (ladder.length === 0) return undefined;
		const cur = EFFORT_RANK[String(member.effort || "").toLowerCase()];
		if (cur === undefined) return undefined;
		const lower = gearAt(ladder, cur - 1);
		if (lower === undefined || EFFORT_RANK[lower] >= cur) return undefined; // already at the floor
		const before = String(member.effort || "?").toLowerCase();
		member.effort = lower;
		member.effortWhy = `降档 ${lower}（上一档实测不支持）`;
		syncMemberSelectionOf(member);
		// the Lead must not keep judging results by the gear it asked for: say it out loud
		pushNotice(member.parentSessionId, "已降档", `${member.name} ${member.provider}/${member.model}@${before} → @${lower}｜上一档实测不支持，下个请求生效；要更高档就 retool 换路由`);
		if (ctx.logger) ctx.logger.info(`dsh-team: ${member.name} 降档 -> ${lower}`);
		return lower;
	}

	/** 阶梯式恢复第二步（设计确定：中途先降档，降档不符合要求再换模型）。
	 *  Only "rejected all the way down the ladder" is machine-detectable — whether the
	 *  lower gear produced good enough WORK is the Lead's call. So this fires when the
	 *  route refuses even its lowest gear, and switches the MEMBER to another route so
	 *  its next request (and the returned task, when that member re-claims it) uses it.
	 *  Bounded per task so a pool of bad routes cannot become a loop. */
	const ROUTE_ROTATE_MAX = 2;
	/** ctx 不够时的自动换路由（2026-10-30 设计确定：派单前插件判、不甘就让插件自己换、换完没有才报队长）。
	 *  和 rotateMemberRoute 的区别：那条是"路由坏了"，这条是"这条路由太小"，前者计入 routeRotate
	 *  次数上限（换两次就放弃），后者按 ctx 专门计数，允许换得更多一点（池子里够大的可能排在后面）。
	 *  返回换到的 `provider/model@effort`，换不动返回 undefined。 */
	const CTX_ROTATE_MAX = 4;
	function rotateForCtx(member, task, needCtx) {
		// 2026-11-02：这单被队长判乱钉在 cloneRoute 上做对照 —— 换路由=换变量，对照作废。
		// 允许换，但换完把钉挪到新路由：第 2 次判乱记的是**这条新路由**的模型分。
		if (task !== undefined && task !== null && String(task.cloneRoute || "") !== "" && String(task.cloneRoute) !== `${member.provider}/${member.model}`) task.cloneRoute = `${member.provider}/${member.model}`;
		const leadId = member.parentSessionId;
		const tries = task === undefined ? 0 : Number(task.ctxRotate || 0);
		if (tries >= CTX_ROTATE_MAX) return undefined;
		const board = boards.get(leadId);
		// exclude 里把已经试过的小路由都带上，避免反复挑同一条
		const triedRoutes = (task !== undefined && Array.isArray(task.ctxTried)) ? task.ctxTried.slice() : [];
		const exclude = [`${member.provider}/${member.model}`, ...triedRoutes];
		const pk = pickRoute(
			task === undefined ? "grunt" : task.kind || "grunt",
			task === undefined ? "m" : task.size || "m",
			leadId, exclude,
			{ vision: task !== undefined && task.vision === true, needCtx: task === undefined ? undefined : Math.max(needCtx, taskNeedCtx(task)) },
		);
		if (pk.error !== undefined) return undefined;
		if (task !== undefined) {
			task.ctxRotate = tries + 1;
			task.ctxTried = [...triedRoutes, `${member.provider}/${member.model}`].slice(-8);
			task.revision += 1;
		}
		member.provider = pk.entry.provider;
		member.model = pk.entry.model;
		member.effortWhy = `ctx 不足换路由（要 ≥${needCtx}K）`;
		applyDemand(member, task);
		persistAll();
		return `${member.provider}/${member.model}@${member.effort}`;
	}
	/** 池子里已经没有够 ctx 的路由了：分清两种情况告诉队长（设计确定：）。
	 *  ① 有别的成员正占着够用的路由 → "等 XXX 跑完可以继续"（不是失败，是排队）；
	 *  ② 一条都没有 → "全池都不够，请拆任务/降 size"（这才是要队长动手）。
	 *  返回一句话（塞进 task.lastReport），空字符串表示没什么可说的。 */
	function reportCtxExhausted(leadId, task, needCtx) {
		const board = boards.get(leadId);
		// 此刻正被占着、且 ctx 够本单的所有路由（别的成员身上）
		const busyEnough = [];
		for (const m of members.values()) {
			if (m.parentSessionId !== leadId) continue;
			if (m.name === (task.owner === null || task.owner === undefined ? "" : task.owner)) continue;
			const e = ledger.get(`${m.provider}/${m.model}`);
			const u = e === undefined ? null : ctxUsableK(e);
			if (u !== null && u >= needCtx) {
				busyEnough.push(`${m.name}（${m.provider}/${m.model}，${u}K${m.currentTask === null ? "，空闲" : "，正在跑 " + m.currentTask}）`);
			}
		}
		const needText = `size=${task.size || "m"} 要 ≥${needCtx}K` + (Number(task.ctxMin) > sizeCtxK(task.size) ? `（这单实测已被压缩抬到 ≥${task.ctxMin}K）` : "");
		if (busyEnough.length > 0) {
			const line = `池子里 ctx 够 ${needText} 的路由都被占着：${busyEnough.join("、")}。等它们跑完这单就能继续（不用改任务）`;
			pushNotice(leadId, "ctx 够用的都占着", `${task.tid}（${task.title}）${needText}，现在够大的路由都在跑：${busyEnough.join("、")}；它们一空出来插件会自动继续派这一单，你先等着或先干别的`);
			return line;
		}
		// 一条能用的都没有：这是要队长改任务的硬结论，把池子里最大的几个摆出来当证据
		const top = Array.from(ledger.values())
			.filter(dispatchable)
			.map((e) => ({ key: `${e.provider}/${e.model}`, k: ctxUsableK(e) }))
			.filter((x) => x.k !== null)
			.sort((a, b) => b.k - a.k)
			.slice(0, 3);
		const proof = top.length === 0 ? "池子里连 ctx 数据都没有" : `池子里最大只有 ${top.map((t) => `${t.k}K(${t.key})`).join("、")}`;
		const line = `全池没一条 ctx 够 ${needText}：${proof}。这单派不出去，要改任务——把输入拆小，或把 size 降到 ${["s", "m", "l"].filter((k) => sizeCtxK(k) <= (top.length === 0 ? 0 : top[0].k)).join("/") || "更小"}`;
		pushNotice(leadId, "ctx 全池不足·要改任务", `${task.tid}（${task.title}）${needText}，但${proof}。插件不会再派这单，也不会自己改 size；请拆小输入或 team(action:"task", action2:"set", tid:"${task.tid}", size:"…") 降档，改完它就会自动派`);
		return line;
	}

	function rotateMemberRoute(member, reason) {
		const leadId = member.parentSessionId;
		const board = boards.get(leadId);
		const task = member.currentTask !== null && board !== undefined ? board.tasks.get(member.currentTask) : undefined;
		const tries = task === undefined ? 0 : Number(task.routeRotate || 0);
		const label = task === undefined ? member.name : task.tid;
		if (tries >= ROUTE_ROTATE_MAX) {
			pushNotice(leadId, "换路由放弃", `${label} 已换 ${tries} 次路由仍不行（${reason}）；拆小任务，或手工 team(retool) 指定路由`);
			return undefined;
		}
		const pk = pickRoute(task === undefined ? "grunt" : task.kind || "grunt", task === undefined ? "m" : task.size || "m", leadId, [`${member.provider}/${member.model}`], { vision: task !== undefined && task.vision === true, needCtx: task === undefined ? undefined : taskNeedCtx(task) });
		if (pk.error !== undefined) {
			pushNotice(leadId, "换路由失败", `${member.name} ${reason}，但没有可换的路由：${pk.error}`);
			return undefined;
		}
		const from = `${member.provider}/${member.model}@${member.effort}`;
		member.provider = pk.entry.provider;
		member.model = pk.entry.model;
		member.effortWhy = `换路由（${reason}）`;
		const gear = applyDemand(member, task); // 内部会 syncMemberSelectionOf（含新路由+新档位）
		if (task !== undefined) { task.routeRotate = tries + 1; task.revision += 1; }
		persistAll();
		// the Lead judges output by the model it assumed was running: always say it changed
		pushNotice(leadId, "已换路由", `${member.name} ${from} → ${member.provider}/${member.model}@${member.effort}｜${reason}（第 ${tries + 1}/${ROUTE_ROTATE_MAX} 次）｜${pk.why}`);
		return { from, to: `${member.provider}/${member.model}@${member.effort}`, why: pk.why, gear };
	}



	// --- 队长报错暂存：已搬到 src/lederr.js（createLeadErrors）。
	//     规矩未变：队长撞未知错 → 先自检问活队长，问不到就留在 lead-errors.json 等下次判。
	const lederrApi = createLeadErrors({ ctx, ledger, pushNotice, routeOf, groupHalted, kernelSessions, wakeSession });
	const { leadErrPath, saveLeadErrors, leadErrSig, recordLeadError, deliverLeadErrors, pendingLeadErrors, pendingRows, askLiveCaptain, maybeAskLiveCaptain, pruneLeadErrors, bumpCallSeq, claimDelivery } = lederrApi;
	// --- 全局公告板 + 内核会话查询：已搬到 src/announce.js（createAnnounce）。
	//     规矩未变：公告不需要回执、整体 5 分钟最多一条、跨实例走 .state/announce.json。
	/** 跨会话唤醒。内核 `subagents.sendMessage` 只允许直接父/子，两个顶层对话框之间
	 *  发不了；但 `sessionController.prompt` 是 GUI 把提示词送进会话的同一个入口
	 *  （「显式 resume 该 Session 再投递」），所以只有它能真的把对方叫起来读信。
	 *
	 *  **2026-10-31 设计确定：要插话送达，不要等它下一步。**
	 *  内核 `prompt` 只有两条路（`sessionController.prompt` 原文实测）：
	 *    `request.mode === "steer"` → `agent.steer(message)` —— **当前回合立即插进去**；
	 *    其它（含老代码用的 `"queue"`） → `agent.followup(message)` —— 排到**下一回合**才看。
	 *  老代码一直写 `mode:"queue"`，所以对方正在跑的时候，信要等它这一步跑完才收到，
	 *  这就是维护方说明的"不是插话送达"。现在改成：**对方在跑 → steer（立即插话）；
	 *  对方空闲 → steer 会被内核拒（`session/steer-unavailable`，它没有"当前回合"可插），
	 *  这时退回 followup（起一个新回合，消息立刻进上下文）。**
	 *  两种情况下正文都是整封的（见下），不改变"全文送达"的定稿。 */
	async function wakeSession(toId, fromShort, text, kind) {
		const sc = ctx.get ? ctx.get("sessionController", false) : ctx.sessionController;
		if (sc === undefined || sc === false || sc === null || typeof sc.prompt !== "function") {
			return { woke: false, why: "这个内核版本没有 sessionController.prompt，只能等对方自己调 team" };
		}
		// 2026-10-31 设计确定：，一天之内两改，最终版是「**直接全文送达**」：
		//   第一版：带 160 字摘要 → 维护方否掉（「给啥摘要，就唤醒告诉他有消息就行了，
		//    你发个摘要如果不是全文他不是还要去看一次」）；
		//   第二版：只报字数、让收信人去 peers 取 → 维护方又否掉（原话「跨会话消息改了，
		//    直接全文送达吧，我是发现了，不直接发你丫的根本懒得看」）。
		//   **根因不是摘要长短，是"让收信人再跑一趟"这件事本身**：只要正文不在唤醒消息里，
		//   长度按整封送（不截断到半截）：需求方要求全文送达，且不要在插件里替人做字数审查 ——
		//   写多长是发信人自己的事（维护方原话「跨会话消息不用改字数，要改的是你自己的毛病，废话太多」）。
		//   只有极端超长（16K）才折叠一次并落盘，避免一次 prompt 塞爆内核，这是保护不是审查。
		const full = String(text || "");
		const WAKE_FULL_MAX = 16000;
		const clipped = full.length > WAKE_FULL_MAX;
		const shown = clipped
			? full.slice(0, 12000) + `\n\n…（原文 ${full.length} 字，超过 ${WAKE_FULL_MAX} 字上限已折叠，其余未显示；全文已落盘：${saveMailFull(full) || "（落盘失败）"}）`
			: full;
		const body = kind === "announce"
			? `【团队公告】${shortOf(fromShort)} 发了一条全体公告（不用回执，看到就行）：\n${shown}`
			: kind === "continue"
				// 插件自己发的「继续」：不加【来信】外壳，否则收信人以为有人给它写信。
				? shown
				: `【来信】${shortOf(fromShort)} 给你发了 1 条消息（${full.length} 字）：\n\n${shown}`;
		try {
			const req = (mode) => ({
				requestId: `team-wake-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
				sessionId: toId,
				mode,
				content: [{ type: "text", text: body }],
				clientTimeZone: "Asia/Shanghai",
			});
			// 先试着**插话**（对方正在跑 → 当前回合立刻看到这条消息）；
			// 对方空闲时内核没有"当前回合"可插，会回 `session/steer-unavailable`，
			// 这时退回 followup —— 它会让对方起一个新回合，消息一样立刻进上下文。
			try {
				const r = await sc.prompt(req("steer"), AbortSignal.timeout(15000));
				return { woke: true, accepted: (r !== undefined && r !== null && r.accepted === true), mode: "steer" };
			} catch (steerErr) {
				const esc = String((steerErr && steerErr.message) || steerErr);
				if (!/steer-unavailable|steer/i.test(esc)) throw steerErr; // 别的错不掩盖，交给下面统一报
				const r2 = await sc.prompt(req("queue"), AbortSignal.timeout(15000));
				return { woke: true, accepted: (r2 !== undefined && r2 !== null && r2.accepted === true), mode: "followup", steerFallback: esc.slice(0, 120) };
			}
		} catch (err) {
			return { woke: false, why: `唤醒失败：${String((err && err.message) || err).replace(/\s+/g, " ").slice(0, 200)}` };
		}
	}
	// --- 输出撞顶自动续写（维护方 2026-11-01 定）
	//
	// 报告原话：「已达到输出 token 上限回答被截断，已有输出保留在对话中。发送“继续”可让
	// 模型接着输出。然后就没反应了」。
	// 内核只负责把这句话写在 GUI 上，**它不会替你发「继续」**；插件以前也只推一条提醒给
	// 队长 —— 提醒的是"发继续"，可没人会去发，于是队长那一轮就停在那儿，成员那单还被
	// 直接退回 open，上半截产出散在写根里。
	//
	// 定稿：认出 `turn/end.reason.kind === "max-tokens"` → 等几秒 → 自己给那个会话发一句
	// 「继续」。三个必须守住的边界：
	//   ① **只续写过本插件认得的会话**（队伍成员，或建过板的队长）。维护方别的对话框撞顶，
	//      插件一个字都不许插 —— 那不是队长的活，也没人让它代管。
	//   ② **有上限、撞穿就收手**（autoContinueMaxRuns）：一直续写下去等于把一个装不下的
	//      活硬塞给一条路由，烧的是维护方的额度，结论是"这活它干不完"。用尽转告队长拆小。
	//   ③ **别在人家还在跑的时候插**：turn/end 已经发生，可内核可能正在自动重试同一回合，
	//      所以延迟（默认 10 秒）里要重新确认它真的空闲（agent.status !== "running"）。
	const continueState = new Map(); // sessionId -> { runs, timers:[], at }
	/** 撞顶那一轮是半截，不是完整样本：等它真正收尾那一轮再记战绩。 */
	const skipScoreOnce = new Set();
	function continueRunsOf(sessionId) {
		const st = continueState.get(String(sessionId));
		return st === undefined ? 0 : Number(st.runs || 0);
	}
	function scheduleAutoContinue(sessionId, info) {
		if (cfg.autoContinue !== true) return { skipped: "autoContinue 已关" };
		const sid = String(sessionId);
		const maxRuns = Math.max(1, Number(cfg.autoContinueMaxRuns || 3));
		const st = continueState.get(sid) || { runs: 0, timers: [], at: 0, tid: null, leadId: null, name: null };
		if (st.runs >= maxRuns) return { skipped: "已达续写上限" };
		st.runs += 1;
		st.at = Date.now();
		st.tid = info && info.tid ? info.tid : st.tid;
		st.leadId = info && info.leadId ? info.leadId : st.leadId;
		st.name = info && info.name ? info.name : st.name;
		continueState.set(sid, st);
		const delayMs = Math.max(1, Number(cfg.autoContinueDelaySec || 10)) * 1000;
		const timer = setTimeout(() => {
			st.timers = (st.timers || []).filter((t) => t !== timer);
			if (!ctxAlive()) return;
			// ② 复确认：延迟里它可能已经自己接着跑了（内核自动重试），那就别再插一句。
			const target = ctx.agents.get(sid);
			if (target !== undefined && String(target.status) === "running") return;
			const n = st.runs;
			const tail = n > 1 ? `（第 ${n}/${maxRuns} 次）` : "";
			const body = `继续${tail}：上一轮输出撞到 token 上限被截断，输出还在对话里，接着上次停的地方往下写，不要重头再来、不要复述已完成的部分。\n`
				+ `如果这活本来就写不完：先把已完成的部分落盘（分批写文件），再回报三行【结论】【判据】【状态】。`;
			void wakeSession(sid, sid, body, "continue").then((r) => {
				if (r !== undefined && r.woke === false) {
					// 叫不动（内核没有 sessionController，或对方已消失）→ 别再空转，告诉队长
					const leadId = st.leadId;
					if (leadId !== null && leadId !== undefined) pushNotice(String(leadId), "撞顶续写失败", `${st.name === null ? "" : st.name + " "}输出撞顶，插件自动发「继续」没成功：${String(r.why || "").slice(0, 160)}。这单要么等维护方手动发「继续」，要么拆小/换 out 更大的路由。`);
				}
			}).catch((error) => {
				if (ctx.logger) ctx.logger.warn("dsh-team: auto-continue failed: " + String(error));
			});
		}, delayMs);
		if (typeof timer.unref === "function") timer.unref();
		st.timers = (st.timers || []).concat([timer]);
		return { scheduled: true, runs: st.runs, delayMs };
	}

	/** Attach undrained notices to a tool result (empty = nothing pending). */
	function withNotices(value, leadId) {
		if (leadId === undefined || leadId === null) return value;
		// 任何一次 team 调用都是「队长在场」的时刻：把积压的队长报错交给他
		// （换了模型/路由之后第一次调 team 就能看到上一条路由怎么死的）。
		let leadRows = [];
		if (claimDelivery()) {
			try {
				pruneLeadErrors();
				leadRows = deliverLeadErrors(leadId, 5);
			} catch { /* 报错文件坏了也不该拖垮整次调用 */ }
		}
		const list = (notices.get(String(leadId)) || []).concat(drainMail(leadId)).concat(pullAnnounce(leadId)).concat(leadRows.map((t) => ({ kind: "队长报错", text: t })));
		if (list.length === 0) return value;
		notices.set(String(leadId), []);
		saveNotices();
		const lines = list.map((n) => (typeof n === "string" ? n : `${n.kind}: ${n.text}`));
		if (value !== null && typeof value === "object" && !Array.isArray(value)) return { ...value, notices: lines };
		return { result: value, notices: lines };
	}
	/** Pin a member to workspace-write: delegation replays the Lead's mode first, so
	 *  this later event wins and the member's own cwd becomes the write boundary. */
	function pinMemberMode(activation, childId, member) {
		try {
			const childSession = activation !== null && activation !== undefined && activation.handle && activation.handle.agent
				? activation.handle.agent.session
				: (ctx.agents.get(childId) === undefined ? undefined : ctx.agents.get(childId).session);
			if (childSession !== undefined && childSession !== null && typeof childSession.append === "function") {
				childSession.append("sandbox/mode", { mode: "workspace-write" });
				member.sandboxMode = "workspace-write";
			}
		} catch (error) {
			if (ctx.logger) ctx.logger.warn("dsh-team: workspace-write 钉不住（成员继承队长档）：" + String(error));
		}
	}

	function resolveLead(agent) {
		let session = agent.session;
		let guard = 0;
		while (session.header && session.header.parentSession && guard < 32) {
			const parent = ctx.agents.get(session.header.parentSession);
			if (parent === undefined) break;
			session = parent.session;
			guard++;
		}
		return String(session.id);
	}

	// --- derived health：已搬到 src/health.js（createHealth）。
	const healthApi = createHealth(cfg);
	const { stuckOf } = healthApi;
	// --- auto-claim: idle member with no task pulls the best open task.
	const dispatching = new Set();
	/** Never rejects: an idle status can fire while the host is tearing this plugin
	 *  down, and an unhandled rejection here kills the whole desktop host. */
	function maybeDispatch(member, agent) {
		return maybeDispatchInner(member, agent).catch((error) => {
			try { if (ctx.logger) ctx.logger.warn("dsh-team: dispatch aborted: " + String(error)); } catch { /* dead ctx */ }
		});
	}
	async function maybeDispatchInner(member, memberAgent) {
		if (cfg.autoClaim !== true) return;
		const leadId = member.parentSessionId;
		const board = boards.get(leadId);
		if (board === undefined || member.currentTask !== null) return;
		const lead = ctx.agents.get(leadId);
		if (lead === undefined) return; // host-side send needs the live lead as authorizer
		if (dispatching.has(member.name)) return;
		// gates: this team's running count + one activation per provider/model route.
		// Counted per team (the subagent service keeps one activation pool per root,
		// default capacity 8), and de-duplicated by ROUTE, not by provider: several
		// models of the same provider may run side by side.
		let running = 0;
		const perRoute = new Map();
		for (const other of members.values()) {
			if (other.parentSessionId !== leadId) continue;
			const otherAgent = ctx.agents.get(sessionIdOf(other));
			if (otherAgent !== undefined && otherAgent.status === "running") {
				running += 1;
				const key = other.provider + "/" + other.model;
				perRoute.set(key, (perRoute.get(key) || 0) + 1);
			}
		}
		if (running >= Math.max(1, Number(cfg.maxConcurrent || 8))) return;
		const ready = (task) => (task.blockedBy || []).every((dep) => {
			const d = board.tasks.get(dep);
			return taskSettled(d); // 验收门：delivered 不算结案，要 lead accept 后才放行下游
		});
		const candidates = Array.from(board.tasks.values())
			.filter((t) => t.status === "open")
			.filter((t) => ready(t))
			.filter((t) => t.preassigned !== true || t.owner === member.name) // #12: pre-assigned tasks have exactly one owner
			.filter((t) => !(t.cooldownUntil > Date.now() && t.cooldownFor === member.name)) // 短回执退单的人 60s 内不再自动领同一单
			.filter((t) => member.caps.length === 0 || t.caps.length === 0 || t.caps.some((c) => member.caps.includes(c)))
			.sort((a, b) => b.prio - a.prio);
		if (candidates.length === 0) return;
		const task = candidates[0];
		if ((perRoute.get(member.provider + "/" + member.model) || 0) >= Math.max(1, Number(cfg.maxPerRoute || cfg.maxPerProvider || 1))) return;
		const entry = ledger.get(`${member.provider}/${member.model}`);
		// 2026-10-30 维护方纠正（原话：「跟队长说有什么用？是插件派人」）：
		// 上一版这里撞墙就推一条"你自己干吧"给队长 —— 方向错了。派人本来就是插件的活，
		// 撞墙不是"请队长动手"的理由，是**插件该补人**的信号（补员判据见 autoFillOne：
		// 撞墙的成员不算人手）。这里只保留一条内部记账，不再骚扰队长。
		// 唯一还需要说话的情形：这个成员是**预指派**在它身上的（那单只有它能领，
		// 换人得队长改派），这时必须点出来 —— 否则那单会默默卡到解禁。
		const blocked = entry === undefined ? null : (wallUntil(entry) !== null ? "wall" : groupHalted(entry) ? "halt" : null);
		if (blocked !== null) {
			const held = board.tasks.get(member.currentTask === null ? "" : member.currentTask);
			const pinned = held !== undefined && held.preassigned === true && held.owner === member.name;
			if (pinned) {
				const key = `${leadId}|${member.name}|${member.provider}/${member.model}|${blocked}`;
				const lastAt = stallNoticeAt.get(key) || 0;
				if (Date.now() - lastAt >= 5 * 60 * 1000) {
					stallNoticeAt.set(key, Date.now());
					const why = blocked === "wall"
						? `它那条 ${member.provider}/${member.model} 要停到 ${new Date(wallUntil(entry)).toLocaleString("zh-CN")}（还剩 ${Math.max(1, Math.round((wallUntil(entry) - Date.now()) / 60000))} 分钟）`
						: `它那条 ${member.provider}/${member.model} 所在的池子整组熔断`;
					pushNotice(leadId, "预指派卡在墙上",
						`${held.tid} 预指派在 ${member.name} 身上，但它现在干不了：${why}。`
						+ `这单只有它能领，别的成员抢不走 —— 要么等解禁，要么改派：task(action2:"set", tid:"${held.tid}", owner:"<别的成员名>")。`);
				}
			}
			return;
		}
		dispatching.add(member.name);
		try {
			noteStatus(task, "claimed", "plugin", `自动派单 → ${member.name}`);
			task.status = "claimed"; task.owner = member.name; task.revision += 1; task.claimedAt = Date.now();
			member.currentTask = task.tid;
			const gear = applyDemand(member, task);
			// R6: 「档位不足照跑」在已知会挂的组合上就是烧重试（实测 t11 连烧 4 轮，全 400
			// does not support reasoning effort "none"）。判据用实测/目录里这条路由的**最高档**：
			// 最高只有 0 档（none/disabled/off）= 任何需求都够不着，直接不派、把单放回。
			// 预指派的单不在此列（只有那一个成员能领，拒了就是死锁，只能照跑+上报）。
			if (gear !== undefined && gear.short && task.preassigned !== true) {
				const ladder = effortLadder(entry);
				const topRank = ladder.length === 0 ? -1 : EFFORT_RANK[ladder[ladder.length - 1]];
				if (topRank <= 0) {
					noteStatus(task, "open", "plugin", `${member.name} 路由最高档位不够（本单要 d${gear.demand}），已放回`);
					task.status = "open";
					task.owner = null;
					task.revision += 1;
					task.claimedAt = null;
					member.currentTask = null;
					task.lastReport = `未派 ${member.name}：${member.provider}/${member.model} 最高只到 ${ladder.length === 0 ? "无档位" : ladder[ladder.length - 1]}，本单要 d${gear.demand}`;
					persistAll();
					pushNotice(leadId, "档位不足不派", `${task.tid} 没派给 ${member.name}（${member.provider}/${member.model} 最高只到 ${ladder.length === 0 ? "无档位" : ladder[ladder.length - 1]}，要 d${gear.demand}）——这种组合跑一轮挂一轮，已放回 open 等有档位的路由`);
					return;
				}
			}
			if (gear !== undefined && (gear.capped || gear.short)) {
				const why = gear.capped ? `实测封顶只到 ${gear.capGear || member.effort}` : `catalog 上限只到 ${member.effort}`;
				pushNotice(leadId, "档位不足", `${member.name} ${member.provider}/${member.model} 这条要 d${gear.demand}，${why}；照跑，质量可能不足 — 要保证就换成员/路由`);
			}
			// ctx 是唯一不能被"分批"绕开的硬限制。2026-10-30 设计确定：的规矩，与"只提醒"不同：
			//  ① 派单前由**插件**按台账判断谁够（不让队长去猜）；
			//  ② 派出去实测撞了 ctx，插件**收回这单并换一条够用的路由重派**，不是让队长处理；
			//  ③ 换到池子里没有够用的路由了 → 看有没有别的成员正占着够用的路由：
			//     有 → 告诉队长"等 XXX 跑完就能继续"；没有 → 告诉队长"全池都不够，请拆任务/降 size"。
			const routeCtx = entry === undefined ? null : ctxK(entry.ctx);
			const usableCtx = entry === undefined ? null : ctxUsableK(entry);
			// 门槛 = size 估计与实测抬升（task.ctxMin）取大者：被压缩过的单不再按 size 派。
			const needCtx = taskNeedCtx(task);
			if (usableCtx !== null && usableCtx < needCtx) {
				// 本成员不够。先让插件自己找一条够用的（换模型继续，不惊动队长）。
				const switched = rotateForCtx(member, task, needCtx);
				if (switched !== undefined) {
					// 已在原地换了路由：这单继续由它跑，不必退回
					pushNotice(leadId, "ctx 不足已换路由", `${member.name} 原路由不够（${usableCtx}K < 需要 ${needCtx}K），已换到 ${switched} 继续干 ${task.tid}`);
				} else {
					noteStatus(task, "open", "plugin", `全池没有够 ${needCtx}K 的路由，已放回 open`);
					task.status = "open";
					task.owner = null;
					task.revision += 1;
					task.claimedAt = null;
					member.currentTask = null;
					const why = reportCtxExhausted(leadId, task, needCtx);
					// 冷却：不然这个成员 idle → sweepIdle 又把它派回来 → 又不够 → 再退回，
					// 一分钟能空转几十轮（那不是在干活，是纯烧 CPU/额度日志）。
					task.cooldownFor = member.name;
					task.cooldownUntil = Date.now() + 60000;
					task.lastReport = `未派 ${member.name}：${member.provider}/${member.model} ctx ${usableCtx}K < 需要 ${needCtx}K（size=${task.size}${Number(task.ctxMin) > sizeCtxK(task.size) ? "，实测压缩已抬到 " + task.ctxMin + "K" : ""}）${why === "" ? "" : "｜" + why}`;
					persistAll();
					return;
				}
			}
			const brief = [task.briefPath ? `任务书文件：${task.briefPath}（第一个动作 read 它）` : task.title, task.body || ""].filter(Boolean).join("\n");
			// The team goal is written ONCE by the Lead; every member inherits it here, so a
			// task body only has to state its own boundary instead of re-narrating the plan.
			const goalText = (() => {
				const g = goals.get(leadId) || (boards.get(leadId) === undefined ? null : boards.get(leadId).goal);
				const t = g !== null && g !== undefined && g.text ? String(g.text).trim() : "";
				return t === "" ? "" : `\n队伍总目标：${t.slice(0, 300)}`;
			})();
			// out is never a reason to split the TASK — it only decides how many write
			// batches the member should use. Stated from the route's own catalog value.
			const outK = entry === undefined ? null : ctxK(entry.out);
			const outHint = outK === null
				? "单次输出上限未标明：产出偏长就分批写文件，不要一次输出整篇。"
				: `单次输出上限标称 ${outK}K：超过就分批写文件，不要一次输出整篇。`;
			const ctxHint = task.size === undefined || task.size === null ? "" : `（本任务 size ${task.size}=输入需 ctx ≥${sizeCtxK(task.size)}K）`;
			// 派单消息第一行就切断历史：成员复活后最常见的错是接着做上一条活。
			const onlyThis = (() => {
				const t = member.lastTask;
				if (t === undefined || t === null) return "【只做本单】只执行本条消息，历史里没结的旧任务一律作废。\n";
				return `【只做本单】你上一条 ${t.tid}《${t.title}》已${t.status === "done" ? "交付" : "作废"}，不要续做、不要动它的文件。\n`;
			})();
			// 产物门槛提前说：声明的文件必须在结单前真落盘，否则 finish 会被拒（插件核对存在+mtime）。
			// #5：把解析后的绝对路径原样回声一次，成员沿用参考实现就不会把文件写到 workspace 根/漏项目段。
			// 产物门槛提前说：声明的文件必须在结单前真落盘，否则 finish 会被拒（插件核对存在+mtime）。
			// #5：把解析后的绝对路径原样回声一次，成员沿用参考实现就不会把文件写到 workspace 根/漏项目段。
			// 2026-10-30 维护方加：**文件已存在/正被占用**必须开工前就说清楚，成员看不到面板，
			// 这段是它唯一的视野。已存在 → 先读、判断能不能接着改；被占 → 别硬写，等通知。
			const artHint = Array.isArray(task.artifacts) && task.artifacts.length > 0
				? `\n本单必须落盘（沿用参考实现下面的绝对路径，别自己拼）：${artifactAbs(task, member).map((p) => `\n  - ${p}`).join("")}\n（finish 会核对存在+mtime，缺一个或没写就拒收；声明原文：${task.artifacts.join("、")}）`
				: "";
			const fileHint = (() => {
				const list = artifactAbs(task, member);
				if (list.length === 0) return "";
				const lines = [];
				for (const p of list) {
					reapStaleLocks(Date.now());
					const rec = fileLocks[lockKeyOf(p)];
					let st;
					try { st = nodeFs.statSync(p); } catch { st = undefined; }
					const exists = st !== undefined && st.isFile();
					const held = rec !== undefined && rec !== null && rec.holder !== null && rec.holder !== undefined ? rec.holder : null;
					if (held !== null && held.member !== member.name) {
						lines.push(`  ⛔ ${p} 正被 ${held.member}${held.task ? "（" + held.task + "）" : ""} 修改中 —— 别硬写，你的 write/edit 会被拦下并排进队列；它放锁后插件会单独通知你`);
					} else if (exists) {
						lines.push(`  ⚠ ${p} 已存在（${st.size} 字节，${new Date(st.mtimeMs).toLocaleString("zh-CN")}${held !== null ? "，你正持有" : ""}）—— 动手前必须先 read 它，确认是在它的基础上增量改；内容与本任务不符就别覆盖，team(action:"msg", to:"<队长短号>", text:"…") 报回来`);
					} else {
						lines.push(`  ✓ ${p} 还不存在，可直接写`);
					}
				}
				return lines.length === 0 ? "" : `\n【文件状态】\n${lines.join("\n")}\n（改文件插件会自动加锁/放锁：同一文件同时只能一个人在改，别人会排队等；你收到的「文件空了」通知才表示轮到你了）`;
			})();
			// 派单是最后一次改路由的机会点：成员闲着的这段时间里名册可能被 retool/降档/
			// 自动换路由改过，而内核的 selection 是每 step 开头读一次的 —— 发消息之前再同步
			// 一次，保证它这一步真跑在名册那条路由上（新内核的硬校验就卡这一处）。
			syncMemberSelectionOf(member);
			await ctx.subagents.sendMessage(lead, sessionIdOf(member), [
				{ type: "text", text: `${onlyThis}领单 ${task.tid}《${task.title}》档位 ${member.effort}。${outHint}${ctxHint}${goalText}\n本任务：${brief}${artHint}${fileHint}\n产出写写根（任务书/总目标给了 workspace 内绝对路径就按那里写）。工牌纪律 6/8 条照做：finish 结案、文件里只写结果。` },
			], { signal: AbortSignal.timeout(30000) });
			if (ctx.logger) ctx.logger.info(`dsh-team: dispatched ${task.tid} -> ${member.name}`);
		} catch (error) {
			noteStatus(task, "open", "plugin", `派单失败：${String(error).slice(0, 80)}，已放回`);
			task.status = "open"; task.owner = null; task.revision += 1;
			member.currentTask = null;
			if (ctx.logger) ctx.logger.warn(`dsh-team: dispatch failed: ${String(error)}`);
		} finally {
			dispatching.delete(member.name);
			persistAll();
		}
	}
	// A task that appears or becomes unblocked while members already sit idle
	// would otherwise wait for an agent/status edge that has already fired:
	// sweep them at the moment the board changes instead.
	function sweepIdle(leadId) {
		for (const member of members.values()) {
			if (member.parentSessionId !== leadId || member.currentTask !== null) continue;
			const agent = ctx.agents.get(sessionIdOf(member));
			if (agent === undefined || agent.status === "idle") dispatchSafely(member, agent);
		}
	}
	// Every team this process knows about (live boards + roster), so status(scope:"all")
	// and teams() can answer "别的会话是不是还挂着一支队" without cross-writing anything.
	function crossTeams(myLeadId) {
		const leads = new Set();
		const archivedTeams = archivedSessions();
		for (const lead of boards.keys()) leads.add(lead);
		for (const member of members.values()) leads.add(member.parentSessionId);
		const rows = [];
		for (const lead of leads) {
			const board = boards.get(lead);
			const tasks = board ? Array.from(board.tasks.values()) : [];
			const count = (s) => tasks.filter((t) => t.status === s).length;
			const mine = lead === myLeadId;
			const membersOf = Array.from(members.values()).filter((m) => m.parentSessionId === lead).length;
			// 2026-10-29 设计确定：队长/队员显示全部 —— 归档的也照列，但标出来，
			// 免得「开了 2 个对话却看到 5 个队」时以为插件乱编。占路由的判定另算（归档不算队长）。
			const arch = archivedTeams.has(String(lead)) ? "|已归档" : "";
			rows.push({ mine, rank: mine ? 0 : 1, text: `${mine ? "本队" : lead.slice(-6)}|成员${membersOf}|open${count("open")}/claimed${count("claimed")}/done${count("done")}|${ctx.agents.get(lead) !== undefined ? "活" : "冷"}${arch}` });
		}
		rows.sort((a, b) => a.rank - b.rank);
		return rows.map((r) => r.text);
	}
	function sessionIdOf(member) {
		for (const [sessionId, m] of members) if (m === member) return sessionId;
		return "";
	}
	/** 谁真正持有这一单。**必须 owner 和 currentTask 都对得上**（2026-10-31 隔壁实测）：
	 *  remove force 删的是一张 claimed 单，owner 是已回收的 auto2，可返回值却通知了 auto1 ——
	 *  因为只按 `currentTask === tid` 找，而 auto1 手里还留着**换血前那张同号单的陈旧指针**。
	 *  tid 会被复用（删单/建单/重建板都会重编号），指针单独不足以证明持有关系。
	 *  找不到活着的持有者就返回 undefined，调用方按 task.owner 说话，别硬塞一个人。 */
	function holderOf(task, leadId) {
		if (task === undefined || task === null || task.owner === null || task.owner === undefined) return undefined;
		for (const m of members.values()) {
			if (leadId !== undefined && m.parentSessionId !== leadId) continue;
			if (m.name !== task.owner) continue;
			if (m.currentTask !== task.tid) continue;
			return m;
		}
		return undefined;
	}

	// --- events on every created agent (fresh + resumed + forked + non-members)
	ctx.on("agent/created", ({ agent }) => {
		attachRouting(agent);
		attachAccounting(agent);
	});

	// HMR mid-session adoption: reattach routing/accounting to already-live agents.
	for (const agent of ctx.agents.list()) {
		attachRouting(agent);
		attachAccounting(agent);
	}

	// --- 全局兜底监听：已搬到 src/accounting.js（createAccounting）。
	const accountingApi = createAccounting({ ctx, members, recordRealRun });
	const { debugSeen, globalFailure, globalReqHandler, globalErrHandler, globalSessionErrHandler } = accountingApi;
	// 三级注册：根 context（最稳，跨会话实例也收得到）→ 本 context（带 global）→ 本 context（普通）。
	// dsh-purge 也是这么干的：根上挂一次，整个进程的 agent 都在射程内。
	const registered = [];
	const tryOn = (target, event, handler, opts) => {
		try {
			if (target === undefined || target === null || typeof target.on !== "function") return false;
			if (opts === undefined) target.on(event, handler);
			else target.on(event, handler, opts);
			registered.push(event + (opts === undefined ? "" : "(global)"));
			return true;
		} catch { return false; }
	};
	{
		const rootCtx = ctx.root !== undefined && ctx.root !== null ? ctx.root : (ctx.app !== undefined && ctx.app !== null ? ctx.app : undefined);
		if (rootCtx !== undefined) {
			tryOn(rootCtx, "agent/request-error", globalReqHandler, { global: true });
			tryOn(rootCtx, "agent/error", globalErrHandler, { global: true });
			tryOn(rootCtx, "api-session/error", globalSessionErrHandler, { global: true });
		}
		tryOn(ctx, "agent/request-error", globalReqHandler, { global: true });
		tryOn(ctx, "agent/error", globalErrHandler, { global: true });
		tryOn(ctx, "api-session/error", globalSessionErrHandler, { global: true });
		const via = registered.length === 0 ? "none" : registered.join(",");
		try {
			nodeFs.writeFileSync(nodePath.join(stateDirPath(), "hook-status.json"), JSON.stringify({ at: Date.now(), via, hasRoot: rootCtx !== undefined }, null, 1));
		} catch { /* 诊断 */ }
	}
	// --- 兜底扫描（2026-10-29 三次漏记之后加的，最后一层保险）。
	//     事件钩子在这套内核里按 Agent scope 过滤：别的会话撞 400，本会话的实例收不到
	//     （`{global:true}` 也没兜住，实测 14:48 / 14:54 两次都空）。但 `sessionPersistence`
	//     是进程级的，可以直接 open 别人的会话日志读尾部事件 —— 这条路不依赖事件传播。
	//     只读最近 15 分钟内活跃的会话、每次最多 6 个、每人尾部 60 条，节流 20 秒。
	const sweptPath = nodePath.join(stateDirPath(), "swept.json");
	let swept = loadJson(sweptPath, {});
	const saveSwept = () => { try { saveJson(sweptPath, swept); } catch { /* 诊断 */ } };
	let lastSweepAt = 0;
	let sweeping = false;
	function failureTextFromAttempt(ev) {
		const stream = ev && ev.data && Array.isArray(ev.data.stream) ? ev.data.stream : [];
		for (let i = stream.length - 1; i >= 0; i -= 1) {
			const chunk = stream[i] && stream[i].chunk;
			const reason = chunk && chunk.reason;
			if (reason !== undefined && reason !== null && reason.kind === "error" && reason.failure) return String(reason.failure.message || reason.failure.code || "");
		}
		const end = ev && ev.data && ev.data.reason;
		if (end !== undefined && end !== null && end.kind === "error" && end.error) return String(end.error.message || end.error.code || "");
		return "";
	}
	async function sweepErrors(force) {
		if (sweeping) return 0;
		const now = Date.now();
		if (force !== true && now - lastSweepAt < 20000) return 0;
		lastSweepAt = now;
		sweeping = true;
		// 「累计干活时长」用**自己的水位**：错误水位是为了不重复报错，一旦推进到最新，
		// 装上那一刻之前的成功回合就再也计不进去了。时长要能回填，所以单独存一份。
		const usedSweptPath = nodePath.join(stateDirPath(), "used-swept.json");
		let usedSwept = loadJson(usedSweptPath, {});
		const saveUsedSwept = () => { try { saveJson(usedSweptPath, usedSwept); } catch { /* 诊断 */ } };
		const dbg = (obj) => {
			try {
				const p = nodePath.join(stateDirPath(), "sweep-debug.jsonl");
				let size = 0;
				try { size = nodeFs.statSync(p).size; } catch { /* 首次 */ }
				if (size > 120 * 1024) nodeFs.writeFileSync(p, "");
				nodeFs.appendFileSync(p, JSON.stringify({ at: Date.now(), ...obj }) + "\n");
			} catch { /* ignore */ }
		};
		let captured = 0;
		try {
			// 内核的 sessionPersistence.stat 不给 eventCount（这个后端是可选字段），
			// 所以直接读会话日志文件的尾部：zstd 多帧，按魔数切开逐帧解压（实测可行）。
			const dshRoot = process.env.DSH_HOME ? String(process.env.DSH_HOME) : nodePath.join(String(process.env.USERPROFILE || ""), ".dsh");
			const sessRoot = nodePath.join(dshRoot, "sessions");
			// 窗口不能太窄：报错要快（15 分钟足够），但「累计干活时长」得覆盖那些
			// 刚跑完就安静下来的会话（探针大对话一小时才动一次）。所以放到 90 分钟、
			// 最多 8 个文件，靠 used-swept 水位保证不重复计。
			const cutoff = now - 90 * 60 * 1000;
			const files = [];
			const walk = (dir, depth) => {
				let ents = [];
				try { ents = nodeFs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
				for (const e of ents) {
					const p = nodePath.join(dir, e.name);
					if (e.isDirectory()) { if (depth < 3) walk(p, depth + 1); continue; }
					if (!e.name.endsWith(".jsonl.zstd")) continue;
					try { const st = nodeFs.statSync(p); if (st.mtimeMs >= cutoff) files.push({ path: p, mtime: st.mtimeMs, size: st.size }); } catch { /* skip */ }
				}
			};
			walk(sessRoot, 0);
			dbg({ step: "files", n: files.length });
			files.sort((a, b) => b.mtime - a.mtime);
			for (const f of files.slice(0, 8)) {
				let text = "";
				try {
					const readLen = Math.min(f.size, 524288);
					const start = f.size - readLen;
					const fd = nodeFs.openSync(f.path, "r");
					const buf = Buffer.alloc(readLen);
					try { nodeFs.readSync(fd, buf, 0, readLen, start); } finally { nodeFs.closeSync(fd); }
					const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
					const cuts = [];
					for (let i = 0; i <= buf.length - 4; i += 1) if (buf.compare(magic, 0, 4, i, i + 4) === 0) cuts.push(i);
					if (cuts.length === 0) { dbg({ step: "no-frame", f: nodePath.basename(nodePath.dirname(f.path)) }); continue; }
					for (let i = 0; i < cuts.length; i += 1) {
						const a = cuts[i];
						const b = i + 1 < cuts.length ? cuts[i + 1] : buf.length;
						try { text += nodeZlib.zstdDecompressSync(buf.subarray(a, b)).toString("utf8"); } catch { /* 尾帧可能被截断 */ }
					}
				} catch (err) { dbg({ step: "read-fail", err: String((err && err.message) || err).slice(0, 120) }); continue; }
				const key = nodePath.basename(nodePath.dirname(f.path));
				const already = Number(swept[key] || 0);
				const alreadyUsed = Number(usedSwept[key] || 0);
				let header = null;
				let headerAt = 0;
				let maxSeq = already;
				let hits = 0;
				let seenHits = 0;
				let usedHits = 0;
				for (const line of text.split("\n")) {
					if (line === "") continue;
					let ev;
					try { ev = JSON.parse(line); } catch { continue; }
					const seq = Number(ev.seq || 0);
					if (ev.type === "request/header" && ev.data && ev.data.header && ev.data.header.config) {
						header = ev.data.header.config;
						headerAt = Number(ev.time) || 0;
					}
					// 成功回合的 usage = 不靠报错就能拿到的实测下界。
					// 放在水位判断之前：这样插件装上/升级后能立刻把最近的证据补进台账
					// （recordSeenUsage 只保留最大值，重复扫同一行是幂等的）。
					let done = null;
					if (ev.type === "assistant/message" && ev.data && ev.data.usage) {
						const inp = Number(ev.data.usage.inputTokens);
						const outTok = Number(ev.data.usage.outputTokens);
						const msg = ev.data.message;
						const bodyOk = msg !== undefined && msg !== null && Array.isArray(msg.content) && msg.content.length > 0 && !msg.error;
						const src = (msg !== null && msg !== undefined && msg.source) || {};
						const prov = src.provider || (header === null ? undefined : header.provider);
						const mdl = src.model || (header === null ? undefined : header.model);
						if (bodyOk && Number.isFinite(inp) && inp > 0 && Number.isFinite(outTok) && outTok > 0) {
							done = { prov, mdl, inp };
							if (recordSeenUsage(prov, mdl, inp, ev.time, ev.data.turn, key) > 0) seenHits += 1;
						}
					}
					if (seq > already) maxSeq = Math.max(maxSeq, seq);
					// 累计「正常干活时长」：走自己的水位，所以插件装上之前的成功回合也能回填
					// （recordSeenUsage 取 max 是幂等的，时长是累加，必须靠水位去重）。
					if (done !== null && seq > alreadyUsed) {
						const dur = Number(ev.time) - headerAt;
						if (recordUsedTime(done.prov, done.mdl, dur) > 0) usedHits += 1;
						usedSwept[key] = Math.max(Number(usedSwept[key] || 0), seq);
					}
					if (!(seq > already)) continue;
					maxSeq = Math.max(maxSeq, seq);
					const type = String(ev.type || "");
					if (type !== "assistant/attempt" && type !== "turn/end") continue;
					const raw = failureTextFromAttempt(ev);
					if (raw === "") continue;
					if (header === null || header.provider === undefined || header.model === undefined) continue;
					const cfg2 = header;
					recordRealRun(cfg2.provider, cfg2.model, "fail", raw, cfg2.reasoningEffort, null, key);
					captured += 1;
					hits += 1;
				}
				if (maxSeq > already) { swept[key] = maxSeq; saveSwept(); }
				saveUsedSwept();
				dbg({ step: "scanned", key, hits, seen: seenHits, used: usedHits, maxSeq });
			}
			return captured;
		} catch (err) {
			dbg({ step: "crash", err: String((err && err.message) || err).slice(0, 300) });
			return 0;
		} finally {
			sweeping = false;
		}
	}

	// #18: a member sometimes loses the parent fast-path and falls into a cold
	// probe that fails with `subagent "…" is unavailable`. Swallow exactly that
	// case (target = the sender's own parent) and carry the member's text to the
	// Lead's notice queue, so a delivered report never dies on a kernel race.
	function installSendMessageFallback() {
		const svc = ctx.subagents;
		if (svc === undefined || svc === null || svc.__teamPatched === true) return;
		const original = svc.sendMessage;
		if (typeof original !== "function") return;
		svc.sendMessage = async function sendMessageWithFallback(sender, targetId, content, options) {
			try {
				return await original.call(this, sender, targetId, content, options);
			} catch (error) {
				const header = sender !== null && sender !== undefined && sender.session !== undefined ? sender.session.header : undefined;
				const parentId = header === undefined || header === null ? undefined : header.parentSession;
				const text = String(error && error.message ? error.message : error);
				if (parentId === undefined || String(parentId) !== String(targetId) || !/unavailable|NOT_RESUMABLE|not a resident|not live|PARENT_UNAVAILABLE/i.test(text)) throw error;
				const member = members.get(String(sender !== null && sender !== undefined ? sender.id : ""));
				const body = Array.isArray(content)
					? content.map((block) => block !== null && block !== undefined && block.type === "text" ? String(block.text) : "").join(" ").trim()
					: String(content || "");
				pushNotice(String(parentId), "成员回报(插件代收)", `${member === undefined ? "?" : member.name}｜${sanitizeReport(body)}`);
				return "team-notice-" + randomUUID();
			}
		};
		svc.__teamPatched = true;
	}
	installSendMessageFallback();

	// Reload-orphan sweep：插件重装的那 1-2 秒里成员恰好结束的话，subagent/end 收不到，
	// 于是留下「claimed 单 + 悬空 currentTask」。下面的 idle 补派又因为 currentTask 非空
	// 跳过它 → 那张单会一直挂着，面板要等 10 分钟才标 stale，期间零通知。
	// 判据：名册里有 currentTask，但 agent 不存在或已不在 running。
	for (const member of Array.from(members.values())) {
		if (member.currentTask === null || member.currentTask === undefined) continue;
		const agent = ctx.agents.get(sessionIdOf(member));
		if (agent !== undefined && String(agent.status) === "running") continue;
		const board = boards.get(member.parentSessionId);
		const orphan = board === undefined ? undefined : board.tasks.get(member.currentTask);
		if (orphan !== undefined && orphan.status === "claimed" && orphan.owner === member.name) {
			noteStatus(orphan, "open", "plugin", `重装窗口丢了 ${member.name} 的收尾事件，已退回`);
			orphan.status = "open";
			orphan.owner = null;
			orphan.revision += 1;
			orphan.claimedAt = null;
			orphan.lastReport = `重装窗口期成员 ${member.name} 已不在运行，任务退回`;
			orphan.error = "重装窗口期成员结束，未见交付";
			pushNotice(member.parentSessionId, "重装孤儿", `${orphan.tid} 在插件重装窗口里丢了收尾事件（成员 ${member.name} 已不在运行），已退回 open——重派前先看写根有没有半成品`);
		}
		member.currentTask = null;
	}
	persistAll();

	// Recovery sweep: idle members missed their status edge during the reload window.
	for (const member of members.values()) {
		const agent = ctx.agents.get(sessionIdOf(member));
		if (agent !== undefined && agent.status === "idle") dispatchSafely(member, agent);
	}

	// --- the single model-facing tool
	const teamTool = {
		name: "team",
			description:
				"TEAM工具：使用TEAM定目标、拆单、发公告、跨会话对话。TEAM根据拆单自动派成员开工。\n" +
				"流程（跳步会被拒）：goal 写总目标 → task create 拆单 → 等汇报 → task action2=accept 验收（reject 打回）。\n" +
				"- goal(text)：写总目标，重复覆盖；传 \"\" 清空。\n" +
				"- task create：title 必填；body=本片边界；brief_path=任务书；blocked_by=前置 tid（有依赖必须逐条标，不写就并行）；kind=grunt|code|design|probe；size=s|m|l；demand=1|1+|2|3|max（默认 2）；vision=true 只派能读图的路由；caps=标签csv；artifacts=必须落盘的文件；no_artifact=没有产出物。批量建用 tasks:[{…}]，{i}=序号 {prev}=上一张 tid。\n" +
				"- task list：看任务板。\n" +
				"- task action2=accept：验收通过（delivered→done）；reject 打回（delivered→open）。\n" +
				"- task action2=set：改单；remove 删单（tid/tids 批量）。\n" +
				"- msg(to,text)：给成员追加指令。\n" +
				"- announce(text)：全体公告；不带 text=读最新。\n" +
				"- tell(to,text)：给另一个会话 Leader 递话；peers 看别的对话框。\n" +
				"- 跨会话消息：能说清问题的前提下尽可能短；没问内容不发。\n" +
				"- files(path?)：查文件占用表。\n" +
				"- 排障：kill(to,ban?|remove?) 叫停；ban:true=判产出混乱；rule 错误规则表（match+errorClass+fix=backoff|downshift|rotate|dead|retry|none）。\n" +
				"其余 action（claim/spawn/retool/unban/models/scan/save/teams/adopt/disband/reload/ofm/continue/score 等）与全部参数细节不在本定义里——碰到问题需要更多内容时，加载 skill team-reference。",
		parameters: {
			type: "object",
			properties: {
				action: { type: "string", enum: ["spawn", "status", "task", "claim", "msg", "retool", "kill", "unban", "models", "scan", "save", "teams", "adopt", "goal", "history", "rule", "files", "peers", "tell", "announce", "disband", "reload", "ofm", "continue", "score"], description: "动作名；未在定义正文说明的动作先加载 skill team-reference" },
				kind: { type: "string", description: "任务类型 grunt|code|design|probe" },
				size: { type: "string", description: "s|m|l" },
				demand: { type: "string", description: "1|1+|2|3|max" },
				caps: { type: "string", description: "能力标签csv" },
				vision: { type: "boolean", description: "只派可读图路由" },
				to: { type: "string", description: "目标成员/会话" },
				ban: { type: "boolean", description: "kill: 判产出混乱" },
				remove: { type: "boolean", description: "kill: 移出名册" },
				text: { type: "string", description: "正文（goal/msg/tell/announce/fail 原因）；保证能说清楚问题的前提下尽可能简短" },
				title: { type: "string", description: "create: 标题(必填)" },
				body: { type: "string", description: "create: 本片边界" },
				brief_path: { type: "string", description: "create: 任务书路径" },
				blocked_by: { type: "string", description: "create: 前置tid(csv)" },
				artifacts: { type: "string", description: "create/set: 本单必须落盘的文件(csv)；**不用填**：产出默认就写在成员写根里" },
				no_artifact: { type: "boolean", description: "create: 无文件产物" },
				tid: { type: "string", description: "任务id" },
				match: { type: "string", description: "rule: 错误特征串" },
				errorClass: { type: "string", description: "rule: 分类名" },
				fix: { type: "string", description: "rule: backoff|downshift|rotate|dead|retry|none" },
				action2: { type: "string", enum: ["create", "list", "finish", "fail", "set", "reopen", "remove", "accept", "reject"], description: "task 子动作，默认 list；细节见 skill team-reference；批量 tid=\"t3-t7\" 也行" },
				tids: { type: "string", description: "批量tid（remove/set）" },
				tasks: { type: "array", items: { type: "object", additionalProperties: true }, description: "create: 批量建单" },
				path: { type: "string" },
			},
			required: ["action"],
			additionalProperties: true,
		},
		output: {
			schema: { type: "object", additionalProperties: true },
			render: (_args, value) => [{ type: "text", text: typeof value === "object" ? JSON.stringify(value) : String(value) }],
		},
		isConcurrencySafe: () => false,
		async execute(args, exec) {
			// 统一出口：跨会话 Lead 信箱对所有 action 都送达 —— 原先只有走 withNotices 的
			// action 才看得到，peers/tell/scan/save/kill/msg 这些会漏掉来信。
			const mailLead = exec.agent === undefined ? undefined : resolveLead(exec.agent);
			// 有些 case 自己 return withNotices(...)，统一出口又包一层 —— 同一个 action 会走
			// 两遍 withNotices。队长报错的交付必须一次调用只做一次（否则 asks 一次跳两格，
			// 没问就升级成「问维护方」），所以用调用序号闸住。
			bumpCallSeq();
			// 台账标注顺手做：队长占用的路由要立刻在台账里标出来（15s 节流）。
			try { markLiveUsage(); } catch { /* 标注失败不影响本次调用 */ }
			// 兜底扫一眼别的会话有没有刚撞墙（钩子收不到，只能主动读会话日志）
			void sweepErrors(false);
			const out = await (async () => {
				const caller = exec.agent;
				if (caller === undefined) throw new Error("team requires a calling agent");
				// 2026-10-31 某次实测 实测（问题 6/8，最重）：成员 auto2 自己跑了
				// create/claim/set/save/adopt/disband 全套，把**队长的板**当场换血，还写了个
				// team-<某队> 存档。根因：resolveLead 沿 parentSession 往上爬，队员调 team
				// 拿到的正是队长板；而下面每个 case 只按 action 分派，从不问"调用方是不是队员"。
				// 修法：队员态只放行「干活 / 回报 / 只读」这几件事，其余一律拒，并说明找谁办。
				//
				// 判"是不是队员"不能只看 members：成员被回收/移出名册之后，它的会话还活着，
				// 那时 members.get(它) === undefined，老代码就把它当队长放行 —— 这正是隔壁问题 8
				// 里"残影成员还能 disband 队长板"的来源。三重判据：在册成员 / 已退役成员 /
				// 有父会话且父会话带板的子代理。
				const selfMemberNow = members.get(caller.session.id);
				const parentOfCaller = caller.session.header && caller.session.header.parentSession ? String(caller.session.header.parentSession) : "";
				const retiredOfCaller = retiredMembers.get(caller.session.id);
				const selfMember = selfMemberNow !== undefined
					? selfMemberNow
					: (retiredOfCaller !== undefined
						? { ...retiredOfCaller, currentTask: null, retired: true }
						: (parentOfCaller !== "" && boards.has(resolveLead(caller))
							? { name: "子会话" + String(caller.session.id).slice(-6), parentSessionId: resolveLead(caller), currentTask: null, retired: true }
							: undefined));
				const MEMBER_ACTIONS = new Set(["task", "claim", "msg", "tell", "files", "history", "status"]);
				let action = String(args.action || "");
				// 弱模型把交单写成 action:"finish"（隔壁实录 status 错误位 "unknown action finish"）。
				// 带 tid 时按 task 的 action2 同义转发；不带 tid 就照旧报错 —— 不猜。
				const ACTION_ALIAS = new Set(["finish", "fail", "reopen", "accept", "reject", "create", "set", "remove"]);
				if (ACTION_ALIAS.has(action) && args.tid !== undefined && args.tid !== null) {
					args = { ...args, action: "task", action2: action };
					action = "task";
				}
				if (selfMember !== undefined && !MEMBER_ACTIONS.has(action)) {
					throw new Error(`成员 ${selfMember.name} 不许调 "${action}"：队员只能 task(list/finish/fail)、claim、msg、tell、files、history、status。建单/改单/删单/验收/存档/收队/换路由/发公告都是队长的活 —— 卡住了用 team(action:"tell", to:"${shortOf(selfMember.parentSessionId)}", text:"…") 报给队长`);
				}
				switch (action) {
					case "spawn": {
						// 必做流程是 goal → task create → 等汇报；人手由插件在拆单后自动补。
						// spawn 只剩例外用途（指定路由/写根），两道硬闸把抢跑和滥用挡在激活前：
						const spawnSelf = members.get(caller.session.id);
						if (spawnSelf !== undefined) throw new Error(`成员 ${spawnSelf.name} 不许 spawn：只干手上这一单，缺人归队长管。`);
						const spawnLead = resolveLead(caller);
						const spawnBoard = boards.get(spawnLead);
						const spawnReady = spawnBoard === undefined ? 0 : Array.from(spawnBoard.tasks.values()).filter((t) => t.status === "open" && (t.owner === null || t.owner === "") && t.blockedBy.every((d) => taskSettled(spawnBoard.tasks.get(d)))).length;
						if (spawnReady === 0) throw new Error("板上无TASK。");
						const name2 = String(args.name || `w${members.size + 1}`).slice(0, 40);
						if (!/^[\w\u4e00-\u9fa5-]{1,20}$/.test(name2)) throw new Error(`成员名 ${name2} 不合法：1–20 字，只允许中文/字母/数字/_/-（它同时是产出文件夹名）`);
						let provider = String(args.provider || "").trim();
						let model = String(args.model || "").trim();
						const effortArg = String(args.effort || "").trim();
						const demandArg = checkDemand(args.demand);
						const leadId = resolveLead(caller);
						// D2 step 1: the route is optional — kind/size let the plugin pick it,
						// and the reply always says why (or that it had no data to go on).
						let pickedWhy = "";
						if (!provider || !model) {
							const pk = pickRoute(String(args.kind || "grunt"), String(args.size || "m"), leadId, undefined, { vision: args.vision === true || String(args.vision || "").trim().toLowerCase() === "true" });
							if (pk.error !== undefined) throw new Error(`spawn 未给 provider/model，插件选型失败：${pk.error}`);
							provider = pk.entry.provider;
							model = pk.entry.model;
							pickedWhy = pk.why;
						}
						for (const other of members.values()) {
							if (other.parentSessionId === leadId && other.name === name2) throw new Error(`成员名 ${name2} 在本队已存在（换一个名字；同名会让 msg/retool 指向不明）`);
						}
						// ledger gate (#13): never hand out a route the scan or a real run
						// already retired. Refusal carries usable alternatives (#22).
						const ledgerEntry = ledger.get(`${provider}/${model}`);
						// Candidates: free quota is shared cross-team, so an unheld route outranks
						// a real-run-proven one that another team is already running right now.
						const alternatives = () => {
							const occ = routeOccupancy();
							const held = (e) => (occ.get(e.provider + "/" + e.model) || []).filter((u) => u.lead !== leadId);
							return Array.from(ledger.values())
								.filter(dispatchable)
								.filter((e) => e.provider + "/" + e.model !== routeOf(caller))
								.filter((e) => !(effectiveBackoff(e) > Date.now()) && !groupHalted(e))
								.map((e) => ({ e, busy: held(e) }))
								.sort((a, b) => (a.busy.length === 0 ? 0 : 1) - (b.busy.length === 0 ? 0 : 1) || (b.e.realResult === "ok" ? 1 : 0) - (a.e.realResult === "ok" ? 1 : 0))
								.slice(0, 3)
								.map(({ e, busy }) => `${e.provider}/${e.model} eff=${e.efforts}${busy.length === 0 ? "" : " [别队在用:" + busy.map((u) => u.team + "/" + u.member).join(",") + "]"}`)
								.join(" | ");
						};
						// 队长路由一律不派：不只是调用方自己，任何顶层会话正在用的都不行。
						const leadKeysNow = leadRouteKeys();
						if (leadKeysNow.has(provider + "/" + model)) throw new Error(`${provider}/${model} 是队长路由（一律不派给成员）— 换一个。可派：${alternatives() || "(先 team(scan))"}`);
						if (ledgerEntry !== undefined) {
							if (ledgerEntry.status === "invalid") throw new Error(`${provider}/${model} 台账已标失效（${ledgerEntry.errClass || ledgerEntry.note || "见 team(models)"}），换一个。可派：${alternatives() || "(先 team(scan))"}`);
							// ★ 2026-11-16（Updating\03）：显式指定路由也要过「内核已下架」这道闸。
							//   原来这里只拦 status==="invalid"，而 mistral-large-4-1t-a52b 下架时
							//   status 是 unknown ⇒ **队长显式 spawn 能绕过 dispatchable() 的唯一闸**，
							//   派下去就是一条必死的路（内核 UNSUPPORTED_REASONING_EFFORT）。
							//   判据与 dispatchable() 同源（看 delisted），不另立第二份口径。
							if (ledgerEntry.delisted === true) throw new Error(`${provider}/${model} 内核目录已下架（${ledgerEntry.note || "见 team(models)"}），台账判为不可派 — 换一个。可派：${alternatives() || "(先 team(scan))"}`);
							const gst = groupHalt.get(groupIdOf(ledgerEntry));
							if (groupHalted(ledgerEntry)) throw new Error(`${provider}/${model} 属 ${groupIdOf(ledgerEntry)} 组（同一条上游出口），整组熔断中${gst && gst.until > Date.now() ? `（约 ${Math.ceil((gst.until - Date.now()) / 3600000)} 小时后单条探活）` : "（等探活）"}，换别的池。可派：${alternatives() || "(先 team(scan))"}`);
							const backoffAt = effectiveBackoff(ledgerEntry);
							if (backoffAt > Date.now()) throw new Error(`${provider}/${model} 正在退避（${Math.ceil((backoffAt - Date.now()) / 60000)} 分钟后解禁），换一个。可派：${alternatives() || "(先 team(scan))"}`);
						}
						// gear (#11): explicit effort = intent, but never above the measured
						// ceiling; omission = 常规 (demand 2). Dispatch recomputes per task later.
						const gearInfo = resolveGear(ledgerEntry, effortArg, demandArg === "" ? String(DEMAND_DEFAULT) : demandArg);
						const effort = gearInfo.gear;
						// write root: the member's cwd IS its workspace-write boundary, so one
						// directory per member. 绝对路径 = 显式写根（并成为本队基底）；"team"/缺省 =
						// <队基底>\<成员名>（没有基底才回落 <队目录>\<成员名>）。三处入口共用 memberWorkdir。
						const rawRoot = String(args.workdir || "").trim();
						if (rawRoot !== "" && rawRoot !== "team" && !nodePath.isAbsolute(rawRoot)) throw new Error(`workdir 必须是绝对路径或 "team"（收到 ${rawRoot}）`);
						const meta = teamMeta(leadId, String(args.teamName || "").trim() || (rawRoot !== "" && rawRoot !== "team" ? nodePath.basename(nodePath.resolve(rawRoot)) : name2));
						const workdir = memberWorkdir(leadId, name2, rawRoot);
						const mkErr = ensureWriteRoot(workdir);
						if (mkErr !== undefined) throw new Error(`workdir 建不出来：${workdir}（${mkErr}）`);
						const outside = outsideWorkspace(workdir);
						const body0 = "等待领单：先待命，收到领单消息再开工。";
						const taskText = `写根（默认产出目录；${WORKSPACE_ROOT} 外会被拒）：${workdir}\n写根父目录（不是任务编号）：${nodePath.dirname(workdir)}\n` + body0;
						const childId = randomUUID();
						const member = { name: name2, parentSessionId: leadId, provider, model, effort, demand: demandArg === "" ? String(DEMAND_DEFAULT) : demandArg, effortWhy: effortArg === "" ? `spawn 缺省 d${demandRank(demandArg)}` : `spawn 指定 ${effortArg}`, routeSource: pickedWhy === "" ? "manual" : "plugin", caps: splitCsv(args.caps), currentTask: null, spawnedAt: Date.now(), lastResult: null, lastError: null, lastErrorClass: null, lastEvent: null, lastEventAt: null, lastStreamAt: null, toolErrStreak: 0, lastToolError: null, lastToolErrorAt: null, loopAt: null, workdir, sandboxMode: "pending", outOfWorkspace: outside, deniedCount: 0, deniedPaths: [] };
						// register BEFORE activation so the created-event listener finds it
						members.set(childId, member);
						let activation;
						try {
							activation = await ctx.subagents.startActivation({
								provider: "spawn",
								childId,
								label: `${name2} ${body0.slice(0, 40)}`,
								// 2026-11-15 修（DSH RC1→RC3）：RC3 读扁平字段，RC1 读 request.*，两份都传
								parent: caller,
								cwd: workdir,
								prompt: [{ type: "text", text: taskText }],
								agentOptions: { provider, model, reasoningEffort: effort },
								request: {
									parent: caller,
									cwd: workdir,
									prompt: [{ type: "text", text: taskText }],
									agentOptions: { provider, model, reasoningEffort: effort },
								},
								delivery: "parent",
								signal: exec.signal,
							});
						} catch (error) {
							members.delete(childId);
							throw new Error(`spawn failed: ${String(error)}`);
						}
						// Pin the member to workspace-write AFTER delegation recorded the parent's
						// mode, so the member's own cwd — not the Lead's mode — is the boundary.
						pinMemberMode(activation, childId, member);
						persistAll();
						// warn (never refuse) when another team already holds this exact model:
						// free quota is shared, but refusing would deadlock single-route setups.
						const takenBy = (routeOccupancy().get(provider + "/" + model) || []).filter((u) => u.lead !== leadId);
						return { spawned: name2, id: childId, route: `${provider}/${model}@${effort}`, effort, gearFrom: gearInfo.capped ? `d${demandRank(demandArg)} 被实测封顶压到 ${effort}` : gearInfo.short ? `d${demandRank(demandArg)} 该路由档位上只到 ${effort}` : (effortArg === "" ? `d${demandRank(demandArg)} 自动` : "显式指定"), ...(pickedWhy === "" ? { routeSetBy: "Lead 指定" } : { routeSetBy: "插件选型", pickedBecause: pickedWhy }), team: meta.slug, workdir, sandbox: member.sandboxMode, workspace: outside ? `写根在 ${WORKSPACE_ROOT} 外（已记录）` : `写根在 ${WORKSPACE_ROOT} 内`, ...(takenBy.length === 0 ? {} : { busyElsewhere: takenBy.map((u) => `${u.team}/${u.member}(${u.state})`).join("，") + " 已在用这个模型，同时跑可能撞限流；team(models) 看占用，或 filter 挑别的" }) };
					}
					case "status": {
						const leadId = resolveLead(caller);
						const all = String(args.scope || "mine") === "all";
						const rows = [];
						for (const [sessionId, member] of members) {
							if (!all && member.parentSessionId !== leadId) continue;
							const agent = ctx.agents.get(sessionId);
							const header = agent && agent.session.requestHeader ? agent.session.requestHeader() : undefined;
							const actual = header && header.config ? `${header.config.provider}/${header.config.model}@${header.config.reasoningEffort || "default"}` : "?";
							const liveStatus = agent ? String(agent.status) : "cold";
							const board = boards.get(member.parentSessionId);
							const cur = member.currentTask && board ? board.tasks.get(member.currentTask) : undefined;
							{
							const ago = typeof member.lastEventAt === "number" ? Math.round((Date.now() - member.lastEventAt) / 1000) : null;
							let evt = ago === null || !member.lastEvent ? "-" : member.lastEvent + "@" + ago + "s";
							// stream liveness only applies while awaiting model output; a member running a
							// tool has no stream and is not "stuck".
							const runningTool = member.lastEvent && /tool\/|tool\/result|tool\/call/.test(member.lastEvent);
							if (liveStatus === "running" && !runningTool && typeof member.lastStreamAt === "number") {
								const streamAgo = Math.round((Date.now() - member.lastStreamAt) / 1000);
								evt += streamAgo <= 5 ? " (流正常)" : " (流停" + streamAgo + "s)";
							}
							// #19: "running" alone hides a member stuck inside a tool loop.
							const stuck = stuckOf(member, liveStatus);
							if (stuck !== null) evt += " (" + stuck + ")";
							const tag = all ? (member.parentSessionId === leadId ? "本队" : member.parentSessionId.slice(-6)) + "|" : "";
							// write root + denial evidence: a member that hit the sandbox names the path.
							const root = member.workdir ? nodePath.basename(member.workdir) + (member.outOfWorkspace ? "(外)" : "") : "?";
							const denied = member.deniedCount ? " denied" + member.deniedCount + (member.deniedPaths && member.deniedPaths.length ? " " + String(member.deniedPaths[member.deniedPaths.length - 1]).slice(-40) : "") : "";
							rows.push(tag + `${member.name}|${liveStatus}|${evt}|want ${member.provider}/${member.model}@${member.effort}|actual ${actual}|${cur ? cur.tid : "-"}|${root}${denied}|${member.lastError || member.lastToolError || ""}`);
						}
						}
						const openByLead = {};
						for (const [lead, board] of boards) openByLead[lead] = Array.from(board.tasks.values()).filter((t) => t.status === "open").length;
						const teamRows = all ? crossTeams(leadId) : undefined;
						// 2026-10-31 某次实测（问题 2）：状态怎么变的、谁改的，status 里要能看全。
						// 只给最近 6 跳（够还原"被退回几次、谁退回的"），完整流水在 board.json 里。
						const statusBoard = boards.get(leadId);
						const trailRows = statusBoard === undefined ? [] : Array.from(statusBoard.tasks.values())
							.filter((t) => Array.isArray(t.trail) && t.trail.length > 0)
							.map((t) => `${t.tid}|${t.status}|` + t.trail.slice(-6).map((h) => `${(h.from === null ? "建单" : h.from)}→${h.to}@${h.by}${h.why === "" ? "" : "(" + h.why + ")"}`).join(" → "));
						return withNotices({ members: rows, open: openByLead, ...(teamRows ? { teams: teamRows } : {}), ...(trailRows.length === 0 ? {} : { trail: trailRows }), ledger: ledgerDigest(null, leadId), ...(memberPool.teamRows(leadId).length === 0 ? {} : { 成员池: memberPool.teamRows(leadId).map((r) => `${r.name}|${r.route}|退役${r.retiredMinAgo}分钟|会话${r.sessionId}`) }), ...(banList.rowsOf(leadId).length === 0 ? {} : { 禁用名单: banList.rowsOf(leadId).map((r) => `${r.name}|${r.route}|会话${String(r.sessionId).slice(0,8)}|${new Date(r.at).toLocaleTimeString("zh-CN")}|${r.reason}`) }) }, leadId);
					}
					case "history": {
						const member = findMember(args.to, resolveLead(caller));
						if (member === undefined) throw new Error(`unknown member ${args.to}`);
						const query = typeof ctx.get === "function" ? ctx.get("sessionQuery", false) : ctx.sessionQuery;
						if (query === undefined || query === false || typeof query.observeSession !== "function") throw new Error("sessionQuery 不在本 profile（读不了成员历史）");
						const lease = await query.observeSession(sessionIdOf(member), { projectionMode: "none" });
						let events = [];
						try { events = lease && Array.isArray(lease.events) ? lease.events : []; }
						finally {
							const dispose = lease && lease[Symbol.dispose];
							if (typeof dispose === "function") { try { dispose.call(lease); } catch { /* lease already gone */ } }
						}
						const needle = String(args.filter || "").trim();
						const rows = [];
						for (const event of events) {
							const text = eventText(event);
							if (text === "") continue;
							if (needle !== "" && !text.includes(needle)) continue;
							rows.push(`${event.seq}|${event.type}|${text.replace(/\s+/g, " ").slice(0, 200)}`);
						}
						return { member: member.name, events: events.length, shown: rows.slice(-8) };
					}
					case "task": {
						// 批量 tid："t3,t5,t7" / "t3-t7" / "t3~t7" / ">=n" / ">n"，也能写成数组；重复的只算一次。
						const expandTids = (v) => {
							const parts = Array.isArray(v) ? v.map(String) : String(v === undefined || v === null ? "" : v).split(/[,，、；;\s]+/).filter(Boolean);
							const out = [];
							const push = (t) => { const x = String(t).trim().replace(/^#/, ""); if (x !== "" && !out.includes(x)) out.push(x); };
							for (const p of parts) {
								const mm = /^(?:t|T)?([0-9]+)\s*(?:-|~|–|…|to)\s*(?:t|T)?([0-9]+)$/.exec(p.trim());
								if (mm !== null) {
									const a = Number(mm[1]); const b = Number(mm[2]);
									if (b - a > 200) throw new Error(`tids 区间 ${p} 一次跨了 ${b - a} 张，太多；分段来`);
									for (let i = Math.min(a, b); i <= Math.max(a, b); i += 1) push(`t${i}`);
									continue;
								}
								const ge = /^(>=|>|\u2265)\s*(?:t|T)?([0-9]+)$/.exec(p.trim());
								if (ge !== null) { const from = Number(ge[2]); for (let i = from; i < from + 200; i += 1) push(`t${i}`); continue; }
								push(p);
							}
							return out;
						};
						// 还没批量化的动作（finish/fail/reopen/accept/reject）：单个位置给单值，多个给数组。
						const tidOf = (multi, one) => (multi.length === 1 ? one : multi);
						const leadId = resolveLead(caller);
						const board = boardFor(leadId);
						const sub = String(args.action2 || "list");
						// 同上（隔壁问题 8）：队员在 task 里也只能交单/看板，不许建单改单验收。
						if (selfMember !== undefined && !["list", "finish", "fail"].includes(sub)) {
							throw new Error(`成员 ${selfMember.name} 不能用 task action2="${sub}"：队员只能 list/finish/fail。要建单/改单/删单/验收找队长：team(action:"msg", to:"${shortOf(selfMember.parentSessionId)}", text:"…")`);
						}
						// 建单参数却漏了 action2:"create"：静默按 list 会把 title/body 全丢掉，
						// 调用方以为建了单其实一张没有（隔壁 10-28 踩过）。只拦，不代建。
						if (sub === "list") {
							const givenCreate = ["title", "body", "brief_path", "artifacts", "no_artifact", "blocked_by", "prio", "caps", "demand", "kind", "size", "vision", "owner"].filter((k) => args[k] !== undefined && args[k] !== null && String(args[k]).trim() !== "");
							if (givenCreate.length > 0) throw new Error(`给了建单参数 ${givenCreate.join("/")}，但 action2 没写 "create" —— 本次不会建单。要建单请 action2:"create"`);
						}
						if (sub === "create") {
							// 批量建单：单建 = 一次 createOne，批量 = tasks 数组每项一次（顶层字段是共用默认）。
							const CREATE_FIELDS = ["title", "body", "brief_path", "artifacts", "no_artifact", "blocked_by", "prio", "kind", "size", "demand", "caps", "vision", "owner"];
							const CREATE_ALIAS = { ti: "title", bo: "body", bp: "brief_path", ar: "artifacts", bb: "blocked_by", si: "size", ki: "kind", de: "demand", pr: "prio", ow: "owner", ca: "caps", vi: "vision", na: "no_artifact" };
							// 参数名 args 遮蔽外层的 args：body 里的写法与改前完全一致。
							const createOne = (args, bc) => {
								const preOwner = String(args.owner || "").trim();
								// 2026-10-30 维护方抓到（隔壁 t8 owner="某次实测" 卡成 open 没人能干）：
								// owner 以前沿用参考实现就收，于是队长把自己**会话短号/会话 id** 填进去也当成员名，
								// 预指派指向一个不存在的人 → 成员按规矩不能抢（preassigned 只许 owner 领），
								// 自动补员也不补（它能领但 owner 不是它）→ 这单永久卡死。
								// 现在建单当场校验：owner 必须是本队名册里真实存在的成员名，否则直接拒，
								// 并把可选成员名回给调用方（省得它再猜一次）。
								if (preOwner !== "") {
									const names = Array.from(members.values()).filter((m) => m.parentSessionId === leadId).map((m) => m.name);
									const isSessionId = /^session-/.test(preOwner) || String(leadId).endsWith(preOwner) || preOwner.length >= 8 && [...members.keys()].some((k) => String(k).endsWith(preOwner));
									if (isSessionId) throw new Error(`owner="${preOwner}" 看着是**会话短号**，不是成员名 —— 预指派只认本队成员名。本队成员：${names.join(",") || "(还没有成员，插件会自动补)"}。想让插件自动派人就别填 owner。`);
									if (!names.includes(preOwner)) throw new Error(`owner="${preOwner}" 不在本队名册里（本队成员：${names.join(",") || "(还没有成员，插件会自动补)"}）。预指派只认已有成员名；要新路由请先 spawn，想自动派人就别填 owner。`);
								}
								// 2026-11-02 皮皮测试报告（瑕疵 2）：demand=5 以前被静默夹成 d3。改单
								// 早就拒了（set 里那句正则），建单/派人也统一成同一口径，写错就当场拒。
								const demandRaw = checkDemand(args.demand);
								const demand = demandRaw === "" ? String(DEMAND_DEFAULT) : demandRaw;
								const kind = String(args.kind || "grunt").trim().toLowerCase() || "grunt";
								// 2026-11-02 某次实测 压测：kind 拼错（比如 coder）以前被**静默接受**，
								// 派活时 KIND_HINT 查不到就落回 /.*/ —— 等于「按名字偏好选型」这层
								// 整个失效，还看不出来。和 size 同口径：非法直接拒。
								if (!TASK_KINDS.has(kind)) throw new Error(`kind 只能是 ${Array.from(TASK_KINDS).join("|")}（收到 ${kind}）。它决定选型时的名字偏好档，写错了不报错只会让派活悄悄变笨`);
								// 2026-10-29 维护方提问「需要读图的活派得出去吗」：以前完全没这个维度，
								// 派给不带视觉的模型 = 图片被静默丢掉或直接 400。现在它是建单参数。
								const vision = args.vision === true || String(args.vision || "").trim().toLowerCase() === "true" || String(args.vision || "").trim() === "1";
								const rawSize = String(args.size || "").trim().toLowerCase();
								if (rawSize !== "" && SIZE_CTX_K[rawSize] === undefined) throw new Error(`size 只能是 s/m/l（收到 ${rawSize}）。它表示这活的输入需要多大 ctx，不是产出量——产出只决定分几批写`);
								const size = sizeKey(rawSize);
								const needCtx = sizeCtxK(size);
								const poolMax = maxCtxK();
								if (poolMax > 0 && needCtx > poolMax) throw new Error(`size=${size} 要 ctx ≥${needCtx}K，但池子里已知最大只有 ${poolMax}K（无数据的路由不能承诺）—— 把这活的输入拆小，或降到 ${["s", "m", "l"].filter((k) => SIZE_CTX_K[k] <= poolMax).join("/")}`);
								if (vision) {
									const eyes = Array.from(ledger.values()).filter((e) => e.vision === true && dispatchable(e));
									if (eyes.length === 0) throw new Error("这单标了 vision:true（要读图），但台账里没有任何一条「已知支持视觉 + 可用」的路由。先 team(scan) 同步 OFM 目录的 vision 字段；还要盯 cline 那批，目录不报、目前只能靠名字推断。");
								}
								// 2026-11-02 皮皮测试报告（瑕疵 3）：建单时 blocked_by 沿用参考实现什么 tid 都收，
								// 指向不存在（或已删）的 tid → 这单永远等不到解锁，只能等人发现。
								// 口径与 set 一致：前置必须是**此刻板上真实存在**的 tid。批量建单时
								// {prev} 指前一张——它在上一轮已经建好了，所以照样通过。
								const blockedBy = splitCsv(args.blocked_by);
								for (const dep of blockedBy) {
									if (board.tasks.get(dep) === undefined) throw new Error(`blocked_by 里的 ${dep} 不在板上（先建它，或去掉这条依赖）`);
								}
								board.seq += 1;
								const tid = `t${board.seq}`;
								// 2026-10-31 某次实测（问题 4）：建单警告只提醒、没有"这单确实没有文件产物"
								// 的正式说法，于是每次 finish 都要再被警告一遍，读起来像出错。
								// 补一个显式免验声明 `no_artifact:true`：建单时就承认不落盘，finish 不再警告。
								const declaredNoArt = args.no_artifact === true || String(args.no_artifact || "").trim().toLowerCase() === "true";
								// 2026-10-31 实测：模型被"必须落盘的文件"这句话推着走，会填 `无`/`none`/`-`/`不需要`
								// 这类占位词。这些不是路径，留着只会让 finish 报"不存在"把单卡死。
								// 建单当场当空值处理（等价于"没有声明产物"，不核），并回一句提示。
								const ART_PLACEHOLDER = /^(无|没有|none|null|nil|-|—|（无）|\(无\)|不需要|不用|无产物|nothing|n\/a|na)$/i;
								const artifactsRaw = splitCsv(args.artifacts);
								const artifactsPlaceholder = artifactsRaw.filter((x) => ART_PLACEHOLDER.test(x));
								const artifactsList = artifactsRaw.filter((x) => !ART_PLACEHOLDER.test(x));
								board.tasks.set(tid, { tid, title: String(args.title || tid), body: String(args.body || ""), briefPath: String(args.brief_path || ""), prio: Number(args.prio || 0), demand, kind, size, vision, caps: splitCsv(args.caps), blockedBy, artifacts: artifactsList, noArtifact: declaredNoArt, status: "open", owner: preOwner === "" ? null : preOwner, preassigned: preOwner !== "", revision: 1, createdAt: Date.now(), claimedAt: null, finishedAt: null, lastReport: null, trail: [{ at: Date.now(), from: null, to: "open", by: `${shortOf(leadId)}(队长)`, why: "建单" }] });
								persistAll();
								// idle members missed their status-transition edge (they slept before
								// this task existed): sweep them now so the board never waits.
								sweepIdle(leadId);
								// 2026-11-01 维护方报「5 个并行任务就给 2 个人？」：建单后只补一个顶不住，
								// 一次拆 5 条独立单就得当场把 5 个人拉齐（补到够为止，不排队等冷却）。
								void autoFillToSatisfy(leadId).catch(() => { /* 补员失败不影响建任务 */ });
								// 2026-10-30 维护方纠错（隔壁 T7→T8→T9→T10 只有一个人从头干到尾）：
								// 拆单的价值**只在并行**。要是这一串单被 blocked_by 串成一条链，
								// 那它们永远只有一个能开工 —— 补再多人也是站着，等于队长自己干加上一堆等待。
								// 以前插件一声不吭，等队长跑完了才发现"我拆了四单却只有一个人"。
								// 现在建单当场算一遍：这单加上板上其它 open 单，**同一时刻最多能开几个工**。
								// 判据是「最大层宽」，所以**骨架串行、中间能并行**（A→(B‖C)→D）不会被误报 ——
								// 维护方 2026-10-30 明确：那种流水线是允许的，只有全程 1 个人的纯串行才不行。
								const parallel = countParallelism(board);
								// 2026-10-31 隔壁问题 11：probe/code 单没带 artifacts，只在 finish 时才警告 ——
								// 那时活已经干完、追不回了。建单当场说清楚（不硬拦：确有无产物的单）。
								const artifactsWarn = (kind === "probe" || kind === "code") && artifactsList.length === 0 && !declaredNoArt
									? `${kind} 单没声明 artifacts：将来 finish 只能凭它的回话，"空心交付"插件验不出来。想让它落盘就在建单时写 artifacts:"路径"（之后也能用 action2:"set" 补）；这单**确实没有文件产物**就建单时加 no_artifact:true，finish 就不会再警告`
									: "";
								if (artifactsWarn !== "") pushNotice(leadId, "建单没写产物", `${tid}《${String(args.title || tid)}》是 ${kind} 类但没声明 artifacts —— 验收时只能看回话。补写：task(action2:"set", tid:"${tid}", artifacts:"路径")；确实没有文件产物就认下来：set 时写 no_artifact:true（finish 不再警告）`);
								if (parallel.max <= 1 && parallel.open >= 2) {
									pushNotice(leadId, "这批全是串行，拆了等于没拆",
										`板上 ${parallel.open} 张 open 单，但每一层都只有 1 张（${parallel.chain}），`
										+ `同一时刻最多只能开 1 个工 —— 全程一个人从头干到尾，那样队长自己干更快。`
										+ `注意：骨架串行、中间有一段能并行（A→(B‖C)→D）是**允许**的，插件不会报它；`
										+ `这里报的是一直串到底。要改：把没必要的 blocked_by 去掉（只有真读同一份前置产物才该串），`
										+ `或者干脆并成一张单。`);
								}
								return { tid, title: String(args.title || tid), info: { created: tid, demand: `d${demandRank(demand)}`, kind, size: `${size}(ctx≥${needCtx}K)`, ...(vision ? { needs: "vision（读图）" } : {}), ...(parallel.max <= 1 && parallel.open >= 2 ? { parallel: `同时最多 ${parallel.max} 个工（串行链 ${parallel.chain}）` } : {}), ...(artifactsList.length > 0 ? { artifacts: `核对 ${artifactsList.length} 个，finish 查存在+mtime` } : {}), ...(artifactsPlaceholder.length > 0 ? { ignored: `忽略占位词 ${artifactsPlaceholder.join("、")}（不是路径，按"没有声明产物"处理）` } : {}), ...(artifactsWarn === "" ? {} : { warning: artifactsWarn }) } };
													};
							// item 覆盖顶层：同名优先，缩写等价；{i}=本项序号(1 起)、{prev}=上一张 tid。
							const subText = (v, i, prev) => (typeof v === "string" ? v.replace(/\{i\}/g, String(i)).replace(/\{prev\}/g, prev) : v);
							const overOf = (item, i, prev) => {
								const over = { ...args };
								delete over.tasks;
								for (const k of CREATE_FIELDS) {
									const raw = item[k] !== undefined && item[k] !== null && String(item[k]).trim() !== "" ? item[k] : args[k];
									if (raw === undefined || raw === null) continue;
									over[k] = subText(raw, i, prev);
								}
								for (const [abbr, full] of Object.entries(CREATE_ALIAS)) {
									const v = item[abbr];
									if (v === undefined || v === null || String(v).trim() === "") continue;
									over[full] = subText(v, i, prev);
								}
								const known = new Set([...CREATE_FIELDS, ...Object.keys(CREATE_ALIAS)]);
								const extra = Object.keys(item).filter((k) => !known.has(k));
								if (extra.length > 0) throw new Error(`tasks[${i}] 有认不出的字段 ${extra.join("/")}（可用：${[...CREATE_FIELDS, ...Object.keys(CREATE_ALIAS)].join(",")}）`);
								return over;
							};
							const items = Array.isArray(args.tasks) ? args.tasks.filter((x) => x !== null && typeof x === "object") : [];
							if (items.length === 0) return withNotices(createOne(args, { batch: false }).info, leadId);
							// 建单前先把每一项的字段名整体校验一遍：第 3 项写错字时，不能把前 2 项已经建到板上 ——
							// 半批单（前 2 张已建、后 1 张没建）最难收拾，队长还得自己一张张删。
							// L24 修①（2026-11-16 维护方演示轮实录）：同一趟预校验顺手把 blocked_by 也查了。
							// 以前它藏在 createOne 里逐张跑：6 张批量单第 4、5 张写了 blocked_by:"W1"
							// （标题不是 tid），前 3 张已落板、还触发了自动补员，才在第 4 张抛错——
							// 队长照编号补建造出同题双份（t6≡t9、t7≡t10、t8≡t11），两个成员各写一份产物。
							// 批内合法指向 = 板上既有 tid，或本批**更早**那张将产生的 tid（t{seqBase+i}）；
							// 依赖本批未来的单是死锁，同样当场拒。整批一张不建，错误里列全本批 tid。
							{
								const seqBase = board.seq;
								let prevSim = "";
								for (const [i, item] of items.entries()) {
									const over = overOf(item, i + 1, prevSim);
									for (const dep of splitCsv(over.blocked_by)) {
										if (board.tasks.get(dep) !== undefined) continue;
										const m = /^t(\d+)$/.exec(dep);
										const idx = m === null ? -1 : Number(m[1]) - seqBase - 1;
										if (idx >= 0 && idx < i) continue;
										throw new Error(`tasks[${i + 1}] 的 blocked_by "${dep}" 既不在板上、也不是本批更早的单（本批将产生 t${seqBase + 1}..t${seqBase + items.length}，批内前置用 {prev} 或写更早那张的 tid；标题不是 tid）—— 整批未建，改好再发`);
									}
									prevSim = `t${seqBase + i + 1}`;
								}
							}
							const made = [];
							let prevTid = "";
							for (let i = 0; i < items.length; i += 1) {
								const one = createOne(overOf(items[i], i + 1, prevTid), { batch: true, index: i + 1 });
								made.push(one);
								prevTid = one.tid;
							}
							// 串行/缺产物这两类提醒在批量里只汇总报一次（逐张报会刷屏）。
							const parallelB = countParallelism(board);
							if (parallelB.max <= 1 && parallelB.open >= 2) pushNotice(leadId, "这批全是串行，拆了等于没拆", `板上 ${parallelB.open} 张 open 单，但每一层都只有 1 张（${parallelB.chain}），同一时刻最多只能开 ${parallelB.max} 个工 —— 把没必要的 blocked_by 去掉，或并成一张单。`);
							const warnTids = made.filter((x) => x.info.warning !== undefined);
							if (warnTids.length > 0) pushNotice(leadId, "建单没写产物", `${warnTids.map((x) => x.tid).join(",")} 是 probe/code 类但没声明 artifacts —— 验收只能看回话。要落盘就 set 补 artifacts，确实没有文件产物就 set 写 no_artifact:true`);
							return withNotices({
								created: made.map((x) => x.tid),
								createdCount: made.length,
								titles: made.map((x) => `${x.tid}=${String(x.title || "").slice(0, 40)}`),
								...(warnTids.length > 0 ? { warning: `${warnTids.length} 张没声明 artifacts：${warnTids.map((x) => x.tid).join(",")}` } : {}),
								...(parallelB.max <= 1 && parallelB.open >= 2 ? { parallel: `同时最多 ${parallelB.max} 个工（串行链 ${parallelB.chain}）` } : {}),
								...(made.some((x) => x.info.artifacts !== undefined) ? { artifacts: `${made.filter((x) => x.info.artifacts !== undefined).length} 张声明了产物，finish 逐张核对存在+mtime` } : {}),
							}, leadId);
						}
						if (sub === "finish" || sub === "fail") {
							const task = board.tasks.get(String(args.tid || ""));
							if (!task) throw new Error(`unknown tid ${args.tid}（tid 形如 t1/t2；队目录名/文件名不是 tid）`);
							// 2026-10-31 某次实测 实测（问题 1，最伤）：队长对一张 open 且**没人认领**
							// 的单直接 finish，插件照样返回 delivered —— 等于"已交付"这两个字可以是假的：
							// 没有成员干过活、没有产物、没有任何人声称完成，板上却写着待验收。
							// 规矩：结单是"干这活的人说干完了"，所以只能由**当班的那个人**发起；
							// 队长要越过人去结单，必须显式 force:true，并在板上留"队长强制结单"的痕。
							const holdsIt = task.status === "claimed" && task.owner === (selfMember === undefined ? task.owner : selfMember.name)
								&& (selfMember === undefined || selfMember.currentTask === task.tid);
							if (selfMember !== undefined) {
								if (!holdsIt) throw new Error(`${task.tid} 现在 ${task.status}${task.owner ? "（" + task.owner + " 持有）" : "（没人认领）"}，不是你手上的活，不能结 —— 队员只能结自己 claimed 的单。别人的单让持有者交，或报队长`);
							} else if (sub === "finish" && !holdsIt && args.force !== true) {
								throw new Error(`${task.tid} 现在 ${task.status}${task.owner ? "，由 " + task.owner + " 持有" : "，还没人认领"} —— 没人干过这单，没有"交付"可验。队长确实要跳过人去结它，给 force:true（板上会记成"队长强制结单"）；正常流程等成员交单或先 claim`);
							}
							// 产物硬门槛：声明了 artifacts 就核对存在 + mtime。成员不能 force，
							// 只有 Lead（非成员调用方）能强制结单。
							if (sub === "finish") {
								const holder = holderOf(task)
									|| Array.from(members.values()).find((m) => m.name === task.owner);
								const bad = verifyArtifacts(task, holder);
								// 2026-10-31 修（隔壁问题 8 的另一半）：这里原来写 `!members.has(String(caller))`，
								// members 是按**子会话 UUID**索引的，String(agent) 永远不命中 → 成员永远被当成
								// 队长，能 force 结单。判据换成 selfMember（同一个断言在 accept/reject、claim 都用它）。
								const leadMayForce = selfMember === undefined;
								if (bad.length > 0 && !(leadMayForce && args.force === true)) {
									// 拒收必须留痕：成员被拒后可能自己补写产物再结单（实测发生过），
									// 若只在成员侧抛异常，Lead 全程零感知、事后只能翻 history。
									const why = bad.map((b) => `${b.path}（${b.why}）`).join("；");
									task.rejections = (task.rejections || []).concat([{
										at: Date.now(),
										by: holder === undefined ? "?" : holder.name,
										why: why.slice(0, 200),
									}]);
									while (task.rejections.length > 10) task.rejections.shift();
									task.lastReport = `finish 被拒收：${why.slice(0, 150)}`;
									persistAll();
									const to = holder === undefined ? undefined : holder.parentSessionId;
									if (to !== undefined) {
										pushNotice(to, "finish 拒收", `${holder.name} 的 ${task.tid} 产物核对没过（${bad.map((b) => b.path).join("、")}）；任务仍 claimed，它若补写产物再结单要复核 mtime。已记入 ${task.tid}.rejections`);
									}
									throw new Error(`产物核对没过，finish 被拒：${why}。把文件真写进写根再来；确认真没有文件产物，让 Lead 用 force:true 结单`);
								}
							}
							// 记账必须在这里做：成员自己调 finish 时 currentTask 立刻被清掉，
							// subagent/end 拿到的 endedTask 已经是 null，那边记不到（实测踩过）。
							// **验收门开启时，finish 不算正分**（放弃一个空心交付也能 finish；
							// 真正的"干成了"由 accept 记、被 reject 记负分）。只有 fail 照记负分。
							// acceptGate 关掉时保持老行为：finish 即正分。
							if (task.status === "claimed") {
								// 同一个陈旧指针问题：只按 currentTask 找，会把撞号旧单的战绩记到别人头上。
								const who = holderOf(task);
								if (who !== undefined) {
									const ok = cfg.acceptGate === true ? (sub === "fail" ? false : null) : sub === "finish";
									if (ok !== null) bumpScore(`${who.provider}/${who.model}`, who.effort, task.kind, ok);
								}
							}
							// 验收门（2026-10-31）：finish 不再直接 done，先转 delivered 等队长验收。
							// 跳过验收的唯一情形是 `cfg.acceptGate === false`（老行为）。
							// 状态流水：谁来交的、交成什么状态，一笔记下（「t2 从 claimed 变 delivered，
							// 无日志」正是某次实测 的问题 2 —— 现在 list/status 都能看见这一跳）。
							const finTo = sub === "fail" ? "failed" : (cfg.acceptGate === false ? "done" : "delivered");
							noteStatus(task, finTo, selfMember === undefined ? `${shortOf(leadId)}(队长)` : selfMember.name,
								sub === "fail" ? (String(args.text || "").trim() === "" ? "fail（未给原因）" : "fail：" + String(args.text).trim().slice(0, 80)) : (cfg.acceptGate === false ? "finish（验收门关着，直接 done）" : "finish 交付，等队长验收"));
							task.status = finTo;
							// 队长强制结单要留痕：否则事后翻板子，跟"成员交的"一模一样（隔壁问题 1 的教训）。
							if (selfMember === undefined && args.force === true && !holdsIt) {
								task.lastReport = `队长强制结单（无人在干${task.owner === null ? "" : "，" + task.owner + " 持有"}）${String(args.text || "").trim() === "" ? "" : "：" + String(args.text).trim().slice(0, 120)}`;
								task.forcedByLeadAt = Date.now();
							}
							if (sub === "fail") {
								// 独立 error 字段：以前失败原因只活在最后一句中转语里，状态机与
								// 复核都读不到可判定的字段。2026-10-31 隔壁问题 10：不给原因也照收，
								// 板上只剩"（fail 未给原因）"，事后没人知道为什么失败 —— 收，但要提。
								task.error = String(args.text || "").trim().slice(0, 300) || "（fail 未给原因）";
							}
							task.revision += 1; task.finishedAt = Date.now();
							// clear by tid, not by owner: a stale currentTask pointing at this tid
							// (from a wiped board that reused the number) would otherwise stick forever
							for (const m of members.values()) {
								if (m.currentTask !== task.tid) continue;
								m.currentTask = null;
								// 交单这一刻持有者的路由 = 「这单的产出是谁做的」最准的凭据。
								// score(tid) 反查路由就吃这条（2026-11-02 某次实测 建议 5）；
								// 之后就算这人被 retool，档案里仍是干活时那条。
								task.routeAtFinish = `${m.provider}/${m.model}`;
								// 留一条"上单已结"的凭据：成员复活后会拿历史里的旧任务接着干，
								// 下次派单与每步系统上下文都靠这条把它挡回去（见 memberTaskContext）。
								m.lastTask = { tid: task.tid, title: task.title, status: task.status };
							}
							persistAll();
							// 只有「真结案」才解锁下游；delivered 是在等队长验收，sweep 不能放行。
							if (sub === "finish" && task.status === "done") sweepIdle(leadId); // dependents just opened up
							if (sub === "finish" && task.status === "delivered") {
								// 交付 ≠ 结案：队长必须验一眼。这条通知就是"验收门"的入口。
								const who = task.owner === null ? "成员" : task.owner;
								const art = Array.isArray(task.artifacts) && task.artifacts.length > 0 ? `产物：${task.artifacts.join("、")}` : "（未声明 artifacts，只能看它的回话）";
								const msg = `${task.tid}《${task.title}》已交付，等你验收：${art}。通过 → task(action2:"accept", tid:"${task.tid}")；打回 → action2:"reject"（下游 blocked_by 在验收通过前不会解锁）`;
								pushNotice(leadId, "待验收", msg);
								// 2026-11-01 维护方提问「50 跑完了没让你验收？」—— 实测：t50 19:44:48 交付，
								// 通知躺进队列，**整整 10 分钟没人看见**，整条串行链静默卡死。
								// 根因：pushNotice 只是"等队长下次调 team 时带出来"，队长不调就永远读不到。
								// 验收门是**必须有人动手**的状态（不 accept 下游就永远锁着），
								// 和普通通知不一样 —— 它得主动叫醒队长，否则就是静默死锁。
								// 只在这一单**真的挡住了下游**时叫醒（没下游的单不打扰），避免每次交付都弹。
								const blocks = Array.from(board.tasks.values())
									.filter((t2) => t2.status === "open" && Array.isArray(t2.blockedBy) && t2.blockedBy.includes(task.tid))
									.map((t2) => t2.tid);
								if (blocks.length > 0) {
									const wakeText = `【待验收】${task.tid}《${task.title}》已交付，它挡着下游 ${blocks.join("、")}，不验收那些单就一直开不了工。\n${art}\n通过 → task(action2:"accept", tid:${task.tid})；打回 → action2:"reject"`;
									void wakeSession(leadId, leadId, wakeText, "continue").catch(() => { /* 唤醒失败不影响交付 */ });
								}
							}
							// R4: code/probe 类不声明 artifacts 就结单 —— 不硬拦（有些活儿确实没有文件
							// 产物），但必须留声：虚报三连（t4/t9/t12）全是"无声明单"，无声放行等于没测。
							// 2026-10-31 某次实测（问题 4）：建单时已经用 no_artifact:true 认下来的单，
							// 这里不再警告 —— 否则"已声明免验"和"忘了写 artifacts"收到同一句话，
							// 每次交付都像出错。只在 lastReport 留一行痕，验收时看得到。
							const noArt = !Array.isArray(task.artifacts) || task.artifacts.length === 0;
							const needsArt = task.kind === "code" || task.kind === "probe";
							const waived = task.noArtifact === true;
							if (sub === "finish" && needsArt && noArt && waived) {
								task.lastReport = `[无文件产物，建单时已声明 no_artifact] ${task.lastReport === null || task.lastReport === "" ? "交付未附产物" : String(task.lastReport).slice(0, 120)}`;
								return withNotices({ [task.tid]: task.status, artifacts: "本单建单时已声明 no_artifact:true，不核产物" }, leadId);
							}
							if (sub === "finish" && needsArt && noArt) {
								const warn = `${task.tid} 是 ${task.kind} 类但没有声明 artifacts —— 已交付待验收，但产物无法核对。两种办法：task(action2:"set", tid:"${task.tid}", artifacts:"路径") 补上（还没验收前都能补）；这单确实没有文件产物就 set no_artifact:true 认下来，下次交付不再警告`;
								pushNotice(leadId, "产物无声明", warn);
								return withNotices({ [task.tid]: task.status, warning: warn }, leadId);
							}
							return withNotices({ [task.tid]: task.status }, leadId);
						}
						// 队长验收 / 打回（2026-10-31 验收门）。accept: delivered→done 并解锁下游；
						// reject: 打回 open（或 failed），下游继续挡着；两种都记进打分表。
						if (sub === "accept" || sub === "reject") {
							const task = board.tasks.get(String(args.tid || ""));
							if (!task) throw new Error(`unknown tid ${args.tid}`);
							// 验收是队长的活，成员不许自己给自己盖章
							if (selfMember !== undefined) throw new Error("accept/reject 只能队长做 —— 成员不能验收自己的交付");
							if (task.status !== "delivered") throw new Error(`${task.tid} 当前是 ${task.status}，只有 delivered（已交付待验收）能验收；先看 status 里的"待验收"`);
							const who = Array.from(members.values()).find((m) => m.name === task.owner);
							if (sub === "accept") {
								noteStatus(task, "done", `${shortOf(leadId)}(队长)`, "验收通过");
								task.status = "done";
								task.acceptedAt = Date.now();
								task.acceptedBy = shortOf(leadId);
								// 打分表：验收通过才是真正的"这活干成了"。以前按 finish 记账，
								// 空心交付也能拿分 —— 验收门落地后这两件事才分开。
								if (who !== undefined) bumpScore(`${who.provider}/${who.model}`, who.effort, task.kind, true);
								task.revision += 1;
								persistAll();
								sweepIdle(leadId); // 验收通过，下游这才真解锁
								const blocks = Array.from(board.tasks.values()).filter((t) => (t.blockedBy || []).includes(task.tid) && t.status === "open").map((t) => t.tid);
								return withNotices({ [task.tid]: "done（已验收）", ...(blocks.length > 0 ? { 已解锁下游: blocks } : {}) }, leadId);
							}
							// reject：默认打回 open 让原成员重干；给 force 则判 failed 不再纠缠
							const rejTo = args.force === true ? "failed" : "open";
							noteStatus(task, rejTo, `${shortOf(leadId)}(队长)`, `打回：${String(args.text || "").trim().slice(0, 80) || "（未给打回原因）"}`);
							task.status = rejTo;
							task.rejectReason = String(args.text || "").trim().slice(0, 300) || "（未给打回原因）";
							task.rejections = (task.rejections || []).concat([{ at: Date.now(), by: "lead", why: task.rejectReason }]);
							while (task.rejections.length > 10) task.rejections.shift();
							// 2026-11-02 设计确定：（第 140 条）：打回时队长若判的是**这个成员乱了**（ban_member:true），
							// 就禁用他的会话并把这单钉在原路由上、新起干净会话做对照 —— 这时还不能记模型分，
							// 变量没排干净；同路由第 2 次判乱才由 banAndReplace 记模型差评。
							if (who !== undefined && (args.ban_member === true || String(args.ban_member) === "true")) { banAndReplace(who, { task, reason: "打回判乱：" + task.rejectReason }); task.status = "open"; }
							else if (who !== undefined) bumpScore(`${who.provider}/${who.model}`, who.effort, task.kind, false);
							task.owner = task.status === "open" && task.preassigned !== true ? null : task.owner;
							task.claimedAt = null;
							task.revision += 1;
							persistAll();
							sweepIdle(leadId);
							return withNotices({ [task.tid]: `${task.status}（已打回：${task.rejectReason}）` }, leadId);
						}
						// Modify an existing task in place. Rebuilding instead used to change the tid,
						// which silently broke every blocked_by pointing at it.
						if (sub === "set") {
							// 改一张 = 原来的行为；改一批 = tids（"t3,t5" / "t3-t7"），**同一组参数**一起改。
							// 单张的改字段逻辑一个字没动，只是被包进 for/try：批量时某张改不了（比如 owner 只能在 open 改）
							// 不会连累其它张，它进 skipped；全都改不了才抛错，一张都不改。
							const setWant = expandTids(args.tids !== undefined && args.tids !== null && String(args.tids).trim() !== "" ? args.tids : args.tid);
							if (setWant.length === 0) throw new Error(`set 要 tid（一张）或 tids（一批）："t3" / "t3,t5,t7" / "t3-t7"`);
							const appliedAll = [];
							const setSkipped = [];
							for (const each of setWant) {
								const task = board.tasks.get(each);
								if (task === undefined) { setSkipped.push(each + " 不在板上"); continue; }
								const applied = [];
								try {
									const has = (k) => args[k] !== undefined && args[k] !== null && String(args[k]).trim() !== "";
									if (has("title")) { task.title = String(args.title); applied.push("title"); }
									if (has("body")) { task.body = String(args.body); applied.push("body"); }
									if (has("brief_path")) { task.briefPath = String(args.brief_path); applied.push("brief_path"); }
									if (has("artifacts")) {
										// 与建单同一套占位词规则：set 时写 `无`/`none` 不是为了核对，是为了解除声明。
										const ART_PH = /^(无|没有|none|null|nil|-|—|（无）|\(无\)|不需要|不用|无产物|nothing|n\/a|na)$/i;
										const raw = splitCsv(args.artifacts);
										task.artifacts = raw.filter((x) => !ART_PH.test(x));
										const ph = raw.filter((x) => ART_PH.test(x));
										applied.push(`artifacts=${task.artifacts.length}${ph.length > 0 ? `（忽略占位词 ${ph.join("、")}）` : ""}`);
									}
									// 2026-10-31 某次实测（问题 4）：把"这单确实没有文件产物"变成板上的一等字段。
									// 只认 true；给 false / 别的值就是解除免验（重新按需要产物处理）。
									if (args.no_artifact !== undefined && args.no_artifact !== null && String(args.no_artifact).trim() !== "") {
										const v = args.no_artifact === true || String(args.no_artifact).trim().toLowerCase() === "true";
										task.noArtifact = v;
										applied.push(v ? "no_artifact=true（交付不再警告产物）" : "no_artifact=false（恢复按产物核对）");
									}
									if (has("prio")) { task.prio = Number(args.prio || 0); applied.push(`prio=${task.prio}`); }
									if (has("caps")) { task.caps = splitCsv(args.caps); applied.push(`caps=${task.caps.length}`); }
									if (has("kind")) {
										const rk = String(args.kind).trim().toLowerCase();
										if (!TASK_KINDS.has(rk)) throw new Error(`kind 只能是 ${Array.from(TASK_KINDS).join("|")}（收到 ${rk}）`);
										task.kind = rk || "grunt"; applied.push(`kind=${task.kind}`);
									}
									if (has("size")) {
										const rs = String(args.size).trim().toLowerCase();
										if (SIZE_CTX_K[rs] === undefined) throw new Error(`size 只能是 s/m/l（收到 ${rs}）`);
										task.size = rs; applied.push(`size=${rs}(ctx≥${sizeCtxK(rs)}K)`);
										// 队长亲手改了 size = 他在重新定义这单的输入范围，实测抬起来的门槛归零；
										// 否则「我把 size 降了，它怎么还派不出去」会变成一个查不出来的死结。
										if (Number(task.ctxMin || 0) > 0) {
											applied.push(`实测门槛 ${task.ctxMin}K 已清零（按新 size 重算）`);
											delete task.ctxMin;
											delete task.ctxTierN;
											delete task.ctxTried;
											delete task.compactN;
											delete task.compactBy;
										}
									}
									if (has("demand")) {
										const raw = checkDemand(args.demand);
										task.demand = raw;
										applied.push(`demand=d${demandRank(raw)}`);
										// already running: the new demand re-prices the gear for its NEXT request
										const m = holderOf(task, leadId);
										if (m !== undefined) { const g = applyDemand(m, task); applied.push(`gear=${g.gear}`); }
									}
									if (has("owner") || args.blocked_by !== undefined && args.blocked_by !== null) {
										if (task.status !== "open") throw new Error(`${task.tid} 是 ${task.status}，只有 open 能改 owner/blocked_by（先 fail 或 reopen）`);
										if (has("owner")) {
											const o = String(args.owner).trim();
											if (o === "-" || o.toLowerCase() === "none") { task.owner = null; task.preassigned = false; applied.push("owner=任何空闲成员可抢"); }
											else {
												if (findMember(o, leadId) === undefined) throw new Error(`没有成员 ${o}`);
												task.owner = o; task.preassigned = true; applied.push(`owner=${o}`);
											}
										}
										// 2026-11-02 某次实测 压测：工具描述一直承诺「set 能改 blocked_by，
										// ""=清依赖」，实现里却根本没消费这个字段 —— 单独 set blocked_by
										// 会掉进「没改成任何东西」的报错，等于只能创建时设。补上，口径与建单一致：
										// 依赖必须是板上真实存在的 tid、不许自依赖、不许成环（A←B←A）。
										if (args.blocked_by !== undefined && args.blocked_by !== null) {
											const raw = String(args.blocked_by).trim();
											if (raw === "" || raw === "-") {
												task.blockedBy = []; applied.push("blocked_by=清空（不再等前置）");
											} else {
												const deps = splitCsv(args.blocked_by);
												for (const d of deps) {
													if (d === task.tid) throw new Error(`${task.tid} 不能依赖自己`);
													if (board.tasks.get(d) === undefined) throw new Error(`前置 ${d} 不在板上（先建它，或去掉这条依赖）`);
													// 环检：d 的传递依赖里已经有 task.tid 的话，加上就成环，永久互锁
													const seen = new Set([d]);
													const stack = [board.tasks.get(d)];
													while (stack.length > 0) {
														const cur = stack.pop();
														for (const nd of cur.blockedBy || []) {
															if (nd === task.tid) throw new Error(`成环：${task.tid} ← ${d} … ← ${task.tid}，依赖链会永久互锁`);
															if (seen.has(nd)) continue;
															seen.add(nd);
															const nx = board.tasks.get(nd);
															if (nx !== undefined) stack.push(nx);
														}
													}
												}
												task.blockedBy = deps; applied.push(`blocked_by=${deps.join(",")}`);
											}
										}
									}
									// 2026-10-31 某次实测 实测（问题 3）：set 一个字都不改也会回
									// "reopened (rev N)" —— 空 set 有隐式重开副作用。规矩：没改任何字段就是没改。
									if (applied.length === 0) {
										throw new Error(`${task.tid} 没改成任何东西 —— set 至少要给一个字段（title/body/brief_path/artifacts/no_artifact/prio/caps/kind/size/demand/owner/blocked_by）。它当前：${task.tid}|${task.status}|${task.owner || "-"}|${task.kind}/${task.size}｜要重开用 action2:"reopen"`);
									}
									task.revision += 1;
									appliedAll.push({ tid: task.tid, summary: `已改 ${applied.join("、")}（${task.status}, rev ${task.revision}${task.owner === null ? "，无预指派" : "，预指派 " + task.owner}）` });
								} catch (error) {
									if (setWant.length === 1) throw error;
									setSkipped.push(each + "：" + String(error && error.message ? error.message : error));
								}
							}
							persistAll();
							sweepIdle(leadId);
							if (appliedAll.length === 0) throw new Error(`这批一张都没改成：${setSkipped.join("；")}`);
							if (appliedAll.length === 1) return withNotices({ [appliedAll[0].tid]: appliedAll[0].summary }, leadId);
							return withNotices({
								changed: appliedAll.map((x) => x.tid),
								changedCount: appliedAll.length,
								...(appliedAll[0] === undefined ? {} : { sample: appliedAll[0].summary }),
								...(setSkipped.length > 0 ? { skipped: setSkipped } : {}),
							}, leadId);
						}
						// 2026-10-31 某次实测 实测（问题 2）：action2 写 "reopen" 直接落到函数末尾的
						// list 分支 —— 返回值是整张任务列表，失败单/已交单的状态一个都没动，看起来"reopen 无效"。
						// 现在它是真动作：把 failed/delivered/done 的单退回 open 重干，并清掉残留状态。
						if (sub === "reopen") {
							const task = board.tasks.get(String(args.tid || ""));
							if (!task) throw new Error(`unknown tid ${args.tid}（tid 形如 t1/t2；队目录名/文件名不是 tid）`);
							if (task.status === "claimed") throw new Error(`${task.tid} 正被 ${task.owner || "?"} 干着（claimed）—— 要中断它先 fail，或让它自己 finish`);
							if (task.status === "open") throw new Error(`${task.tid} 已经是 open（没人干、也没交），不用 reopen；要改内容用 action2:"set"`);
							const from = task.status;
							const heldBy = holderOf(task, leadId);
							noteStatus(task, "open", `${shortOf(leadId)}(队长)`, `reopen（原 ${from}）${String(args.text || "").trim() === "" ? "" : "：" + String(args.text).trim().slice(0, 60)}`);
							if (heldBy !== undefined) heldBy.currentTask = null;
							task.status = "open";
							task.owner = task.preassigned === true ? task.owner : null;
							task.claimedAt = null;
							task.finishedAt = null;
							task.revision += 1;
							// reopen 是队长亲手把单重新拿回来干：实测抬起来的门槛/试过的路由一并清掉，
							// 不然「重开了还是派不出去」完全是插件自己在挡自己。压缩计数也归零。
							delete task.ctxMin;
							delete task.ctxTierN;
							delete task.ctxTried;
							delete task.compactN;
							delete task.compactBy;
							delete task.compactAt;
							if (task.error !== undefined) delete task.error;
							task.lastReport = `队长 reopen（原 ${from}，rev ${task.revision}）${String(args.text || "").trim() === "" ? "" : "：" + String(args.text).trim().slice(0, 160)}`;
							persistAll();
							sweepIdle(leadId);
							return withNotices({ [task.tid]: `open（已重开，原 ${from}，rev ${task.revision}）${task.owner === null ? "，任何空闲成员可领" : "，仍预指派 " + task.owner}` }, leadId);
						}
						// 删单：验完的探针单、建错/建重的单直接抹掉，不从 open 里再走一遍。
						// 板子是持久化的，删了不可撤销（要留底先 save）；被成员持有的单要 force:true。
						if (sub === "remove" || sub === "delete") {
							// 删单：验完的探针单、建错/建重的单直接抹掉，不从 open 里再走一遍。
							// 板子是持久化的，删了不可撤销（要留底先 save）；被成员持有的单要 force:true。
							// 批量：tids（"t3,t5,t7" / "t3-t7"）；带 tids 时 = 想砍的那批（不在板上的直接忽略），
							// 有一张被持有又没给 force → 整批不动并点名（不会砍一半留一半）。
							const rmWant = expandTids(args.tids !== undefined && args.tids !== null && String(args.tids).trim() !== "" ? args.tids : args.tid);
							if (rmWant.length === 0) throw new Error(`remove 要 tid（一张）或 tids（一批）："t3" / "t3,t5,t7" / "t3-t7"`);
							const rmForce = args.force === true || String(args.force) === "true";
							const rmHit = rmWant.filter((t) => board.tasks.has(t));
							const rmMiss = rmWant.filter((t) => !board.tasks.has(t));
							if (rmHit.length === 0) {
								if (rmWant.length === 1) throw new Error(`unknown tid ${rmWant[0]}（tid 形如 t1/t2；队目录名/文件名不是 tid）`);
								throw new Error(`tids 里 ${rmWant.join(",")} 一张都不在板上（当前：${Array.from(board.tasks.keys()).join(",") || "板上没有单"}）`);
							}
							// 先把会被挡住的挑出来：整批连坐，不砍一半。
							const rmHeld = rmHit.map((t) => board.tasks.get(t)).filter((t) => t.status === "claimed" && !rmForce);
							if (rmHeld.length > 0) throw new Error(`${rmHeld.map((t) => `${t.tid}（${t.owner}）`).join("、")} 正被成员干着（claimed）—— 确认真要连活一起砍，给 force:true`);
							const rmDone = [];
							const rmNoticed = [];
							const rmUnblocked = [];
							for (const each of rmHit) {
								const task = board.tasks.get(each);
								if (task === undefined) continue;
								// 2026-10-31 隔壁终报的唯一遗留：这里原来只按 currentTask 找持有者，而 tid 会被复用
								// （删单/建单/重建板都重编号），auto1 手里留着换血前同号单的陈旧指针 →
								// force 删掉的是已回收的 auto2 的单，返回值却通知了 auto1。改用 holderOf
								// （owner 和 currentTask 必须都对得上）；找不到活着的人就不编一个人出来。
								const held = holderOf(task, leadId);
								board.tasks.delete(task.tid);
								// 2026-10-31：删单 = 这单彻底不要了。原实现留着 open 的时候，删掉的单会被
								// sweepIdle/补员当成可领活又派出去（实测：kill 完插件转头又派）。删就是删，不留尾巴。
								// 别人 blocked_by 里挂着已删的 tid 会留下永远等不到的依赖（list 里也难看）
								for (const t of board.tasks.values()) {
									if (Array.isArray(t.blockedBy) && t.blockedBy.includes(task.tid)) {
										t.blockedBy = t.blockedBy.filter((dd) => dd !== task.tid);
										t.revision += 1;
										if (!rmUnblocked.includes(t.tid)) rmUnblocked.push(t.tid);
									}
								}
								if (held !== undefined) {
									held.currentTask = null;
									try {
										await ctx.subagents.sendMessage(caller, sessionIdOf(held), [{ type: "text", text: `${task.tid} 已被 Lead 删除，别交了；等下一单。` }], { signal: exec.signal });
									} catch { /* 成员已停 */ }
								}
								// 通知对象如实写：有人被通知才写 notified；持有者已不在册（回收/收队）
								// 就写 ownerGone，别让队长以为活人收到了消息。
								rmNoticed.push(held === undefined
									? (task.owner === null || task.owner === undefined ? {} : { ownerGone: `${task.owner} 已不在名册，没人可通知（单已删）` })
									: { notified: held.name });
								rmDone.push(`${task.tid}|${task.status}|${task.title}`.slice(0, 120));
							}
							persistAll();
							if (rmUnblocked.length > 0) pushNotice(leadId, "删单解依赖", `${rmHit.join(",")} 已删，同时从 ${rmUnblocked.join(",")} 的 blocked_by 里摘掉`);
							// 2026-11-02 皮皮测试报告（瑕疵 1）：">=t26" 这类批量会把 100+ 条
							// 「不在板上」逐条列出，真正该看的 removed 被噪音淹掉 → 折成区间。
							const rmBase = { left: board.tasks.size, ...(rmMiss.length > 0 ? { skipped: summarizeMissingTids(rmMiss).map((t) => `${t} 不在板上`) } : {}), ...(rmUnblocked.length === 0 ? {} : { unblocked: rmUnblocked }) };
							if (rmDone.length === 1) {
								return withNotices({
									removed: rmDone[0],
									...rmBase,
									...rmNoticed[0],
									ownerNote: "通知对象如实：notified=活人收到；ownerGone=持有者已不在名册，没人可通知",
									note: "板子是持久化的，删了不可撤回；要留底先 team(action:\"save\") 或 save compact",
								}, leadId);
							}
							return withNotices({
								removed: rmDone,
								removedCount: rmDone.length,
								...rmBase,
								...(rmNoticed.filter((n) => n.notified !== undefined).length === 0 ? {} : { notified: rmNoticed.filter((n) => n.notified !== undefined).map((n) => n.notified).join(",") }),
								...(rmNoticed.filter((n) => n.ownerGone !== undefined).length === 0 ? {} : { ownerGone: rmNoticed.filter((n) => n.ownerGone !== undefined).map((n) => n.ownerGone) }),
								note: "板子是持久化的，删了不可撤回；要留底先 team(action:\"save\") 或 save compact",
							}, leadId);
						}
						// 一单一行。失败的把 error 带上，被拒收过的把次数带上 —— 测试靶实测：
						// 只看这行永远不知道拒收/归因，得再调 status 才看得见。
						return withNotices({
							tasks: Array.from(board.tasks.values()).map((t) => {
								const rej = (t.rejections || []).length;
								const tail = `${t.status === "failed" && t.error !== undefined ? `|错误:${String(t.error).slice(0, 120)}` : ""}${rej > 0 ? `|拒收${rej}次` : ""}${Array.isArray(t.artifacts) && t.artifacts.length > 0 ? `|产物${t.artifacts.length}` : ""}`;
								// 2026-10-31 某次实测（问题 2）：光给当前状态，看不出"谁把它从 claimed
								// 改成 delivered、什么时候改的"。行尾补最近一跳，中间被退回几次也能看出来。
								return `${t.tid}|${t.status}|${t.owner || "-"}|p${t.prio}|d${demandRank(t.demand)}|${t.kind || "grunt"}/${t.size || "m"}${t.blockedBy && t.blockedBy.length > 0 ? "|←" + t.blockedBy.join(",") : ""}|${t.title}${tail}${trailLine(t)}`;
							}),
						}, leadId);
					}
					case "claim": {
						const leadId = resolveLead(caller);
						const board = boardFor(leadId);
						const task = board.tasks.get(String(args.tid || ""));
						if (!task) throw new Error(`unknown tid ${args.tid}`);
						if (task.status !== "open") throw new Error(`${task.tid} is ${task.status} (rev ${task.revision})`);
						// A failed prerequisite is a settled dependency, not a pending one:
						// otherwise one failure freezes every downstream task forever (no set/reopen
						// could ever unlock it). Only open/claimed keep a dependent waiting.
						const releasedDeps = [];
						{
							const pendingDeps = [];
							for (const dep of task.blockedBy || []) {
								const d = board.tasks.get(dep);
								if (d === undefined) continue;
								if (d.status === "open" || d.status === "claimed") pendingDeps.push(dep);
								else if (d.status === "failed") releasedDeps.push(dep);
							}
							if (pendingDeps.length > 0) throw new Error(`${task.tid} blocked by ${pendingDeps.join(",")} (前置未完成)`);
						}
						// self-claim when the caller is a member; explicit `to` otherwise
						//
						// 2026-10-31 某次实测 实测（问题 1/2，靶上 t3）：用 `to:"实现方-claimer"`
						// 认领，插件照收 —— 因为 findMember 找不到这个名字时 member 是 undefined，
						// 然后 `task.owner = String(args.to || "manual")` 把**一个不存在的人**写进
						// owner。后果是这条单从此挂在幽灵名下：名册里没人认它，自动派单不会给它，
						// holderOf 找不到持有者，finish 只能队长 force ——而队长收到的回执是
						// "claimed by 实现方-claimer"，看起来像认领成功了。这就是"认领无效但列表变了"
						// 的来源。
						// 现在的规矩：认领只认**两种人** ——
						//   ① 队员自己（不能写 to，写了就是越权替别人抢）；
						//   ② 队长自己（owner 记成本队短号，让它自己干这单，它能 finish 不用 force）。
						// 名字既不是本队成员、也不是队长短号 → 直接拒，并把本队可选名单回给对方。
						const self = members.get(caller.session.id);
						if (self !== undefined && String(args.to || "").trim() !== "") {
							throw new Error(`成员 ${self.name} 认领不能写 to（收到 to="${String(args.to).trim()}"）：队员只能领自己那一单，替别人抢是队长的活。直接 team(action:"claim", tid:"${task.tid}")`);
						}
						const wantTo = String(args.to || "").trim();
						const selfShort = shortOf(leadId);
						// 短号前缀只在前缀够长时才算（否则 to:"a" 这种一字符会被误认成队长）
						const isLeadSelf = wantTo === "" || wantTo === selfShort
							|| (wantTo.length >= 6 && (String(leadId).endsWith(wantTo) || String(leadId).replace(/^session-/, "").startsWith(wantTo)));
						const member = self !== undefined ? self : (wantTo === "" ? undefined : findMember(wantTo, leadId));
						if (member === undefined && !isLeadSelf) {
							const names = Array.from(members.values()).filter((m) => m.parentSessionId === leadId).map((m) => m.name);
							throw new Error(`认领人 "${wantTo}" 既不是本队成员、也不是队长短号（${selfShort}）—— 认领只认这两种人。本队成员：${names.join(",") || "(还没有成员，插件会自动补)"}。队员自己领：team(action:"claim", tid:"${task.tid}")；队长自己干这单：team(action:"claim", tid:"${task.tid}") 不写 to（owner 记成 ${selfShort}）`);
						}
						if (task.preassigned === true && task.owner !== null && (member === undefined || member.name !== task.owner)) throw new Error(`${task.tid} 已预指派给 ${task.owner}，别的成员不能抢`);
						const claimer = self === undefined ? `${selfShort}(队长)` : self.name;
						noteStatus(task, "claimed", claimer, member === undefined ? "队长手动认领，自己干" : "成员认领");
						task.status = "claimed"; task.owner = member ? member.name : selfShort; task.revision += 1; task.claimedAt = Date.now();
						task.claimedBy = claimer;
						if (member !== undefined) { member.currentTask = task.tid; applyDemand(member, task); }
						persistAll();
						return withNotices({
							[task.tid]: `claimed by ${task.owner} (rev ${task.revision})${member === undefined ? "｜队长自己干这单（它能直接 finish，不用 force）" : " gear " + member.effort}${releasedDeps.length === 0 ? "" : "｜前置 " + releasedDeps.join(",") + " 已失败，依赖按解除处理"}`,
							board: `${task.tid} 现在是 claimed（owner=${task.owner}）；别人不会再来领它，干完用 action2:"finish"`,
						}, leadId);
					}
					case "msg": {
						// 2026-10-31 隔壁问题 8 的配套：成员唯一的对外通道是"报给队长"。
						// 原来 msg 只认本队成员名，成员想 msg 队长会被 "unknown member" 挡回去 ——
						// 成员被禁掉建单/改单之后，必须有一条能真的通到队长的口子，否则卡住就憋死。
						const leadIdForMsg = resolveLead(caller);
						if (selfMember !== undefined) {
							const target = String(args.to || "").trim();
							if (!(target === leadIdForMsg || String(leadIdForMsg).endsWith(target) || String(leadIdForMsg).replace(/^session-/, "").startsWith(target))) {
								throw new Error(`成员 ${selfMember.name} 只能 msg 队长（${shortOf(leadIdForMsg)}），不能给别的成员派活（收到 to="${target}"）。要给队友传话请让队长转`);
							}
							const text = String(args.text || "").trim();
							if (text === "") throw new Error("msg 要 text");
							deliverMail(leadIdForMsg, caller.session.id, selfMember.name, text, true);
							const w = await wakeSession(leadIdForMsg, selfMember.name, text);
							return { sent: `队长 ${shortOf(leadIdForMsg)}`, ...w, note: "队员报给队长：整封原文已进师傅上下文" };
						}
						const member = findMember(args.to, leadIdForMsg);
						if (member === undefined) throw new Error(`unknown member ${args.to}`);
						const dm = checkDemand(args.demand);
						if (dm !== "") applyDemand(member, { demand: dm });
						const target = sessionIdOf(member);
						await ctx.subagents.sendMessage(caller, target, [{ type: "text", text: String(args.text || "") }], { signal: exec.signal });
						return { sent: member.name, ...(dm === "" ? {} : { gear: member.effort }) };
					}
					case "retool": {
						const member = findMember(args.to, resolveLead(caller));
						if (member === undefined) throw new Error(`unknown member ${args.to}`);
						const provider = String(args.provider || "").trim();
						const model = String(args.model || "").trim();
						const effort = String(args.effort || "").trim();
						// `provider:"auto"` hands the member back to the plugin's rotation:
						// manual always wins, but the Lead must be able to give control back.
						if (provider === "auto") {
							const pk = pickRoute(String(args.kind || "grunt"), String(args.size || "m"), resolveLead(caller), [`${member.provider}/${member.model}`], { vision: args.vision === true || String(args.vision || "").trim().toLowerCase() === "true" });
							if (pk.error !== undefined) throw new Error(`交回自动轮换失败：${pk.error}`);
							member.provider = pk.entry.provider;
							member.model = pk.entry.model;
							member.routeSource = "plugin";
							const g = applyDemand(member, undefined);
							persistAll();
							return { retool: member.name, want: `${member.provider}/${member.model}@${member.effort}`, handsBack: "交回插件轮换（让它按当前台账重新挑一条）", pickedBecause: pk.why, gear: g === undefined ? member.effort : g.gear };
						}
						if (!provider || !model) throw new Error("retool needs provider+model（或 provider:\"auto\" 交回插件轮换）");
						if (leadRouteKeys().has(provider + "/" + model)) throw new Error(`${provider}/${model} 是队长路由（一律不派给成员）— 换一个`);
						// 2026-11-02 某次实测 压测（6.3）：retool 沿用参考实现任何字符串都收，装上去
						// 成员下一步才报 "no adapter registered"，整单退回 open 白烧一轮。
						// 台账里从没见过这条路由 = 网关侧多半不存在 —— 当场拒，除非 force。
						if (!ledger.has(`${provider}/${model}`) && args.force !== true && String(args.force) !== "true") {
							throw new Error(`${provider}/${model} 从没见过（不在台账/OFM 目录里）。先 team(action:"models") 核对准确 id；确定是刚上架的新路由再带 force:true 强装。`);
						}
						// gear: explicit wins as intent, but the measured ceiling still clips it;
						// the next dispatch recomputes from the task's demand anyway.
						const rt = resolveGear(ledger.get(`${provider}/${model}`), effort, member.demand === undefined ? String(DEMAND_DEFAULT) : member.demand);
						member.provider = provider; member.model = model; member.effort = rt.gear;
						member.effortWhy = `retool ${effort || "auto"}`;
						// manual is a SOURCE, not a lock: the plugin keeps evaluating this member
						// (measured ceiling → downshift → route rotation) exactly as if it had picked it
						member.routeSource = "manual";
						// live agents pick it up on their next step: 新内核对 selection 做硬校验，
						// 所以这里必须**立刻**把新路由写进 model/selection（旧内核仍走 agent/request 覆写）。
						// cold agents re-attach at agent/created on resume（attachRouting 里再同步一次）。
						syncMemberSelectionOf(member);
						persistAll();
						return { retool: member.name, want: `${provider}/${model}@${rt.gear}`, source: "手动指定（插件仍按实测封顶/降档/换路由继续维护）", ...(rt.capped ? { capped: `要 ${effort || "auto"} 但实测封顶，已压到 ${rt.gear}` } : rt.short ? { short: `该路由档位只到 ${rt.gear}` } : {}), note: "effective from member's next step; verify via team(status) actual column" };
					}
					case "kill": {
						const member = findMember(args.to, resolveLead(caller));
						if (member === undefined) throw new Error(`unknown member ${args.to}`);
						// 2026-11-02 设计确定：「判断成员已混乱 → 禁用这个成员，新开一个」：ban:true 走 banAndReplace
						// （拉黑会话+退单+钉同路由对照新起）；比 remove 多一层"永不复用"，也不要求先叫停成功。
						if (args.ban === true || String(args.ban) === "true") return withNotices(banAndReplace(member, { reason: String(args.text || "") || "队长判产出混乱" }), resolveLead(caller));
						ctx.subagents.interrupt(sessionIdOf(member), { kind: "ancestor", agent: caller });
						// 2026-10-31 实测：「他KILL没用，转头插件自己又派」。
						// kill 之后单退回 open，如果这单已经被压过/踩过小路由，下一次补员还会挑一条
						// 同样小的路由，死循环原样重开。所以撤人时就把"这条装不下"记到单上。
						{
							const bd = boards.get(member.parentSessionId);
							const heldTask = bd === undefined || member.currentTask === null ? undefined : bd.tasks.get(member.currentTask);
							if (heldTask !== undefined) markRouteTooSmall(heldTask, member, args.remove === true ? "手动移除" : "手动叫停");
						}
						if (args.remove === true) {
							// 维护方分得很清：kill=叫停但留着；remove=真正腾名额。
							// 被移除的成员手上若有任务，必须退回 open，否则永远挂 claimed、
							// 挡死下游，而 owner 已经不在名册里了。
							const sid = sessionIdOf(member);
							const held = member.currentTask;
							let reverted = null;
							if (held !== null) {
								const board = boards.get(member.parentSessionId);
								const task = board === undefined ? undefined : board.tasks.get(held);
								// 只退「它自己持有的」：adopt 重建板后，同号 tid 已经是另一个任务，
								// 可能是别的成员在干 —— 无条件按 tid 退会把别人的活抢回 open。
								if (task !== undefined && task.status === "claimed" && task.owner === member.name) {
									noteStatus(task, "open", `${shortOf(member.parentSessionId)}(队长)`, `成员 ${member.name} 被 remove，任务退回`);
									task.status = "open"; task.owner = null; task.claimedAt = null; task.revision += 1;
									task.lastReport = `成员 ${member.name} 被移除，任务退回 open`;
									reverted = held;
								}
							}
							members.delete(sid);
							// 2026-11-02 设计确定：「除非队长选择不用这个子智能体」：remove 是队长
							// 亲手不要他了 —— 不但不入池，他以前回收留下的池条目也一并销账。
							memberPool.drop(sid);
							// remove 是最硬的"不要他"：连禁用名单也记一笔，任何路径（含 adopt 档案
							// 重建）都再也捡不回这个会话。
							banList.add(sid, { name: member.name, leadId: member.parentSessionId, route: `${member.provider}/${member.model}`, reason: "kill remove（队长亲手移除）" });
							rememberRetired(sid, member);
							member.currentTask = null;
							persistAll();
							return { interrupted: member.name, removed: `已从名册移除${reverted === null ? "" : `，它手上的 ${reverted} 已退回 open`}` };
						}
						return { interrupted: member.name };
					}
					case "unban": {
						// 解禁：队长改主意了（或判错了）就捞回来。只删插件侧名单里的记录 ——
						// 会话本身从没被删过；解禁后他重新具备被池复用/被 claim 的资格。
						const want = String(args.to || "").trim();
						if (want === "") throw new Error("unban 要 to（成员名或会话 id）");
						const me = resolveLead(caller);
						const removed = banList.remove(want, me);
						if (removed.length === 0) return withNotices({ unban: want, removed: 0, note: "禁用名单里没有这个（名字按本队匹配，也认完整会话 id）" }, me);
						return withNotices({ unban: want, removed: removed.map((r) => r.name + "|" + String(r.sessionId).slice(0, 8)) }, me);
					}
					case "files": {
						// 共享文件占用表（维护方 2026-10-30 定）：谁在改哪个文件、谁在排队、谁刚改完。
						// 全员可见（跨队），只读；真正加锁/放锁由插件在 write/edit 前后自动做。
						const me = resolveLead(caller);
						const filter = String(args.to || args.path || "").trim().toLowerCase();
						const rows = lockRows().filter((r) => filter === "" || String(r.path).toLowerCase().includes(filter) || String(r.name).toLowerCase().includes(filter));
						if (rows.length === 0) {
							return {
								文件占用: filter === "" ? "（表里还没有任何被占用过的文件）" : `（没有匹配 "${filter}" 的文件）`,
								how: "成员 write/edit 前插件自动查表加锁、跑完自动放锁；被占的调用会被拦下并排队，放锁后只通知队首那一个",
							};
						}
						const lines = rows.slice(0, 40).map((r) => {
							const who = r.holder === null ? (r.last === null ? "（空闲）" : `空闲，上次 ${r.last}${r.lastSize !== undefined ? "（" + r.lastSize + "B）" : ""}`) : `改中 ${r.holder}`;
							const wait = r.waiters.length === 0 ? "" : `｜排队 ${r.waiters.join(" > ")}`;
							const st = r.stale === null ? "" : `｜⚠${r.stale}`;
							const ex = r.exists ? "" : "｜⚠磁盘上已不存在";
							return `${r.path}｜${who}${wait}${st}${ex}`;
						});
						return {
							文件占用: lines,
							统计: `${rows.filter((r) => r.holder !== null).length} 个正被修改｜${rows.filter((r) => r.waiters.length > 0).length} 个有人排队`,
							...(filter === "" && rows.length > 40 ? { 提示: `只显示最近 40 条（共 ${rows.length} 条），用 to/filter 按路径过滤` } : {}),
							how: "成员 write/edit 前插件自动查表加锁、跑完自动放锁；被占的调用会被拦下并排队，放锁后只通知队首那一个",
						};
					}
					case "peers": {
						// 所有还留记录的会话（本会话 + 别的对话框），只读摘要，不跨写。
						const me = resolveLead(caller);
						const leads = new Set([...boards.keys(), ...Array.from(members.values()).map((m) => m.parentSessionId), ...goals.keys()]);
						const rows = [];
						for (const lead of leads) {
							const board = boards.get(lead);
							const ts = board === undefined ? [] : Array.from(board.tasks.values());
							const cnt = (s) => ts.filter((t) => t.status === s).length;
							const mem = Array.from(members.values()).filter((m) => m.parentSessionId === lead);
							rows.push({
								id: lead, short: shortOf(lead), mine: lead === me, live: ctx.agents.get(lead) !== undefined,
								members: mem.length, idle: mem.filter((m) => m.currentTask === null).length,
								open: cnt("open"), claimed: cnt("claimed"), done: cnt("done"), failed: cnt("failed"),
								goal: String((goals.get(lead) || {}).text || "").slice(0, 60),
							});
						}
						rows.sort((a, b) => (a.mine ? 0 : 1) - (b.mine ? 0 : 1) || Number(b.live) - Number(a.live));
						// 内核里还有一批「从没碰过 team」的会话（包括刚开、一句没说的空会话）：
						// 它们没有板子，peers 原本看不见，但 can 被 tell 唤醒当测试靶。
						const known = new Set(rows.map((r) => String(r.id)));
						const ks = await kernelSessions();
						const extra = [];
						if (ks !== undefined) {
							for (const s of ks) {
								if (known.has(s.id) || s.id === me || s.sub) continue;
								extra.push({
									id: s.id, short: shortOf(s.id), mine: false, live: s.agent,
									team: "没碰过 team", blank: s.blank, running: s.running,
									updated: s.updatedAt === 0 ? "-" : new Date(s.updatedAt).toISOString().slice(11, 19) + "Z",
								});
							}
							extra.sort((a, b) => (a.updated < b.updated ? 1 : -1));
						}
						const annAll = loadAnnounce();
						const annLast = annAll.items[annAll.items.length - 1];
						return {
							peers: rows,
							...(ks === undefined ? { kernelSessions: "内核没给会话清单（sessionController.list 不可用）" } : { 其他会话: extra }),
							公告: annLast === undefined ? "（还没有公告）" : `#${annLast.seq} ${shortOf(annLast.from)}（${new Date(Number(annLast.at) || 0).toLocaleTimeString()}）：${String(annLast.text).slice(0, 300)}`,
							how: "对讲用 team(action:\"tell\", to:\"<短号>\", text:\"…\")；写了 to 就算指名、默认叫醒对方（wake:false 才只投递）。**正文在保证说清问题的前提下尽可能短**：回答问题中的操作细节没问不发（回执只写一句结论，修法/文件/验证过程留自己这边）。读全部公告用 team(action:\"announce\") 不带 text",
						};
					}
					case "tell": {
						const to = String(args.to || "").trim();
						const text = String(args.text || "").trim();
						if (to === "" || text === "") throw new Error("tell 要 to（对方会话短号或完整 id）和 text");
						// 成员视角：resolveLead 会爬到它的队长，"to 是自己"就会把自己的报告挡回去 ——
						// 成员报队长的唯一通道必须先把这条排除掉（2026-10-31 加成员白名单时补）。
						const meRaw = String(caller.session.id);
						const leads = new Set([...boards.keys(), ...Array.from(members.values()).map((m) => m.parentSessionId), ...goals.keys()]);
						// 也要能 tell 一个「从没碰过 team」的会话（比如刚开的测试靶）
						const ks = await kernelSessions();
						if (ks !== undefined) for (const s of ks) { if (!s.sub) leads.add(s.id); }
						const hits = Array.from(leads).filter((id) => id === to || String(id).endsWith(to) || String(id).replace(/^session-/, "").startsWith(to));
						if (hits.length === 0) throw new Error(`没有这个会话：${to}（先 team(action:"peers") 看短号）`);
						if (hits.length > 1) throw new Error(`短号 ${to} 命中 ${hits.length} 个会话，换完整 id：${hits.map(shortOf).join(",")}`);
						const me = resolveLead(caller);
						// 自己 = 本会话（按原始会话 id 比），不是 resolveLead 之后的"我所属的队长"。
						if (hits[0] === meRaw) throw new Error("to 是自己 —— 填对方会话的短号");
						// 2026-10-31 维护方报的真事故（某次实测 → 某次实测 的报告没被叫醒）根因就是下面这条：
						// `tell` 明明把收信人写在一等公民字段 `to` 里，代码却去**正文**里找 @。
						// 正文没 @（或 @ 落在 800 字截断点之后）= 永远不叫醒 → 报告躺在信箱里等人自己想起来。
						// 改法：收信人由 `to` 决定，**信里写了 to 就算指名**（addressed 默认 true），
						// 正文再写 @短号 只是额外确认；只有显式 wake:false 才纯投递。
						const addressed = true;
						deliverMail(hits[0], me, shortOf(me), text, true);
						// 2026-10-30 维护方抓到的真事故：实现方自测 @ 了一个**空白会话**，prompt 灌进去后它
						// 从「开过但没说过话」变成「有一条消息的会话」，侧栏凭空多出个叫「取信邮件」的对话。
						// 根因是 `sessionController.prompt` 既能叫醒老会话、也能**替维护方新建**会话。
						// 所以空白会话（blank:true = 开过对话一句没说、还没落盘）一律不唤醒：信只入信箱，
						// 等它自己发第一句、或维护方先在 GUI 里点开用一次，之后才允许叫醒。
						const blankTarget = (ks === undefined ? [] : ks).find((s) => s.id === hits[0])?.blank === true;
						const wake = args.wake === false
							? { woke: false, why: "wake:false，只投递不唤醒" }
							: blankTarget
								? { woke: false, why: "对方是空白会话（开过对话但一句没说），叫醒会凭空造出一个新对话 —— 只入信箱" }
								: await wakeSession(hits[0], me, text);
						return {
							delivered: shortOf(hits[0]),
							queued: (mailBox[hits[0]] || []).length,
							...wake,
							// 2026-10-31 修：原来无论叫没叫醒，note 都写「只入信箱、对方下次调 team 才看到」，
							// 连同整段 `woke:false` 一起被成员当成"没送到"的证据 —— 措辞按真实行为分开。
							// 再修（维护方问"不是插话送达？"）：woke 之外还要说清**走的是插话还是新回合**，
							// 写"不打断当前回合"是旧 steer/queue 时代的反话，现在是主动插话，不能再写。
							note: wake.woke
								? (wake.mode === "steer"
									? "已插话送达：整封全文直接进了它当前回合（它下一步就能看到）"
									: "已叫它起来（它当时空闲，起了一个新回合，整封全文已进它的上下文）")
								: `已入 ${shortOf(hits[0])} 的信箱（${String(wake.why || "")}）；它下一次调用 team 时整封原文会带出来`,
						};
					}
					case "announce": {
						// 两种用法：带 text = 发公告；不带 text = 读公告板（维护方会直接对别的对话说
						// 「看公告」，那一枪必须能直接出结果，不能回一句「参数缺失」）。
						const text = String(args.text || "").trim();
						const me = resolveLead(caller);
						if (text === "") {
							const a0 = loadAnnounce();
							// 2026-11-09 设计确定：公告板只留最后一条，读侧同步只读最新一条。
							const rows = a0.items.slice(-ANNOUNCE_KEEP).map((it) => `#${it.seq} ${new Date(Number(it.at) || 0).toLocaleString()} ${shortOf(it.from)}：${it.text}`);
							const wait = announceWaitSec();
							return {
								公告: rows.length === 0 ? "公告板是空的（还没人发过）" : rows,
								距下次可发: wait > 0 ? `${wait} 秒` : "现在可发",
								how: '发公告：team(action:"announce", text:"…")；全体 5 分钟最多一条',
							};
						}
						const waitSec = announceWaitSec();
						if (waitSec > 0) throw new Error(`公告限流：**全体** 5 分钟最多一条（不是一人一条），还要等 ${waitSec} 秒。急事请 tell 具体的人`);
						const a = loadAnnounce();
						const nowA = Date.now();
						a.seq = Number(a.seq || 0) + 1;
						a.lastAt = nowA;
						a.items.push({ seq: a.seq, at: nowA, from: String(me), text: text.slice(0, 1200) });
						while (a.items.length > ANNOUNCE_KEEP) a.items.shift();
						a.seen[String(me)] = a.seq; // 自己发的那条不用再收一遍
						saveAnnounce(a);
						// 2026-10-30 设计确定：**新公告默认要把人叫起来**（公告是"需要你注意"的事，
						// 光入信箱等于等维护方自己想起来去看）；只有显式 wake:false 才纯投递。
						// 正在跑的会话不打断（排队进它下一步），成员（子会话）一律不叫。
						const doWake = args.wake === false ? false : true;
						const woke = [];
						const later = [];
						const ks = doWake ? await kernelSessions() : undefined;
						if (ks !== undefined) {
							const live = ks
								.filter((s) => s.id !== String(me) && s.agent && s.blank !== true && s.parent === "")
								.sort((x, y) => y.updatedAt - x.updatedAt);
							for (const s of live) {
								if (s.running || woke.length >= ANNOUNCE_WAKE_MAX) { later.push(shortOf(s.id)); continue; }
								const r = await wakeSession(s.id, me, text, "announce");
								if (r !== undefined && r.woke === true) woke.push(shortOf(s.id)); else later.push(shortOf(s.id));
							}
						}
						return {
							seq: a.seq,
							at: new Date(nowA).toLocaleTimeString(),
							已叫醒: doWake ? (woke.length === 0 ? "没有空闲会话可叫" : woke) : "只投递未唤醒（wake:false 才这样）",
							...(doWake && later.length > 0 ? { 下次调team才收到: later } : {}),
							限频: "全体 5 分钟最多一条（不分会话，不会一人一条刷屏）",
							note: "公告只投递、不要回执；活的会话下次调用 team 时随 notices 看到全部未读公告。成员（子会话）不广播，避免打断干活",
						};
					}
					case "disband": {
						// 收队：先把档案存下来（可 adopt 恢复），再叫停并清空本队，最后删板。
						// 删板后 status/peers 的「其他队」摘要里就不再出现这个会话。
						const leadId = resolveLead(caller);
						const board = boards.get(leadId);
						const mine = Array.from(members.values()).filter((m) => m.parentSessionId === leadId);
						const names = mine.map((m) => m.name);
						for (const m of mine) {
							try { ctx.subagents.interrupt(sessionIdOf(m), { kind: "ancestor", agent: caller }); } catch { /* 已停的成员不可中断 */ }
							const sidM = sessionIdOf(m);
							members.delete(sidM);
							rememberRetired(sidM, m);
							// 2026-11-02：disband = 队长整队不要了，会话不进池；循环外 dropTeam 清旧账。
						}
						memberPool.dropTeam(leadId);
						let archived;
						if (board !== undefined) {
							archived = writeTeamFile(leadId, `disband-${shortOf(leadId)}-${dayStamp()}`);
							boards.delete(leadId);
						}
						goals.delete(leadId);
						persistAll();
						return { disbanded: String(leadId).slice(-8), archived: archived === undefined ? "存档失败（板仍已删）" : nodePath.basename(archived), members: names.length, tasks: board === undefined ? 0 : board.tasks.size, note: "摘要里不再出现本队；要恢复用 adopt 指向存档" };
					}
					case "rule": {
						const leadId = resolveLead(caller);
						if (args.ruleId !== undefined && String(args.ruleId).trim() !== "") {
							const id = String(args.ruleId).trim();
							// errorRules 是从 errbook 解构来的 const 绑定，且 errbook 的
							// saveErrorRules/matchErrorRule 闭包盯的是同一个数组对象 ——
							// 只能原地 splice，重新赋值既违法（Assignment to constant
							// variable，某次实测 报告 3.1 的根因）又会把闭包里那份旧数组留下。
							const idx = errorRules.findIndex((r) => r.id === id);
							if (idx === -1) throw new Error(`没有这条登记规则：${id}（内置规则不能删）`);
							errorRules.splice(idx, 1);
							saveErrorRules();
							return withNotices({ removed: id, left: errorRules.length }, leadId);
						}
						const match = String(args.match || "").trim();
						if (match === "") {
							pruneLeadErrors();
							deliverLeadErrors(leadId, 0); // 0 = 只升级判不了的那些，不再交付新的
							const pend = pendingRows();
							return withNotices({
								rules: errorRules.length === 0 ? ["（还没登记任何规则）"] : errorRules.map((r) => `${r.id}|${r.class}|${r.fix}|${r.match}`),
								builtin: BUILTIN_ERROR_RULES.map((r) => `${r.id}|${r.class}|${r.fix}`),
								队长报错待判: pend.length === 0 ? "（没有：所有见过的错都已归类或无积压）" : pend.slice(-5).map((e) => `${new Date(Number(e.at)).toISOString().slice(11, 19)}Z ${e.route}@${e.effort || "?"}${Number(e.repeat) > 1 ? "×" + e.repeat : ""}：${String(e.raw).slice(0, 300)}`),
								note: "插件只查表：命中就按 fix 办；没命中的队长报错堆在 lead-errors.json，成员一报错就连它一起推给当时的队长判；问过一遍还判不出来的会升级成「问维护方」并从文件里删掉",
							}, leadId);
						}
						const errorClass = String(args.errorClass || "").trim();
						if (errorClass === "") throw new Error("登记判据要 errorClass（额度限流|档位不支持|路由bug|白名单未开|地区封锁|上下文超限|网关共性|… 自定也行）");
						const fixRaw = String(args.fix || "").trim().toLowerCase();
						if (fixRaw !== "" && !FIX_VALUES.includes(fixRaw)) throw new Error(`fix 只能是 ${FIX_VALUES.join("|")}（收到 ${fixRaw}）`);
						const fix = fixRaw === "" ? "retry" : fixRaw;
						if (fix === "none" && !/context|上下文|length|token/i.test(match)) {
							// fix=none 等于「别重试别换路由」，通常只用于"只能靠人改输入"的那类
							pushNotice(leadId, "提醒", `规则 ${match} 用了 fix="none"：插件将不再重试/换路由，只上报。确认这是你要的`);
						}
						// 2026-10-29 维护方抓到的真实误判：某个会话「看到 400 就判死」，把**模型名**当 match、
						// fix 写 dead 登记进来，于是这个模型的任何报错（含临时 400）都被永久判死。
						// 插件读不懂上游报错，但能挡住这两种写法，逼登记的人把话说到证据上。
						// 模型名识别不靠猜：直接拿台账里已知的 model / provider/model 对照。
						// 这样 `dots-3-note-preview`（无 provider 前缀）也能认出来，又不会误伤
						// `STREAM_CUT`、`429` 这类正常错误特征。
						const looksLikeRoute = ledger.has(match)
							|| Array.from(ledger.values()).some((e) => e.model === match || (match.length >= 6 && !/\s/.test(match) && e.model.includes(match)))
							|| /^[\w.-]+\/[\w.:@+-]+$/.test(match);
						// 2026-10-29 设计确定：匹配文本现在带 `[route] provider/model` 前缀，
						// 所以「某一类错只对某条路由成立」是合法写法 —— 显式写 `[route]` 才放行，
						// 光秃秃一条模型名照旧拒（那等于「这个模型的任何错都算」，还是会误杀）。
						const routeScoped = /\[route\]/i.test(match);
						if (looksLikeRoute && !routeScoped) {
							throw new Error(`match 写的是模型名/路由（${match}）：规则匹配的是**错误特征**，不是模型名。`
								+ `写模型名等于「这个模型的任何错都按这条办」，一次临时 400 就会把它永久判死。`
								+ `改成报错里的特征片段（例：end of life / Rate limit exceeded / bad request / 整段贴原文关键句）。`);
						}
						if (fix === "dead") {
							// 判死必须有终局证据。裸 `400 bad request` 是零信息量（不是超限/限流/地区/白名单），
							// 只能退避重试，不能判死 —— 这正是维护方这次抓到的那个错的形状。
							const FINAL_EVIDENCE = /end of life|end-of-life|decommission|retired|deprecated|not found|does not exist|no such model|unsupported model|not available in your country|region.?block|not allowed for this Session|白名单|地区封锁|已下线|停止服务|不存在|insufficient credits|充值墙|额度已用尽/i;
							const because = String(args.because || args.evidence || "").trim();
							if (!FINAL_EVIDENCE.test(match) && !FINAL_EVIDENCE.test(because)) {
								throw new Error(`fix="dead" 缺终局证据：match 或 because 里得出现「end of life / not found / does not exist / unsupported / 地区封锁 / 白名单未开」这类字样。`
									+ `HTTP 400 + "Provider returned error/bad request" 不含任何死因，先按 fix:"backoff" 或 "retry" 处理；`
									+ `确实要判死就带上 because:"报错原文里的终局那句"。`);
							}
						}
						const id = `L${Date.now().toString(36).slice(-5)}`;
						errorRules.push({ id, match, class: errorClass, fix, at: Date.now(), test: ruleMatcher(match), source: "lead" });
						saveErrorRules();
						// 判完立刻清：能新规则认出来的队长报错不用再问第二次
						const pruned = pruneLeadErrors();
						return withNotices({ added: `${id} ${errorClass}/${fix}`, match, cleared: pruned > 0 ? `清掉 ${pruned} 条已能归类的队长报错` : "没有可清的队长报错", nextTime: "同类报错直接按 fix 处理，不再上报" }, leadId);
					}
					case "models": {
						const modelsLead = resolveLead(caller);
						const nowMs = Date.now();
						const modelsFilter = String(args.filter || "");
						// UI 能显示的 ctx/efforts，插件也能：直接问内核 llm 服务（catalog 不报时补上）。
						try { await syncModelInfo(modelsFilter); } catch { /* 查询失败就按台账显示 */ }
						// filter 非空就把内核真实档位名一并带出来 —— 这是唯一不用派活就能确认
						// 「Off/Low/Medium/High 在内核里到底叫什么」的路子。
						let kernelRows;
						if (modelsFilter !== "") {
							try { kernelRows = await kernelEffortRows(modelsFilter); } catch { kernelRows = ["内核档位查询失败"]; }
						}
						const top = Array.from(scores)
							.map(([k, r]) => ({ k, n: r.n * scoreDecay(r, nowMs), rate: r.n > 0 ? r.ok / r.n : 0 }))
							.filter((r) => r.n >= 0.2)
							.sort((a, b) => b.n - a.n)
							.slice(0, 5)
							.map((r) => `${r.k} 成${Math.round(r.rate * 100)}%/样本${r.n.toFixed(1)}`);
						const scorebook = cfg.scoreRecord !== true
							? "scoreRecord=false，未记账"
							: scores.size === 0
								? "账本空（还没有真实派活结束过）"
								: [`账本 ${scores.size} 条｜聚合不计流水｜半衰 ${Number(cfg.scoreHalfLifeDays || 14)} 天｜上限 ${Number(cfg.scoreMaxKeys || 1500)} 条｜权重 ${cfg.scoreWeighted === true ? "已启用" : "未启用(只记)"}`, ...top];
						// filter 里点名 ofm/版本时，把"自动更新做了什么"一并带出来 ——
						// 维护方提问「升级了没」时不用再翻 .state 文件。
						// 只放"确定有值"的字段：undefined 会让整条 JSON 序列化失败
							// （实测：team(models, filter:"ofm") 直接报 value is not lossless JSON）。
							const ofmRes = ofmAutoLast.result;
							const ofmBit = /ofm|版本|version|升级/i.test(modelsFilter) && ofmRes !== null && ofmRes !== undefined
								? { ofm: {
									at: Number(ofmRes.at) || 0,
									ok: ofmRes.ok === true,
									did: String(ofmRes.did === undefined || ofmRes.did === null ? "" : ofmRes.did),
									version: String(ofmRes.version === undefined || ofmRes.version === null ? "" : ofmRes.version),
									latest: String(ofmRes.latest === undefined || ofmRes.latest === null ? "" : ofmRes.latest),
									error: String(ofmRes.error === undefined || ofmRes.error === null ? "" : ofmRes.error),
								} }
								: {};
						return withNotices({
							digest: ledgerDigest(modelsFilter, modelsLead),
							...(kernelRows === undefined ? {} : { 内核档位: kernelRows }),
							...ofmBit,
							scorebook,
						}, modelsLead);
					}


					case "scan": {
						// #11 manual reset: measured ceilings and gear rejections are evidence,
						// but stale evidence must be droppable without editing JSON by hand.
						if (String(args.reset || "").trim() === "efforts") {
							let cleared = 0;
							for (const entry of ledger.values()) {
								if (entry.effortOk !== undefined || entry.effortBad !== undefined || entry.badEfforts !== undefined) cleared += 1;
								delete entry.effortOk;
								delete entry.effortBad;
								delete entry.badEfforts;
								if (/^(档位不支持|最低档 )/.test(String(entry.note || ""))) { entry.note = ""; entry.updatedStr = dayStamp(); }
							}
							persistAll();
							return withNotices({ reset: "efforts", cleared }, resolveLead(caller));
						}
						// 2026-10-29：python 扫描器随台账退役。scan 的新语义 = 从内核 llm 服务同步模型清单
						// （listProviders + listModels），补台账没有的模型；顺带回填白名单、刷一下 OFM 目录和探活。
						const kernel = await syncFromKernel(ctx, cfg);
						const avail = applyAvailability(ctx, cfg);
						const ofm = (() => { try { return syncFromOfm(cfg); } catch (error) { return { added: 0, gone: 0, why: String(error) }; } })();
						// 2026-11-01：顺手把 OFM 的**实测账**挂到台账条目上（失败率/速度/首字延迟）。
						// 只挂 ofm 字段，不动 status —— 那是历史表现，不是现在的可用性开关。
						const measured = (() => { try { return annotateOfmLedger([...ledger.values()], readOfmStats()); } catch (error) { return { matched: 0, error: String((error && error.message) || error) }; } })();
						persistAll();
						const mdPath = ledgerMdPathOf(cfg);
						return {
							scan: "kernel",
							added: Number(kernel.added || 0),
							dropped: Number(kernel.dropped || 0),
							providers: Number(kernel.providers || 0),
							failed: Number(kernel.failed || 0),
							whitelist: kernel.whitelist === undefined ? "未解析" : String(kernel.whitelist),
							revoked: Number(kernel.revoked || 0),
							delisted: Number(kernel.delisted || 0),
							relisted: Number(kernel.relisted || 0),
							codeTag: String(kernel.codeTag || ""),
							seenCount: Number(kernel.seenCount || 0),
							ofmSync: { added: Number((ofm || {}).added || 0), gone: Number((ofm || {}).gone || 0) },
							ofmMeasured: measured.matched === undefined ? 0 : measured.matched,
							availabilityMerged: Number(avail || 0),
							ledgerMd: mdPath === null ? "已退役（数据在 .state/ledger.json）" : "仍在同步",
							...(kernel.why === undefined ? {} : { why: String(kernel.why) }),
						};
					}
					case "ofm": {
						// 2026-11-01 说明：「他有我们没有的也可以拿过来充实我们的数据」。
						// 直接读 ~/.dsh/our-free-model/stats.json（OFM 面板那张表的数据源），
						// 不经过 HTTP 接口、不写它一个字节。给的是**实测**：跑了几次、错几次、
						// 多快、首字多久 —— 这些正是人工打分要的证据，不是用来替 status 做开关的。
						const dir = ofmDataDir();
						const stats = readOfmStats(dir);
						if (stats.ok !== true) return { ofm: "读不到", why: stats.why, dir, hint: "OFM 还没跑过请求，或者装到别处去了" };
						const all = Object.keys(stats.models).map((id) => {
							const row = stats.models[id];
							const v = ofmVerdict(row);
							return { id, ...v, text: ofmRowText(row), tokens: (row.input || 0) + (row.output || 0) };
						});
						const counts = {};
						for (const r of all) counts[r.state] = (counts[r.state] || 0) + 1;
						const filter = String(args.filter || "").trim().toLowerCase();
						const pool = filter === "" ? all : all.filter((r) => r.id.toLowerCase().includes(filter));
						const limit = Math.max(1, Math.min(80, Number(args.limit) || 20));
						const byCalls = pool.slice().sort((a, b) => (b.calls || 0) - (a.calls || 0));
						const bad = byCalls.filter((r) => r.state === "bad").slice(0, limit);
						const solid = byCalls.filter((r) => r.state === "solid").slice(0, limit);
						const line = (r) => `${r.id}｜${r.text}`;
						return {
							source: nodePath.join(dir, "stats.json"), version: stats.version, at: dayStamp(new Date(stats.at)),
							totals: `请求 ${stats.requests}｜失败 ${stats.failedRequests}（${pct(stats.requests > 0 ? stats.failedRequests / stats.requests : 0)}）｜回合 ${stats.turns ?? "?"}｜失败回合 ${stats.failedTurns ?? "?"}｜重试救回 ${stats.recoveredTurns}`,
							counts: Object.keys(counts).map((k) => `${k}=${counts[k]}`).join("｜"),
							bad: bad.map(line), solid: solid.map(line),
							mostUsed: byCalls.slice(0, limit).map(line),
							note: "bad/solid 只是历史失败率判档，不改台账 status；样本 <3 次的记 thin，不下结论。",
						};
					}
					case "continue": {
						// 输出撞顶的续写状态（维护方 2026-11-01 定）。插件已经会自己发「继续」，
						// 这个口子是给队长看「谁续了几次、为什么停手」，以及手动补一脚。
						const rows = [];
						for (const [sid, st] of continueState) {
							const m = members.get(sid);
							rows.push({
								session: String(sid).slice(-8),
								who: m === undefined ? (boards.has(String(sid)) ? "队长(本队)" : "别的会话") : `${m.name}@${m.provider}/${m.model}`,
								runs: Number(st.runs || 0),
								left: Math.max(0, Number(cfg.autoContinueMaxRuns || 3) - Number(st.runs || 0)),
								pending: (st.timers || []).length,
								lastAt: st.at ? new Date(st.at).toLocaleTimeString("zh-CN") : "",
								task: st.tid || "",
							});
						}
						rows.sort((a, b) => b.runs - a.runs);
						const to = String(args.to || "").trim();
						if (to !== "") {
							// 手动补一脚：队长点名让某个会话继续（自动续写已用尽、或想立刻催）
							const leadId = resolveLead(caller);
							const target = findMember(to, leadId);
							const sid = target === undefined ? "" : sessionIdOf(target);
							if (sid === "") return { continue: "找不到这个成员", to };
							const st = continueState.get(sid) || { runs: 0, timers: [], at: 0 };
							st.runs = 0; // 手动补的那一脚重置额度，让自动续写还有余量
							continueState.set(sid, st);
							const r = await wakeSession(sid, leadId, `继续：队长让你接着上次停的地方往下写，不要重头再来。`, "continue");
							return { continue: r.woke === true ? `已催 ${to} 继续（mode ${r.mode}）` : `催不动 ${to}：${r.why}`, to };
						}
						return {
							rules: `自动续写 ${cfg.autoContinue === true ? "开" : "关"}｜延迟 ${Math.max(1, Number(cfg.autoContinueDelaySec || 10))}s｜上限 ${Math.max(1, Number(cfg.autoContinueMaxRuns || 3))} 次｜只对队伍成员和建过板的队长会话生效`,
							rows: rows.length === 0 ? ["当前没有会话撞顶"] : rows.map((r) => `${r.who}｜已续 ${r.runs} 次（还差 ${r.left} 次停手）${r.pending > 0 ? "｜已有 1 脚在排" : ""}${r.task ? "｜" + r.task : ""}${r.lastAt ? "｜" + r.lastAt : ""}`),
							hint: "想立刻催某个成员：team(action:\"continue\", to:\"<成员名>\")",
						};
					}
					case "score": {
						// 2026-11-01 设计确定：评分要加一项「产出品质」，就是**队长打分**。
						// 「先给一个平均值，就是没队长打分的时候忽略不计，以后队长看产出打分就可以影响了」
						//
						// 所以：不写 score 就只**看**当前平均（还没人打就是 null，公式里乘 1.00 = 不参与）；
						// 写了 score 就记一笔，带上是哪条路由、哪一单、谁判的、为什么。
						// 与仪表盘上的 `scoreWeighted` 是两码事：那个管的是「同类通过率要不要参与选路」，
						// 这个是**人工对产出的判断**，维护方明确要求它必须影响评分。
						const qPath = nodePath.join(stateDirPath(), "quality.json");
						const raw = loadJson(qPath, []);
						const list = Array.isArray(raw) ? raw : [];
						const rawScore = args.score === undefined || args.score === null ? "" : String(args.score).trim();
						// 1..5 分制：3 = 合格（×1.00 的基准），低于 3 扣、高于 3 加，各自按 0.2 一档。
						// 为什么锚在 3 而不是 5：维护方说明「先给一个平均值」，正态的中心就该是「合格」。
						if (rawScore === "") {
							const avg = qualityAvgOf();
							const byRoute = new Map();
							for (const r of list) {
								const k = String(r.route || "?");
								const cur = byRoute.get(k) || { sum: 0, n: 0 };
								cur.sum += Number(r.score) || 0;
								cur.n += 1;
								byRoute.set(k, cur);
							}
							const rows = Array.from(byRoute.entries())
								.sort((a, b) => b[1].n - a[1].n)
								.slice(0, 20)
								.map(([k, v]) => `${k}｜${(v.sum / v.n).toFixed(2)} 分（${v.n} 判）`);
							return withNotices({
								品质平均: avg === null ? "还没有任何队长打分 → 评分公式里这一维乘 1.00，等于不参与" : avg.toFixed(3),
								打分条数: list.length,
								按路由: rows.length === 0 ? ["（空）"] : rows,
								note: "打分口径：1=胡编乱造 ｜ 2=有明显错 ｜ 3=合格（基准，乘 1.00）｜ 4=好 ｜ 5=很好。"
									+ "\n评分公式里 品质 = 0.6 + (平均分 − 1) × 0.2：3 分 ×1.00、5 分 ×1.40、1 分 ×0.60。"
									+ "\n怎么写：team(action:\"score\", provider, model, score:3, text:\"为什么\")；不写 score 就只读当前平均。",
								hint: "这条只记「队长对产出的判断」；仪表盘那个 scoreWeighted 管的是「同类通过率要不要参与选路」，两者不是一回事。",
							}, resolveLead(caller));
						}
						const v = Number(rawScore);
						if (!Number.isFinite(v) || v < 1 || v > 5) throw new Error(`score 要给 1~5 的数字（3=合格，低于 3 扣分、高于 3 加分），收到「${rawScore}」`);
						let sp = String(args.provider || "").trim();
						let sm = String(args.model || "").trim();
						// 2026-11-02 某次实测 压测（建议 5）：队长手里最自然的信息是「这一单」，
						// 路由是次要的。给了 tid 就自动反查：干这单的人（现任 owner 或
						// 交付时记录的持有路由）是谁、走哪条路由。查得到就不用再写 provider/model。
						const scoreTid = String(args.tid || "").trim();
						let tidRouteFrom = "";
						if ((sp === "" || sm === "") && scoreTid !== "") {
							const leadId2 = resolveLead(caller);
							const board2 = boards.get(leadId2);
							const tk = board2 === undefined ? undefined : board2.tasks.get(scoreTid);
							const holderName = tk !== undefined && tk.owner !== undefined && tk.owner !== null ? String(tk.owner) : "";
							if (tk !== undefined && holderName !== "") {
								// 交单时记下的路由优先（那是干活那一刻的）；人还在线但没交过单就取现路由
								if (typeof tk.routeAtFinish === "string" && tk.routeAtFinish.includes("/")) {
									const slash = tk.routeAtFinish.indexOf("/");
									sp = tk.routeAtFinish.slice(0, slash);
									sm = tk.routeAtFinish.slice(slash + 1); // model 自己可能带 "/"（cline/nvidia/xxx），切第一段之后整段归它
									tidRouteFrom = `（反查自 ${scoreTid} 交单时的持有路由，owner=${holderName}）`;
								} else {
									const mem2 = findMember(holderName, leadId2);
									if (mem2 !== undefined) { sp = mem2.provider; sm = mem2.model; tidRouteFrom = `（反查自 ${scoreTid} 现任持有者 ${holderName}）`; }
								}
							}
						}
						if (sp === "" || sm === "") throw new Error('打分要写清是哪条路由：provider 和 model（如 provider:"qodercn", model:"qfmodel"），或者只给 tid:"t5"（干这单的人的路由自动反查）');
						const routeKey = `${sp}/${sm}`;
						if (!ledger.has(routeKey)) throw new Error(`${routeKey} 不在台账里；先 team(action:"models") 看准确的路由 id`);
						const why = String(args.text || "").replace(/\s+/g, " ").slice(0, 400);
						const rec = {
							at: Date.now(),
							route: routeKey,
							score: v,
							weight: 1,
							kind: String(args.kind || "").trim() || null,
							tid: String(args.tid || "").trim() || null,
							by: String(caller && caller.sessionId || "").slice(-8) || null,
							why,
						};
						list.push(rec);
						// 上限护住文件：留最近 2000 条（打分是稀疏事件，一天的量级是几到几十条）。
						const keeplist = list.slice(-2000);
						try { saveJson(qPath, keeplist); } catch (error) { throw new Error(`写 ${qPath} 失败：${String((error && error.message) || error)}`); }
						// 缓存立刻作废，下一轮评分就用新分（面板 2.5 秒后就变）。
						globalThis.__scoreAt = 0;
						const avgNow = qualityAvgOf();
						const mult = avgNow === null ? 1 : 0.6 + (avgNow - 1) * 0.2;
						return withNotices({
							已记: `${routeKey} = ${v} 分${rec.tid ? "（" + rec.tid + "）" : ""}${rec.kind ? "｜" + rec.kind : ""}${tidRouteFrom}`,
							理由: why === "" ? "（没写理由）" : why,
							新的品质平均: avgNow === null ? "—" : avgNow.toFixed(3),
							品质乘数: mult.toFixed(3),
							总条数: keeplist.length,
							note: "3 分是基准（×1.00）；这条路由下一次算分就会带上它。",
						}, resolveLead(caller));
					}
					case "reload": {
						// 2026-11-01：拆完 OFM 之后这里有两条路。
						//
						//   self   —— 按包根前缀清掉 loader 的 loadCache（**连 src/*.js 一起**），
						//             再重新 import(index.js)。内核 HMR 的 ignored 默认含
						//             `**/node_modules`，而本插件从 node_modules 下的 Junction
						//             进来，所以它永远看不见 src/ 的改动 —— 这条路不经过任何
						//             监视器，是唯一能真换掉模块的。实现在 src/selfreload.js。
						//   kernel —— 原来的 pluginManager.reload()，只换 index.js，兜底保留。
						//
						// dry:true 只干跑探针：报「能不能重载、会清掉哪些键」，一个字节不动。
						const dry = args.dry === true || String(args.dry) === "true";
						const mode = String(args.mode || args.via || "auto");
						let probe;
						try {
							const extra = typeof args.extraBase === "string" && args.extraBase.trim() !== "" ? [args.extraBase.trim()] : [];
							probe = probeReload(ctx, { extraBases: extra });
						} catch (error) {
							probe = { ok: false, error: String((error && error.message) || error) };
						}
						if (dry) return { reload: "干跑（未做任何改动）", probe, lastReload: lastReload(), persist: persistDiagnostics() };
						if (mode !== "kernel" && probe !== null && probe.canReload === true) {
							if (isReloading()) return { reload: "已在重载中", probe };
							// 必须先回应再换代码：重载会拆掉当前这个实例，包括正在返回的这次调用。
							try { saveJson(nodePath.join(stateDirPath(), "reload-log.json"), { at: Date.now(), codeTag: "self-reload-v1", cached: probe.cacheKeyCount, src: probe.srcKeys, via: "self" }); } catch { /* 诊断用，写不进不影响重载 */ }
							setTimeout(() => {
								Promise.resolve()
									.then(() => selfReload(ctx, { logger: console }))
									.catch((error) => {
										try { saveJson(nodePath.join(stateDirPath(), "reload-error.json"), { at: Date.now(), error: String((error && error.message) || error) }); } catch { /* 诊断 */ }
									});
							}, 50).unref?.();
							return {
								reload: "已提交（自热重载）", via: "self",
								willPurge: probe.cacheKeyCount, srcModules: probe.srcKeys,
								note: "本实例先回应，50ms 后才换代码。下次调用 reload(dry:true) 看 lastReload 和 cacheKeys 变了没。",
							};
						}
						// —— 兜底：内核 pluginManager（原逻辑，一字未改）——
						const pm = ctx.get ? ctx.get("pluginManager", false) : ctx.pluginManager;
						if (pm === undefined || pm === false || typeof pm.listPlugins !== "function" || typeof pm.reload !== "function") {
							return { reload: "不可用", why: "自热重载不可用，且内核没提供 pluginManager", probe, hint: "手动在插件页点关闭→再点打开" };
						}
						let rows;
						try { rows = await pm.listPlugins(); } catch (error) {
							return { reload: "失败", why: String((error && error.message) || error) };
						}
						const teamRows = (Array.isArray(rows) ? rows : []).filter((r) => `${String(r && r.entryId || "")}${String(r && r.moduleName || "")}${String(r && r.patchId || "")}`.includes("dsh-team"));
						if (teamRows.length === 0) return { reload: "没找到", why: "pluginManager.listPlugins() 里没有 dsh-team 的 entry", scanned: Array.isArray(rows) ? rows.length : 0 };
						const blocked = teamRows.filter((r) => r.readOnlyReason !== undefined);
						if (blocked.length > 0) return { reload: "只读", why: teamRows.map((r) => `${String(r.entryId)}:${String(r.readOnlyReason)}`).join("｜"), hint: "手动在插件页点关闭→再点打开" };
						const ids = teamRows.map((r) => String(r.entryId || "")).filter((x) => x !== "");
						if (ids.length === 0) return { reload: "没找到", why: "entryId 全空" };
						const before = { at: Date.now(), codeTag: "reload-action-v1" };
						let outcome;
						try {
							// ★ 必须走 configure()：它内部是 `hmr.runExclusive(operation)`。
							// 裸调 reload() 会报 "HMR profile reconciliation must run inside runExclusive"
							// （2026-11-01 实测踩到）。configure 是 pluginManager 自己的排他包装器。
							outcome = await pm.configure(() => pm.reload(ids));
						} catch (error) {
							return { reload: "失败", why: String((error && error.message) || error), ids };
						}
						// 重载成功后，新代码里的 apply 会重新跑；这里返回的是**旧实例**看到的结果，
						// 所以把「已提交」写进状态文件，供下一次调用确认真的换了代。
						try { saveJson(nodePath.join(stateDirPath(), "reload-log.json"), { ...before, ids, outcome: outcome === undefined ? null : outcome }); } catch { /* 诊断 */ }
						return { reload: "已提交", ids, outcome: outcome === undefined ? null : outcome, note: "新实例会重跑 apply；用 scan 看 codeTag 有没有变" };
					}
					case "goal": {
						const leadId = resolveLead(caller);
						const text = String(args.text || "").trim();
						if (text === "") { goals.delete(leadId); persistAll(); return { goal: "cleared（面板回落显示 Lead 会话标题）" }; }
						goals.set(leadId, { text, at: Date.now() });
						persistAll();
						return { goal: text.slice(0, 80), nextStep: "下一步：task(action2:\"create\") 拆单" };
					}
					case "save": {
						const leadId = resolveLead(caller);
						const name2 = String(args.name2 || ("team-" + leadId.slice(-8)));
						// compact:true = 只存「目标 + 拆单 + 状态」，给新对话继承用（不带成员/走位细节）
						const dest = args.compact === true || String(args.compact) === "true"
							? writeCompactTeamFile(leadId, name2)
							: writeTeamFile(leadId, name2);
						if (dest === undefined) throw new Error("队伍文件写入失败（检查 teamDir 路径）");
						persistAll();
						return args.compact === true || String(args.compact) === "true"
							? { saved: dest, compact: true, inherit: `新对话里 team(action:"adopt", name2:"${name2}", force:true) 即可继承目标与拆单状态` }
							: { saved: dest, heartbeat: "每10s随状态自动刷新 savedAt；本 Lead 会话存续期间该文件锁定不可被别队认领" };
					}
					case "teams": {
						let files = [];
						try { files = nodeFs.readdirSync(cfg.teamDir).filter((f) => f.endsWith(".json")); } catch { /* empty dir */ }
						const rows = [];
						for (const f of files) {
							const data = loadJson(nodePath.join(cfg.teamDir, f), null);
							if (data === null || data.leadSessionId === undefined) continue;
							const locked = await leadExists(String(data.leadSessionId));
							const mine = String(data.leadSessionId) === resolveLead(caller);
							const done = (data.tasks || []).filter((tk) => tk.status === "done").length;
							rows.push(f.replace(/\.json$/, "") + "|" + (mine ? "本队" : locked ? "🔒锁定(Lead会话存在)" : "可认领") + (data.compact === true ? "|精简(可继承)" : "|成员" + (data.members || []).length) + "|任务" + done + "/" + (data.tasks || []).length + "|存于" + dayStamp(new Date(data.savedAt || 0)));
						}
						return { dir: cfg.teamDir, teams: rows, live: crossTeams(resolveLead(caller)) };
					}
					case "adopt": {
						const name2 = String(args.name2 || "").trim();
						if (name2 === "") throw new Error("adopt 需要 name2（队伍文件名）");
						const src = nodePath.join(cfg.teamDir, name2.replace(/[\\\/:*?"<>|]/g, "_") + ".json");
						const data = loadJson(src, null);
						if (data === null) throw new Error("队伍文件不存在：" + src);
						if (await leadExists(String(data.leadSessionId)) && String(data.leadSessionId) !== resolveLead(caller)) {
							throw new Error("拒绝认领：" + name2 + " 的原 Lead 会话仍存在（" + String(data.leadSessionId) + "）——即使冷启动后没在用，会话在就锁队。要接手请先删除那个对话。");
						}
						const leadId = resolveLead(caller);
						const board = boardFor(leadId);
						if (board.tasks.size > 0 && args.force !== true && String(args.force) !== "true") throw new Error("本会话已有任务板（" + board.tasks.size + " 条），adopt 会清空覆盖 — 确认请带 force:true");
						// adopt = 接手这个队：档案里没有的成员让位。不清的话名册只增不减，
						// 上一个档案拉起的成员会一直空转占名额、占路由（实测：连 adopt 两轮后
						// 名册变成 demo+mini1 两条）。
						const archiveNames = new Set((data.members || []).map((m) => m.name));
						const evicted = [];
						for (const [sid, mm] of Array.from(members.entries())) {
							if (mm.parentSessionId !== leadId) continue;
							if (archiveNames.has(mm.name)) continue;
							ctx.subagents.interrupt(sid, { kind: "ancestor", agent: caller });
							members.delete(sid);
							rememberRetired(sid, mm);
							memberPool.drop(sid); // adopt 换血踢掉的 = 不要的人，不给复用捡回来
							evicted.push(mm.name);
						}
						// rebuild board with full history
						board.tasks.clear();
						let seq = 0;
						for (const tk of data.tasks || []) {
							// 精简档案只带「目标/拆单/状态」，缺的字段在这里补默认值：caps/blockedBy
							// 若是 undefined，后面的候选过滤会直接抛，整块板子废掉。
							const restored = {
								body: "", briefPath: "", preassigned: false, revision: 1, prio: 0,
								demand: "2", kind: "grunt", size: "m",
								...tk,
								caps: Array.isArray(tk.caps) ? tk.caps : [],
								blockedBy: Array.isArray(tk.blockedBy) ? tk.blockedBy : [],
								artifacts: Array.isArray(tk.artifacts) ? tk.artifacts : [],
							};
							// 档案里的 claimed 没有持有者（成员是重拉的，currentTask 都是 null），
							// 原样恢复会变成永久幽灵单、把下游挡死 —— 退回 open，owner 保留当提示
							if (restored.status === "claimed") {
								restored.status = "open";
								restored.claimedAt = null;
								restored.lastReport = "adopt 恢复：原 claimed 任务退回 open（持有者不会随档案复活）";
							}
							board.tasks.set(restored.tid, restored);
							const n = Number(/^t(\d+)$/.exec(restored.tid)?.[1] || 0); if (n > seq) seq = n;
						}
						board.seq = seq;
						// 精简档案的 goal 是对象（{text}），整档是字符串 —— 两种都要能吃
						const adoptedGoal = typeof data.goal === "string" ? data.goal : String((data.goal && data.goal.text) || "");
						if (adoptedGoal !== "") goals.set(leadId, { text: adoptedGoal, at: Date.now() });
						// 板子马上重建：留任成员手里的 currentTask 会变成新板上同号 tid 的假持有关系
						for (const mm of members.values()) {
							if (mm.parentSessionId === leadId) mm.currentTask = null;
						}
						// re-spawn members on recorded routes (fresh context; task board carries the progress)
						const revived = [];
						const aliveNames = new Set(Array.from(members.values()).filter((mm) => mm.parentSessionId === leadId).map((mm) => mm.name));
						for (const m of data.members || []) {
							if (aliveNames.has(m.name)) { revived.push(m.name + ":KEPT(alive)"); continue; }
							// 2026-11-02 设计确定：优先复用：档案里的成员如果还在本队成员池里
							// （名字对得上），直接唤醒那个旧会话，不新起子智能体。
							{
								const poolCands = memberPool.candidates(leadId, m.provider, m.model, new Set(members.keys()), new Set()).filter((c) => c.rec.name === m.name);
								let woken = undefined;
								for (const c of poolCands) {
									if (banList.isBanned(c.sessionId)) { memberPool.drop(c.sessionId); continue; } // 档案里的人被队长禁用过：不复用，走下面的新起
									const rec = memberPool.claim(c.sessionId, leadId);
									if (rec === undefined) continue;
									// 档案里的档位可能是**当年的**（2026-11-02 实测：退役僵尸被
									// coldResume 重放 balanced，路由现在不支持，第一个请求就死）——
									// 唤醒前按台账现在支持的档压一遍再登记。
									let adoptGear = m.effort;
									{
										const e0 = ledger.get(`${m.provider}/${m.model}`);
										const lad = effortLadder(e0);
										if (lad.length > 0 && lad.indexOf(String(m.effort || "").toLowerCase()) === -1) adoptGear = lad[lad.length - 1];
									}
									woken = await wakePoolMember(c.sessionId, rec, leadId, caller,
										`你是${m.name}，队伍档案 ${name2} 接手（adopt）把你唤醒。任务板已恢复（team(task) 可查，产物路径在任务 brief_path 里），写根 ${rec.workdir || memberWorkdir(leadId, m.name, "")}。先待命，等领单；历史里没结的旧任务一律作废。`,
										{ provider: m.provider, model: m.model, effort: adoptGear, demand: m.demand === undefined || m.demand === null ? "" : String(m.demand), effortWhy: "adopt 复用唤醒（档位按台账重压）" });
									if (woken !== undefined) break;
								}
								if (woken !== undefined) { revived.push(m.name + ":REUSED(池唤醒)"); continue; }
							}
							try {
								const childId = randomUUID();
								// 档案里记着写根就用它；没记就按本队基底补（继承原始落盘位置）
								const wd = m.workdir || memberWorkdir(leadId, m.name, "");
								const mkErr = ensureWriteRoot(wd);
								const workdir = mkErr === undefined ? wd : nodePath.join(teamMeta(leadId, name2).root, m.name);
								if (mkErr !== undefined) ensureWriteRoot(workdir);
								const member = { name: m.name, parentSessionId: leadId, provider: m.provider, model: m.model, effort: m.effort, demand: m.demand === undefined || m.demand === null ? String(DEMAND_DEFAULT) : String(m.demand), effortWhy: "adopt 继承档案", caps: m.caps || [], currentTask: null, spawnedAt: Date.now(), lastResult: null, lastError: null, lastEvent: null, lastEventAt: null, lastStreamAt: null, workdir, sandboxMode: "pending", outOfWorkspace: outsideWorkspace(workdir), deniedCount: 0, deniedPaths: [] };
								members.set(childId, member);
								const activation = await ctx.subagents.startActivation({ provider: "spawn", childId, label: m.name + " (adopted)", parent: caller, cwd: workdir, prompt: [{ type: "text", text: `写根（默认产出目录；${WORKSPACE_ROOT} 外会被拒）：${workdir}\n你是` + m.name + "，由队伍档案 " + name2 + " 重建。任务板已恢复（team(task) 可查，产物路径在任务 brief_path 里）。先待命，等领单。" }], agentOptions: { provider: m.provider, model: m.model, reasoningEffort: m.effort }, request: { parent: caller, cwd: workdir, prompt: [{ type: "text", text: `写根（默认产出目录；${WORKSPACE_ROOT} 外会被拒）：${workdir}\n你是` + m.name + "，由队伍档案 " + name2 + " 重建。任务板已恢复（team(task) 可查，产物路径在任务 brief_path 里）。先待命，等领单。" }], agentOptions: { provider: m.provider, model: m.model, reasoningEffort: m.effort } }, delivery: "parent", signal: exec.signal });
								pinMemberMode(activation, childId, member);
								revived.push(m.name + "@" + m.provider + "/" + m.model);
							} catch (error) { revived.push(m.name + ":FAILED " + String(error).slice(0, 60)); }
						}
						savedTeams.set(leadId, name2);
						writeTeamFile(leadId, name2);
						persistAll();
						return { adopted: name2, board: board.tasks.size + " tasks", members: revived, ...(evicted.length === 0 ? {} : { evicted: evicted.join(",") + " 已移出（档案里没有这个成员）" }) };
					}
					default:
						throw new Error(`unknown action ${action}`);
				}
			})();
			return withNotices(out, mailLead);
		},
	};

	function splitCsv(value) { return String(value || "").split(/[,，]/).map((s) => s.trim()).filter(Boolean); }
	/** 2026-11-02 皮皮测试报告（瑕疵 2）：demand=5 以前静默夹到 d3，和 size/kind「写错就拒」口径不一致。
	 *  空串 = 用默认档；合法 = 1|1+|2|2+|3|3+|max；其它一律拒（拒的样子跟 set 里原来那句一字不差）。
	 *  @param {unknown} value 原始参数
	 *  @returns {string} 规范化后的原样值（"" 表示未给） */
	function checkDemand(value) {
		const raw = String(value === undefined || value === null ? "" : value).trim();
		if (raw === "") return "";
		if (!/^[123]\+?$/i.test(raw) && raw.toLowerCase() !== "max") throw new Error(`demand 只能是 1|1+|2|3|max，收到 ${raw}`);
		return raw;
	}
	/** 2026-11-02 皮皮测试报告（瑕疵 1）：批量 remove ">=t26" 会把 100+ 条「不在板上」逐条列出来，
	 *  真正该看的 removed/count 被噪音淹掉。这里把连续的 tN 折成区间（t29~t225），非 tN 的原样留着。
	 *  @param {string[]} list tid 列表（已按用户给的顺序）
	 *  @returns {string[]} 聚合后的片段，如 ["t29~t225","junk"] */
	function summarizeMissingTids(list) {
		const nums = [];
		const rest = [];
		for (const x of list) {
			const m = /^t([0-9]+)$/i.exec(String(x).trim());
			if (m === null) rest.push(String(x));
			else nums.push(Number(m[1]));
		}
		nums.sort((a, b) => a - b);
		const segs = [];
		for (const n of nums) {
			const last = segs.length === 0 ? undefined : segs[segs.length - 1];
			if (last !== undefined && n === last[1] + 1) last[1] = n;
			else segs.push([n, n]);
		}
		return segs.map(([a, b]) => (a === b ? `t${a}` : `t${a}~t${b}`)).concat(rest);
	}
	// Same first-party text projection session-query uses (blockText/extractSessionEventText),
	// copied so we read history through the service instead of depending on a third-party route.
	function contentText(content) {
		return (Array.isArray(content) ? content : []).flatMap((block) => {
			if (!block || typeof block !== "object") return [];
			if (block.type === "text") return [String(block.text ?? "")];
			if (block.type === "tool-call") return [String(block.name ?? "") + " " + String(block.arguments ?? "")];
			return [];
		}).map((part) => part.trim()).filter(Boolean).join("\n");
	}
	function eventText(event) {
		const d = event && event.data ? event.data : {};
		switch (event && event.type) {
			case "user/message": return contentText(d.content);
			case "assistant/message": return contentText(d.message && d.message.content);
			case "tool/call": return [d.name, d.arguments].filter(Boolean).join(" ").trim();
			case "tool/result": return contentText(d.message && d.message.content);
			case "turn/end": return d.reason && d.reason.kind ? String(d.reason.kind) : "";
			default: return "";
		}
	}
	// Team-scoped lookup: a Lead may only address its own members by name.
	// A raw session id still resolves, but only inside the same team.
	function findMember(nameOrId, leadId) {
		if (nameOrId === undefined) return undefined;
		const want = String(nameOrId);
		for (const member of members.values()) {
			if (leadId !== undefined && member.parentSessionId !== leadId) continue;
			if (member.name === want) return member;
		}
		const byId = members.get(want);
		if (byId !== undefined && (leadId === undefined || byId.parentSessionId === leadId)) return byId;
		return undefined;
	}
	function countUnmatched() {
		const mdPath = ledgerMdPathOf(cfg);
		if (mdPath === null) return 0;
		try {
			const text = nodeFs.readFileSync(mdPath, "utf8");
			const known = new Set([...text.matchAll(/^\|\s*\d+\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/gm)].map((m) => `${m[1].trim()}/${m[2].trim()}`));
			return Array.from(ledger.keys()).filter((k) => !known.has(k)).length;
		} catch { return ledger.size; }
	}

	// Who is holding a route right now — across every team in this process. Free
	// quota is shared, so "another team is already running this model" must be
	// visible before a Lead spawns onto it.
	function routeOccupancy() {
		const out = new Map();
		for (const member of members.values()) {
			const agent = ctx.agents.get(sessionIdOf(member));
			const live = agent !== undefined && String(agent.status) === "running";
			// A stale pointer (task deleted or already settled) is not an occupancy.
			const boardOfMember = boards.get(member.parentSessionId);
			const held = boardOfMember !== undefined && member.currentTask !== null && member.currentTask !== undefined
				? boardOfMember.tasks.get(member.currentTask)
				: undefined;
			const holds = held !== undefined && (held.status === "claimed" || held.status === "open");
			if (!live && !holds) continue;
			const route = member.provider + "/" + member.model;
			const board = boardOfMember;
			const team = board !== undefined && board.meta !== null && board.meta !== undefined ? board.meta.slug : "队-" + String(member.parentSessionId).slice(-6);
			const list = out.get(route) || [];
			list.push({ team, member: member.name, lead: member.parentSessionId, state: live ? "跑" : "占" });
			out.set(route, list);
		}
		return out;
	}
	/** One-line-per-route occupancy summary, empty when nothing is held. */
	function busySummary(occupancy, selfLead) {
		const rows = [];
		for (const [route, users] of occupancy) {
			const mine = users.every((u) => u.lead === selfLead);
			rows.push(`${route} ← ` + users.map((u) => `${mine ? "本队" : u.team}/${u.member} ${u.state}`).join("，"));
			if (rows.length >= 6) break;
		}
		return rows;
	}

	/** 读全部按天错误日志（`.state/errors/*.jsonl`）。
	 *  评分要长期证据：errors.json 只留最近 60 条，会天天翻篇，不够算故障率。
	 *  单日文件超过 8MB 就不再追加（`ERRLOG_MAX_BYTES`），所以这里扫描的量有天然上限。
	 *  解析失败的行直接跳过 —— 半行 JSON 不该让评分整个崩掉。 */
	function readAllErrorRows() {
		const out = [];
		let names = [];
		try { names = nodeFs.readdirSync(errorsDir).filter((n) => n.endsWith(".jsonl")).sort(); } catch { return out; }
		for (const name of names) {
			let text = "";
			try { text = nodeFs.readFileSync(nodePath.join(errorsDir, name), "utf8"); } catch { continue; }
			for (const line of text.split(/\r?\n/)) {
				if (line === "") continue;
				try {
					const row = JSON.parse(line);
					if (row !== null && typeof row === "object") out.push(row);
				} catch { /* 半行/坏行跳过 */ }
			}
		}
		return out;
	}

	/** 队长人工品质分（`team(action:"score")`）的平均值。
	 *  维护方 2026-11-01 定：「没队长打分的时候忽略不计」—— 一条都没有就返回 null，
	 *  评分公式里 quality 乘 1.00，等于这一维完全不参与。
	 *  打分按任务 kind 记；现在先给全池平均，后续要按 kind 分档时在这里细分。 */
	function qualityAvgOf() {
		const qPath = nodePath.join(stateDirPath(), "quality.json");
		let raw = null;
		try { raw = loadJson(qPath, null); } catch { raw = null; }
		const list = Array.isArray(raw) ? raw : (raw !== null && typeof raw === "object" && Array.isArray(raw.scores) ? raw.scores : []);
		let sum = 0;
		let wsum = 0;
		for (const r of list) {
			const v = Number(r && r.score);
			if (!Number.isFinite(v) || v <= 0) continue;
			const w = Number(r && r.weight);
			const weight = Number.isFinite(w) && w > 0 ? w : 1;
			sum += v * weight;
			wsum += weight;
		}
		return wsum > 0 ? sum / wsum : null;
	}

	/** 评分表（进程内 30 秒缓存）。
	 *  面板 2.5 秒拉一次、pickRoute 每次派活也要用，错误日志是 5 个按天文件 ——
	 *  每次都读盘会把文件读成热文件。缓存存 globalThis：同一个会话里的热重载
	 *  能保住缓存，别的实例各自算各自的，互不干扰。
	 *  证据两源：TEAM 真派战绩（带故障分类）+ OFM 请求账（带逐日解码时长）。 */
	function scoreTableNow() {
		const nowTick = Date.now();
		if (nowTick - (globalThis.__scoreAt || 0) > 30000) {
			globalThis.__scoreAt = nowTick;
			try { globalThis.__scoreRows = readAllErrorRows(); } catch { globalThis.__scoreRows = globalThis.__scoreRows || []; }
			try { globalThis.__scoreStats = readOfmStats(); } catch { globalThis.__scoreStats = globalThis.__scoreStats || null; }
		}
		const rows = globalThis.__scoreRows || [];
		const stats = globalThis.__scoreStats || null;
		const perRoute = bucketByRoute(rows);
		const ofmHoursOf = (key) => {
			if (stats === null || stats.ok !== true) return 0;
			const row = stats.models[key] === undefined ? stats.models[String(key).replace(/^our-free-model\//, "")] : stats.models[key];
			return row === undefined ? 0 : Number(row.decodeMs || 0) / 3600000;
		};
		try {
			return buildScoreTable([...ledger.values()], perRoute, qualityAvgOf(), ofmHoursOf);
		} catch {
			return { table: new Map(), base: null };
		}
	}

	// compact digest: never the full table into context.
	// Ordering answers "what should I spawn next": unheld routes first, then real-run-proven.
	/** 四档计数（与面板同源：都读 scoreTableNow 算出来的 tier）。
	 *  2026-11-01：加这个是因为 `team(models)` 汇总行原来读 `status === "unknown"`，
	 *  那是「台账知不知道自己探过活」，跟四档的「样本够不够」不是一回事 ——
	 *  维护方看见的两个未测数字对不上，就是这里。 */
	function tierCount(want) {
		const table = scoreTableNow().table;
		let n = 0;
		for (const e of ledger.values()) {
			const s = table.get(`${e.provider}/${e.model}`);
			if (s !== undefined && s.tier === want) n += 1;
		}
		return n;
	}
	function ledgerDigest(filter, selfLead) {
		const entries = Array.from(ledger.values()).filter((e) => !filter || `${e.provider}/${e.model}`.includes(filter));
		const leadKeys = leadRouteKeys();
		const occupied = routeOccupancy();
		const heldElsewhere = (e) => (occupied.get(e.provider + "/" + e.model) || []).filter((u) => selfLead === undefined || u.lead !== selfLead);
		const ok = entries.filter((e) => dispatchable(e) && !leadKeys.has(e.provider + "/" + e.model));
		// 队长在用的路由不是"消失"，要看得见：单独列出来标住，别让人以为台账里没这条。
		const mine = entries.filter((e) => leadKeys.has(e.provider + "/" + e.model));
		const closed = entries.filter((e) => e.whitelist === "closed");
		const dead = entries.filter((e) => e.status === "invalid");
		const top = ok
			.sort((a, b) => (heldElsewhere(a).length === 0 ? 0 : 1) - (heldElsewhere(b).length === 0 ? 0 : 1)
				|| (b.realResult === "ok" ? 1 : 0) - (a.realResult === "ok" ? 1 : 0)
				// 2026-11-01 拆 OFM：再按实测判档排（只排序，不排除），同档里按预计耗时快的优先
				|| (ofmRank(b) === null ? 0 : ofmRank(b)) - (ofmRank(a) === null ? 0 : ofmRank(a))
				|| ofmSpeedRank(a) - ofmSpeedRank(b)
				|| Number(effectiveBackoff(b) < Date.now()) - Number(effectiveBackoff(a) < Date.now()))
			.slice(0, 8)
			.map((e) => {
				const users = occupied.get(e.provider + "/" + e.model);
				const busy = users === undefined ? "" : " [占用:" + users.map((u) => u.team + "/" + u.member).join(",") + "]";
				const capRank = effortCapRank(e);
				const capGear = capRank < 0 ? undefined : gearAt(effortLadder(e), capRank);
				const cap = capGear === undefined ? "" : ` 封顶:${capGear}`;
				const ofmBit = ofmBadge(e.ofm) === "" ? "" : ` [OFM ${ofmBadge(e.ofm)}]`;
				return `${e.provider}/${e.model} ${ctxK(e.ctx) === null ? "ctx=无数据" : `ctx=${e.ctx}(标称)`} ${ctxK(e.out) === null ? "out=无数据" : `out=${e.out}(标称)`} eff=${e.efforts}${cap}${e.vision === true ? " 👁读图" : ""}${e.realResult === "ok" ? " [真派ok]" : ""}${e.backoffUntil > Date.now() ? " [退避中]" : ""}${ofmBit}${busy}`;
			});
		const busy = Array.from(occupied.keys()).length === 0 ? "" : "\n占用中：" + Array.from(occupied, ([route, users]) => `${route}←` + users.map((u) => `${u.team}/${u.member}(${u.state})`).join("，")).join("｜");
		const sized = ok.map((e) => ({ c: ctxK(e.ctx), o: ctxK(e.out) }));
		const withCtx = sized.filter((x) => x.c !== null);
		const noData = sized.length - withCtx.length;
		const atCtx = (k) => withCtx.filter((x) => x.c >= k).length;
		const outMax = withCtx.reduce((m, x) => (x.o !== null && x.o > m ? x.o : m), 0);
		const atOut = (k) => withCtx.filter((x) => x.o !== null && x.o >= k).length;
		const ladder = `能力阶梯（ctx=硬门槛, out 只决定分几批写）：`
			+ `ctx标称≥1M ${atCtx(1024)}条｜≥512K ${atCtx(512)}条｜≥256K ${atCtx(256)}条｜≥128K ${atCtx(128)}条｜ctx无数据 ${noData}条(不可承诺,只配小活)\n`
			+ `单次输出：最大 ${outMax === 0 ? "无数据" : `${outMax}K`}｜≥131K ${atOut(131)}条｜≥33K ${atOut(33)}条｜out无数据 ${sized.filter((x) => x.o === null).length}条\n`
			// the actionable conclusion, not just numbers: output is batchable, context is not
			+ `⇒ 产出再大也不用拆任务——派单时插件会按该路由 out 标称值要求「分批写文件」；只有 ctx 是硬门槛：输入超过池子最大 ${maxCtxK() === 0 ? "（当前无 ctx 数据）" : `${maxCtxK()}K`} 就必须拆任务，否则内核会静默压缩、结果不可信`;
		return `catalog 的 ctx/out/eff 全是标称值，不是实测；「无数据」= 插件不知道，不能当成无限\n`
			// 2026-11-01：这里的「未测」改成读**评分表的四档**，不再读 status === "unknown"。
			// 维护方提问「为啥未测还有 6 个」时发现这是两套判据：status 是「台账知不知道自己
			// 探过活」，四档的未测是「有多少条样本」，两者根本不是一回事 ——
			// status=unknown 的条目里有派过 25 次全失败的路由，也有白名单没开的。
			// 面板上画的是四档，这里数字必须跟面板同源，否则两处对不上账。
			+ `ledger ${entries.length} 行：可派 ${ok.length}｜队长 ${mine.length}｜沉底/失效 ${dead.length}｜白名单未开 ${closed.length}｜未测 ${tierCount("未测")}（四档口径：样本 <${MIN_RUNS} 次）\n`
			+ (mine.length === 0 ? "" : mine.map((e) => `⚠️ ${e.provider}/${e.model} 队长（绝不派给成员）`).join("\n") + "\n")
			+ `${top.join("\n")}\n${ladder}${busy}`;
	}

	// member epoch accounting: subagent/end gives the terminal stopReason.
	// (Real-run ok/fail already rides agent/status + agent/error above.)
	// This also recycles the member's task (#14): a member that died mid-task must
	// not leave the board claiming work nobody is doing.
	// A short ack ("收到"/"好"/"知道了") is not a delivery: small models use it to
	// acknowledge a rework instruction and then end the turn. Anything that names a
	// real artifact (完成/写/路径/报告/…) counts as substantive.
	const isShortAck = (text) => {
		const s = String(text || "").trim();
		if (s.length >= 16) return false;
		return !/(完成|done|已写|已改|已生成|产出|文件|路径|报告|结论|验证|生成|修复|附件|结果|产物)/i.test(s);
	};
	/** 回报净化（R7）：产物侧已经禁掉思考流，回报侧还在整段吐「So I need to…/让我想想…」。
	 *  保守做法：按句子切开，只丢掉**以思考套话开头**的句子；拿不准就保留原文，
	 *  绝不因为净化把真正的结论删掉（宁可留长一点）。 */
	const THINK_OPENER = /^(?:we need to|we should|we can|we'll|we will|we have|let me|let's|i need to|i should|i'll|i will|i have|now,|now i|first,|firstly|next,|then,|okay|ok,|hmm+|so,|so i|looking at|based on the|让我|我先|我来|我要|我需要|首先|先看|接下来|然后|好的[，,、]?|那么|嗯+)/i;
	const sanitizeReport = (text, max = 240) => {
		const raw = String(text === undefined || text === null ? "" : text).replace(/\r/g, "");
		const parts = raw.split(/(?<=[。！？!?；;\n])/).map((s) => s.trim()).filter((s) => s !== "");
		const kept = parts.filter((s) => !THINK_OPENER.test(s));
		const out = (kept.length > 0 ? kept.join("") : raw).replace(/\s+/g, " ").trim();
		return out.slice(0, max);
	};
	const unbindSubEnd = ctx.on("subagent/end", (info) => {
		const member = members.get(info.id);
		if (member === undefined) return;
		const stop = String(info.stopReason || "unknown");
		const endedTask = member.currentTask; // the task this epoch ran, before recycling
		member.lastResult = stop;
		// 成员自己调 finish 时 currentTask 当场被清掉，下面那条分支就看不到了；
		// 用 lastTask 补一次：刚结完的那单如果没留回报，把它的原话写进去。
		if (member.currentTask === null && member.lastTask !== undefined && member.lastTask !== null) {
			const b0 = boards.get(member.parentSessionId);
			const t0 = b0 === undefined ? undefined : b0.tasks.get(member.lastTask.tid);
			if (t0 !== undefined && (t0.lastReport === null || t0.lastReport === "")) {
				const txt0 = Array.isArray(info.lastAssistantMessage)
					? info.lastAssistantMessage.map((x) => x && x.type === "text" ? x.text : "").join(" ").trim()
					: "";
				if (txt0 !== "") { t0.lastReport = txt0.slice(0, 160); persistAll(); }
			}
		}
		if (member.currentTask !== null) {
			const board = boards.get(member.parentSessionId);
			const task = board === undefined ? undefined : board.tasks.get(member.currentTask);
			let keptForContinue = false;
			if (task !== undefined) {
				// 竞态闸：这单可能已经被别人重新领走（实测 t18：w3 撞 16/16 worker limit 异常
				// 结束时，w4 已经在跑同一张单）。此时再把它退回 open 会覆盖 w4 的认领，
				// notice 也会骗 Lead 去重派。只有"单还是我名下、且仍 claimed"才允许改状态。
				if (task.status !== "claimed" || task.owner !== member.name) {
					pushNotice(member.parentSessionId, "状态竞态", `${member.name} 结束时 ${task.tid} 已归 ${task.owner || "?"}（${task.status}），插件不回退也不改状态；它这次「${stop}」只记进战绩。别再照旧 notice 重派这张单`);
					member.currentTask = null;
				} else {
				let text = "";
				if (Array.isArray(info.lastAssistantMessage)) text = info.lastAssistantMessage.map((block) => block && block.type === "text" ? block.text : "").join(" ").trim();
				// sandbox denials are evidence for the Lead, not a member failure: append
				// the paths so the escalation decision rides the same report (#07).
				const deniedNote = member.deniedCount ? `｜撞沙盒${member.deniedCount}次：${(member.deniedPaths || []).join(" ")}` : "";
				if (text !== "") task.lastReport = (text.slice(0, 160) + deniedNote).slice(0, 240);
				// only a FAILED end loses the task: a clean turn end can be a member
				// waiting for its next message, so keep its claim (the panel marks it
				// stale after 10 min and the Lead can re-dispatch).
				if (stop === "error" || stop === "aborted" || stop === "max-tokens") {
					// 撞顶自动续写（维护方 2026-11-01 定）：max-tokens 不是"这单干砸了"，
					// 是"这一条回复写不完"。既然插件已经给它排了「继续」，**这单必须留在它
					// 名下** —— 退回 open 会让别人领走，它续写时写的是没有主的活，两边一起改
					// 同一批文件。所以：还有续写机会 → 保住认领，只记一条状态说明。
					const cont = stop === "max-tokens" ? continueState.get(sessionId) : undefined;
					const maxRuns = Math.max(1, Number(cfg.autoContinueMaxRuns || 3));
					const willContinue = stop === "max-tokens"
						&& cfg.autoContinue === true
						&& cont !== undefined
						&& Number(cont.runs || 0) > 0
						&& Number(cont.runs || 0) <= maxRuns;
					if (willContinue) {
						const n = Number(cont.runs || 0);
						noteStatus(task, "claimed", "plugin", `${member.name} 输出撞顶，插件第 ${n} 次自动续写`);
						task.lastReport = `成员 ${member.name} 输出撞顶（max-tokens），插件 ${Math.max(1, Number(cfg.autoContinueDelaySec || 10))} 秒后自动发「继续」（第 ${n}/${Math.max(1, Number(cfg.autoContinueMaxRuns || 3))} 次），任务仍归它，产物可能只写了一半` + deniedNote;
						if (task.error !== undefined) delete task.error;
						// 这是半截，不是一次完整的成败样本：战绩不记，续写完再记。
						skipScoreOnce.add(member.name);
						keptForContinue = true;
					} else {
					const whyStop = stop === "max-tokens" ? "输出被截断（max-tokens），产物可能只写了一半" : stop === "aborted" ? "被中止" : `报错${member.lastError ? "：" + String(member.lastError).slice(0, 60) : ""}`;
					noteStatus(task, "open", "plugin", `${member.name} 异常结束（${whyStop}），已退回`);
					task.status = "open";
					task.owner = null;
					task.revision += 1;
					task.claimedAt = null;
					if (text === "") task.lastReport = `成员 ${member.name} 结束（${stop}）未结案，任务已退回` + (member.lastError ? `：${String(member.lastError).slice(0, 90)}` : member.lastToolError ? `：${String(member.lastToolError).slice(0, 90)}` : "");
					// 以前 max-tokens 只改状态不吭声：Lead 只看到"任务又变 open"，不知道是
					// 输出被截断、产物可能半个。三种异常结束都推一条，理由分开写。
					const why = stop === "max-tokens" ? "输出被截断（max-tokens），产物可能只写了一半" : stop === "aborted" ? "被中止" : `报错${member.lastError ? "：" + String(member.lastError).slice(0, 60) : ""}`;
					task.error = `成员异常结束：${why}`;
					// 这单在这条路由上已经被压缩过 = 这条路由装不下它。退回 open 之前把门槛抬起来，
					// 否则下一次自动派单/补员又会挑一条同样小的，把死循环原样重开（实测烧了 57 分钟）。
					if (Number(task.compactN || 0) > 0) markRouteTooSmall(task, member, `异常结束且已被压缩 ${task.compactN} 次`);
					pushNotice(member.parentSessionId, "成员异常结束", `${member.name} 的 ${task.tid} ${why}；任务已退回 open，重派前先看写根有没有半成品`);
					}
				} else if (text !== "" && !isShortAck(text)) {
					// 弱模型干完活常常不调 finish（实测：auto3 写完产物就结束，任务永久挂
					// claimed，而 owner 已经不会再动了）。正常收尾 + 有实质发言 = 认定干完，
					// 自动结单并把它的原话留在 lastReport 里供复核（插件不做内容验收）。
					// 但自动结单同样要过产物门槛，否则不调 finish 就成了绕过校验的后门。
					const autoBad = verifyArtifacts(task, member);
					if (autoBad.length > 0) {
						noteStatus(task, "open", "plugin", `${member.name} 正常结束但声明产物没落盘，已退回`);
						task.status = "open";
						task.owner = null;
						task.preassigned = false;
						task.revision += 1;
						task.claimedAt = null;
						task.cooldownFor = member.name;
						task.cooldownUntil = Date.now() + 60000;
						task.lastReport = `成员 ${member.name} 正常结束但产物没落盘（${autoBad.map((b) => `${b.path}:${b.why}`).join("；")}），任务退回` + deniedNote;
						task.error = `产物未落盘：${autoBad.map((b) => `${b.path}(${b.why})`).join("；")}`.slice(0, 300);
						pushNotice(member.parentSessionId, "产物缺失", `${member.name} 的 ${task.tid} 结束但声明产物没落盘（${autoBad.map((b) => b.path).join("、")}），任务退回 open`);
					} else {
						noteStatus(task, "done", "plugin", `${member.name} 正常结束未调 finish，插件自动结单`);
						task.status = "done";
						task.finishedAt = Date.now();
						task.revision += 1;
						if (task.error !== undefined) delete task.error;
						task.lastReport = (text.slice(0, 150) + "｜成员正常结束未调 finish，插件自动结单，产物见写根（插件不验收内容）" + deniedNote).slice(0, 240);
					}
				} else if (text !== "") {
					// 短回执：返工场景下小模型拿它当交付，任务不能算完成——退回 open，让
					// Lead 或别的成员接手（10-28 Capacity 实测：回"收到"就想下班）。
					noteStatus(task, "open", "plugin", `${member.name} 只回短回执「${text.slice(0, 20)}」，视为没干活`);
					task.status = "open";
					task.owner = null;
					task.preassigned = false; // 预指派不清会让同一个人立刻再领，形成摸鱼循环
					task.revision += 1;
					task.claimedAt = null;
					task.cooldownFor = member.name; // 自动派单 60s 内跳过这个人
					task.cooldownUntil = Date.now() + 60000;
					task.lastReport = `成员 ${member.name} 只回了短回执「${text.slice(0, 20)}」，视为没干活，任务退回` + deniedNote;
					task.error = `短回执视为未交付：「${text.slice(0, 40)}」`;
				} else {
					// 正常结束但一句话没说：不敢判干完了，放回 open 等下一个
					noteStatus(task, "open", "plugin", `${member.name} 正常结束但没回话，已退回`);
					task.status = "open";
					task.owner = null;
					task.revision += 1;
					task.claimedAt = null;
					task.lastReport = `成员 ${member.name} 正常结束但没回话，任务已退回`;
					task.error = "成员正常结束但未回话，未见交付";
				}
				}
			}
			// 续写中的成员**留着 currentTask** —— 否则下一次 idle 补派会把它当空闲，
			// 再塞一张单给一个正在续写上一张的 agent。
			if (!keptForContinue) member.currentTask = null;
		}
		// #15: a model-level fault must reach the Lead without the member having to
		// speak (a broken model can't be trusted to report itself). One line, with
		// the attribution and a clipped excerpt of the raw error.
		// 2026-11-01：改为走 src/errpush.js 盒子 —— 认人、定路（队长不行就递别的空闲队长）、
		// 拼身份证（成员+队长短号+tid+路由+错误类）全在盒子里，这里只给事实。
		if (stop === "error") {
			const err = String(member.lastError || member.lastToolError || "").replace(/\s+/g, " ").trim();
			const tid = endedTask === null ? "" : ` tid:${endedTask}`;
			pushFault({
				sessionId: sessionIdOf(member),
				memberName: member.name,
				fix: member.lastErrorFix === undefined ? "" : String(member.lastErrorFix),
				tid: endedTask === null ? "" : String(endedTask),
				route: `${member.provider}/${member.model}`,
				effort: String(member.effort || ""),
				errClass: member.lastErrorClass || "未归类",
				leads: [...new Set([...boards.keys(), ...goals.keys()])],
			}, {
				kind: "成员模型故障",
				text: err === "" ? "" : `原文：${err.slice(0, 200)}`,
			}, {
				members,
				retiredMembers,
				agentsGet: (id) => (ctx.agents && typeof ctx.agents.get === "function" ? ctx.agents.get(id) : undefined),
				resolveLead,
				pushNotice,
				leadHealth: (leadId) => leadHealthOf(leadId),
				idleOtherLeads: (excludeId) => idleLeadSessions(excludeId),
			});
			archiveError({ at: Date.now(), kind: "model-fault", route: member.provider + "/" + member.model, effort: member.effort, by: member.name, class: member.lastErrorClass || "未归类", raw: err.slice(0, 600), tid: endedTask, stop });
		}
		// 战绩记账（只记，不参与选路）：这次跑成没成，归到「路由@档位 × kind」名下
		// 撞顶续写中的那一轮先不记（半截不是完整样本），等它真正收尾那一轮再记。
		if (skipScoreOnce.has(member.name)) skipScoreOnce.delete(member.name);
		else if (endedTask !== null) {
			const sb = boards.get(member.parentSessionId);
			const st = sb === undefined ? undefined : sb.tasks.get(endedTask);
			bumpScore(`${member.provider}/${member.model}`, member.effort, st === undefined ? "grunt" : st.kind, !(stop === "error" || stop === "aborted" || stop === "max-tokens"));
		}
		persistAll();
		// 成员结束 = 它手上的文件锁必须放掉，否则一次异常退出就卡死所有排队的人
		try { releaseAllLocksOf(info.id); } catch { /* 放锁失败不影响收尾 */ }
	});

	// =====================================================================
	// 文件占用表（维护方 2026-10-30 定的共享锁）
	//
	// 需求原话：多人要改同一个文件时，先查表 → 没人占用就写上「谁在改」→ 改完自动清掉 →
	// 后来的人查到有人在改就排队等 → 前一个放锁后**按顺序只通知队首那一个**（绝不广播，
	// 否则文件一空两人同时上，又是一次覆盖）。锁是**全局**的（跨队跨会话），因为两支队的
	// 成员同样会撞同一个文件。插件自己监控、自己释放、卡死自动回收。
	//
	// 三条边界必须先说清：
	//  1. 表是**插件维护**的，不是成员自己去写。成员唯一的视野是工具结果，所以它在
	//     write/edit 被拦的那一刻会看到「X 正被 auto2 修改，完成后会通知你」。
	//  2. 锁只覆盖 `write`/`edit`（改文件），不锁 `read`（读永远放行）。
	//  3. 成员崩了/被 kill，锁不能永久卡死：超时（默认 10 分钟）无人心跳自动释放，
	//     并在面板标「疑似残留」，谁接手都能看见。
	// =====================================================================
	/** 挂到 tools/pre-execute：任何 write/edit 之前先过这张表。 */
	// 文件占用表：模块化后由 src/locks.js 提供（原来是这里的闭包，逻辑未变）。
	const locks = createLocks({ ctx, cfg, members, shortOf, pushNotice });
	const { locksPath, fileLocks, LOCK_STALE_MS, lockKeyOf, absPathOf, saveFileLocks, reapStaleLocks, writerOf, acquireLock, releaseLock, notifyLockFree, releaseAllLocksOf, lockRows } = locks;

	const WRITE_TOOLS = new Set(["write", "edit", "str_replace_editor", "multi_edit", "notebook_edit"]);
	const lockHeldFor = new Map(); // exec -> { key, absPath }，给 post-execute 放锁用
	const unbindPreExec = ctx.on("tools/pre-execute", async (exec, next) => {
		if (!ctxAlive()) return next();
		const name = String(exec && exec.name ? exec.name : "");
		if (!WRITE_TOOLS.has(name)) return next();
		const args = exec && exec.arguments ? exec.arguments : {};
		const raw = args.file_path !== undefined ? args.file_path : args.path;
		if (typeof raw !== "string" || raw.trim() === "") return next();
		const agent = exec.agent;
		const sessionCwd = (() => {
			try {
				const h = agent && agent.session && agent.session.header ? agent.session.header : undefined;
				if (h !== undefined && h !== null && typeof h.cwd === "string" && h.cwd !== "") return h.cwd;
			} catch { /* 读不到 header 就退回队长 cwd */ }
			return "";
		})();
		const absPath = absPathOf(raw, sessionCwd);
		if (absPath === "") return next();
		const who = writerOf(agent && agent.session ? agent.session.id : "");
		const got = acquireLock(absPath, who, Date.now());
		if (got.ok !== true) {
			const h = got.holder;
			const holderText = h === null || h === undefined ? "别人" : `${h.member}${h.task ? "（" + h.task + "）" : ""}`;
			return {
				kind: "deny",
				reason: `${nodePath.basename(absPath)} 正被 ${holderText} 修改中。你已经排到第 ${got.queuePos} 位，${holderText} 放锁后插件会通知你文件可操作（不会同时叫醒多人）。现在别硬写 —— 先干别的活，或等这条通知。`,
			};
		}
		lockHeldFor.set(exec, { key: got.key, absPath });
		return next();
	});
	/** 工具跑完（成功或失败）都要放锁：失败也该放，否则一次报错就永久卡住所有人。 */
	const unbindPostExec = ctx.on("tools/post-execute", async (exec, result, next) => {
		if (!ctxAlive()) return typeof next === "function" ? next() : undefined;
		const held = lockHeldFor.get(exec);
		if (held === undefined) return typeof next === "function" ? next() : undefined;
		lockHeldFor.delete(exec);
		const who = writerOf(exec.agent && exec.agent.session ? exec.agent.session.id : "");
		try { await releaseLock(held.absPath, who, Date.now()); } catch { /* 放锁失败不该拖垮工具结果 */ }
		return typeof next === "function" ? next() : undefined;
	});
	/** 面板要用：当前所有被占/有人排队的文件，按「谁在改」排好。 */

	// =====================================================================
	// 压缩提醒（维护方 2026-10-30 定稿）
	//
	// 设计说明：「你只需要在压缩发生的时候提醒，你的上下文内容被压缩，最终产出不可仅凭记忆。
	//           如果全程不出现压缩，压根都不要提醒」
	//
	// 所以这里**没有任何占用率扫描、没有压缩线预测、没有 70%/90% 分档** ——
	// 那套是错的：压缩什么时候来不可预测，猜它等于每 10 秒赌一次，还必然误报。
	//
	// 改成**只听内核的事实**：内核压缩时会写 `compaction/start` 和 `compaction/end`
	// （见 dsh-compaction-basic / dsh-context-mode 的 precompact 监听器）。
	// 插件只订阅 `compaction/end`，事件一到就说一次话；没压缩就全程静默、零开销。
	//
	// 消息里要讲清三件事（都来自这次实测，不是套话）：
	//   ① 你的上下文被压缩了 → 终稿不能仅凭记忆，必须落盘；
	//   ② 压缩后的上下文只知道"大概"，要细节就查 CTX 索引，要原文拆 ZSTD 底档；
	//   ③ 别凭压缩后的印象编造或重做 —— 原文没丢，丢的是"你还知道它在哪"。
	const compactNoticePath = nodePath.join(stateDirPath(), "compact-notice.json");
	/** 成员 sessionId -> 上次提醒的时间戳（防连环压缩刷屏；也用于面板展示） */
	const compactNotices = new Map(Object.entries(loadJson(compactNoticePath, {})));
	const saveCompactNotices = () => { try { saveJson(compactNoticePath, Object.fromEntries(compactNotices)); } catch { /* 写不进就只留内存 */ } };
	/** 给被压缩的那个成员说的话。事实陈述 + 三层查法 + 不许凭记忆，不说软话也不编。
	 *  2026-10-31 实测（隔壁 auto1 一单压了 15 次）：第 1 次说「别凭记忆、要落盘」是对的；
	 *  第 2 次往后光说这三句没用 —— 它压完就去重读同一批文件（实测 pkg/lib/index.js 读了 5 次），
	 *  读回来又把窗口顶回压缩线，形成「压缩→重读→再压缩」。所以第 2 次起换成命令式：
	 *  别再扩读、手上有什么就落什么、立刻结单。 */
	function compactionNoticeText(member, count) {
		const who = member === undefined || member === null ? "" : `你（${member.name}，${member.provider}/${member.model}）`;
		const taskPart = member === undefined || member === null || member.currentTask === null
			? "当前没有在跑的单。"
			: `当前在跑 ${member.currentTask}。`;
		const n = Number(count || 1);
		if (n >= 2) {
			// 第 2 次起：短、命令式。这一条不是讲道理，是止损。
			return `【第 ${n} 次压缩】${who}这一轮又被压了 ${n} 次，同一个任务反复压缩只有一个原因：`
				+ "你一直在把大文件读进上下文，读回来又顶到压缩线，再被压缩一次。\n"
				+ `现在起**停止扩读**：不要再 open 新文件、不要再整份 read 已经读过的文件（${taskPart}）\n`
				+ "① 手上已有的结论立刻写进写根的文件，写成能交的样子；\n"
				+ "② 写完就 team(action:\"task\", action2:\"finish\")，在回报里写清「干到哪、缺什么」——\n"
				+ "   缺的部分交给队长处置，比你自己硬扛更靠得住；\n"
				+ "③ 确实还需要原文，就查 CTX/ZSTD 底档（一条没删），不要再往上下文里搬整份文件。";
		}
		return `【上下文已被压缩】${who}这一轮的历史被内核压缩了 —— 摘要之外的内容你**已经不再拥有**。${taskPart}`
			+ "从现在起：\n"
			+ "① **最终产出不可仅凭记忆**：手上已有的结论、数据、路径立刻落盘到写根的文件；已干完就直接 finish，别拖。\n"
			+ "② 需要细节时按粒度往下查：上下文里留下的 archive 索引只是**大概**（做过什么、结论在哪层）；"
			+ "再具体就 ctx_search 查 CTX 库（原文片段）；要一字不差就拆 ZSTD 会话底档（原文全在，一条没删）。\n"
			+ "③ 压缩后最容易犯的错不是忘，而是**忘了却以为没忘**：要读的文件重新 read 一遍再判断；"
			+ "发现自己可能在重复劳动，立刻上报队长。";
	}
	/** 压缩 = 实测证据：同一张单压到第 2 次还没结单，就**自动把窗口 +1 档**并换到够大的路由
	 *  （维护方 2026-10-31 定：「不停压缩 2 次以上没产出，直接 +1 档上下文，别一直死循环」）。
	 *
	 *  为什么必须由插件做、而不是推给队长：
	 *  - 队长看到提醒再去 retool，中间又烧掉几轮；跨会话那两句话根本来不及。
	 *  - kill 掉成员也没用 —— 单退回 open 后补员又按 `size` 挑一条同样小的路由，
	 *    把同一个死循环原样重开（某次实测 实测：kill 完立刻又被派回去）。
	 *  所以这里做两件事：① 把 `task.ctxMin` 抬到下一档并**落盘**（之后派单/补员/换路由
	 *  全部按它筛，小路由再也接不到这单）；② 原地把当前成员换到够大的路由，下一步生效，
	 *  不用重派。抬到顶档（MAX_TIERS）仍被压缩，才说明池子里没有能装下这单的窗口 —— 那时
	 *  才推队长拆任务，而且不再自动重派。
	 *  @returns {{target:number, from:number, route:string|null, error:string|null}|undefined} */
	const AUTO_TIER_AT = 2; // 第 2 次压缩就开始抬（第 1 次还可能是正常的上下文整理）
	const MAX_TIERS = 3;    // s=128 → 最多抬到 1024，再往上没有意义，改为请队长拆单
	function bumpCtxTier(member, task, seenCount) {
		if (task === undefined || task === null || member === undefined || member === null) return undefined;
		const from = taskNeedCtx(task);
		const done = Number(task.ctxTierN || 0);
		if (done >= MAX_TIERS) return { target: from, from, route: null, error: `已自动抬过 ${done} 档仍被压缩，池子里没有更合适的大窗口` };
		const target = nextCtxTierK(from);
		if (target <= from) return { target: from, from, route: null, error: `已经顶到最大档 ${from}K` };
		const leadId = member.parentSessionId;
		const curKey = `${member.provider}/${member.model}`;
		const exclude = [curKey, ...(Array.isArray(task.ctxTried) ? task.ctxTried : [])];
		const pk = pickRoute(task.kind || "grunt", task.size || "m", leadId, exclude, { vision: task.vision === true, needCtx: target });
		// 无论换没换成，门槛都要落盘：这是这单"装得下"的下限，之后所有入口按它筛。
		task.ctxMin = target;
		task.ctxTierN = done + 1;
		task.revision += 1;
		if (pk.error !== undefined) {
			task.ctxTried = [...(Array.isArray(task.ctxTried) ? task.ctxTried : []), curKey].slice(-8);
			persistAll();
			return { target, from, route: null, error: pk.error };
		}
		const fromRoute = `${member.provider}/${member.model}@${member.effort}`;
		member.provider = pk.entry.provider; // live agent 下一步走新路由（和 retool 同一条通道）
		member.model = pk.entry.model;
		member.routeSource = "plugin";
		member.effortWhy = `压缩自动+1档（要 ≥${target}K）`;
		applyDemand(member, task);
		task.ctxTried = [...(Array.isArray(task.ctxTried) ? task.ctxTried : []), curKey].slice(-8);
		persistAll();
		// 这单已经按更大窗口重开了，压缩计数从零算 —— 否则旧账会把新路由也判成"反复压缩"。
		task.compactN = 0;
		task.compactBy = member.name;
		const route = `${member.provider}/${member.model}@${member.effort}`;
		pushNotice(leadId, "已自动+1档窗口", `${task.tid}《${task.title}》压了 ${Number(seenCount || 2)} 次还没产出，插件已把 ${member.name} 从 ${fromRoute}（窗口 ${from}K）换到 ${route}（窗口 ${target}K），下一步就用新窗口继续，不用重派${done > 0 ? `（第 ${done + 1} 次抬档）` : ""}。`);
		if (ctx.logger) ctx.logger.info(`dsh-team: auto ctx tier ${task.tid} ${from}K -> ${target}K (${route})`);
		return { target, from, route, fromRoute, error: null };
	}

	/** 成员从这单上下来了（被 kill / 异常结束 / 退回），而它已经压过 —— 这单的窗口下限必须记住。
	 *  否则 kill 掉再派、或者异常结束退回 open，补员会按 size 又挑一条同样小的路由，
	 *  同一个压缩死循环原样重开（维护方 2026-10-31 亲口骂的就是这个："他KILL没用，转头插件自己又派"）。
	 *  只记"这条路由不行"（ctxTried）并抬一档门槛（ctxMin），不动路由选择本身。 */
	/** 2026-11-02 设计确定：（「如果在判断一个成员已经混乱的前提下，禁用这个成员，新开一个」
	 *  ＋「第一次是成员混乱，如果新开同模型还混乱就是模型不行，第2次就要标记模型分数」）：
	 *  队长看着产出判混乱 → 拉黑这个**子会话**（内核没有真清空上下文的 API —— /compact 是
	 *  摘要接续，混乱会被摘进摘要继续带毒；retool 同会话换模型也是带着旧上下文上岗，
	 *  还会把「上下文乱」误判成「模型不行」）。所以唯一干净的做法是禁用+新起。
	 *  归因走对照实验：这单钉在同一条路由上（task.cloneRoute），补员用**全新会话**在同模型
	 *  重跑 —— 变量只剩「上下文干净与否」；同一条路由第 2 次被队长判乱 → 判模型本身不行：
	 *  记一条模型差评（bumpScore false 进战绩），解除钉选，重派换别的路由。 */
	function banAndReplace(member, opts = {}) {
		const leadId = member.parentSessionId;
		const sid = sessionIdOf(member);
		const route = member.provider + "/" + member.model;
		const board = boards.get(leadId);
		let held = member.currentTask === null || member.currentTask === undefined || member.currentTask === "" ? undefined : (board === undefined ? undefined : board.tasks.get(member.currentTask));
		// 2026-11-02 t74 实测断链：交过单的人被 ban 时 currentTask 已清空（finish 会清指针），
		// 「无在手任务」就不计数 —— 第二次判乱记不上模型分。兜底：板上 status=open/delivered 且
		// owner 还是它名字的，就是它留下的那单（owner 按名不按人：这人可能已经不在名册里）。
		if (held === undefined && board !== undefined) {
			for (const t of board.tasks.values()) {
				if ((t.status === "delivered" || t.status === "open" || t.status === "claimed") && t.owner === member.name) { held = t; break; }
			}
		}
		const task = opts.task !== undefined ? opts.task : held;
		let judged = "无在手任务";
		if (task !== undefined && task !== null) {
			const n = Number(task.banCount || 0) + 1;
			task.banCount = n;
			const secondOnSameRoute = n >= 2 && String(task.cloneRoute || "") === route;
			if (secondOnSameRoute) {
				// 第二次：干净新会话在同模型上还乱 → 不是上下文的事，是模型不行。
				bumpScore(route, String(task.cloneGear || member.effort || ""), task.kind || "grunt", false);
				delete task.cloneRoute;
				delete task.cloneGear;
				const e = ledger.get(route);
				if (e !== undefined) { e.banBad = Number(e.banBad || 0) + 1; }
				judged = "同模型干净重跑第 " + n + " 次仍判乱 → 记模型差评（" + route + "），重派换路由";
			} else {
				const e0 = ledger.get(route);
				if (e0 !== undefined && (wallUntil(e0) !== null || groupHalted(e0))) {
					// 路由正撞墙/组停：拿它做对照毫无意义（新会话一样干不了活），不钉，重派照常换路由。
					delete task.cloneRoute;
					judged = "路由撞墙/停摆，对照无意义：不钉路由，重派换别条（本单第 " + n + " 次判乱）";
				} else {
					task.cloneRoute = route; // 钉住同一条路由：补员新起干净会话照原模型对照重跑
					task.cloneGear = member.effort; // 档位一起钉：第二次判定的模型差评要记在 路由@档位 上
					judged = n === 1 ? "首次判乱：拉黑该会话，这单钉 " + route + " 用干净新会话对照重跑" : "换过路由后再判乱（第 " + n + " 次）：重新钉 " + route + " 对照";
				}
			}
			// claimed=在干活、delivered=交上来的正是乱产物（reject ban_member 走这里）—— 两种都要退回；
			// deliverer 早已离册时按名匹配会落空，所以用 owner（名字）而不是在册成员对象比对。
			if ((task.status === "claimed" || task.status === "delivered") && task.owner === member.name) {
				noteStatus(task, "open", "plugin", "成员 " + member.name + " 被队长判产出混乱（" + String(opts.reason || "").slice(0, 80) + "），禁用并退回");
				task.status = "open"; task.owner = null; task.preassigned = false; task.claimedAt = null;
				task.lastReport = ("成员 " + member.name + " 产出被队长判混乱（" + String(opts.reason || "（未给理由）").slice(0, 80) + "）：会话已禁用永不复用，任务退回 open；" + judged).slice(0, 240);
				task.error = "产出判乱（队长认定）：" + String(opts.reason || "").slice(0, 120);
			}
		}
		try { const leadAgent = ctx.agents.get(leadId); if (leadAgent !== undefined) ctx.subagents.interrupt(sid, { kind: "ancestor", agent: leadAgent }); } catch { /* 叫停失败不阻断禁用 */ }
		members.delete(sid);
		rememberRetired(sid, member);
		memberPool.drop(sid);
		banList.add(sid, { name: member.name, leadId, route, reason: String(opts.reason || "").slice(0, 160) });
		member.currentTask = null;
		persistAll();
		Promise.resolve(autoFillOne(leadId, { bypass: true })).catch(() => {});
		pushNotice(leadId, "已禁用成员会话", member.name + "（" + route + "）会话 " + String(sid).slice(0, 8) + " 已禁用：永不复用；" + judged);
		return { banned: member.name, sessionId: String(sid), route, judged };
	}
	function markRouteTooSmall(task, member, reason) {
		if (task === undefined || task === null || member === undefined || member === null) return;
		const key = `${member.provider}/${member.model}`;
		const tried = Array.isArray(task.ctxTried) ? task.ctxTried.slice() : [];
		if (!tried.includes(key)) tried.push(key);
		task.ctxTried = tried.slice(-8);
		const done = Number(task.ctxTierN || 0);
		if (done < MAX_TIERS) {
			const from = taskNeedCtx(task);
			const target = nextCtxTierK(from);
			if (target > from) {
				task.ctxMin = target;
				task.ctxTierN = done + 1;
			}
		}
		task.revision += 1;
		task.lastReport = `${member.name} 已从这单撤下（${reason}）：它的 ${key} 已被记入"试过且装不下"，这单下次只派 ctx ≥${taskNeedCtx(task)}K 的路由`;
	}

	/** 压缩结束：内核已经写完了 `compaction/end`，原作已被替换 —— 只在这时说话。 */
	function onCompacted(sessionId, member) {
		const now = Date.now();
		// 2026-10-31 实测（隔壁 auto1 一单 15 次压缩、37 步、57 分钟没结单）：
		// 压缩次数本身是**最有价值的证据** —— 同一个任务在同一个成员身上压第 N 次，
		// 说明这单的实际 ctx 需求远超这条路由的窗口，不是成员在偷懒。
		// 以前这个数字哪都没记，队长直到维护方自己看见才知情。现在按单记。
		const board = member === undefined || member === null ? undefined : boards.get(member.parentSessionId);
		const task = board === undefined || member.currentTask === null || member.currentTask === undefined
			? undefined
			: board.tasks.get(member.currentTask);
		let count = 0;
		if (task !== undefined) {
			// 换了人接着干就重新计：这是新的一次尝试，不是旧账。
			if (task.compactBy !== null && task.compactBy !== undefined && task.compactBy !== member.name) {
				task.compactN = 0;
			}
			task.compactN = Number(task.compactN || 0) + 1;
			task.compactBy = member.name;
			task.compactAt = now;
			count = task.compactN;
			persistAll();
		}
		// ★ 自动 +1 档（维护方 2026-10-31 定）：压到第 2 次还没产出，就是"这条路由装不下这单"的
		//   硬证据 —— 插件自己把窗口抬一档并原地换路由，不再等队长看提醒、更不许 kill 完又派回小路由。
		//   抬档成功会把 compactN 归零（这单已按更大窗口重开，旧账不该算到新路由头上）。
		let tier = undefined;
		if (task !== undefined && count >= AUTO_TIER_AT) {
			tier = bumpCtxTier(member, task, count);
			count = Number(task.compactN || 0);
			if (tier !== undefined && tier.route === null) {
				// 抬不动了：池子里没有更大的窗口。这单不再自动重派，等队长拆单/降输入。
				task.lastReport = `压到第 ${AUTO_TIER_AT} 次仍装不下（已抬到 ${tier.target}K）：${tier.error}`;
				pushNotice(member.parentSessionId, "压缩顶格｜要拆单", `${task.tid}《${task.title}》在 ${member.name} 身上反复被压缩，插件已自动把窗口抬到 ${tier.target}K 仍装不下（${tier.error}）。这单不会再自动重派，避免继续烧额度。请拆小输入（或 action2:"reopen" 后重建成两张更小的单）。`);
				persistAll();
				return;
			}
		}
		// 剩下的只是告知：插件已经把窗口抬过了（或这单还没到抬档线），队长只需要知道
		// "它被压过、产出不可仅凭记忆"这一层。原来那套"压到 4 次推队长做 retool/kill"
		// 已经没用了 —— 插件自己抬档比队长反应快，而且 kill 之后补员又会派回小路由。
		const gap = Math.max(0, Number(cfg.compactNoticeMinGapMs || 0));
		const last = Number(compactNotices.get(sessionId) || 0);
		const due = !(last > 0 && now - last < gap);
		const leadId = member === undefined || member === null ? null : member.parentSessionId;
		const bumped = tier !== undefined && tier.route !== null;
		if (due || bumped) {
			compactNotices.set(sessionId, now);
			saveCompactNotices();
		}
		if (leadId !== null && due && !bumped) {
			const name = member === undefined || member === null ? sessionId : member.name;
			const extra = task === undefined ? "" : "，这单已压 " + count + " 次";
			pushNotice(leadId, "成员被压缩", name + " 的上下文已被内核压缩（历史丢了一段）" + extra + "；插件已提醒它：最终产出不可仅凭记忆、要落盘、要查就查 CTX/ZSTD 底档。同一张单压到第 " + AUTO_TIER_AT + " 次，插件会自动把窗口抬一档并换路由，不用你手动 retool。");
		}
		// 成员提醒：刚抬过档就不说话（它下一步已经换窗口了，再灌一段文字只是又占上下文）。
		// 其余按原节流；抬到顶格之后不再给成员发（那时它需要的是止损，不是又一段说明）。
		if (!due || bumped) return;
		const text = compactionNoticeText(member, count);
		const leadAgent = leadId === null ? undefined : ctx.agents.get(leadId);
		if (leadAgent !== undefined) {
			void ctx.subagents.sendMessage(leadAgent, sessionId, [{ type: "text", text }], { signal: AbortSignal.timeout(30000) })
				.catch((error) => { if (ctx.logger) ctx.logger.warn("dsh-team: compaction notice to member failed: " + String(error)); });
		}
	}

	/** OFM 自动更新（维护方 2026-10-31 定：「没有就安装，装了有更新就更新」）。
	 *
	 *  **为什么必须在这里做，而不是让维护方去 OFM 面板点**：
	 *  OFM 自己有一套很严的自更新（Ed25519 签名 manifest + 逐文件 SHA256 + staging →
	 *  backup → install → verifyInstalled）。但它有一条 `installationIsManaged()`：
	 *  只要 `package.json/index.js/client.js` 的 `nlink > 1`（= pnpm 从 tgz 装的硬链接），
	 *  它就认定"这个安装由打包者管理"，**检查更新/热更/自升级全部关闭**，
	 *  面板上那句话就是这里来的（「此安装由安装它的宿主管理」）。
	 *  维护方的 profile 一直是 `file:./vendor/*.tgz`，所以**每装一次都会被 pnpm 重新硬链**，
	 *  自升级能力被反复夺走 —— 这就是"本地又不能升级了"的真身。
	 *
	 *  两条路：
	 *  ① **正常路径**：profile 把 OFM 声明成 `link:…/plugins/dsh-our-free-model`（和 dsh-team
	 *     一样的链接依赖）。pnpm 只会建 junction，nlink 恒为 1，OFM 自己的升级器一直可用。
	 *  ② **兜底路径**：声明还是 tgz 时（被谁改回去了、或者刚在新机器上装完），插件检测到
	 *     nlink>1，就直接调用 OFM 自带的 updater 做这一轮升级 —— 用同一个信任链，
	 *     不自己写下载/安装逻辑。装完把结果（版本、recovery 状态）记进台账历史。
	 *
	 *  每次只做一件事，失败不重试轰炸：有版本差就升，没有就什么都不做。
	 *  @returns {Promise<object>} 诊断结果，面板和 team(status) 都能看到 */
	// 2026-11-01 晚：这两个原来是写死的字面量（`C:\Users\Diccup\...`），config 覆盖不了。
	// 现在取 cfg —— 默认值在 src/config.js 的 defaultPaths() 里，按插件自身位置推导：
	// OFM 包跟本插件同级（<dsh>/.dsh/plugins/dsh-our-free-model），数据目录在 .dsh 根下。
	const OFM_PKG_DIR = String(cfg.ofmPkgDir || "");
	const OFM_DATA_DIR = String(cfg.ofmDataDir || "");
	let ofmAutoLast = { at: 0, result: null };
	async function autoUpdateOfm(force) {
		// 面板每次快照都可能触发，所以重活至少隔 6 小时（和 updateCheckHours 一致）。
		if (force !== true && Date.now() - ofmAutoLast.at < 6 * 60 * 60 * 1000) return ofmAutoLast.result;
		const out = { at: Date.now(), ok: false, did: "没动", version: "", latest: "", error: "", hardlinked: false, upgraded: false };
		ofmAutoLast = { at: out.at, result: out };
		// 只在装了 OFM 的机器上做；没装就是"没有就安装"那一半，需要 profile 层动手，
		// 插件这边只能给出一句话（不能替维护方改 profile 的依赖，那是安装器的事）。
		// 空字符串也走这条：`join("", "package.json")` 会去查**当前工作目录**下的 package.json，
		// 别人的机器上可能真有一个，然后就误判成「装了 OFM」并 import 一个不存在的 updater.js。
		// ★ 2026-11-02 发包踩雷第 2 条：报错必须说清**找过哪两处**。默认值现在按序探测
		//   ① <.dsh>\plugins\dsh-our-free-model（link 装法）② <profile>\node_modules\dsh-our-free-model
		//   （pnpm/tgz 装法）；老版本只推 ①，装在 ② 的机器永远报"还没装 OFM"、永远不自更新。
		if (OFM_PKG_DIR === "" || !nodeFs.existsSync(nodePath.join(OFM_PKG_DIR, "package.json"))) {
			const probe = cfg.ofmPkgDirSrc === "not-found" && nodeFs.existsSync(nodePath.join(OFM_PKG_DIR, "package.json")) === false
				? `（找过 ${OFM_PKG_DIR} 和 ${nodePath.join(String(cfg.ofmProfileDir || ""), "node_modules", "dsh-our-free-model")}）`
				: `（${OFM_PKG_DIR}）`;
			out.error = `这台机器上还没装 OFM${probe === "" ? "" : OFM_PKG_DIR === "" ? "（没配 ofmPkgDir）" : probe}。装法：profile 的 package.json 加依赖 "dsh-our-free-model": "link:<.dsh>\\plugins\\dsh-our-free-model"（正版仓库 Ebony-Vinyl/dsh-our-free-model），装完重启；插件不冒充安装器`;
			return out;
		}
		try {
			const mod = await import(pathToFileUrl(nodePath.join(OFM_PKG_DIR, "src", "updater.js")));
			const chain = mod.default === undefined ? mod : mod.default;
			const installed = JSON.parse(nodeFs.readFileSync(nodePath.join(OFM_PKG_DIR, "package.json"), "utf8")).version;
			out.version = installed;
			// ① 硬链接 = OFM 自己已关掉升级能力：先老实说清楚，再照样帮它把这一轮升了。
			const hardlinked = typeof chain.packageUsesHardLinks === "function" ? chain.packageUsesHardLinks(OFM_PKG_DIR) : false;
			out.hardlinked = hardlinked;
			const updater = new chain.PluginUpdater({ pkgDir: OFM_PKG_DIR, dataDir: OFM_DATA_DIR, settings: () => ({ updateCheckHours: 6 }), log: (m) => { if (ctx.logger) ctx.logger.info("dsh-team/ofm: " + String(m)); } });
			const check = await updater.check();
			out.latest = check.latest;
			if (!check.available) { out.ok = true; out.did = `已是最新（${installed}）`; return out; }
			// ② 有新版：交给 OFM 自己的 apply（签名+逐文件校验+备份+回滚全在它那边）
			const result = await updater.apply({});
			out.ok = true;
			out.did = `已升级 ${result.previous} → ${result.version}（${result.files} 文件 / ${Math.round(result.bytes / 1048576)}MB）`;
			out.upgraded = true;
			const st = updater.status();
			out.restartRequired = st.restartRequired === true;
			appendLedgerHistory(cfg, "our-free-model", "*", "插件自动升级 OFM", out.did + (hardlinked ? "（原安装是 pnpm 硬链接，建议把 profile 里 OFM 改成 link:…/plugins/dsh-our-free-model，恢复它自己的升级按钮）" : ""));
		} catch (error) {
			out.error = String(error && error.message ? error.message : error).slice(0, 300);
		}
		return out;
	}
	/** 本机路径 → file: URL（Windows 反斜杠要转正斜杠，盘符冒号不能编码）。 */
	function pathToFileUrl(p) {
		const fwd = String(p).replace(/\\/g, "/").replace(/^([A-Za-z]):/, "$1:");
		return "file:///" + (fwd.startsWith("/") ? fwd.slice(1) : fwd);
	}

	// --- timers: reprobe via availability.json
	// 2026-11-01：每日扫描的 tick 删了。扫描器 2026-10-29 就退役了（scanScript=null），
	// 那个 tick 每 30 分钟醒一次、读一遍 scan-state.json、判一次「今天扫过没」，
	// 然后调 runScanner 拿到 `{ok:false}`——**永远什么也不做**。
	// 现在「发现新模型」只走下面这条 reprobeTick（OFM 目录 + 内核清单 + 探活），
	// 手动触发走 team(scan)，两条都跟 python 无关。留着一个恒空的定时器只会让人以为还有扫描。

	// OFM 目录同步 + 内核模型清单同步：换版/加减模型后 15 分钟内自动进台账
	const reprobeTick = ctx.timer ? ctx.timer.interval(() => {
		applyAvailability(ctx, cfg);
		try { syncFromOfm(cfg); } catch { /* 下一轮再试 */ }
		void syncFromKernel(ctx, cfg).catch(() => { /* 内核不可用就等下一轮 */ });
		// 2026-11-01：OFM 实测账跟着一起刷（失败率/速度会变，人工打分的证据要新鲜）。
		try { annotateOfmLedger([...ledger.values()], readOfmStats()); } catch { /* OFM 没数据就跳过 */ }
		// OFM 官方最新版：走仓库 feed/manifest.json（不走 npm —— 同名 npm 包是别人的）。
		// 30 分钟缓存，所以这个 15 分钟 tick 实际是"最多半小时问一次"，不会刷网络。
		void refreshOfmRemote().catch(() => { /* 网络不通就沿用上次 */ });
		persistAll();
	}, Math.max(5, cfg.reprobeEveryMinutes) * 60 * 1000) : null;
	// 启动即同步一次：维护方换完 OFM 不用等 15 分钟；内核 provider 注册晚，延迟 8 秒再扫清单
	try { syncFromOfm(cfg); } catch { /* 首次没有目录文件就跳过 */ }
	const ofmRemoteTimer = setTimeout(() => {
		void refreshOfmRemote().catch(() => { /* 网络不通就算了，面板显示"未知" */ });
		// 查完官方版本顺手判一次"要不要自动升级"（维护方 2026-10-31 定：没有就装、有更新就更新）。
		// 放在这里而不是逐 tick 里：它可能真的要下载 38MB，不该被高频 tick 反复触发。
		void autoUpdateOfm(false).then((r) => {
			if (r !== null && r !== undefined && (r.ok !== true || r.did !== "没动")) {
				pushNotice("*", "OFM 自动更新", `已装版本 ${r.version || "?"}${r.latest === null || r.latest === undefined ? "" : "｜官方最新 " + r.latest}｜${r.did}${r.error === null || r.error === undefined ? "" : "｜" + r.error}`);
			}
		}).catch(() => { /* 自动升级失败不打断别的东西 */ });
	}, 12000);
	if (typeof ofmRemoteTimer.unref === "function") ofmRemoteTimer.unref();
	try { syncFromOfm(cfg); } catch { /* 首次没有目录文件就跳过 */ }
	const kernelSyncTimer = setTimeout(() => {
		void syncFromKernel(ctx, cfg).catch(() => { /* provider 没注册完就等下一轮 */ });
	}, 8000);
	if (typeof kernelSyncTimer.unref === "function") kernelSyncTimer.unref();

	// --- panel data lane: loopback HTTP snapshot, NOT session events.
	// The right-sidebar tab polls /api/dsh-team/snapshot; the model never sees a byte.
	// ctx.inject keeps the plugin alive in profiles without a web server.
	ctx.inject(["webServer"], (scoped) => {
		const server = scoped.webServer;
		const handler = (req, res) => {
			try {
				const url = String(req.url || "");
				// 宿主级重载入口（2026-11-01）。为什么需要它：
				//   HMR 每次只会重跑 apply()，但 src/*.js 这些**被深度 import 的模块**留在
				//   ESM 缓存里不换 —— 证据：hook-status 被重写（apply 真跑了）而
				//   syncFromKernel 的 codeTag 还是旧值。
				//   真正的重载 = 宿主 pluginManager.reload(entryIds)，
				//   也就是 UI「关闭→打开」那两下的底层。
				if (/\/reload(\?|$)/.test(url)) {
					const reply = (code, obj) => { res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify(obj)); };
					// 2026-11-01 拆 OFM 之后：先试**自热重载**（按包根清 loadCache，连 src/*.js
					// 一起换），不行才退回内核 pluginManager。?dry=1 只干跑探针。
					const qs = url.indexOf("?") >= 0 ? new URLSearchParams(url.slice(url.indexOf("?") + 1)) : new URLSearchParams();
					const dry = qs.get("dry") === "1" || qs.get("dry") === "true";
					const wantKernel = qs.get("mode") === "kernel";
					let probe;
					try { probe = probeReload(ctx); } catch (error) { probe = { ok: false, error: String((error && error.message) || error) }; }
					if (dry) return reply(200, { reload: "干跑", probe, lastReload: lastReload() });
					if (!wantKernel && probe !== null && probe.canReload === true) {
						if (isReloading()) return reply(200, { reload: "已在重载中", probe });
						reply(200, { reload: "已提交（自热重载）", via: "self", willPurge: probe.cacheKeyCount, srcModules: probe.srcKeys });
						setTimeout(() => {
							selfReload(ctx, { logger: console }).then((r) => {
								try { saveJson(nodePath.join(stateDirPath(), "reload-log.json"), { at: Date.now(), codeTag: "self-reload-v1", result: r, via: "self" }); } catch { /* 诊断 */ }
							}).catch((error) => {
								try { saveJson(nodePath.join(stateDirPath(), "reload-error.json"), { at: Date.now(), error: String((error && error.message) || error) }); } catch { /* 诊断 */ }
							});
						}, 120);
						return undefined;
					}
					const pm = ctx.get ? ctx.get("pluginManager", false) : ctx.pluginManager;
					if (pm === undefined || pm === false || typeof pm.listPlugins !== "function" || typeof pm.reload !== "function") {
						return reply(200, { reload: "不可用", why: "自热重载不可用，且内核没提供 pluginManager", probe });
					}
					pm.listPlugins().then((rows) => {
						const teamRows = (Array.isArray(rows) ? rows : []).filter((r) => `${String(r && r.entryId || "")}${String(r && r.moduleName || "")}${String(r && r.patchId || "")}`.includes("dsh-team"));
						if (teamRows.length === 0) return reply(200, { reload: "没找到", why: "listPlugins 里没有 dsh-team", scanned: Array.isArray(rows) ? rows.length : 0 });
						const blocked = teamRows.filter((r) => r.readOnlyReason !== undefined);
						if (blocked.length > 0) return reply(200, { reload: "只读", why: teamRows.map((r) => `${String(r.entryId)}:${String(r.readOnlyReason)}`).join("｜") });
						const ids = teamRows.map((r) => String(r.entryId || "")).filter((x) => x !== "");
						if (ids.length === 0) return reply(200, { reload: "没找到", why: "entryId 全空" });
						// 先回话再重载：重载会把当前实例拆掉，晚回话就连不上客户端了。
						reply(200, { reload: "已提交", ids, note: "重载后 apply 会重跑；用 scan 看 codeTag 变没变" });
						setTimeout(() => {
							// ★ 必须用 pm.configure()：内部 hmr.runExclusive()，裸调 reload 会报
							// "HMR profile reconciliation must run inside runExclusive"。
							pm.configure(() => pm.reload(ids)).catch(() => { /* 失败已无从回报（实例已换） */ });
						}, 120);
						return undefined;
					}).catch((error) => reply(200, { reload: "失败", why: String((error && error.message) || error) }));
					return undefined;
				}
				// 面板「跨会话消息」一键清除（2026-11-04 设计确定：）：只清投递流水 mailLog
				// （面板给人扫的那 20 条显示），**不碰 mailBox** —— 信箱是 Agent 读的那条，
				// 每箱 MAIL_BOX_MAX 条兜底，清了它等于把别人还没读的信删掉。
				if (/\/mail\/clear(\?|$)/.test(url)) {
					clearMailLog();
					res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
					res.end(JSON.stringify({ cleared: true, mail: mailLog.slice(-MAIL_PANEL_MAX) }));
					return;
				}
				// prefix dispatch: url may be "/snapshot", "/api/dsh-team/snapshot",
				// or carry a query; match the tail, not the head.
				if (!/\/snapshot(\?|$)/.test(url)) { res.writeHead(404); res.end(); return; }
				// session scope (#03): the tab passes its own session id, so the panel
				// shows ONE team. Without it the payload stays global (back-compat).
				let leadScope;
				{
					const q = url.indexOf("?");
					if (q >= 0) {
						try {
							const lead = new URLSearchParams(url.slice(q + 1)).get("lead");
							if (lead !== null && lead.trim() !== "") leadScope = lead.trim();
						} catch { /* keep global */ }
					}
				}
				const inScope = (leadId) => leadScope === undefined || String(leadId) === leadScope;
				// 面板每几秒被拉一次：顺手做兜底扫描（内部 20s 节流），别的会话撞墙也能进台账
				void sweepErrors(false);
				// 2026-10-29 维护方报「重载后一直显示 5 个队长」：markLiveUsage 只有 team 调用才跑，
				// 面板被拉时没人触发 → liveLeadSessions 永远是 null（尚未问过内核）→ 全部
				// roots 都算队长。这里也触发一次（内部 15s 节流），面板自己就能收敛。
				try { markLiveUsage(); } catch { /* 标注失败不影响面板 */ }
				// 2026-11-01：OFM 实测账也在这里挂（面板 2.5s 拉一次，不能每次都读盘）。
				// 30 秒节流：够新鲜，又不至于把 stats.json 读成热文件。
				{
					const nowTick = Date.now();
					if (nowTick - (globalThis.__ofmStatsAt || 0) > 30000) {
						globalThis.__ofmStatsAt = nowTick;
						try { annotateOfmLedger([...ledger.values()], readOfmStats()); } catch { /* OFM 没数据就跳过 */ }
					}
				}
				// 2026-11-01 设计确定：四档（推荐=最好用的 / 可用=能用但有小问题 /
				// 不稳=能用但经常出问题 / 未测=样本不够）：判据全在 src/score.js，
				// 面板和 pickRoute 读同一张表，不再各算一份。
				const scoreTable = scoreTableNow();
				const memberRows = [];
				for (const [sessionId, member] of members) {
					if (!inScope(member.parentSessionId)) continue;
					const agent = ctx.agents.get(sessionId);
					const header = agent && agent.session.requestHeader ? agent.session.requestHeader() : undefined;
					const live = agent ? String(agent.status) : "cold";
					memberRows.push({
						name: member.name,
						lead: member.parentSessionId,
						status: live,
						want: member.provider + "/" + member.model + "@" + member.effort,
						actual: header && header.config ? header.config.provider + "/" + header.config.model + "@" + (header.config.reasoningEffort || "default") : null,
						task: member.currentTask,
						lastResult: member.lastResult,
						lastError: member.lastError,
						lastErrorClass: member.lastErrorClass || null,
						lastToolError: member.lastToolError || null,
						loop: member.loopAt != null ? member.toolErrStreak || 3 : null,
						stuck: stuckOf(member, live),
						spawnedAt: member.spawnedAt || null,
						lastEvent: member.lastEvent || null,
						lastEventAgo: member.lastEventAt !== null ? Math.round((Date.now() - member.lastEventAt) / 1000) : null,
						streamAgo: member.lastStreamAt != null ? Math.round((Date.now() - member.lastStreamAt) / 1000) : null,
						runningTool: member.lastEvent ? /tool\//.test(member.lastEvent) : false,
					});
				}
			const taskRows = [];
			const nowMs = Date.now();
			for (const [taskLead, board] of boards) {
				if (!inScope(taskLead)) continue;
				for (const task of board.tasks.values()) {
					const ownerMember = Array.from(members.values()).find((mm) => mm.name === task.owner && mm.parentSessionId === taskLead);
					const ownerAgent = ownerMember === undefined ? undefined : ctx.agents.get(sessionIdOf(ownerMember));
					const stale = task.status === "claimed" && (ownerAgent === undefined || ownerAgent.status !== "running") && task.claimedAt !== null && nowMs - task.claimedAt > 10 * 60 * 1000;
					// 下游：谁在等我。只显示上游的话，Lead 看不出"这条一结会解锁什么"。
					const blocks = Array.from(board.tasks.values()).filter((t) => (t.blockedBy || []).includes(task.tid)).map((t) => t.tid);
					taskRows.push({ lead: taskLead, tid: task.tid, title: task.title, status: task.status, owner: task.owner, preassigned: task.preassigned === true, prio: task.prio, revision: task.revision, vision: task.vision === true, blockedBy: task.blockedBy || [], blocks, artifacts: task.artifacts || [], noArtifact: task.noArtifact === true, createdAt: task.createdAt || null, claimedAt: task.claimedAt || null, finishedAt: task.finishedAt || null, lastReport: task.lastReport || null, error: task.error || null, rejections: (task.rejections || []).length, stale, trail: Array.isArray(task.trail) ? task.trail.slice(-8) : [] });
				}
			}
				const leadKeys = leadRouteKeys();
				// 2026-10-30 维护方报「自动派出去的成员在右边台账里没标注、还是可用状态」：
				// 占用信息以前只在 team(models) 的文本里算，面板这条数据线从来没带出去，
				// 于是成员正跑着的路由在面板上照样是绿点。现在把 routeOccupancy() 一并塞进快照，
				// 面板据此标「成员在用」并把绿点降级（别处要用模型时会先挑没人标注的）。
				const occupancyNow = routeOccupancy();
				const ledgerRows = Array.from(ledger.values()).map((entry) => {
					const keyOfEntry = entry.provider + "/" + entry.model;
					const holders = occupancyNow.get(keyOfEntry);
					return {
					key: keyOfEntry, status: leadKeys.has(keyOfEntry) ? "lead" : entry.status, ctx: entry.ctx, out: entry.out, efforts: entry.efforts,
					// 实测跑过的最大输入（tokens）：报错给的是硬上限，这个给的是下界，两个都要露出来
					seen: Number(entry.seenMax) > 0 ? Number(entry.seenMax) : null, seenAt: entry.seenMaxAt || null, seenTurn: entry.seenMaxTurn === undefined ? null : entry.seenMaxTurn,
					// 累计正常干活时长 00Y00D00H + 成功轮次（真扛过多久活）
					used: fmtUsed(entry.usedMs), usedMs: Number(entry.usedMs || 0), usedRuns: Number(entry.usedRuns || 0),
					ctxRaw: Number(entry.ctxRaw) > 0 ? Number(entry.ctxRaw) : null,
					whitelist: entry.whitelist, real: entry.realResult, realAt: entry.realAt, errClass: entry.errClass,
					// 退避到什么时候：取路由退避和组停的较大值（见 effectiveBackoff）——
					// 以前这里读 entry.backoffUntil，qodercn 那条显示 2 分钟，实际整池停到本地 0:05，
					// 面板和 groups.json 两个数打架。
					backoff: effectiveBackoff(entry) > Date.now() ? effectiveBackoff(entry) : null, note: ledgerNote(entry),
					// 输出撞顶（max-tokens 截断）：既不是 ok 也不是 fail，以前面板完全看不见 —— 单独给字段
					truncated: Number(entry.truncatedAt) > 0 ? Number(entry.truncatedAt) : null,
					truncatedN: Number(entry.truncatedN || 0),
					// 视觉能力：true=能读图 / false=不能 / null=未知（数据显示成 👁，未知不显示）
					vision: entry.vision === true ? true : entry.vision === false ? false : null,
					visionSrc: entry.visionSrc === undefined ? null : String(entry.visionSrc),
					// -1 = 组停已到期、还没探活（until 是 0），面板据此显示「等探活」而不是空白。
					groupHalt: groupHalted(entry) ? ((groupHalt.get(groupIdOf(entry)) || {}).until || -1) : null,
					// 谁正占着这条：成员/别队的成员都算。空数组=没人占，可直接派。
					holders: holders === undefined ? [] : holders.map((u) => ({ team: u.team, member: u.member, lead: u.lead, state: u.state })),
					// 显示名：和聊天框下方那个名字同源（内核 catalog 的 model.name）。
					// **只给展示层用** —— key/model 一个字都不动，派单和白名单照旧按原始 id 匹配。
					displayName: typeof entry.displayName === "string" && entry.displayName.trim() !== "" ? entry.displayName : null,
					// 2026-11-01：OFM 面板那套实测账（失败率/速度/首字延迟）。
					// 注意这是**历史表现**，只用来排序和人工打分的证据，不当可用性开关。
					ofm: entry.ofm === undefined ? null : entry.ofm,
					// 2026-11-01 设计确定：四档的判据（src/score.js）：置信 / 风险 / 档位 / 分数。
					// 面板和 pickRoute 都读这一个字段，不再各算一份（以前面板说「推荐」、
					// 派活却排最后，就是这么来的）。null = 两个实测源都没有这条的样本。
					score: scoreTable.table.get(keyOfEntry) || null,
					};
				});
				const sessionsSvc = ctx.get ? ctx.get("sessions", false) : undefined;
				const titleSvc = ctx.get ? ctx.get("sessionTitle", false) : undefined;
				const goalRows = [];
				const leadIds = new Set([
					...Array.from(members.values()).map((m) => m.parentSessionId),
					...Array.from(boards.keys()),
					...Array.from(goals.keys()),
				]);
				for (const leadId of leadIds) {
					if (!inScope(leadId)) continue;
					const explicit = goals.get(leadId);
					let title;
					try {
						const session = sessionsSvc === undefined ? undefined : sessionsSvc.get(leadId);
						if (session !== undefined && titleSvc !== undefined && titleSvc !== false) title = (titleSvc.get(session) || {}).title;
					} catch { /* title optional */ }
					const board = boards.get(leadId);
					const taskArr = board === undefined ? [] : Array.from(board.tasks.values());
					const text = explicit !== undefined ? explicit.text : String(title || "");
					const hasMember = Array.from(members.values()).some((m) => m.parentSessionId === leadId);
					if (text === "" && !hasMember) continue; // hide empty unlabeled leftovers
					goalRows.push({
						lead: leadId,
						text,
						explicit: explicit !== undefined,
						done: taskArr.filter((tk) => tk.status === "done").length,
						total: taskArr.length,
						members: Array.from(members.values()).filter((m) => m.parentSessionId === leadId).length,
					});
				}
				goalRows.sort((a, b) => (Number(b.explicit) - Number(a.explicit)) || (Number(b.text !== "") - Number(a.text !== "")) || (b.members - a.members) || (b.total - a.total));
				// Always render the caller's own scope, even when the team is empty.
				if (leadScope !== undefined && goalRows.length === 0) {
					let title = "";
					try {
						const session = sessionsSvc === undefined ? undefined : sessionsSvc.get(leadScope);
						if (session !== undefined && titleSvc !== undefined && titleSvc !== false) title = String((titleSvc.get(session) || {}).title || "");
					} catch { /* title optional */ }
					goalRows.push({ lead: leadScope, text: title, explicit: false, done: 0, total: 0, members: 0 });
				}
				// Other teams: counts only, never task titles (#03).
				const teamSummary = [];
				if (leadScope !== undefined) {
					const leadIds2 = new Set([...Array.from(members.values()).map((m) => m.parentSessionId), ...Array.from(boards.keys()), ...Array.from(goals.keys())]);
					for (const leadId of leadIds2) {
						if (String(leadId) === leadScope) continue;
						const board2 = boards.get(leadId);
						const arr = board2 === undefined ? [] : Array.from(board2.tasks.values());
						const n = Array.from(members.values()).filter((m) => m.parentSessionId === leadId).length;
						if (n === 0 && arr.length === 0 && !goals.has(leadId)) continue;
						teamSummary.push({ lead: leadId, members: n, open: arr.filter((t) => t.status === "open").length, claimed: arr.filter((t) => t.status === "claimed").length, done: arr.filter((t) => t.status === "done").length });
					}
				}
				const lastAnnounce = (() => {
					const a = loadAnnounce();
					const last = a.items[a.items.length - 1];
					return last === undefined ? { waitSec: announceWaitSec() } : { at: Number(last.at) || 0, from: shortOf(last.from), text: String(last.text || "").slice(0, 400), waitSec: announceWaitSec() };
				})();
				const body = JSON.stringify({ at: Date.now(), lead: leadScope === undefined ? null : leadScope, goals: goalRows, teams: teamSummary, members: memberRows, tasks: taskRows, ledger: ledgerRows, announce: lastAnnounce, ofm: { ...ofmVersionState(cfg), auto: ofmAutoLast.result === null || ofmAutoLast.result === undefined ? null : { at: Number(ofmAutoLast.result.at) || 0, ok: ofmAutoLast.result.ok === true, did: String(ofmAutoLast.result.did || ""), version: String(ofmAutoLast.result.version || ""), latest: String(ofmAutoLast.result.latest || ""), error: String(ofmAutoLast.result.error || ""), hardlinked: ofmAutoLast.result.hardlinked === true, upgraded: ofmAutoLast.result.upgraded === true } }, mail: mailLog.slice(-MAIL_PANEL_MAX), files: lockRows() });
				res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
				res.end(body);
			} catch (error) {
				res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
				res.end(JSON.stringify({ error: String(error) }));
			}
		};
		scoped.effect(() => server.register({ kind: "prefix", path: "/api/dsh-team", handler }), "dsh-team: panel api");
	});

	const disposeTool = ctx.tools.register(teamTool);
	// 2026-11-04 设计确定：工具定义只留跑通闭环所需的基本动作，其余 action 与参数细节搬进
	// skill team-reference，模型碰到问题时按需加载。这里把它注册进技能目录（runtime skill），
	// 模型就能通过 skill 工具按名加载正文；文件缺失或 ctx.skills 未挂载时不阻断主工具。
	let disposeSkill;
	try {
		const skillBody = nodeFs.readFileSync(
			nodePath.join(nodePath.dirname(fileURLToPath(import.meta.url)), "skills", "team-reference", "SKILL.md"),
			"utf8",
		);
		disposeSkill = ctx.skills?.register?.({
			name: "team-reference",
			description: "dsh-team（team 工具）完整参数手册：全部 action、参数、流程细节、权限边界与排障。需要精确调用 team 工具时加载。",
			content: skillBody,
			// 2026-11-06 修复：内核 skills.register 不补 source 默认值，而 skill 工具加载
			// 走 validateDefinition()——source 必须是字符串，缺了就抛
			// `loaded skill "team-reference" source must be a string`，目录里看得见却加载失败。
			source: "plugin:dsh-team",
		});
	} catch { /* skill 文件缺失或 ctx.skills 未挂载时不阻断主工具 */ }

	if (ctx.logger) ctx.logger.info("dsh-team: active (1 tool; auto-claim " + (cfg.autoClaim === true ? "on" : "off") + ", ledger " + (ledgerMdPathOf(cfg) === null ? "json-only (md retired)" : (cfg.renderLedger === true ? "render on" : "dry-run")) + ")");
	// provider 注册晚于插件装载：等几秒再把 ctx/out/efforts 从内核补一次。
	const modelInfoTimer = setTimeout(() => { void syncModelInfo().catch(() => { /* 台账没变就算了 */ }); }, 5000);
	if (typeof modelInfoTimer.unref === "function") modelInfoTimer.unref();

	return () => {
		disposeTool();
		if (disposeSkill) disposeSkill();
		if (typeof unbindSubEnd === "function") unbindSubEnd();
		if (typeof unbindPreExec === "function") unbindPreExec();
		if (typeof unbindPostExec === "function") unbindPostExec();
		if (persistTimer) persistTimer();
		if (reprobeTick) reprobeTick();
		clearTimeout(kernelSyncTimer);
		// 2026-11-01 维护方抓到的根因：退出时无条件 `persistAll()` 会用**内存里的旧值**
		// 覆盖磁盘上的新值。实测过程：改好 ledger.json → 触发自热重载 → 新实例还没接手，
		// 老实例先跑这段 dispose → 旧的内存台账（backoffUntil=16:02、errClass=额度限流）
		// 整块写回去，改好的东西凭空消失。反复两次都是同一个现象。
		//
		// 清账：**只有内存真的比磁盘新时才写**。判据用文件 mtime 对比本实例最后一次
		// 落盘的时刻 —— 文件被外部改过（人改、别的实例改），就说明磁盘更新，
		// 这时退出不该覆盖它。
		//
		// 为什么不是"干脆不写"：正常关插件的时候内存里可能有还没落盘的改动
		// （persistTimer 是节流的），一声不吭丢掉同样是数据损失。
		try {
			let diskMtime = 0;
			try { diskMtime = nodeFs.statSync(ledgerPath).mtimeMs; } catch { /* 还没文件 */ }
			if (diskMtime < lastPersistAt) persistAll();
		} catch { /* 退出路径不许再抛 */ }
	};
}
