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
// lederr — 队长报错暂存（维护方 10-29 定的设计）
// 从 index.js 的「队长报错暂存」区原样搬来（2026-10-31 模块化第三批）。
//
// 为什么要有：队长自己撞了没登记过的错时，**问它没用** —— 它正是报错的那个，
// 上下文里也没有原文。所以不推通知、不广播，直接写进文件；等**下一次有成员报错**时，
// 把积压的队长报错连成员那条一起推给「当时还能用的那个队长」判
// （队长可能已经换模型/换路由了）。
//
// 逻辑一行未改；ctx / ledger / pushNotice / kernelSessions / wakeSession 等原是闭包依赖，
// 改为工厂参数。deliverMail / shortOf 直接从 src 模块 import。
// ---------------------------------------------------------------------------

import * as nodePath from "node:path";
import { stateDirPath } from "./config.js";
import { loadJson, saveJson, shortOf } from "./util.js";
import { deliverMail } from "./mailbox.js";

/**
 * @param {object} deps
 * @param {object} deps.ctx 内核 ctx（读 sessionController / agents）
 * @param {Map} deps.ledger 路由台账
 * @param {Function} deps.pushNotice 通知入队
 * @param {Function} deps.routeOf 从 agent 读路由 key
 * @param {Function} deps.groupHalted 组级熔断判定
 * @param {Function} deps.kernelSessions 内核会话清单（src/announce.js 提供）
 * @param {Function} deps.wakeSession 跨会话唤醒（apply 内的函数声明，提升可用）
 */
