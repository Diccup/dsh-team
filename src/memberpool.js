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
// memberpool — 退役成员「会话池」：补员优先复用同一个子智能体，不再每次新起
// ---------------------------------------------------------------------------
// 背景（维护方 2026-11-02 抓「子智能体现在 56 个了，每次起成员都是新调用一个
// 子智能体，完全没有复用这一说」）：
//   内核本地子级是 **continuable** 的 —— dsh-subagent README 写明「本地子级接受
//   后续消息并支持冷恢复」；manager.coldResume（dsh-subagent/lib/index.js:2141）
//   会把已从内存卸载、但会话日志还在盘上的子会话**原样唤醒**：persona、
//   provider/model/档位都从持久化的 `subagent/descriptor` 事件折叠还原，
//   并且 `agents.resume` → `announce(agent, "resume")` 会**重发 agent/created**
//   （dsh-agent/lib/index.js:581），所以插件挂在 agent/created 上的路由覆盖、
//   badge、AGENTS.md 抑制、任务上下文对复活成员照样生效 —— 复用是安全的。
//   反过来，startActivation 对同一 childId 会抛 DUPLICATE_CHILD（:1436），
//   说明复用的正确姿势是「往旧会话发一条唤醒消息」，不是重新激活。
//   老代码的洞：回收/移除/disband 只把成员从 members 删掉，**从不记住它的会话**，
//   补员一律 randomUUID() 新起一个 → 56 个子会话只增不减。
//
// 规矩（严格按维护方那句「除非队长选择不用这个子智能体」）：
//   · **空闲回收 / 撞墙回收** → 入池，补员优先复用（队长没表态不要他）；
//   · **kill remove / disband / adopt 换血踢掉 / 收尸**（会话已不在内核）→ 不入池，
//     并且把该会话从池里删掉 —— 队长明确不要的人绝不再被捡回来；
//   · 池上限 memberPoolMax（LRU：最久没复用的先淘汰）；0 = 关复用；
//   · **只登记不删会话**：内核没有公开「删会话」API（cordis 目录只有
//     archiveSession，且它只挡新活动），会话日志留在盘上，由维护方经 GUI 自行处置；
//     池里不再有条目的旧会话对插件就没有复用义务，也不会被任何逻辑引用。
//
// 本模块是纯存储（Map<sessionId, record> + 裁剪 + 落盘），挑人与唤醒都在 index.js。
// ---------------------------------------------------------------------------

import * as nodeFs from "node:fs";
import * as nodePath from "node:path";

