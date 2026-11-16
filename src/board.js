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
// board — 任务板基础操作（取板 / 并行度分析）
// 从 index.js 的「board helpers」区原样搬来（2026-10-31 模块化第二批）。
// 逻辑一行未改，只把闭包依赖 boards 改成从 state.js import。
// ---------------------------------------------------------------------------

import { boards } from "./state.js";

// --- board helpers
export function boardFor(leadSessionId) {
	let board = boards.get(leadSessionId);
	if (board === undefined) { board = { seq: 0, tasks: new Map(), meta: null }; boards.set(leadSessionId, board); }
	return board;
}
/** 这批 open 单**同一时刻最多能开几个工**。
 *  2026-10-30 维护方纠错（隔壁 t7→t8→t9→t10 只有一个人从头干到尾）：
 *  「拆单的价值只在并行」——可 serial chain 拆四单也只有一个能开工，
 *  那拆出来的全是等待。拆单时当场算一遍，别等队长跑完才发现。
 *
     *  **判据的边界（维护方 2026-10-30 亲口定的）**：
     *  - ❌ 整条线串行（A→B→C→D，全程只有一个人能干）= 不行，这不算"拆单"；
     *  - ✅ 骨架串行、中间一段能并行（A→(B‖C)→D）= **允许**，这是正常的流水线。
     *  所以判据用「**最大层宽**」而不是"有没有依赖"：只要有一层宽度 ≥2（真有并行段），
     *  就不报警；只有每一层都恰好 1 张单（纯串行）才报。
     *  这样菱形、扇出再收拢、以及"并了几张再串一张"都不会被误杀。
     *
 *  算法是标准的「最长依赖链分层」：按拓扑层数，同一层的单可以同时开工。
 *  返回 { open, max, chain } —— max 是最大层宽（=同时能开工的单数），
 *  chain 是人话描述的最长链（只在纯串行时才有意义）。 */
export function countParallelism(board) {
	const open = Array.from(board.tasks.values()).filter((t) => t.status === "open" || t.status === "claimed");
	if (open.length === 0) return { open: 0, max: 0, chain: "" };
	const byTid = new Map(open.map((t) => [t.tid, t]));
	// 每张单的"层" = 它依赖链上最深的层 + 1；依赖不在本批 open 里的（已完成）算第 0 层。
	const level = new Map();
	const visiting = new Set();
	const levelOf = (t) => {
		if (level.has(t.tid)) return level.get(t.tid);
		if (visiting.has(t.tid)) return 0; // 环：当成同层，别死循环
		visiting.add(t.tid);
		let maxDep = -1;
		for (const dep of t.blockedBy || []) {
			const dt = byTid.get(dep);
			if (dt === undefined) continue; // 已完成/不存在的前置不挡层
			const lv = levelOf(dt);
			if (lv > maxDep) maxDep = lv;
		}
		visiting.delete(t.tid);
		const v = maxDep + 1;
		level.set(t.tid, v);
		return v;
	};
	for (const t of open) levelOf(t);
	const widths = new Map();
	for (const t of open) {
		const lv = level.get(t.tid);
		widths.set(lv, (widths.get(lv) || 0) + 1);
	}
	const max = Math.max(...widths.values());
	// 最长链写成人话：从最深的那张单往回追。
	// 必须挡环：blocked_by 可以事后用 set 改成环（a→b→a），没有 seen 的话这个 while
	// 会永远转下去，把 10 秒 tick 整个挂死（2026-10-30 自测当场撞出来的）。
	let cur = null;
	for (const t of open) if (cur === null || level.get(t.tid) > level.get(cur.tid)) cur = t;
	const path = [];
	const seen = new Set();
	while (cur !== null) {
		if (seen.has(cur.tid)) break; // 环：停在这里，不谎报也不死转
		seen.add(cur.tid);
		path.unshift(cur.tid);
		let nxt = null;
		for (const dep of cur.blockedBy || []) {
			const dt = byTid.get(dep);
			if (dt === undefined || seen.has(dt.tid)) continue;
			if (nxt === null || level.get(dt.tid) > level.get(nxt.tid)) nxt = dt;
		}
		cur = nxt;
	}
	const chain = path.join("→");
	return { open: open.length, max, chain };
}
