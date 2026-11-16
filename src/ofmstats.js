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
// ofmstats — 读 OFM（dsh-our-free-model）自己记的**实测账**。
//
// 为什么要有这个模块（2026-11-01 说明：「好多功能都是我们能用的」）：
//
//   OFM 面板那张「模型性能指标与用量一览」不是画出来的，是它每跑一个请求就记一笔，
//   存在 ~/.dsh/our-free-model/stats.json（STATS_VERSION = 3）。里面有 TEAM 一直
//   在**猜**的东西的真值：
//
//     models[id] = { input, output, reasoning, cacheRead, calls, failed }
//     days[date].models[id] = { ..., ttftMs, ttftSamples, decodeMs, decodeTokens }
//     logical   = { turns, failed, recovered, models:{id:{turns,failed,recovered}} }
//
//   - `calls` / `failed` 是**物理请求**级的成功失败，比 TEAM 自己按 turn 状态推测准；
//   - `logical.recovered` 是「失败了但重试救回来了」的回合数 —— TEAM 完全没有这个概念，
//     把这类当成失败会冤枉模型，当成成功又会掩盖问题；
//   - `ttftMs`（首字延迟）/ `decodeMs`（解码窗口）能算出真 tok/s，TEAM 现在只有「跑没跑过」。
//
//   TEAM 的免费台账只存「通/不通/未知」，OFM 存的是「跑了多少次、错了几次、多快」。
//   两边的 model id 是同一个（OFM 目录条目 id），所以**不用 HTTP、不用接口，直接读文件**。
//
// 只读：本模块不写 OFM 的任何文件（那是它的地盘，写坏了要背锅）。
// ---------------------------------------------------------------------------

import * as nodeFs from "node:fs";
import * as nodePath from "node:path";
import * as nodeOs from "node:os";
import { loadJson } from "./util.js";

/** OFM 的数据目录名（src/store.js 的 DATA_DIR_NAME，别改）。 */
export const OFM_DATA_DIR = "our-free-model";
/** OFM 的 stats.json 结构版本；对不上就只报版本不硬解。 */
export const OFM_STATS_VERSION = 3;
/** 少于这么多次物理请求，失败率就是噪声，不下结论（和 OFM 的 MIN_DECODE_MS 一个思路）。 */
export const OFM_MIN_CALLS = 3;
/** 解码窗口太短 / 太快都不算数，阈值沿用参考实现 OFM（它踩过 63000 tok/s 的假样本）。 */
export const MIN_DECODE_MS = 250;
export const MAX_CREDIBLE_TPS = 250;

/** 判档阈值：失败率 ≤15% 稳、≤35% 留意、再高就是坏。 */
export const OFM_RATE_SOLID = 0.15;
export const OFM_RATE_WATCH = 0.35;

/** OFM 数据目录。`$DSH_HOME` 优先，和 OFM 的 resolveDshHome 同一套规则。 */
export function ofmDataDir(env = process.env) {
	const fromEnv = env === undefined || env === null ? undefined : env.DSH_HOME;
	const home = typeof fromEnv === "string" && fromEnv.trim() !== "" ? fromEnv.trim() : nodePath.join(nodeOs.homedir(), ".dsh");
	return nodePath.join(home, OFM_DATA_DIR);
}

/**
 * 读 OFM 的 stats.json 并归一。
 *
 * @returns {{ok:boolean, why?:string, at:number, version:number, requests:number,
 *   failedRequests:number, turns:number|null, failedTurns:number|null, recoveredTurns:number|null,
 *   models:Record<string, {calls:number,failed:number,input:number,output:number,reasoning:number,
 *   cacheRead:number,tps:number|null,avgTtftMs:number|null,turns:number|null,failedTurns:number|null,
 *   recoveredTurns:number|null,lastSeen:string|null}>}}
 */
