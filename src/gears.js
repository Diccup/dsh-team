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
// gears — 档位（effort/demand）与上下文档位阶梯（#11）
// 从 index.js 的「effort gears」区原样搬来（2026-10-31 模块化）。
// 逻辑一行未改，只把顶层声明改成 export。
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// effort gears (#11)
// Every route advertises its own ladder ("low/high/max", "none/low/medium/xhigh",
// even the reversed "high/none"), so gears are ordered by a canonical rank and
// never by position inside the string.
// ---------------------------------------------------------------------------

// "on" 是只开/关推理的模型用的档位（UI 显示"开启/关闭"，实测请求头 reasoningEffort:"on"），
// 台账里把它记成 high/none 会让派单传 "none"，内核直接拒：does not support effort "none"。
// "disabled" 是 Kilo 系四档模型的最低档（UI 显示 Off，内核 id=disabled）；
// "light/balanced/deep" 是 flint-40b-free 的唯一一套（不是 low/medium/high 的同义词，
// 是三档自命名，按 1/2/3 排）。
export const EFFORT_RANK = {
	disabled: 0, none: 0, off: 0,
	minimal: 0.5,
	light: 1, low: 1,
	balanced: 2, medium: 2,
	high: 3, on: 3, deep: 3,
	xhigh: 4, max: 5,
};
export const DEMAND_DEFAULT = 2; // 常规

/** "1"/"1+"/"2"/"3"/"max" -> canonical rank; unknown/blank -> 2 (常规). */
export function demandRank(demand) {
	const d = String(demand === undefined || demand === null ? "" : demand).trim().toLowerCase().replace(/\+/g, "");
	if (d === "") return DEMAND_DEFAULT;
	if (d === "max") return EFFORT_RANK.max;
	const n = Number(d);
	if (!Number.isFinite(n)) return DEMAND_DEFAULT;
	return Math.max(1, Math.min(3, Math.round(n)));
}

/** Task size -> how much input context it needs, in K tokens. `ctx` is the only HARD
 *  limit (out can always be batched), so this is what gates model choice. */
export const SIZE_CTX_K = { s: 128, m: 256, l: 1024 };
export function sizeCtxK(size) {
	const key = String(size === undefined || size === null ? "" : size).trim().toLowerCase();
	return SIZE_CTX_K[key === "" ? "m" : key];
}
export function sizeKey(size) {
	const key = String(size === undefined || size === null ? "" : size).trim().toLowerCase();
	return SIZE_CTX_K[key] === undefined ? "m" : key;
}

/** 窗口档位（K）。「+1 档」就是在这个阶梯上往上跳一格，不是标称值除以二。 */
export const CTX_TIERS_K = [64, 128, 256, 512, 1024, 2048, 4096];
export function nextCtxTierK(currentK) {
	const cur = Number(currentK);
	if (!Number.isFinite(cur) || cur <= 0) return SIZE_CTX_K.s;
	for (const t of CTX_TIERS_K) if (t > cur) return t;
	return CTX_TIERS_K[CTX_TIERS_K.length - 1];
}

/** 一张单**真正**需要的 ctx（K）：`size` 是队长的估计，`ctxMin` 是实测证据。
 *  2026-10-31 设计确定：「不停压缩 2 次以上没产出，直接 +1 档上下文，别一直死循环」。
 *  压缩次数就是"这单实际要多大窗口"的硬证据，所以它抬起来的门槛 `ctxMin` 必须压过 size：
 *  派单/补员/换路由/撞顶重派全部按这个数筛路由 —— 否则 kill 掉成员后 autoFill 会再挑一条
 *  同样小的路由，把同一个死循环原样重开一遍（隔壁 8eaff90a 实测就是这么转圈烧 token 的）。 */
export function taskNeedCtx(task) {
	const base = sizeCtxK(task === undefined || task === null ? undefined : task.size);
	const raised = Number(task === undefined || task === null ? 0 : task.ctxMin);
	return Number.isFinite(raised) && raised > base ? raised : base;
}

/** Catalog ctx/out -> K tokens. null means THE CATALOG SAID NOTHING — callers must
 *  read that as "不可承诺", never as "unlimited". */
export function ctxK(text) {
	const s = String(text === undefined || text === null ? "" : text).trim();
	if (s === "" || s.startsWith("无数据") || s.startsWith("未adv") || s === "—" || s === "-") return null;
	const m = /^([\d.]+)\s*([KMGT]?)/i.exec(s);
	if (m === null) return null;
	const v = Number(m[1]);
	if (!Number.isFinite(v) || v <= 0) return null;
	const u = (m[2] || "").toUpperCase();
	if (u === "T") return Math.round(v * 1024 * 1024 * 1024);
	if (u === "G") return Math.round(v * 1024 * 1024);
	if (u === "M") return Math.round(v * 1024);
	return u === "K" ? Math.round(v) : Math.round(v / 1024);
}