export function createLeadErrors({ ctx, ledger, pushNotice, routeOf, groupHalted, kernelSessions, wakeSession }) {
	const leadErrPath = nodePath.join(stateDirPath(), "lead-errors.json");
	let leadErrors = (() => {
		const v = loadJson(leadErrPath, []);
		return Array.isArray(v) ? v : [];
	})();
	const saveLeadErrors = () => {
		try { saveJson(leadErrPath, leadErrors); } catch { /* 写不进去就只留内存 */ }
	};
	const leadErrSig = (e) => `${e.route}|${String(e.raw || "").slice(0, 80)}`;
	/** 记一条队长侧报错。**不套成员轮换规则**：队长撞了本来就是维护方换模型，插件不该替它
	 *  downshift/rotate（那是派单域的规则）。这里只做三件事：留原文、记实测上限、交给下一个
	 *  能用的队长/维护方看一眼。opts.cap = 从原文解析出的真实输入上限（tokens）。 */
	function recordLeadError(provider, model, effort, raw, opts) {
		const meta = opts === undefined || opts === null ? {} : opts;
		const row = { at: Date.now(), route: `${provider}/${model}`, effort: effort || null, raw: String(raw || "").replace(/\s+/g, " ").slice(0, 1200), repeat: 1, asks: 0, deliveredAt: undefined, captain: true };
		if (typeof meta.cap === "number" && meta.cap > 0) row.cap = meta.cap;
		const sig = leadErrSig(row);
		const last = leadErrors[leadErrors.length - 1];
		if (last !== undefined && leadErrSig(last) === sig && Date.now() - Number(last.at || 0) < 10 * 60 * 1000) {
			last.repeat = Number(last.repeat || 1) + 1;
			last.at = Date.now();
			if (row.cap !== undefined) last.cap = row.cap;
		} else {
			leadErrors.push(row);
			while (leadErrors.length > 50) leadErrors.shift();
		}
		saveLeadErrors();
	}
	/** 交付积压的队长报错：
	 *  - 全部都是**告知**性质（队长换不换模型由设计确定：），送一次就删，不重复问；
	 *  - 未归类且问满 2 次 / 搁超 2 小时的旧条目 → 推一条「问维护方」后删（兼容老数据）。 */
	function deliverLeadErrors(leadId, limit) {
		const now0 = Date.now();
		const stuck = leadErrors.filter((e) => e.class === undefined && e.captain !== true && (Number(e.asks || 0) >= 2 || now0 - Number(e.at || 0) > 2 * 3600 * 1000));
		if (stuck.length > 0 && leadId !== undefined && leadId !== null) {
			const lines = stuck.map((e) => `${e.route}@${e.effort || "?"}${Number(e.repeat) > 1 ? "×" + e.repeat : ""}：${String(e.raw).slice(0, 400)}`);
			pushNotice(leadId, "问维护方", `这几条报错实现方判不了（问过一遍还没归类），必须原样问维护方，别自己猜：\n` + lines.join("\n"));
			const drop = new Set(stuck);
			leadErrors = leadErrors.filter((e) => !drop.has(e));
			saveLeadErrors();
		}
		const fresh = leadErrors.filter((e) => Number(e.asks || 0) < 2 && e.captain !== true);
		if (fresh.length === 0 || !(limit > 0)) return [];
		const take = fresh.slice(-limit);
		const now = Date.now();
		for (const e of take) { e.asks = Number(e.asks || 0) + 1; e.deliveredAt = now; }
		// 队长侧/已归类的都只告知一次，不留着重复问
		const dropAfter = take.filter((e) => e.captain === true || e.class !== undefined);
		if (dropAfter.length > 0) {
			const drop = new Set(dropAfter);
			leadErrors = leadErrors.filter((e) => !drop.has(e));
		}
		saveLeadErrors();
		return take.map((e) => {
			const head = `${new Date(Number(e.at)).toISOString().slice(11, 19)}Z ${e.route}@${e.effort || "?"}${Number(e.repeat) > 1 ? "×" + e.repeat : ""}`;
			if (e.captain === true) {
				const cap = typeof e.cap === "number" && e.cap > 0 ? `，实测输入上限 ${e.cap} tokens（≈${Math.floor(e.cap / 1024)}K）已记进台账` : "";
				return `队长侧报错${cap}｜换不换模型由维护方决定，插件不会自动动这条｜原文：${String(e.raw).slice(0, 320)}`;
			}
			return e.class === undefined
				? `${head}：${String(e.raw).slice(0, 400)}`
				: `${head}：已归类「${e.class}」，按规则处理即可；原文：${String(e.raw).slice(0, 300)}`;
		});
	}
	const pendingLeadErrors = () => leadErrors.filter((e) => Number(e.asks || 0) < 2).length;
	/** 面板/rule 列表要原样给队长看：未归类的那些。 */
	const pendingRows = () => leadErrors.filter((e) => Number(e.asks || 0) < 2);
	/** 自检：当下**有没有活着的对话队长可以当场问**。条件——不是自己、agent 在线、
	 *  当前空闲（不在跑回合）、不是空白会话、不是子会话、且它的路由不是刚坏的那条。
	 *  有 → 直接 tell 过去（带原文）并唤醒；没有 → 返回 undefined，交回文件躺着。 */
	async function askLiveCaptain(fromSessionId, route, text) {
		const sc = ctx.get ? ctx.get("sessionController", false) : ctx.sessionController;
		if (sc === undefined || sc === false || sc === null || typeof sc.prompt !== "function") return undefined;
		const ks = await kernelSessions();
		if (ks === undefined) return undefined;
		const cands = ks.filter((s) => s.id !== String(fromSessionId) && s.agent && s.running !== true && s.blank !== true && s.parent === "");
		if (cands.length === 0) return undefined;
		// 10-30 修复：以前只排「同一条坏路由」，结果把待判信投给隔壁会话后它自己立刻
		// 「本轮运行失败→处理失败」（它的 raccoon 路由也在限流）。候选队长必须过台账体检：
		// 失效/退避中/组停的路由一律不投——投给救不了自己的队长只会再制造一条无人处理的报错。
		const scored = cands.map((cs) => {
			const a = ctx.agents && typeof ctx.agents.get === "function" ? ctx.agents.get(cs.id) : undefined;
			const r = a === undefined || a === null ? undefined : routeOf(a);
			const e = r === undefined ? undefined : ledger.get(r);
			const broken = e !== undefined && (e.status === "invalid" || e.backoffUntil > Date.now() || groupHalted(e));
			return { s: cs, sameRoute: r !== undefined && r === route, broken };
		}).sort((x, y) => Number(x.sameRoute || x.broken) - Number(y.sameRoute || y.broken) || y.s.updatedAt - x.s.updatedAt);
		const pick = scored[0];
		if (pick.sameRoute || pick.broken) return undefined; // 没有健康的活队长：留文件里等，别投给将死之人
		const body = `【队长报错待判】${text}`;
		deliverMail(pick.s.id, fromSessionId, shortOf(fromSessionId), body, true);
		const woke = await wakeSession(pick.s.id, shortOf(fromSessionId), body);
		return { to: shortOf(pick.s.id), woke: woke !== undefined && woke.woke === true };
	}
	/** 队长撞未知错时的入口：先做自检直接问活着的队长，问不到才留在文件里。
	 *  限流：同一报错 10 分钟内只问一次，全局 3 分钟最多问一个队长（别把别的对话刷屏）。 */
	const askGate = new Map();
	let lastAskAt = 0;
	function maybeAskLiveCaptain(selfId, route, raw) {
		if (selfId === undefined || selfId === null || String(selfId) === "") return;
		const now = Date.now();
		const sig = `${route}|${String(raw || "").slice(0, 80)}`;
		const seen = askGate.get(sig);
		if (seen !== undefined && now - seen < 10 * 60 * 1000) return;
		if (now - lastAskAt < 3 * 60 * 1000) return;
		askGate.set(sig, now);
		lastAskAt = now;
		const brief = `路由 ${route} 报错未登记，原文：${String(raw || "").replace(/\s+/g, " ").slice(0, 600)}\n判完用 team(action:"rule", match:"<特征串>", errorClass:"…", fix:"…") 登记；判不了就原样问维护方，别猜。`;
		void (async () => {
			try {
				const asked = await askLiveCaptain(String(selfId), route, brief);
				if (asked === undefined) return;
				const row = leadErrors[leadErrors.length - 1];
				if (row !== undefined && leadErrSig(row) === sig) {
					row.asks = Math.max(1, Number(row.asks || 0));
					row.askedTo = asked.to;
					row.askedAt = Date.now();
					saveLeadErrors();
				}
			} catch { /* 自检失败就当没有活队长，文件里那条会照常等 */ }
		})();
	}
	/** 清账：已归类且已经告知过的（送一次就够）、超过 7 天的，都删掉。
	 *  未归类的不动——它们还要等队长判。（维护方 10-29：判完就清，别一直存着。） */
	function pruneLeadErrors() {
		const before = leadErrors.length;
		const keepMs = 7 * 24 * 3600 * 1000;
		leadErrors = leadErrors.filter((e) => {
			if (Date.now() - Number(e.at || 0) > keepMs) return false;
			if (e.class !== undefined && (e.deliveredAt !== undefined && e.deliveredAt !== null)) return false;
			return true;
		});
		if (leadErrors.length !== before) saveLeadErrors();
		return before - leadErrors.length;
	}
	// 一次 team 调用里，队长报错只交付一次（同一 action 可能两次经过 withNotices）
	let callSeq = 0;
	let lastDeliverSeq = -1;
	const bumpCallSeq = () => { callSeq += 1; };
	/** true = 本次调用还没交付过（调用方据此决定要不要真交付）。 */
	const claimDelivery = () => {
		if (lastDeliverSeq === callSeq) return false;
		lastDeliverSeq = callSeq;
		return true;
	};

	return { leadErrPath, leadErrorsList: () => leadErrors, saveLeadErrors, leadErrSig, recordLeadError, deliverLeadErrors, pendingLeadErrors, pendingRows, askLiveCaptain, maybeAskLiveCaptain, pruneLeadErrors, bumpCallSeq, claimDelivery };
}
