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
// util — 小工具（日期 / JSON 读写 / 格式化 / 台账 md 路径 / 可用 ctx）
// 从 index.js 的「small utils」区原样搬来（2026-10-31 模块化）。
// 唯一改动：把顶层 const/function 加 export；ctxK 从 gears.js 导入。逻辑一行未改。
// ---------------------------------------------------------------------------

import * as nodeFs from "node:fs";
import * as nodePath from "node:path";
import { ctxK } from "./gears.js";
import { writeJsonAtomic } from "./persist.js";

// ---------------------------------------------------------------------------
// small utils
// ---------------------------------------------------------------------------

export const dayStamp = (d = new Date()) =>
	`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
export const localDate = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
/** 台账 md 的路径；null = 已退役（2026-10-29 设计确定：数据只走 .state/ledger.json，面板直接读 JSON，
 *  md 留在 FreeProviderModels 当历史档案）。所有 md 读写点都必须先过这一关，插件才不会把文件重建出来。 */
export const ledgerMdPathOf = (cfg) => {
	const p = cfg === undefined || cfg === null ? undefined : cfg.ledgerMdPath;
	if (typeof p !== "string") return null;
	const s = p.trim();
	return s === "" ? null : s;
};

export function loadJson(path, fallback) {
	try {
		return JSON.parse(nodeFs.readFileSync(path, "utf8"));
	} catch {
		return fallback;
	}
}
/** 写 JSON。**原子**：先写临时文件再 rename 覆盖（2026-11-01 抄 OFM 的写法）。
 *  原来直接 writeFileSync，断电/并发会留下半个 JSON，下次 loadJson 读不出来就
 *  静默 fallback，整个台账/板子/锁表变空且不报错。这里换掉之后，目标文件要么是
 *  旧的完整版、要么是新的完整版。返回值语义不变（true/false），失败原因记在
 *  persist.lastWriteError 里，可以查。 */
export function saveJson(path, value) {
	return writeJsonAtomic(path, value);
}

/** 千分位显示：台账里 407857 比 398K 更有说服力（需求方要的是"真跑过多少"）。 */
export const fmtTok = (n) => {
	const v = Number(n);
	return Number.isFinite(v) && v > 0 ? v.toLocaleString("en-US") : "";
};

/** 累计「正常干活时长」→ 有几天就写几天，没有的年/天直接省掉（维护方 2026-10-29 定）：
 *  `00Y02D06H` → `2D06H`；`00Y01D01H` → `1D01H`；`00Y00D01H` → `1H`；`00Y00D00H` → `0H`。
 *  有年或天时小时补两位（`1D01H`，读起来不歧义）；只剩小时就不补零（`1H`）。
 *  只累计成功回合的 request→response 时间差：失败/重试/空转不算，所以这个数字是"这模型真扛过多久活"。一年按 365 天。 */
export function fmtUsed(ms) {
	const total = Math.floor((Number(ms) || 0) / 3600000);
	const y = Math.floor(total / (365 * 24));
	const d = Math.floor((total - y * 365 * 24) / 24);
	const hh = total - y * 365 * 24 - d * 24;
	const pad = (n) => String(n).padStart(2, "0");
	if (y > 0) return d > 0 ? `${y}Y${d}D${pad(hh)}H` : `${y}Y${hh}H`;
	if (d > 0) return `${d}D${pad(hh)}H`;
	return `${hh}H`;
}

/** 一条路由派单时**能用**的 ctx（K）。
 *  2026-10-30 设计确定：**实测比标称可信**。撞过输入上限的路由（`capK` = 上游原文给出的
 *  硬数字）按实测的来，标称写得再大也不算数；没撞过的才用标称；标称也没写才退回
 *  「正常跑过的最大值」（那是证据，不是猜测）。 */
export function ctxUsableK(entry) {
	const measuredCap = Number(entry && entry.capK);
	if (Number.isFinite(measuredCap) && measuredCap > 0) return Math.floor(measuredCap);
	const known = ctxK(entry.ctx);
	if (known !== null) return known;
	const seen = Number(entry && entry.seenMax);
	return Number.isFinite(seen) && seen > 0 ? Math.floor(seen / 1024) : null;
}

/** 会话短号 */
export const shortOf = (id) => String(id || "").replace(/^session-/, "").slice(0, 8);