export function readOfmStats(dir = ofmDataDir(), now = Date.now()) {
	const file = nodePath.join(dir, "stats.json");
	let raw;
	try {
		const st = nodeFs.statSync(file);
		raw = loadJson(file, null);
		if (raw === null || typeof raw !== "object") return emptyStats("stats.json 不是合法 JSON", st.mtimeMs);
	} catch (error) {
		return emptyStats(`读不到 ${file}（${String((error && error.code) || (error && error.message) || error)}）`, 0);
	}
	const version = Number(raw.version);
	if (Number.isFinite(version) && version !== OFM_STATS_VERSION) {
		// 版本不认识时**不猜结构**：报版本、给空表，让调用方退回原逻辑。
		return emptyStats(`stats.json 版本 ${version}，本模块只认 ${OFM_STATS_VERSION}`, 0);
	}

	const lifetime = raw.models !== null && typeof raw.models === "object" ? raw.models : {};
	const logical = raw.logical !== null && typeof raw.logical === "object" ? raw.logical : {};
	const logicalModels = logical.models !== null && typeof logical.models === "object" ? logical.models : {};
	const days = raw.days !== null && typeof raw.days === "object" ? raw.days : {};

	// 延迟/速度只存在于按天的分片里，跨天累加（和 OFM buildStats 同一算法）。
	const windows = Object.create(null);
	const lastSeen = Object.create(null);
	for (const day of Object.keys(days).sort()) {
		const bucket = days[day];
		const models = bucket !== null && typeof bucket === "object" && bucket.models !== null && typeof bucket.models === "object" ? bucket.models : {};
		for (const id of Object.keys(models)) {
			const row = models[id];
			if (row === null || typeof row !== "object") continue;
			const acc = windows[id] ?? (windows[id] = { ttftMs: 0, ttftSamples: 0, decodeMs: 0, decodeTokens: 0 });
			acc.ttftMs += num(row.ttftMs);
			acc.ttftSamples += num(row.ttftSamples);
			acc.decodeMs += num(row.decodeMs);
			acc.decodeTokens += num(row.decodeTokens);
			lastSeen[id] = day;
		}
	}

	const models = Object.create(null);
	for (const id of new Set([...Object.keys(lifetime), ...Object.keys(logicalModels)])) {
		const life = lifetime[id] !== null && typeof lifetime[id] === "object" ? lifetime[id] : {};
		const win = windows[id] ?? { ttftMs: 0, ttftSamples: 0, decodeMs: 0, decodeTokens: 0 };
		const log = logicalModels[id] !== null && typeof logicalModels[id] === "object" ? logicalModels[id] : {};
		models[id] = {
			calls: num(life.calls),
			failed: num(life.failed),
			input: num(life.input),
			output: num(life.output),
			reasoning: num(life.reasoning),
			cacheRead: num(life.cacheRead),
			// 窗口够长才给速度；否则 null = 「没测出来」，不是 0。
			tps: win.decodeMs >= MIN_DECODE_MS ? clampTps(win.decodeTokens / (win.decodeMs / 1000)) : null,
			avgTtftMs: win.ttftSamples > 0 ? Math.round(win.ttftMs / win.ttftSamples) : null,
			turns: Number.isSafeInteger(log.turns) ? log.turns : (Number.isSafeInteger(logical.turns) ? null : num(log.turns)),
			failedTurns: Number.isSafeInteger(log.failed) ? log.failed : (Number.isSafeInteger(logical.failed) ? null : num(log.failed)),
			recoveredTurns: num(log.recovered),
			lastSeen: typeof lastSeen[id] === "string" ? lastSeen[id] : null,
			// 2026-11-01 评分用：逐日 `decodeMs` 累加 = 这条路由**真解码了多久**。
			// 和 TEAM 台账的 usedMs 是同一件事的另一种记法，给 OFM 车道补「耐力」这一维
			// （OFM 的 lifetime 表里没有时长，只有 days 分片里才有）。
			decodeMs: win.decodeMs,
		};
	}

	return {
		ok: true,
		at: num(raw.at) || now,
		version: Number.isFinite(version) ? version : OFM_STATS_VERSION,
		requests: num(raw.requests),
		failedRequests: num(raw.failedRequests),
		turns: Number.isSafeInteger(logical.turns) ? logical.turns : null,
		failedTurns: Number.isSafeInteger(logical.failed) ? logical.failed : null,
		recoveredTurns: num(logical.recovered),
		models,
	};
}

