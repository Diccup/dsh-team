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
// errors — 报错分类（维护规则 §3 的五类口径 + 档位类）
// 从 index.js「small utils」尾部的 classifyError + ROUTE_FAULT_CLASSES 原样搬来。
// ---------------------------------------------------------------------------

/** Deterministic failure classification (维护规则 §3 的五类口径 + 档位类). */
export function classifyError(message) {
	const m = String(message || "");
	if (/Free usage limit reached|soft_rate|429|usage will reset/i.test(m)) return "额度限流";
	if (/reasoning_content must be passed back/i.test(m)) return "路由bug";
	if (/not allowed for this Session/i.test(m)) return "白名单未开";
	if (/not available in your country|RegionError|403/i.test(m)) return "地区封锁";
	// A gear rejection must NAME the effort/reasoning/gear. A bare 400 or
	// "invalid request" is NOT a gear defect — ctx overflow, bad JSON and provider quirks
	// all produce those — and misreading one as a gear problem poisons the measured
	// ceiling and silently downgrades a healthy route for a whole TTL.
	const namesGear = /reasoning|thinking|effort|budget|\b(low|medium|high|xhigh|maximal|minimal)\b/i.test(m);
	const refusesGear = /unsupported|not supported|does not support|invalid|unknown|must be|allowed/i.test(m);
	if (namesGear && refusesGear) return "档位不支持";
	if (/STREAM_CUT|Stream ended without finish_reason|UPSTREAM|aborted|EAC_UPSTREAM_FAILED|RATE_LIMIT|no eligible anonymous exit|Provider returned error/i.test(m)) return "网关共性";
	return "网关共性";
}

export const ROUTE_FAULT_CLASSES = new Set(["路由bug", "白名单未开", "地区封锁"]);
