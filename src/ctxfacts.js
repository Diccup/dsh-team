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
// ctxfacts — 实测上下文事实（下限/上限/跑过的最大值）
// 从 index.js 的共享状态区原样搬来（2026-10-31 模块化）：三张实测表 + 三个盖章函数。
// ---------------------------------------------------------------------------

import { fmtTok } from "./util.js";

/** 只测出**下限**的路由（灌了 N 输入还没炸）：写成 `400K+`，派单按这个下限封顶
 *  （宁可少派，也不让内核静默压缩）。同样只登记真正实测过的 provider+model，不外推。
 *  2026-10-29 实测 cline/nvidia/nemotron-3.5-lightning-free：跑完 78 轮、约 40 万
 *  token 输入仍然活着，没有报 400 —— 只能说明 ≥400K，上限未知。 */
export const MEASURED_CTX_MIN = {
	"cline/nvidia/nemotron-3.5-lightning-free": 400 * 1024,
};

/** 把「实测下限」盖到台账条目上：ctx 显示成 `400K+`（ctxK 能解析出 400，派单即按 400 封顶），
 *  另存 ctxMin 原始 tokens。幂等，且目录同步/台账 md 导入不再覆盖它。 */
export function applyMeasuredCtxMin(entry, key) {
	const tokens = MEASURED_CTX_MIN[key];
	if (typeof tokens !== "number" || tokens <= 0) return false;
	const k = `${Math.floor(tokens / 1024)}K+`;
	let touched = false;
	if (entry.ctx !== k) { entry.ctx = k; touched = true; }
	if (entry.ctxMin !== tokens) { entry.ctxMin = tokens; touched = true; }
	if (!/实测下限/.test(String(entry.note || ""))) {
		entry.note = `${entry.note ? entry.note + "；" : ""}实测下限 ≥${Math.floor(tokens / 1024)}K 输入（未触顶，上限未知）`;
		touched = true;
	}
	return touched;
}

/** 目录/内核给的 ctx 标称值有假的：**只登记真正实测撞过的那个 provider+model**，不做同类外推
 *  （同一模型换个 provider/网关，上限可能完全不同 —— 维护方明确要求别一把梭）。
 *  2026-10-29 实测 cline/poolside/laguna-s-2.1:free：UI 显示 1M，OpenRouter 回 400
 *  「Input length 262281 exceeds the maximum allowed input length of 262112 tokens」——
 *  连压缩请求都超限，所以「压缩不出摘要」不是 bug，是这条路根本运不回来。
 *  其它入口（our-free-model/kilo 的 laguna、-xs 版本、中划线变体）**没有实测**，不写在这里，
 *  等真撞墙了由 recordRealRun 的运行时自学习按实际报错逐条落账。 */
export const MEASURED_CTX = {
	"cline/poolside/laguna-s-2.1:free": 262112,
	// 同一模型的中划线变体走的是另一个上游（Vercel，不是 OpenRouter），但 10-29 14:13 实测
	// `Input length 569984 exceeds the maximum allowed input length of 262112 tokens` —— 数字一样，
	// 所以各记各的一条（不是拿上面那条外推：这条有自己的报错原文）。
	"cline/poolside/laguna-s-2.1-free": 262112,
};

/** 把实测 ctx 盖到台账条目上（幂等；ctxRaw 一旦有值，目录同步就不再改它）。 */
export function applyMeasuredCtx(entry, key) {
	const tokens = MEASURED_CTX[key];
	if (typeof tokens !== "number" || tokens <= 0) return false;
	const k = `${Math.floor(tokens / 1024)}K`;
	let touched = false;
	if (entry.ctx !== k) { entry.ctx = k; touched = true; }
	if (entry.ctxRaw !== tokens) { entry.ctxRaw = tokens; touched = true; }
	if (typeof entry.ctxMeasuredAt !== "number") { entry.ctxMeasuredAt = Date.now(); touched = true; }
	if (!/输入上限实测/.test(String(entry.note || ""))) {
		entry.note = `${entry.note ? entry.note + "；" : ""}输入上限实测 ${tokens} tokens（目录显示不可信）`;
		touched = true;
	}
	return touched;
}

/** 把「实测跑过的最大输入」盖到台账上（幂等）。
 *  这是**不靠报错**也能拿到的下界：DSH 每次正常完成都会在会话日志里写
 *  `assistant/message.usage.inputTokens`，那就是真实灌进去的上下文。所以：
 *  报错 → 学到硬上限（ctxRaw）；没报错 → 学到下界（seenMax）。两条腿都要。
 *  注意：标称 ctx 已知时**不改 ctx 字符串**（1M 的路由不能因为只跑过 400K 就被砍成 400K），
 *  只把 seenMax 记进 ctxMin 并在备注里写一行证据。 */
export function applySeenMax(entry, key) {
	const tokens = Number(entry && entry.seenMax);
	if (!Number.isFinite(tokens) || tokens <= 0) return false;
	let touched = false;
	if (Number(entry.ctxMin || 0) < tokens) { entry.ctxMin = tokens; touched = true; }
	const k = Math.floor(tokens / 1024);
	const turn = entry.seenMaxTurn === undefined || entry.seenMaxTurn === null ? "" : `，turn ${entry.seenMaxTurn}`;
	const line = `正常跑过最大输入 ${fmtTok(tokens)} tokens（≈${k}K${turn}）`;
	const note = String(entry.note === undefined || entry.note === null ? "" : entry.note);
	const stripped = note.replace(/；?正常跑过最大输入[^；]*/g, "");
	const next = stripped === "" ? line : `${stripped}；${line}`;
	if (next !== note) { entry.note = next; touched = true; }
	void key;
	return touched;
}