/** record 至少要有 name/parentSessionId/provider/model，其余尽力保留。 */
export function createMemberPool({ loadJson, saveJson, poolPath, cfg, logger }) {
	const pool = new Map();
	function loadPool() {
		pool.clear();
		let raw;
		try { raw = loadJson(poolPath, {}); } catch { return; }
		if (raw === null || typeof raw !== "object") return;
		for (const [sid, rec] of Object.entries(raw)) {
			if (rec === null || typeof rec !== "object") continue;
			if (typeof rec.name !== "string" || typeof rec.provider !== "string") continue; // 脏行丢掉
			pool.set(String(sid), rec);
		}
		if (logger && typeof logger.info === "function" && pool.size > 0) logger.info(`dsh-team: 成员池载入 ${pool.size} 个可复用会话`);
	}
	function persist() {
		try { saveJson(poolPath, Object.fromEntries(pool)); } catch { /* 池落盘失败不影响主流程 */ }
	}
	function cap() {
		return Math.max(0, Number(cfg.memberPoolMax === undefined ? 24 : cfg.memberPoolMax));
	}
	function trim() {
		const max = cap();
		if (max === 0) { if (pool.size > 0) { pool.clear(); persist(); } return; }
		while (pool.size > max) {
			let oldestKey = null;
			let oldestAt = Infinity;
			for (const [k, r] of pool) {
				const at = Number(r.retiredAt || 0);
				if (at < oldestAt) { oldestAt = at; oldestKey = k; }
			}
			if (oldestKey === null) break;
			pool.delete(oldestKey);
		}
	}
	/** 成员离册时入池（重复登记 = 刷新成最新状态 + 挪到 LRU 头）。
	 *  memberPoolMax=0 时这里什么都不做（等于关复用）。 */
	function remember(sid, member) {
		if (member === undefined || member === null) return false;
		if (sid === undefined || sid === null || String(sid) === "") return false;
		if (cap() === 0) return false;
		pool.set(String(sid), {
			name: String(member.name || "?"),
			parentSessionId: String(member.parentSessionId || ""),
			provider: String(member.provider || ""),
			model: String(member.model || ""),
			effort: member.effort === undefined ? "" : String(member.effort),
			demand: member.demand === undefined ? "" : String(member.demand),
			effortWhy: member.effortWhy === undefined ? "" : String(member.effortWhy),
			routeSource: member.routeSource === undefined ? "plugin" : String(member.routeSource),
			autoSpawned: member.autoSpawned === true,
			caps: Array.isArray(member.caps) ? member.caps.slice(0, 20) : [],
			workdir: member.workdir === undefined ? "" : String(member.workdir),
			lastEventAt: typeof member.lastEventAt === "number" ? member.lastEventAt : null,
			spawnedAt: typeof member.spawnedAt === "number" ? member.spawnedAt : null,
			retiredAt: Date.now(),
		});
		trim();
		persist();
		return true;
	}
	/** 本队 + 这条路由上的可复用旧成员，按「最近退役」排序（上下文还热）。
	 *  liveIds = 现在内存名册里的会话（正在册的不算池子）；
	 *  usedNames = 本队现在在用的成员名（名字撞车的旧人不能捡回来，否则两个 auto1）。 */
	function candidates(leadId, provider, model, liveIds, usedNames) {
		const out = [];
		for (const [sid, rec] of pool) {
			if (String(sid) === "") continue;
			if (rec.parentSessionId !== leadId) continue;
			if (rec.provider !== provider || rec.model !== model) continue;
			if (liveIds !== undefined && liveIds.has(String(sid))) continue;
			if (usedNames !== undefined && usedNames.has(String(rec.name))) continue;
			out.push({ sessionId: String(sid), rec });
		}
		out.sort((a, b) => Number(b.rec.retiredAt || 0) - Number(a.rec.retiredAt || 0));
		return out;
	}
	/** 队长不要这个人了 / 会话没了 → 从池里销账（下次不许再捡）。 */
	function drop(sid) {
		if (pool.delete(String(sid))) persist();
	}
	/** 占用一个池条目（复用前必调）：先重读盘看它还在不在 —— 别的实例可能已经把它
	 *  捡走了（跨实例互斥靠 member-pool-claim.lock 文件，O_EXCL 建锁 = 天然 CAS）。
	 *  抢到返回 record（并从池里删掉 + 落盘），抢不到返回 undefined。 */
	function claim(sid, leadId) {
		const key = String(sid);
		const rec0 = pool.get(key);
		if (rec0 === undefined) return undefined;
		let lockFd = null;
		const lockFile = nodePath.join(nodePath.dirname(poolPath), ".member-pool-claim.lock");
		try {
			try {
				const st = nodeFs.statSync(lockFile);
				if (Date.now() - st.mtimeMs > 10000) nodeFs.unlinkSync(lockFile); // 死锁 10 秒自动清
			} catch { /* 没有锁文件 */ }
			lockFd = nodeFs.openSync(lockFile, "wx");
			nodeFs.writeSync(lockFd, `${String(leadId).slice(-8)} ${Date.now()}`);
		} catch {
			return undefined; // 别人正在占用，让出去（这轮不捡它，下轮再说）
		}
		try {
			const fresh = loadJson(poolPath, {});
			const rec = fresh !== null && typeof fresh === "object" ? fresh[key] : undefined;
			if (rec === null || typeof rec !== "object") { pool.delete(key); persist(); return undefined; } // 别的实例先捡走了（内存也销 + 落盘，盘上不许留幽灵）
			if (rec.parentSessionId !== leadId) { pool.delete(key); persist(); return undefined; } // 队不属它（盘上陈旧/写错），同样销账
			pool.delete(key);
			persist();
			return rec;
		} finally {
			try { nodeFs.closeSync(lockFd); } catch { /* ignore */ }
			try { nodeFs.unlinkSync(lockFile); } catch { /* 已被死锁清理 */ }
		}
	}
	/** 整队清理（disband / 收尸）：这支队的池条目全销。 */
	function dropTeam(leadId) {
		let changed = false;
		for (const [sid, rec] of Array.from(pool.entries())) {
			if (rec.parentSessionId !== leadId) continue;
			pool.delete(sid);
			changed = true;
		}
		if (changed) persist();
		return changed;
	}
	/** 会话清单对账：池里登记的会话如果内核里已经没有它了，销账。 */
	function pruneTo(aliveIds) {
		let removed = 0;
		for (const sid of Array.from(pool.keys())) {
			if (!aliveIds.has(String(sid))) { pool.delete(sid); removed += 1; }
		}
		if (removed > 0) persist();
		return removed;
	}
	/** 本队的池（面板/status 展示用，只读）。 */
	function teamRows(leadId) {
		return Array.from(pool.entries())
			.filter(([, r]) => r.parentSessionId === leadId)
			.map(([sid, r]) => ({ sessionId: String(sid).slice(-6), name: r.name, route: `${r.provider}/${r.model}`, retiredMinAgo: Math.max(0, Math.round((Date.now() - Number(r.retiredAt || 0)) / 60000)) }))
			.sort((a, b) => a.retiredMinAgo - b.retiredMinAgo);
	}
	return { pool, loadPool, persist, trim, remember, candidates, claim, drop, dropTeam, pruneTo, teamRows };
}
