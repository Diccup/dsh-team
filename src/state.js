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
// state — 进程内共享可变状态（重启后落到 JSON）
// 从 index.js 的「shared mutable state」区原样搬来（2026-10-31 模块化）。
// 这些 Map 是插件的真源：所有模块都从这一处 import，不再在 index.js 里另开副本。
// ---------------------------------------------------------------------------

export const members = new Map(); // childSessionId -> MemberRecord (live roster)
// 2026-10-31 某次实测 问题 8 的最后一道缝：成员被 recycle/kill-remove 之后从 members
// 里消失了，但它的会话还在内核里活着 —— 这时它调 team，resolveLead 照样把它归到队长板上，
// 而且 members.get(它) 是 undefined，被当成"队长"放行全套动作。
// 所以除了"现在是不是在册成员"，还要记一份**曾经是成员的会话**，用来认领这种"退役成员"。
export const retiredMembers = new Map(); // childSessionId -> {name, parentSessionId, at}
/** 成员离册（回收/移除/收队/换血）时登记一笔 —— 它会话还活着，不能被当成队长放行。
 *  只留 200 条，最早的自然淘汰（这不是审计日志，只是一张"这是子代理"的名片）。 */
export function rememberRetired(sessionId, member) {
	if (sessionId === undefined || sessionId === null || String(sessionId) === "") return;
	retiredMembers.set(String(sessionId), { name: String(member.name || "?"), parentSessionId: String(member.parentSessionId || ""), at: Date.now() });
	while (retiredMembers.size > 200) {
		const oldest = Array.from(retiredMembers.entries()).sort((a, b) => Number(a[1].at || 0) - Number(b[1].at || 0))[0];
		retiredMembers.delete(oldest[0]);
	}
}
export const boards = new Map(); // leadSessionId -> {seq:number, tasks:Map<string,TaskRecord>}
export const goals = new Map(); // leadSessionId -> {text:string, at:number} — 任务总目标
export const ledger = new Map(); // "provider/model" -> LedgerEntry
