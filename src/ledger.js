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
// ledger — 台账薄壳：注入点 + re-export + 渲染
//
// 2026-11-02 模块化改造（说明：「别每次改一个要改一整个大文件」）。这个 630 行的
// 文件按层拆进了 src/freeledger/：
//   · collect.js    —— 采集（syncFromKernel / syncFromOfm / applyAvailability /
//                      inferVision / appendLedgerHistory / OFM 版本哨兵）
//   · whitelist.js  —— 白名单读 + 免费特征识别
//   （pool.js / dispatch.js 从 index.js 拆来，见各自头注释）
// ledger.js 只剩三件事：
//   1. persist 注入的两级转发：index.js setPersist(真落盘) → 本模块 → collect 的
//      setCollectPersist。分两级是因为 collect 若反过来 import 本文件会成环，
//      钩子必须由已经拿到注入的一方转发。
//   2. re-export 采集/白名单的符号：index.js 和全部 verify 脚本的 import 路径
//      一个字都不用改（改一处要改一整个大文件，正是要治的病）。
//   3. STATUS_TEXT / ledgerNote / renderLedgerMd —— 台账**渲染**层，跟着壳留下。
// 逻辑一行未改（采集段整段程序切片搬走，非手敲重打）。
// ---------------------------------------------------------------------------

import * as nodeFs from "node:fs";
import { ledger } from "./state.js";
import { dayStamp, localDate, ledgerMdPathOf } from "./util.js";
import { effortCapRank, gearAt, effortLadder } from "./gears.js";
import { setCollectPersist } from "./freeledger/collect.js";

/** index.js 启动时注入的「落盘」函数（写 roster/board/scores/ledger）。
 *  同时转发给 collect —— 采集层改完台账也走同一个 persistAll。
 *  渲染层（本文件剩下的部分）只读台账、不落盘，所以自己不再调 persist。 */
export function setPersist(fn) {
	setCollectPersist(typeof fn === "function" ? fn : () => {});
}

// 采集层 re-export（本体在 src/freeledger/collect.js；导入即完成模块求值，
// 钩子在 setPersist 时才接线，无环）。
export {
	applyAvailability,
	syncFromOfm,
	inferVision,
	LEDGER_HISTORY_KEEP,
	appendLedgerHistory,
	syncFromKernel,
	ofmVersionState,
	refreshOfmRemote,
	OFM_MANIFEST_URLS,
	// 2026-11-16（Updating\04 · 遗留 1）：档位复核的两个常量。
	//   EFFORTS_RECHECK_DAYS   —— 保鲜期，index.js 的 syncModelInfo 用它决定是否重查；
	//   EFFORTS_ABSENT_TEXT    —— 内核明确答"无 reasoning 元数据"时写进台账的真相文本。
	EFFORTS_RECHECK_DAYS,
	EFFORTS_ABSENT_TEXT,
} from "./freeledger/collect.js";
// 白名单层 re-export（本体在 src/freeledger/whitelist.js）。
export { whitelistFromPatch, freeFeatureGuess } from "./freeledger/whitelist.js";

export const STATUS_TEXT = { ok: "✅", invalid: "⚠️ 暂时失效", lead: "⚠️ 队长", unknown: "待实测" };

export function ledgerNote(entry) {
	const bits = [];
	if (entry.note) bits.push(entry.note);
	if (entry.errClass) bits.push(entry.errClass);
	if (entry.realResult === "fail" && entry.realAt) bits.push(`真派失败@${dayStamp(new Date(entry.realAt))}`);
	if (entry.realResult === "ok" && entry.realAt) bits.push(`真派 ok@${dayStamp(new Date(entry.realAt))}`);
	if (entry.whitelist === "closed") bits.push("白名单未开（改配置即可，非模型失效）");
	// #11 measured ceiling: show it wherever the entry is read (md 备注 / models / panel)
	const cap = effortCapRank(entry);
	if (cap >= 0) {
		const capGear = gearAt(effortLadder(entry), cap);
		if (capGear !== undefined) bits.push(`封顶:${capGear}`);
	}
	return bits.join("；").slice(0, 300) || entry.note || "—";
}

