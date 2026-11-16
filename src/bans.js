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
// bans — 「禁用名单」：队长判定成员产出混乱后，那个子会话永久不再被复用
// ---------------------------------------------------------------------------
// 背景（维护方 2026-11-02 定）：插件只能判断成员**可用性**（撞墙/报错/档位不支持），
// 「模型混乱」只有队长看着产出才能判。判出来之后：
//   · 内核没有真·清空上下文的原语 —— /compact 是「摘要接续」，混乱的内容会被
//     摘进摘要继续带毒，摘不动的还会占窗口；retool 同会话换模型也是**带着旧上下文
//     换新脑子**，维护方一针见血：「否则换模型都是继承成员以前的上下文内容，该混乱的
//     还是会混乱，但是会误判成模型不行」。
//   · 所以唯一干净的做法：**禁用这个成员会话，新开一个**。
// 归因规矩（设计说明：「判断第一次是成员混乱，如果新开同模型还混乱就是模型不行，
// 所以第2次就要标记模型分数了」）：
//   · 第 1 次禁用 → 只拉黑这个会话；单子退回 open 并钉住**同一条路由**（cloneRoute），
//     补员用干净新会话在同模型上对照重跑 —— 变量只剩「上下文干净与否」；
//   · 同一条路由第 2 次被禁用 → 判定模型本身不行：记一条模型差评（bumpScore false，
//     进路由战绩），解除钉选，重派换别的路由；
//   · unban 可以解禁（拉黑是插件侧闸门，不动内核会话本身）。
// 本模块是纯存储（Map<sessionId, record> + 上限裁剪 + 落盘）；判定与编排都在 index.js。
// ---------------------------------------------------------------------------

export function createBanList({ loadJson, saveJson, bansPath, logger, max = 50 }) {
	const list = new Map(); // sessionId -> {name, leadId, route, reason, at}

	function load() {
		list.clear();
		let raw;
		try { raw = loadJson(bansPath, {}); } catch { return; }
		if (raw === null || typeof raw !== "object") return;
		for (const [sid, rec] of Object.entries(raw)) {
			if (rec === null || typeof rec !== "object") continue;
			if (typeof rec.name !== "string") continue; // 脏行丢掉
			list.set(String(sid), rec);
		}
		if (logger && typeof logger.info === "function" && list.size > 0) logger.info(`dsh-team: 禁用名单载入 ${list.size} 个会话`);
	}
	function persist() {
		try { saveJson(bansPath, Object.fromEntries(list)); } catch { /* 落盘失败不阻断主流程 */ }
	}
	function trim() {
		const cap = Math.max(5, Number(max));
		while (list.size > cap) {
			let oldestKey = null;
			let oldestAt = Infinity;
			for (const [k, r] of list) {
				const at = Number(r.at || 0);
				if (at < oldestAt) { oldestAt = at; oldestKey = k; }
			}
			if (oldestKey === null) break;
			list.delete(oldestKey);
		}
	}
	/** 禁用一个会话。重复 ban 同一会话只更新时间/原因（幂等）。 */
	function add(sessionId, rec) {
		if (sessionId === undefined || sessionId === null || String(sessionId) === "") return false;
		list.set(String(sessionId), { ...rec, at: Date.now() });
		trim();
		persist();
		return true;
	}
	function isBanned(sessionId) {
		return list.has(String(sessionId));
	}
	/** 解禁：to 给会话 id 直接删；给名字则在本队记录里找（可匹配多条）。返回删掉的记录。 */
	function remove(nameOrSessionId, leadId) {
		const want = String(nameOrSessionId || "");
		if (want === "") return [];
		const removed = [];
		if (list.has(want)) {
			removed.push({ sessionId: want, ...list.get(want) });
			list.delete(want);
		} else {
			for (const [sid, r] of Array.from(list)) {
				if (String(r.name) !== want) continue;
				if (leadId !== undefined && leadId !== "" && String(r.leadId) !== String(leadId)) continue;
				removed.push({ sessionId: sid, ...r });
				list.delete(sid);
			}
		}
		if (removed.length > 0) persist();
		return removed;
	}
	function rowsOf(leadId) {
		return Array.from(list.entries())
			.filter(([, r]) => String(r.leadId) === String(leadId))
			.map(([sid, r]) => ({ sessionId: sid, name: r.name, route: r.route || "?", reason: r.reason || "", at: Number(r.at || 0) }));
	}
	return { list, load, persist, add, isBanned, remove, rowsOf };
}