/** Gear names out of a human-authored string: "on（开启）/ off（关闭）" -> ["on","off"].
 *  台账格子是人写的，带中文注释和全角括号，不剥掉就一个都认不出来（ladder 为空 →
 *  派单不带 effort → 模型回落到默认档）。 */
export function gearTokens(raw) {
	const names = String(raw === undefined || raw === null ? "" : raw)
		.split("/")
		.map((s) => s.trim().toLowerCase().replace(/[（(][^）)]*[）)]/g, "").trim())
		.filter((s) => EFFORT_RANK[s] !== undefined);
	return Array.from(new Set(names));
}

/** 实测过的档位（跑成功/被拒都算）：effortOk/effortBad 的键。 */
export function measuredGears(entry) {
	if (entry === undefined || entry === null) return [];
	return gearTokens(Object.keys(entry.effortOk || {}).concat(Object.keys(entry.effortBad || {})).join("/"));
}

/** Route ladder as canonical gear names, ascending. Empty when unadvertised.
 *  MEASURED BEATS CATALOG: when we actually sent gears and they are disjoint from what
 *  the catalog claims (raccoon/sn-deepseek-v4-1-flash-1017: 目录 high/none，实测 on/off),
 *  the catalog is wrong — following it would send "none" and get
 *  `does not support reasoning effort "none"` on every dispatch. */
export function effortLadder(entry) {
	const catalog = gearTokens(entry === undefined || entry === null ? "" : entry.efforts);
	const measured = measuredGears(entry);
	let uniq = catalog;
	if (measured.length > 0 && catalog.every((g) => measured.indexOf(g) < 0)) uniq = measured;
	uniq = uniq.slice();
	uniq.sort((a, b) => EFFORT_RANK[a] - EFFORT_RANK[b]);
	return uniq;
}

/** Highest gear at or below `rank`; falls back to the lowest gear when every gear is higher. */
export function gearAt(ladder, rank) {
	if (ladder.length === 0) return undefined;
	let best;
	for (const name of ladder) if (EFFORT_RANK[name] <= rank) best = name;
	return best === undefined ? ladder[0] : best;
}

/** Rejection-based ceiling as a rank (-1 = nothing was ever rejected → no cap).
 *  ONLY rejections cap a route. A successful run at some gear is evidence that gear
 *  works, NOT that higher gears are unusable — capping on effortOk would make the
 *  untested higher gear unreachable forever (it could never be measured, so it would
 *  never be lifted). Rejections expire after `ttlHours`.
 *  A rejection at the LOWEST gear yields -1 too, so callers must pair this with
 *  `entry.status === "invalid"` to tell "route is dead" from "never measured". */
export function effortCapRank(entry, ttlHours = 24) {
	const now = Date.now();
	const ttl = Math.max(1, Number(ttlHours || 24)) * 3600 * 1000;
	let cap = -1;
	for (const [gear, at] of Object.entries((entry && entry.effortBad) || {})) {
		if (EFFORT_RANK[gear] === undefined) continue;
		if (now - Number(at) > ttl) continue; // expired: the gear may work again
		const below = EFFORT_RANK[gear] - 1;
		cap = cap < 0 ? below : Math.min(cap, below);
	}
	return cap;
}

/** Gear to run a `demand` on this route: catalog ladder clipped by the measured
 *  ceiling. Two different gaps, kept apart on purpose:
 *  - `short`: the catalog itself cannot reach the demand (e.g. d3 on a low/medium route);
 *  - `capped`: the measured ceiling clipped a gear the catalog does advertise (#11).
 *  `demand:"max"` means "this route's own top gear", never a global rank. */
export function effortFor(entry, demand, ttlHours = 24) {
	const ladder = effortLadder(entry);
	const target = demandRank(demand);
	const cap = entry === undefined ? -1 : effortCapRank(entry, ttlHours);
	const top = ladder.length === 0 ? target : EFFORT_RANK[ladder[ladder.length - 1]];
	const want = target === EFFORT_RANK.max ? top : target;
	const ceiling = cap < 0 ? want : Math.min(want, cap);
	const gear = gearAt(ladder, ceiling);
	const catalogGear = gearAt(ladder, want);
	return {
		gear,
		target,
		cap,
		short: gear !== undefined && EFFORT_RANK[gear] < want,
		capped: gear !== undefined && catalogGear !== undefined && EFFORT_RANK[gear] < EFFORT_RANK[catalogGear],
		capGear: cap < 0 ? undefined : gearAt(ladder, cap),
	};
}
