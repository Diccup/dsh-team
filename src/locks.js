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
// locks — 文件占用表（同一文件同时只允许一个成员改）
// 从 index.js 的「file locks」区原样搬来（2026-10-31 模块化）。逻辑一行未改。
//
// 原来这些函数是 apply 的闭包，直接吃 ctx/cfg/members/pushNotice。
// 搬出来以后改成工厂：createLocks(deps) 返回同一组函数，闭包变量由参数注入。
// 这样依赖方向明确（模块不反向 import index.js），行为完全一致。
// ---------------------------------------------------------------------------

import * as nodeFs from "node:fs";
import * as nodePath from "node:path";
import { stateDirPath } from "./config.js";
import { loadJson, saveJson } from "./util.js";

/**
 * @param {object} deps
 * @param {object} deps.ctx     内核 context（agents/subagents/logger）
 * @param {object} deps.cfg     配置（读 lockStaleSeconds）
 * @param {Map}    deps.members 活成员名册
 * @param {(id:string)=>string} deps.shortOf 会话短号
 * @param {(lead:string,tag:string,text:string)=>void} deps.pushNotice 给队长的通知
 * @returns 文件锁 API
 */
export function createLocks({ ctx, cfg, members, shortOf, pushNotice }) {
	const locksPath = nodePath.join(stateDirPath(), "file-locks.json");
	/** 表结构：{ "<归一后的绝对路径>": { path, display, holder:{member,lead,task,at,pid}, waiters:[{member,lead,task,at}], last:{member,task,doneAt,size} } } */
	const fileLocks = (() => {
		const v = loadJson(locksPath, {});
		return v !== null && typeof v === "object" ? v : {};
	})();
	const LOCK_STALE_MS = Math.max(60, Number(cfg.lockStaleSeconds || 600)) * 1000;
	/** 锁的键 = 归一后的**绝对**路径。只用 basename 会把 `a\README.md` 和 `b\README.md`
	 *  认成同一个（那是两个文件）；只用相对路径又会漏掉不同写根下的同名文件。 */
	function lockKeyOf(absPath) {
		return String(absPath || "").replace(/\\/g, "/").replace(/\.\//, "").toLowerCase();
	}
	/** 把工具参数里的 file_path 解析成绝对路径。工具拿到的是成员视角的路径（可能是相对
	 *  它自己 cwd 的），所以必须用**那个会话的 cwd** 来解析，不能用队长的。 */
	function absPathOf(raw, sessionCwd) {
		const s = String(raw || "").trim();
		if (s === "") return "";
		if (nodePath.isAbsolute(s)) return nodePath.resolve(s);
		const base = String(sessionCwd || "");
		return base === "" ? "" : nodePath.resolve(nodePath.join(base, s));
	}
	function saveFileLocks() {
		try { saveJson(locksPath, fileLocks); } catch { /* 写不进就只留内存 */ }
	}
	/** 清掉过期持有：成员异常退出留下的锁不能卡死别人。只在**读取时**做，不靠定时器。 */
	function reapStaleLocks(now) {
		let changed = 0;
		for (const [key, rec] of Object.entries(fileLocks)) {
			if (rec === null || rec === undefined) { delete fileLocks[key]; changed++; continue; }
			const holder = rec.holder;
			if (holder === null || holder === undefined) continue;
			if (now - Number(holder.at || 0) > LOCK_STALE_MS) {
				rec.last = { member: holder.member, task: holder.task || "", doneAt: now, size: rec.last === undefined ? undefined : rec.last.size };
				rec.holder = null;
				rec.staleReleased = { at: now, member: holder.member, why: `超过 ${Math.round(LOCK_STALE_MS / 1000)} 秒无心跳，插件自动释放` };
				changed++;
			}
		}
		if (changed > 0) saveFileLocks();
		return changed;
	}
	/** 成员的「身份」：必须是团队成员才有名字可显示；不是成员（队长自己/别的插件）用会话短号。 */
	function writerOf(agentOrSession) {
		const sessionId = String(agentOrSession || "");
		const m = members.get(sessionId);
		if (m !== undefined) return { member: m.name, lead: String(m.parentSessionId), task: m.currentTask === null ? "" : m.currentTask, member_: true };
		return { member: sessionId === "" ? "?" : shortOf(sessionId), lead: sessionId, task: "", member_: false };
	}
	/** 尝试拿锁：拿到就返回 {ok:true}，被占就排队并返回 {ok:false, holder}。 */
	function acquireLock(absPath, who, now) {
		const key = lockKeyOf(absPath);
		reapStaleLocks(now);
		const rec = fileLocks[key] === undefined
			? (fileLocks[key] = { path: absPath, display: String(absPath), holder: null, waiters: [] })
			: fileLocks[key];
		if (rec.waiters === undefined || !Array.isArray(rec.waiters)) rec.waiters = [];
		// 自己已经持有：重复调用（同一个人连续 edit 同一文件）直接放行，别自己挡自己
		if (rec.holder !== null && rec.holder !== undefined && rec.holder.member === who.member && rec.holder.lead === who.lead) {
			rec.holder.at = now;
			rec.holder.task = who.task;
			saveFileLocks();
			return { ok: true, key, reentrant: true };
		}
		// 没人占：直接上锁
		if (rec.holder === null || rec.holder === undefined) {
			// 队列里排在自己前面的（理论上不该有，除非同一成员重复排队）先剔除
			rec.waiters = rec.waiters.filter((w) => !(w.member === who.member && w.lead === who.lead));
			rec.holder = { member: who.member, lead: who.lead, task: who.task, at: now };
			saveFileLocks();
			return { ok: true, key, took: true };
		}
		// 被占：进队列（同一人不重复入队，只刷新时间）
		const exist = rec.waiters.find((w) => w.member === who.member && w.lead === who.lead);
		if (exist !== undefined) { exist.at = now; exist.task = who.task; }
		else rec.waiters.push({ member: who.member, lead: who.lead, task: who.task, at: now });
		saveFileLocks();
		return { ok: false, key, holder: rec.holder, queuePos: rec.waiters.length };
	}
	/** 放锁 + **只通知队首那一个**。维护方明确要求：不能文件一空就广播给两个人。 */
	async function releaseLock(absPath, who, now) {
		const key = lockKeyOf(absPath);
		const rec = fileLocks[key];
		if (rec === undefined) return { released: false, why: "表里没这个文件" };
		// 锁本来就是空的：谁来说"放锁"都不算数（否则任何人都能顺手改写 last/size，
		// 表就变成谁都能污染的历史）。这不是错误，是"无事可做"。
		if (rec.holder === null || rec.holder === undefined) {
			return { released: false, why: "这个文件现在没被占用（锁是空的）" };
		}
		// 只有持有者本人能放；插件超时回收走 reapStaleLocks
		if (rec.holder.member !== who.member) {
			return { released: false, why: `现在持有的是 ${rec.holder.member}，不是 ${who.member}` };
		}
		let size;
		try { size = nodeFs.statSync(absPath).size; } catch { size = undefined; }
		rec.last = { member: who.member, task: who.task || "", doneAt: now, ...(size === undefined ? {} : { size }) };
		rec.holder = null;
		rec.waiters = (rec.waiters || []).filter((w) => !(w.member === who.member && w.lead === who.lead));
		saveFileLocks();
		// FIFO：只叫队首，其余继续排队。叫醒用 subagents.sendMessage（和派单同一个通道）。
		const head = rec.waiters[0];
		if (head !== undefined && head !== null) {
			const notified = await notifyLockFree(head, absPath, rec.last);
			if (notified === true) {
				// 通知成功就把它从队列移到「已通知」，等它自己的 write 再真正拿锁；
				// 留一条 30 秒后未拿锁就自动作废的宽限，避免"通知了但人已经不在"堵住队列。
				rec.waiters[0] = { ...head, notifiedAt: now };
			}
			saveFileLocks();
		}
		return { released: true, key, nextInLine: head === undefined ? null : `${head.member}${head.task ? "/" + head.task : ""}`, waiting: rec.waiters.length };
	}
	/** 通知队首「文件空了，可以改了」。成员可能已经不在（被回收/kill），那就跳过它叫下一个。 */
	async function notifyLockFree(waiter, absPath, last) {
		try {
			if (ctx.agents.get(waiter.lead) === undefined) return false; // 队长不在，叫不醒
			const memberId = waiter.member;
			// 成员会话来路：按名字在名册里找（waiter 存的是名字）
			let targetSession = "";
			for (const [sid, m] of members) {
				if (m.name === memberId && m.parentSessionId === waiter.lead) { targetSession = sid; break; }
			}
			if (targetSession === "") {
				// 不是本进程名册里的成员（可能是另一支队的、或已回收）：退回广播给它的队长
				if (last !== undefined && last !== null) {
					pushNotice(waiter.lead, "文件已空", `${memberId} 在等 ${nodePath.basename(absPath)}，现在空了（${last.member} 刚改完）；队列第 1 位就是它`);
				}
				return false;
			}
			const leadAgent = ctx.agents.get(waiter.lead);
			if (leadAgent === undefined) return false;
			await ctx.subagents.sendMessage(leadAgent, targetSession, [
				{ type: "text", text: `【文件空了】${absPath} 现在没人占用（上一个改它的是 ${last === undefined || last === null ? "?" : last.member}），你可以动手了。改完不用管锁，插件会自动放。若还有别人在排队，下一个会在你放锁后才收到通知。` },
			], { signal: AbortSignal.timeout(30000) });
			pushNotice(waiter.lead, "轮到你了", `${absPath} 已空，已通知 ${memberId}（队列第 1 位）`);
			return true;
		} catch (error) {
			if (ctx.logger) ctx.logger.warn("dsh-team: lock notify failed: " + String(error));
			return false;
		}
	}

	function releaseAllLocksOf(sessionId) {
		const who = writerOf(sessionId);
		for (const [key, rec] of Object.entries(fileLocks)) {
			if (rec === null || rec === undefined || rec.holder === null || rec.holder === undefined) continue;
			if (rec.holder.member === who.member && rec.holder.lead === who.lead) {
				rec.last = { member: who.member, task: rec.holder.task || "", doneAt: Date.now() };
				rec.holder = null;
				rec.releasedOnEnd = Date.now();
			}
		}
		saveFileLocks();
	}
	/** 面板要用：当前所有被占/有人排队的文件，按「谁在改」排好。 */
	function lockRows() {
		reapStaleLocks(Date.now());
		const rows = [];
		for (const rec of Object.values(fileLocks)) {
			if (rec === null || rec === undefined) continue;
			const holder = rec.holder === undefined ? null : rec.holder;
			const waiters = Array.isArray(rec.waiters) ? rec.waiters : [];
			rows.push({
				path: String(rec.path || ""),
				name: nodePath.basename(String(rec.path || "")),
				holder: holder === null ? null : `${holder.member}${holder.task ? "·" + holder.task : ""}`,
				holderAt: holder === null ? 0 : Number(holder.at || 0),
				waiters: waiters.map((w) => `${w.member}${w.task ? "·" + w.task : ""}`),
				last: rec.last === undefined || rec.last === null ? null : `${rec.last.member}${rec.last.task ? "·" + rec.last.task : ""}`,
				lastAt: rec.last === undefined || rec.last === null ? 0 : Number(rec.last.doneAt || 0),
				lastSize: rec.last === undefined || rec.last === null ? undefined : rec.last.size,
				stale: rec.staleReleased === undefined ? null : String(rec.staleReleased.why || ""),
				exists: (() => { try { return nodeFs.statSync(String(rec.path || "")).isFile(); } catch { return false; } })(),
			});
		}
		// 正在被改的排最前，然后按最近活动时间倒序
		rows.sort((a, b) => (b.holder === null ? 0 : 1) - (a.holder === null ? 0 : 1) || (b.holderAt || b.lastAt) - (a.holderAt || a.lastAt));
		while (rows.length > 200) rows.pop();
		return rows;
	}

	return { locksPath, fileLocks, LOCK_STALE_MS, lockKeyOf, absPathOf, saveFileLocks, reapStaleLocks, writerOf, acquireLock, releaseLock, notifyLockFree, releaseAllLocksOf, lockRows };
}
