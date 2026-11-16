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
// freeledger/whitelist — 白名单层：读 allowedModels + 免费特征识别
//
// 2026-11-02 模块化改造第二刀：`whitelistFromPatch` 原来在 src/ledger.js，
// 混在采集/探活/渲染中间。白名单是派单口径的**第一道闸**（名单里没有 = 网关必拒），
// 单独成层后，所有"名单从哪读、怎么判、怎么认免费"只改这一个文件。
//
// ★ 血的规矩（2026-11-02 发包踩雷第 4 条，永远不许破）：
//   `wl === null` 的含义是「**读不到白名单**」，不是「谁都不许用」。
//   读不到 → 内核列出一律收进台账并标 whitelist:"unknown"（collect.js 执行），
//   硬闸绝不许把 unknown 当 closed 挡死 —— 那是「一个模型都派不出去」的直接成因。
// ---------------------------------------------------------------------------

import * as nodeFs from "node:fs";

/** cordis.patch.yml 的 allowedModels → Set("provider/model")。
 *  纯文本扫描，不引 YAML 库。一条都解析不出时返回 null = "不知道"，绝不能拿空集合把全台账标成 closed。 */
export function whitelistFromPatch(cfg) {
	const p = cfg === undefined || cfg === null ? undefined : cfg.whitelistPatchPath;
	if (typeof p !== "string" || p.trim() === "") return null;
	let text = "";
	try { text = nodeFs.readFileSync(p, "utf8"); } catch { return null; }
	const set = new Set();
	const unq = (v) => String(v).replace(/^["']|["']$/g, "").trim();
	let inBlock = false, baseIndent = -1, prov = null;
	for (const line of text.split(/\r?\n/)) {
		if (line.trim() === "") continue;
		const indent = line.length - line.trimStart().length;
		if (/^\s*allowedModels\s*:/.test(line)) { inBlock = true; baseIndent = indent; prov = null; continue; }
		if (!inBlock) continue;
		if (indent <= baseIndent && !/^\s*-/.test(line)) { inBlock = false; prov = null; continue; }
		const pm = line.match(/(?:^|\s|-)\s*provider\s*:\s*([^\s#]+)/);
		if (pm !== null) { prov = unq(pm[1]); continue; }
		const mm = line.match(/(?:^|\s|-)\s*model\s*:\s*([^\s#]+)/);
		if (mm !== null && prov !== null) { set.add(prov + "/" + unq(mm[1])); prov = null; }
	}
	return set.size === 0 ? null : set;
}

/** 免费特征识别（维护方 2026-11-02 原话）：
 *  「名字带FREE，免费，限时免费，X0.00 0.0都是免费的……插件能干的直接选中就行」。
 *
 *  只认**强特征**，宁可漏认不可误认：漏了维护方自己勾一次，误认会把付费路由写进
 *  白名单白烧额度。认得出来的特征（命中任一即 free=true，全部带出处）：
 *    · `:free` 后缀          —— Kilo/OpenRouter 系的免费道命名约定（catalog.json 实证）
 *    · `-free` 词尾 / `free` 独立词 —— OPENCODE 匿名池约定（big-pickle 之外的 7 条全是 *-free）
 *    · 中文名含「免费 / 限时免费」 —— 维护方点名
 *    · 显式零价 `0.00` / `0.0`（价格字段，等内核/OFM 把 pricing 送过来才用得上）
 *  认不出的返回 { free: null }（未知 ≠ 收费），由维护方手勾或网关报错定夺。
 *
 *  @param {string} model   原始 model id（大小写不敏感）
 *  @param {string} [name]  展示名（内核 displayName / catalog name），中文名特征在这
 *  @param {{input?: string|number, output?: string|number}} [pricing] 价格字段（有就判零价）
 *  @returns {{free: boolean|null, why: string}} */
export function freeFeatureGuess(model, name, pricing) {
	const m = String(model || "").toLowerCase();
	const n = String(name || "").toLowerCase();
	// 词边界很关键：`free` 出现在中间不算（DeepSeek-V3 **Free**der? 没有这种模型，但
	//  `freeze` / `freesail` 这类词必须挡掉），所以用 (?:^|[^a-z]) 前界 + 词尾。
	if (/:(?:free)$/.test(m)) return { free: true, why: "id 带 :free 后缀（Kilo/OpenRouter 免费道约定）" };
	if (/(?:^|[-_\/])free$/.test(m)) return { free: true, why: "id 以 -free 结尾（OPENCODE 匿名池约定）" };
	if (/免费|限时免费/.test(n)) return { free: true, why: "展示名含「免费」" };
	if (pricing !== undefined && pricing !== null) {
		const zero = (v) => v !== undefined && v !== null && Number(v) === 0;
		if (zero(pricing.input) && zero(pricing.output)) return { free: true, why: "标价 0.00/0.0（输入输出均免费）" };
	}
	return { free: null, why: "无免费特征（未知 ≠ 收费，留给维护方手勾或网关报错定夺）" };
}