function emptyStats(why, at) {
	return {
		ok: false, why, at: num(at), version: 0,
		requests: 0, failedRequests: 0, turns: null, failedTurns: null, recoveredTurns: null,
		models: Object.create(null),
	};
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const clampTps = (v) => (Number.isFinite(v) && v > 0 && v <= MAX_CREDIBLE_TPS ? Math.round(v) : null);

/**
 * 一条路由的实测判档。
 *
 * 档位只有四个，且**样本不够就不下结论**——维护方 2026-10-31 定的规矩：
 * 「不可用就写不可用，别猜」。这里同理，样本不够写 `thin`，不撮合进好/坏。
 *
 * @returns {{state:"solid"|"watch"|"bad"|"thin"|"none", calls:number, failed:number,
 *   failRate:number|null, tps:number|null, avgTtftMs:number|null, why:string}}
 */
export function ofmVerdict(row, minCalls = OFM_MIN_CALLS) {
	if (row === undefined || row === null) return { state: "none", calls: 0, failed: 0, failRate: null, tps: null, avgTtftMs: null, why: "OFM 没记过这个模型" };
	const calls = num(row.calls);
	const failed = num(row.failed);
	const tps = row.tps === null || row.tps === undefined ? null : row.tps;
	const avgTtftMs = row.avgTtftMs === null || row.avgTtftMs === undefined ? null : row.avgTtftMs;
	if (calls <= 0) return { state: "none", calls: 0, failed, failRate: null, tps, avgTtftMs, why: "有记录但 0 次请求" };
	const failRate = failed / calls;
	if (calls < minCalls) return { state: "thin", calls, failed, failRate, tps, avgTtftMs, why: `样本 ${calls} 次，不到 ${minCalls} 次不做判断` };
	if (failed === calls) return { state: "bad", calls, failed, failRate, tps, avgTtftMs, why: `${calls} 次全失败` };
	if (failRate > OFM_RATE_WATCH) return { state: "bad", calls, failed, failRate, tps, avgTtftMs, why: `失败率 ${pct(failRate)}（${failed}/${calls}），高于 ${pct(OFM_RATE_WATCH)}` };
	if (failRate > OFM_RATE_SOLID) return { state: "watch", calls, failed, failRate, tps, avgTtftMs, why: `失败率 ${pct(failRate)}（${failed}/${calls}），需要留意` };
	return { state: "solid", calls, failed, failRate, tps, avgTtftMs, why: `失败率 ${pct(failRate)}（${failed}/${calls}）` };
}

export const pct = (v) => (typeof v === "number" && Number.isFinite(v) ? `${Math.round(v * 1000) / 10}%` : "—");

/**
 * 给台账条目批量挂实测数据。**只读 OFM、只写 entry 上的一个字段**，不动 status。
 *
 * 为什么不直接改 status：OFM 的统计是「历史上跑过多少」，不是「现在能不能用」。
 * 一个模型可以昨天错 40% 今天修好；把它一票打成不可用，就重演了 QODER 那个坑。
 * 这些数字是给**排序**和**打分**用的证据，不是开关。
 *
 * @returns {{matched:number, stats:object, at:number}}
 */
export function annotateOfmLedger(entries, stats) {
	if (!Array.isArray(entries) || stats === null || stats === undefined || stats.ok !== true) {
		return { matched: 0, stats, at: stats === undefined ? 0 : num(stats.at) };
	}
	let matched = 0;
	let cleared = 0;
	for (const entry of entries) {
		if (entry === null || typeof entry !== "object") continue;
		const id = ofmIdOf(entry);
		if (id === null) {
			// **对不上就必须清掉**（2026-11-01 维护方抓到 cline 挂着 OFM 读数）。
			// 光收紧匹配规则没用：`entry.ofm` 是从 ledger.json 读回来的历史字段，
			// 只改 ofmIdOf 的话，老数据还挂在内存里，面板照旧画那个「稳」。
			// 所以「这条路由不归 OFM 管」= 显式删掉这个字段，让它跟着下次 persist 落盘。
			if (entry.ofm !== undefined) { delete entry.ofm; cleared++; }
			continue;
		}
		const row = stats.models[id];
		if (row === undefined) {
			if (entry.ofm !== undefined) { delete entry.ofm; cleared++; }
			continue;
		}
		const verdict = ofmVerdict(row);
		entry.ofm = {
			id,
			calls: verdict.calls,
			failed: verdict.failed,
			failRate: verdict.failRate === null ? null : Math.round(verdict.failRate * 1000) / 1000,
			state: verdict.state,
			tps: verdict.tps,
			ttftMs: verdict.avgTtftMs,
			recoveredTurns: num(row.recoveredTurns),
			lastSeen: row.lastSeen === undefined ? null : row.lastSeen,
			at: num(stats.at),
		};
		matched++;
	}
	return { matched, cleared, stats, at: num(stats.at) };
}

/**
 * 台账条目 → OFM stats.json 的 model id。
 *
 * **只有 OFM 自己那条车道才有这把钥匙。** OFM 注册给内核的 provider 就两个：
 * `our-free-model` 和 `our-free-model-region`（`src/adapter.js` 的 ROUTE_MAIN /
 * ROUTE_REGION）。OFM 的 stats.json 记的是「OFM 自己发出去的那些物理请求」，
 * 所以只有走 OFM 车道的台账条目才该跟它对得上。
 *
 * 2026-11-01 维护方当场抓到反例：面板上 `cline/reflection/beam-free` 后面挂着
 * 「OFM 稳 …」—— 可 cline 是 Cline 自己的渠道，OFM 一个字节都没经手。
 * 成因是下面那条**兜底猜测**：model 带 `/` 或 `:free` 就当它是 OFM 的键。
 * `reflection/beam-free` 正好带斜杠，于是借到了 `our-free-model` 那份
 * 「343 次、错 3.8%」的读数 —— 两条完全不同的路由被画成同一份履历。
 *
 * 现在按维护方「别猜」的规矩收紧：**provider 必须是 OFM 的**，
 * 不在白名单里的 provider 一律返回 null。宁可面板上少一个徽标，
 * 也不能把别家的运气算到这条路由头上。
 */
const OFM_PROVIDERS = new Set(["our-free-model", "our-free-model-region"]);

export function ofmIdOf(entry) {
	if (entry === null || typeof entry !== "object") return null;
	const provider = String(entry.provider || "");
	const model = String(entry.model || "").trim();
	if (model === "") return null;
	if (!OFM_PROVIDERS.has(provider)) return null;
	// OFM 车道的 model 就是 OFM 目录条目 id，同一把钥匙，直接用（可以带斜杠）。
	return model;
}

/**
 * 台账条目 → **可靠性优先分**（-1 / 0 / +1 / null），给 pickRoute 当平手裁决的**第一维**。
 *
 * 为什么不是过滤而是排序：维护方 2026-11-01 定的红线 —— OFM 的统计是历史表现，
 * **不是可用性开关**。所以：solid 提前、bad 排队尾、thin/none 一律 null（不表态），
 * 谁也不被踢出候选。坏路由只是"排在同等的队友后面"，而不会永远轮不到它。
 *
 * @returns {number|null} +1 稳 / 0 留意 / -1 差 / null 没数或样本太薄
 */
export function ofmRank(entry) {
	const ofm = entry === null || typeof entry !== "object" ? undefined : entry.ofm;
	if (ofm === null || ofm === undefined || typeof ofm !== "object") return null;
	if (num(ofm.calls) < OFM_MIN_CALLS) return null; // 样本不足：不表态（和 routeScore 同一规矩）
	if (ofm.state === "solid") return 1;
	if (ofm.state === "watch") return 0;
	if (ofm.state === "bad") return -1;
	return null;
}

// ===========================================================================
// 速度这一维（2026-11-01 说明：「一个稳定的16TOK/S跟一个比较稳定100TOK/S，
// 你觉得你应该知道选哪个吧」）
//
// 实现方原来的排序只比失败率，于是「16 tok/s」和「151 tok/s」两条 solid **被当成并列**，
// 谁先谁后看运气。真机数据里这个洞很大：
//
//   glm-5.3    360次 错7.2%  solid    16tok/s  首字30454ms
//   beam-free  305次 错3.9%  solid   151tok/s  首字 2585ms
//
// 两条都"稳"，但同一个 1000 token 的活，前者要 **93 秒**，后者 **9 秒** —— 差 10 倍。
//
// 所以速度不能只看 tok/s：**首字延迟**才是差距最大的那一段（30.5s vs 2.6s）。
// 维护方提问「首字是不是应该也算进排班」，答案是算，而且必须和 tok/s 合成一个
// 人能看懂的数：**干完这活要多久**。
//
//   预计秒数 = 首字延迟 + 产出 token 数 / tok/s
//
// 产出按 1000 token 估（成员一次汇报 / 一段代码的量级）。这不是精确预测，
// 是**同一把尺子**——所有路由都按同一个产出量比，谁快谁慢就不会错。
// ===========================================================================

/** 排序基准：按产出 1000 token 折算。改这个数只影响相对顺序的量级，不影响谁比谁快。 */
export const OFM_SAMPLE_OUTPUT_TOKENS = 1000;
/** 没测出速度的路由，比较时按这个中位秒数算 —— 不奖励也不惩罚（照「样本不够不表态」的规矩）。 */
export const OFM_ETA_UNKNOWN_S = 30;

/**
 * 这条路由干一个标准活（1000 token）预计要多少秒。
 *
 * 首字延迟和 tok/s 缺一不可：少了 tok/s 就没法估解码段，返回 null（不表态）。
 * 首字缺失按 0 算（比按 30 秒猜好——OFM 没记首字说明它没采到样本）。
 *
 * @returns {number|null} 秒；null = 没测出速度
 */
export function ofmEtaSeconds(ofm) {
	if (ofm === null || ofm === undefined || typeof ofm !== "object") return null;
	if (num(ofm.calls) < OFM_MIN_CALLS) return null; // 样本太薄：不表态
	const tps = ofm.tps === null || ofm.tps === undefined ? null : Number(ofm.tps);
	if (tps === null || !Number.isFinite(tps) || tps <= 0) return null;
	const ttftMs = ofm.ttftMs === null || ofm.ttftMs === undefined ? 0 : Math.max(0, Number(ofm.ttftMs) || 0);
	const decodeS = OFM_SAMPLE_OUTPUT_TOKENS / tps;
	return Math.round((ttftMs / 1000 + decodeS) * 10) / 10;
}

/** 排序用的速度分：**越小越快**。没测出速度的退回中位数（不奖励也不惩罚）。 */
export function ofmSpeedRank(entry) {
	const ofm = entry === null || typeof entry !== "object" ? undefined : entry.ofm;
	const eta = ofmEtaSeconds(ofm === undefined ? null : ofm);
	return eta === null ? OFM_ETA_UNKNOWN_S : eta;
}

/** 人话版：`约93s（首字30.5s + 解码62.5s）`。没数据返回空串。 */
export function ofmEtaText(ofm) {
	const eta = ofmEtaSeconds(ofm);
	if (eta === null) return "";
	const ttftMs = ofm.ttftMs === null || ofm.ttftMs === undefined ? 0 : Math.max(0, Number(ofm.ttftMs) || 0);
	const decodeS = Math.round((OFM_SAMPLE_OUTPUT_TOKENS / Number(ofm.tps)) * 10) / 10;
	return `约${eta}s（首字${Math.round(ttftMs / 100) / 10}s + 解码${decodeS}s）`;
}

/** 面板/工具用的紧凑徽标：`20次·错75%·187tok/s·约14.3s`。没有实测就返回空串（不画假数据）。 */
export function ofmBadge(ofm) {
	if (ofm === null || ofm === undefined || typeof ofm !== "object") return "";
	if (num(ofm.calls) <= 0) return "";
	const bits = [`${num(ofm.calls)}次`];
	if (ofm.failRate !== null && ofm.failRate !== undefined) bits.push("错" + pct(num(ofm.failRate)));
	if (ofm.tps !== null && ofm.tps !== undefined) bits.push(`${num(ofm.tps)}tok/s`);
	const eta = ofmEtaSeconds(ofm);
	if (eta !== null) bits.push(`约${eta}s`);
	return bits.join("·");
}

/** 面板/工具用的一行摘要。 */
export function ofmRowText(row) {
	const v = ofmVerdict(row);
	const bits = [v.state, `${v.calls}次`];
	if (v.failRate !== null) bits.push(`错${pct(v.failRate)}`);
	if (v.tps !== null) bits.push(`${v.tps}tok/s`);
	if (v.avgTtftMs !== null) bits.push(`首字${v.avgTtftMs}ms`);
	return bits.join("｜");
}