/** Update ONLY 状态/备注/更新时间 cells of matched rows; append unknown models at the tail. Never reorder, never delete. */
export function renderLedgerMd(cfg) {
	const mdPath = ledgerMdPathOf(cfg);
	if (mdPath === null) return { ok: false, reason: "台账 md 已退役：数据在 .state/ledger.json，面板直接读 JSON" };
	let text;
	try { text = nodeFs.readFileSync(mdPath, "utf8"); } catch { return { ok: false, reason: "台账 md 不可读" }; }
	const lines = text.split(/\r?\n/);
	const out = [];
	const seen = new Set();
	let maxIdx = 0;
	const appended = [];
	for (const line of lines) {
		const m = line.match(/^\|\s*(\d+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|$/);
		if (!m) { out.push(line); continue; }
		const [, idx, provider, model] = m;
		const key = `${provider.trim()}/${model.trim()}`;
		const entry = ledger.get(key);
		maxIdx = Math.max(maxIdx, Number(idx));
		if (!entry) { seen.add(key); out.push(line); continue; } // untouched when plugin has no data
		seen.add(key);
		const status = STATUS_TEXT[entry.status] || "待实测";
		// note merge: keep the human-recorded facts, append only genuinely new
		// plugin facts (error class / real-run stamps) — maintenance rule §11.
		const fresh = ledgerNote(entry);
		const oldNote = m[7] ? m[7].trim() : "";
		let note = oldNote;
		const tokens = [];
		if (entry.errClass) tokens.push(entry.errClass);
		if (entry.realResult === "ok" && entry.realAt) tokens.push(`真派 ok@${dayStamp(new Date(entry.realAt))}`);
		if (entry.realResult === "fail" && entry.realAt) tokens.push(`真派失败@${dayStamp(new Date(entry.realAt))}`);
		for (const tok of tokens) if (!oldNote.includes(tok.slice(0, 12))) note = note ? `${note}；${tok}` : tok;
		if (note.length > 320) note = note.slice(-320);
		const changedNote = note !== oldNote || !oldNote;
		const stamp = changedNote || entry.status !== "ok" ? (entry.updatedStr || dayStamp()) : (m[8] || entry.updatedStr || dayStamp());
		out.push(`| ${idx} | ${provider} | ${model} | ${m[4]} | ${m[5]} | ${status} | ${note || fresh} | ${stamp} |`);
	}
	// append models the scanner knows but the table lacks (format-identical rows)
	for (const [key, entry] of ledger) {
		if (seen.has(key)) continue;
		maxIdx += 1;
		appended.push(`| ${maxIdx} | ${entry.provider} | ${entry.model} | ${entry.ctx || "未 advertised"} | ${entry.efforts || "未advertised"} | ${STATUS_TEXT[entry.status]} | ${ledgerNote(entry)} | ${entry.updatedStr || dayStamp()} |`);
	}
	let last = -1;
	out.forEach((l, i) => { if (/^\|\s*\d+\s*\|/.test(l)) last = i; });
	if (appended.length > 0) out.splice(last + 1, 0, ...appended);
	const renderedText = out.join(/\r\n/.test(text) ? "\r\n" : "\n");
	let finalText = renderedText;
	// refresh the document-level 更新时间 stamp whenever rows changed
	const headerNow = localDate() + " " + dayStamp().slice(11);
	const headerRe = /(> \*\*更新时间\*\*：)(\d{4}-\d{2}-\d{2} \d{2}:\d{2})/;
	if (headerRe.test(finalText)) finalText = finalText.replace(headerRe, (_all, pre) => pre + headerNow);
	if (finalText === text) return { ok: true, appended: appended.length, changed: false };
	return { ok: true, text: finalText, appended: appended.length, changed: true };
}
