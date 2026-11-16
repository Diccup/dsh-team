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
// announce — 全局公告板 + 内核会话查询
// 从 index.js 的「全局公告板」区原样搬来（2026-10-31 模块化第三批）。
// 规矩（维护方原话）：公告**不需要回执**，活着的都收到就行；限频是**整体** 5 分钟
// 最多一条（不是每个会话各一条 —— 对话一多就变成一人一条刷屏）；正在跑的会话
// 不打断，等它下次调 team 时自己拉到。跨实例靠文件（.state/announce.json），
// 不靠内存广播。
// 逻辑一行未改；ctx 与 shortOf 原是闭包依赖，改为工厂参数。
// ---------------------------------------------------------------------------

import * as nodePath from "node:path";
import { stateDirPath } from "./config.js";
import { loadJson, saveJson, shortOf } from "./util.js";

/**
 * @param {object} deps
 * @param {object} deps.ctx 内核 ctx（读 sessionController）
 */
export function createAnnounce({ ctx }) {
	const announcePath = nodePath.join(stateDirPath(), "announce.json");
	const ANNOUNCE_GAP_MS = 5 * 60 * 1000;
	// 2026-11-09 设计确定：公告板只保留最后一条（原 20）。新公告进板即把旧的顶掉。
	const ANNOUNCE_KEEP = 1;
	const ANNOUNCE_WAKE_MAX = 8;
	function loadAnnounce() {
		const v = loadJson(announcePath, null);
		if (v === null || typeof v !== "object") return { lastAt: 0, seq: 0, items: [], seen: {} };
		return {
			lastAt: Number(v.lastAt || 0),
			seq: Number(v.seq || 0),
			items: Array.isArray(v.items) ? v.items : [],
			seen: v.seen !== null && typeof v.seen === "object" ? v.seen : {},
		};
	}
	const saveAnnounce = (v) => { try { saveJson(announcePath, v); } catch { /* 写不进就只留内存 */ } };
	const announceWaitSec = () => Math.max(0, Math.ceil((loadAnnounce().lastAt + ANNOUNCE_GAP_MS - Date.now()) / 1000));
	/** 把这个会话还没读过的公告挂进它的 notices。只投递，不要求任何回执。 */
	function pullAnnounce(leadId) {
		const a = loadAnnounce();
		if (a.items.length === 0) return [];
		const self = String(leadId);
		const since = Number(a.seen[self] || 0);
		const fresh = a.items.filter((it) => Number(it.seq) > since && String(it.from) !== self).slice(-1); // 2026-10-29 设计确定：只给最后一条，别一堆
		if (fresh.length === 0) return [];
		a.seen[self] = Number(a.seen[self] || 0);
		for (const it of fresh) a.seen[self] = Math.max(a.seen[self], Number(it.seq) || 0);
		// 只缓存最后一条时，把 seen 直接推到全局最新，避免下次又把中间几条翻出来
		for (const it of a.items) a.seen[self] = Math.max(a.seen[self], Number(it.seq) || 0);
		const keys = Object.keys(a.seen);
		if (keys.length > 300) for (const k of keys.slice(0, keys.length - 300)) delete a.seen[k];
		saveAnnounce(a);
		return fresh.map((it) => ({ kind: "公告", text: `📢 ${shortOf(it.from)} 的公告（${new Date(Number(it.at) || 0).toLocaleTimeString()}）：${it.text}` }));
	}

	/** 内核视角的全部会话（含「开了对话但一句没说、还没落盘」的空白会话）。
	 *  peers 只看板子/名册，会漏掉这种会话；要拿新开的对话框当测试靶就得问内核。 */
	async function kernelSessions() {
		const sc = ctx.get ? ctx.get("sessionController", false) : ctx.sessionController;
		if (sc === undefined || sc === false || sc === null || typeof sc.list !== "function") return undefined;
		try {
			const v = await sc.list({}, AbortSignal.timeout(8000));
			const items = v !== null && v !== undefined && Array.isArray(v.items) ? v.items : [];
			return items.map((s) => ({
				id: String(s.sessionId),
				blank: s.blank === true,
				running: s.running === true,
				agent: s.agentAvailable === true,
				parent: s.parentSessionId === undefined ? "" : String(s.parentSessionId),
				sub: s.origin === "subagent",
				updatedAt: Number(s.updatedAt || 0),
			}));
		} catch { return undefined; }
	}

	return { announcePath, ANNOUNCE_GAP_MS, ANNOUNCE_KEEP, ANNOUNCE_WAKE_MAX, loadAnnounce, saveAnnounce, announceWaitSec, pullAnnounce, kernelSessions };
}
