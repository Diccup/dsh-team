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
// health — 成员派生健康状态
// 从 index.js 的「derived health」区原样搬来（2026-10-31 模块化第三批）。
 // "running" 既可能是正常跑，也可能是卡在工具调用里 / 反复撞同一个错，
 // 所以状态需要自己的词表（#19）。静默挂死（#21）另算一类。
 // 逻辑一行未改；cfg 原是闭包变量，改为工厂参数。
 // ---------------------------------------------------------------------------

/**
 * @param {object} cfg 插件配置（读 stallNoticeSec）
 */
export function createHealth(cfg) {
	// --- derived health: a member stuck in a tool call or repeating one error.
	// "running" is true in both cases, so status needs its own vocabulary (#19).
	function stuckOf(member, liveStatus, now = Date.now()) {
		if (String(liveStatus) !== "running") return null;
		if (member.loopAt !== null && member.loopAt !== undefined) return "loop×" + (member.toolErrStreak || 3) + " " + String(member.lastToolError || "").slice(0, 60);
		const at = member.lastEventAt;
		if (typeof at === "number" && /tool\/call/.test(String(member.lastEvent || "")) && now - at > 120000) {
			return "卡住 " + Math.round((now - at) / 1000) + "s";
		}
		// Silent hang (#21): no stream frame and no session event at all. The
		// kernel's own stream watchdog fires at streamIdleTimeoutMs (300s), so
		// silence past that is either the automatic retry window or a dead
		// activation — both invisible in a bare "running".
		const last = Math.max(typeof member.lastStreamAt === "number" ? member.lastStreamAt : 0, typeof at === "number" ? at : 0);
		if (last > 0 && now - last > cfg.stallNoticeSec * 1000) return "静默 " + Math.round((now - last) / 1000) + "s";
		return null;
	}

	return { stuckOf };
}
