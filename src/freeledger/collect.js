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
// freeledger/collect — 采集层：台账里每一条从哪来、每个字段是什么根据
//
// 2026-11-02 模块化改造第三刀。原来采集（内核/OFM/探活）、白名单判定、版本哨兵、
// 渲染全挤在 src/ledger.js 一个 630 行的文件里，维护方点名的病：「别每次改一个要改
// 一整个大文件」。拆开后的规矩：
//   · collect.js    —— 本文件：syncFromKernel / syncFromOfm / applyAvailability /
//                      inferVision / 历史追加 / OFM 版本哨兵（只**登记事实**，不做派单决定）
//   · whitelist.js  —— 白名单读 + 免费特征识别（wl===null 是「不知道」不是「全禁」！）
//   · pool.js       —— 共享池归组与整组熔断
//   · dispatch.js   —— 派活唯一闸 dispatchable() + pickRoute
// ledger.js 保留：persist 注入点、re-export（import 路径不断）、STATUS_TEXT/渲染。
//
// 采集只写台账字段（status/whitelist/vision/ctx...），**永远不判「能不能派」** ——
// 那是 dispatch.js 的事。两层各自独立可改，这就是需求方要的「需要什么判断去找什么模块」。
// ---------------------------------------------------------------------------

import * as nodeFs from "node:fs";
import * as nodePath from "node:path";
import { ledger } from "../state.js";
import { stateDirPath } from "../config.js";
import { dayStamp, loadJson } from "../util.js";
import { whitelistFromPatch } from "./whitelist.js";

/** 落盘钩子：collect 不 import ledger.js（会成环），由 ledger.js 启动时注入。 */
let persistHook = () => {};
export function setCollectPersist(fn) { persistHook = typeof fn === "function" ? fn : () => {}; }
function persist() { persistHook(); }

/** 档位「复核保鲜期」（天）。
 *
 *  为什么需要（2026-11-16 · Updating\04 · 遗留 1）：
 *  `index.js` 的 `syncModelInfo()` 判据是「ctx/out/efforts/vision 四项都有值就 continue」，
 *  于是**首遇快照会永久生效**。mistral-large-4-1t-a52b 从 2026-10-31 首遇起一直挂着
 *  `light/balanced/deep`，而它 2026-11-01 就从内核目录消失了 —— 目录外模型内核侧
 *  `reasoning: undefined`，发**任何**档位词都抛 UNSUPPORTED_REASONING_EFFORT。
 *  **假档位比没档位更坏**：选路器会照这份陈数据挑词，派下去必死。
 *
 *  7 天是折中：够短能跟上目录变化，够长不至于每轮 tick 把几百条路由全量问一遍内核。
 *  与 `index.js` 里的同名判据联动 —— 改这个数就同时改了那边的重查节奏。 */
export const EFFORTS_RECHECK_DAYS = 7;

/** 台账 efforts 的「真相文本」：内核明确答了但没有 reasoning 元数据时写这个。
 *  `gears.js` 的 `gearTokens()` 认不出它（不是合法档位名）⇒ `effortLadder` 返回空数组
 *  ⇒ `effortFor()` 走 `known:false` 分支 ⇒ 派单不再给它挑档位。这正是想要的。 */
export const EFFORTS_ABSENT_TEXT = "无思考开关（内核不给档位）";

export function applyAvailability(ctx, cfg) {
	// availability.json covers the our-free-model lanes; manualResults override results (§6 rule).
	const raw = loadJson(cfg.availabilityPath, null);
	if (!raw || typeof raw !== "object") return 0;
	const results = raw.results || {};
	const manual = raw.manualResults || {};
	let touched = 0;
	for (const [key, entry] of ledger) {
		if (entry.provider !== "our-free-model") continue;
		const model = entry.model;
		const r = results[model] || manual[model];
		const mm = manual[model];
		const chosen = mm || r;
		if (!chosen) continue;
		const state = (mm && mm.state) || chosen.state;
		const at = Number(chosen.at || 0);
		if (entry.lastProbeAt && at < entry.lastProbeAt && !entry.realAt) continue;
		if (state === "available") {
			// ★ 2026-11-16 修（Updating\03）：已判「内核目录下架」的路由不许被探活复活。
			//   实证两条（不是推理，台账里躺着的）：
			//     · liquid/lfm-2.5-2.6b:free —— 11-04 10:02 判死，被 11-03 21:33 的
			//       manual available 改回 status=ok，delisted 至今仍是 true
			//     · deepseek-ai/deepseek-v4.1-flash —— 11-01 15:46 判死，被 11-12 11:47
			//       的 manual available 改回 ok（updatedStr 正好是那一刻）
			//   两者的口径谁是"现在时"：available 是**那一次探活成功过**（旧快照，
			//   availability.json 里全带 stale:true），delisted 是**内核现在不列它了**。
			//   旧快照不许推翻现在时 —— 否则 dispatchable 的 delisted 排除会在
			//   applyAvailability 之后（它先于 syncFromKernel 跑）被抹掉。
			//   注：真跑成功仍可解封，那条通道在 index.js 的 recordRealRun（硬证据）。
			if (entry.delisted === true) continue;
			if (entry.status === "invalid" && entry.realResult !== "fail") { entry.status = "ok"; entry.backoffUntil = 0; entry.failStreak = 0; }
		} else if (state === "throttled" || state === "error" || state === "region-blocked") {
			if (entry.realResult === "ok" && Date.now() - Number(entry.realAt || 0) < 10 * 60 * 1000) continue; // fresh real-run beats probe
			entry.status = "invalid";
			entry.errClass = state === "region-blocked" ? "地区封锁" : state === "throttled" ? "额度限流" : entry.errClass;
			if (chosen.detail) entry.note = String(chosen.detail).slice(0, 120);
		}
		entry.lastProbeAt = Math.max(entry.lastProbeAt || 0, at);
		entry.updatedStr = dayStamp(new Date(at || Date.now()));
		touched++;
		void ctx;
	}
	return touched;
}

/** OFM 目录同步（2026-10-29 设计确定：免费模型列表一直在变，插件要跟上）。
 *  OFM 换版会重写 ~/.dsh/our-free-model/catalog.json（kiloRows / entries / sealIds），
 *  这里是台账唯一的新增入口：只读本地文件，不发任何网络请求。
 *  规则与维护规则 §6 一致：
 *   - 只补台账没有的条目；已有条目一个字段都不覆盖（实测 > 目录 > 探活）
 *   - 新条目状态取 availability 探活：available→ok、throttled/error/region-blocked→invalid、
 *     白名单未开→invalid、没探过→unknown
 *   - 目录里消失的条目不删，只追加「OFM 目录已无此模型」，历史实测值留着
 *  ctx/out 用目录标称值换算成 K；目录没报就写「未 advertised」，不当成无限。 */
export function syncFromOfm(cfg, now = Date.now()) {
	const catPath = nodePath.join(nodePath.dirname(cfg.availabilityPath), "catalog.json");
	const cat = loadJson(catPath, null);
	if (cat === null || typeof cat !== "object") return { added: 0, gone: 0, why: "no catalog.json" };
	const av = loadJson(cfg.availabilityPath, null) || {};
	const probeOf = (model) => {
		const r = (av.manualResults || {})[model] || (av.results || {})[model];
		return r === null || r === undefined || typeof r !== "object" ? null : r;
	};
	const rows = [];
	for (const r of Array.isArray(cat.kiloRows) ? cat.kiloRows : []) {
		if (r === null || r === undefined || typeof r.id !== "string") continue;
		rows.push({ model: r.id, channel: "kilo", ctx: r.contextWindow, out: r.maxOutput, gears: r.efforts, vision: typeof r.vision === "boolean" ? r.vision : null });
	}
	for (const id of Array.isArray(cat.entries) ? cat.entries : []) if (typeof id === "string") rows.push({ model: id, channel: "free", vision: null });
	for (const id of Array.isArray(cat.sealIds) ? cat.sealIds : []) if (typeof id === "string") rows.push({ model: id, channel: "eac", vision: null });
	const present = new Set();
	let added = 0;
	let visionFilled = 0;
	for (const row of rows) {
		present.add(row.model);
		const key = "our-free-model/" + row.model;
		if (ledger.has(key)) {
			// 2026-10-29 维护方提问「需要读图的活现在派得出去吗」：视觉能力必须落进台账。
			// 目录里有的直接信目录；目录没说的先留 null（未知 ≠ 不支持，派读图活时会跳过未知）。
			const ex = ledger.get(key);
			if (row.vision === true || row.vision === false) {
				if (ex.vision !== row.vision || ex.visionSrc !== "catalog") {
					ex.vision = row.vision;
					ex.visionSrc = "catalog";
					visionFilled++;
				}
			}
			continue;
		}
		const p = probeOf(row.model);
		const state = p === null ? "" : String(p.state || "");
		const detail = p === null ? "" : String(p.detail || "");
		const wlClosed = /not allowed for this Session/.test(detail);
		const status = wlClosed ? "invalid"
			: state === "available" ? "ok"
				: state === "throttled" || state === "error" || state === "region-blocked" ? "invalid" : "unknown";
		const ctxTxt = typeof row.ctx === "number" && row.ctx > 0 ? `${Math.round(row.ctx / 1024)}K` : "未 advertised";
		const outTxt = typeof row.out === "number" && row.out > 0 ? `${Math.round(row.out / 1024)}K` : "—";
		const gears = Array.isArray(row.gears) ? row.gears.map(String) : [];
		ledger.set(key, {
			provider: "our-free-model",
			model: row.model,
			status,
			ctx: ctxTxt,
			out: outTxt,
			efforts: gears.length > 0 ? gears.join("/") : "无思考开关（内核不给档位）",
			whitelist: wlClosed ? "closed" : "allow",
			expiry: "无逐模型到期时间（插件探测）",
			note: `OFM 目录同步发现（${row.channel} 通道${detail ? "；" + detail.slice(0, 80) : ""}）`,
			realResult: null,
			realAt: null,
			errClass: state === "throttled" ? "额度限流" : state === "region-blocked" ? "地区封锁" : null,
			lastProbeAt: p === null ? 0 : Number(p.at || 0),
			failStreak: 0,
			backoffUntil: 0,
			updatedStr: dayStamp(new Date(now)),
			channel: row.channel,
			// 视觉能力：目录说了就信目录（true/false），没说留 null = 未知。
			// 未知既不能当"能读图"（派出去必失败），也别直接判死。
			vision: row.vision === true ? true : row.vision === false ? false : null,
			visionSrc: row.vision === true || row.vision === false ? "catalog" : null,
		});
		added++;
		appendLedgerHistory(cfg, "our-free-model", row.model, "OFM 新增", `${row.channel} 通道；目录 ${typeof row.ctx === "number" ? Math.round(row.ctx / 1024) + "K" : "未广告"}，状态 ${status}`);
	}
	let gone = 0;
	for (const [, e] of ledger) {
		if (e.provider !== "our-free-model") continue;
		if (present.has(e.model)) continue;
		if (String(e.note || "").indexOf("OFM 目录已无此模型") >= 0) continue;
		const tail = `OFM 目录已无此模型（${dayStamp(new Date(now))}，历史实测保留）`;
		e.note = (e.note === undefined || e.note === null || e.note === "" ? "" : String(e.note) + "；") + tail;
		gone++;
		appendLedgerHistory(cfg, e.provider, e.model, "OFM 下架", "OFM 目录里已无此模型；条目保留（历史实测值不删）");
	}
	// 目录没说视觉能力的那批（cline / 内核发现的路由）用名字推断，只补 null，不覆盖目录值。
	let visionInferred = 0;
	for (const [, e] of ledger) {
		if (e.vision !== null && e.vision !== undefined) continue;
		const guess = inferVision(e.model);
		if (guess === null) continue;
		e.vision = guess;
		e.visionSrc = "name";
		visionInferred++;
	}
	if (added > 0 || gone > 0 || visionFilled > 0 || visionInferred > 0) persist();
	return { added, gone, visionFilled: visionFilled + visionInferred };
}

/** 视觉能力（能不能读图）—— 2026-10-29 维护方提问「派读图的活现在是不是派不出去」。
 *  数据来源按可信度排序：`catalog`（OFM 目录的 vision 字段）> `name`（名字推断）> `null`（未知）。
 *  名字推断只认**强线索**：`-vl` / `vision` / `omni` / `-vl:` 这类命名约定；
 *  推断值会被标成 visionSrc:"name"，派单时**同样算数**（不然 cline 那批 28 条全派不了读图活），
 *  但面板上会跟目录值区分开，撞墙后可以人工纠正。 */
export function inferVision(model) {
	const m = String(model || "");
	if (m === "") return null;
	if (/[-_/]vl\b|[-_]vl[:/-]|vision|omni|multimodal|[-_]mm\b/i.test(m)) return true;
	return null;
}

/** 台账历史记录（维护方 2026-10-29 问「历史记录为什么不能新建一个 MD」）。
 *  老台账 md 退役，历史不跟着断：插件自己往 ledgerHistoryPath 追加人可读的行。
 *  数据源仍然是 .state/ledger.json，这个文件只是"发生过什么"的时间线，只留最近 N 行。 */
export const LEDGER_HISTORY_KEEP = 4000;
export function appendLedgerHistory(cfg, provider, model, kind, detail) {
	const p = cfg === undefined || cfg === null ? undefined : cfg.ledgerHistoryPath;
	if (typeof p !== "string" || p.trim() === "") return;
	try {
		nodeFs.mkdirSync(nodePath.dirname(p), { recursive: true });
		let text = "";
		try { text = nodeFs.readFileSync(p, "utf8"); } catch { text = ""; }
		if (text === "") {
			text = "# 免费模型台账 · 历史记录（插件自动追加，人可读；数据源是 .state/ledger.json）\n\n"
				+ "| 时间 | 路由 | 事件 | 详情 |\n|---|---|---|---|\n";
		}
		const cell = (v) => String(v === undefined || v === null ? "" : v).replace(/\|/g, "/").replace(/\s+/g, " ").slice(0, 220);
		text += `| ${dayStamp()} | ${cell(String(provider) + "/" + String(model))} | ${cell(kind)} | ${cell(detail)} |\n`;
		const lines = text.split("\n");
		if (lines.length > LEDGER_HISTORY_KEEP + 6) text = lines.slice(0, 4).join("\n") + "\n" + lines.slice(-LEDGER_HISTORY_KEEP).join("\n");
		nodeFs.writeFileSync(p, text, "utf8");
	} catch { /* 历史写不进去不影响主流程 */ }
}

/** 从内核 llm 服务同步模型清单（2026-10-29 起接手 python 扫描器的"发现新模型"职能）。
 *  listProviders() → 每个 provider 调 listModels()，台账没有的按 unknown 登记；顺带用
 *  cordis.patch.yml 的 allowedModels 回填 whitelist 未知的条目。
 *  listModels 可能让 adapter 向服务端问一次，所以每个 provider 加 5 秒超时，失败就跳过、不阻塞派活。 */
export async function syncFromKernel(ctx, cfg) {
	// 2026-11-01 修：白名单是**配置文件**决定的事实，和内核 llm 能不能用毫无关系。
	// 原来这里一拿不到 llm 就整个 return，白名单环节一起被跳过 —— 于是维护方删掉的路由
	// 永远收回不来（qoder/qfmodel 就是这么一直挂在候选里的）。
	// 现在：llm 不可用也照做白名单，只为发现新模型才需要 llm。
	const llm = ctx.get ? ctx.get("llm", false) : ctx.llm;
	const usable = llm !== undefined && llm !== false && typeof llm.listProviders === "function" && typeof llm.listModels === "function";
	let providers = [];
	let why = "";
	if (usable) {
		try { providers = llm.listProviders(); } catch (error) { why = String(error); providers = []; }
		if (!Array.isArray(providers)) providers = [];
	} else {
		why = "内核 llm 不可用（只做白名单同步）";
	}
	const wl = whitelistFromPatch(cfg);
	// ★ 2026-11-02 发包踩雷第 4 条，这条是最要命的。
	//   `wl === null` 的含义是「**读不到白名单**」，不是「谁都不许用」。
	//   原来写成 `if (wl === null || !wl.has(key)) continue;` —— 读不到就当全禁，
	//   于是别人机器上（profile 名对不上、或压根没配 allowedModels）台账收 0 条，
	//   没有可派路由，整个插件等于没装。设计说明：「免费台账开始就是空的，一个模型都没有」。
	//   现在：wl 未知 → 内核列出的一律收进来，标 `whitelist:"unknown"`。
	//   未知**不参与派单**（见 index.js pickRoute 的 unknownFallback），但：
	//     · 台账有行，面板看得见，维护方知道内核里有什么；
	//     · 网关真拒时 errbook 归「白名单未开」，跟着 wl 生效后的回填自动转 closed；
	//     · profile 一旦配了 allowedModels，下一次同步就把 unknown 判成 allow/closed（415 行那段）。
	const wlKnown = wl !== null;
	const timed = (p, ms) => Promise.race([
		Promise.resolve(p),
		new Promise((resolve) => { const t = setTimeout(() => resolve(null), ms); if (typeof t.unref === "function") t.unref(); }),
	]);
	let added = 0, asked = 0, failed = 0, wlApplied = 0, visionApplied = 0;
	/** 本次内核真正列出来的路由。用于「内核目录已下架 → 台账跟着不可用」的判定。 */
	const seen = new Set();
	let seenProviders = new Set();
	for (const p of providers) {
		const pid = p === null || p === undefined ? undefined : p.id;
		if (typeof pid !== "string" || pid === "") continue;
		let models = null;
		try { models = await timed(llm.listModels(pid), 5000); } catch { models = null; }
		if (models === null || !Array.isArray(models)) { failed++; continue; }
		asked++;
		seenProviders.add(pid);
		for (const m of models) {
			const mid = m === null || m === undefined ? undefined : m.id;
			if (typeof mid !== "string" || mid === "") continue;
			const key = pid + "/" + mid;
			seen.add(key);
			// 显示名对齐聊天框（维护方 2026-11-01 定：「免费台账显示改用聊天框下方同一个模型名」）。
			// 聊天框下方那个名字来自内核 catalog 的 `model.name`（见 dsh-api-session-controller
			// lib/types/catalog.js：`{ id: model.id, name: model.name }`），而台账 key 是
			// `provider/model` 的原始 id。两者对不上时需求方要自己翻译一遍，所以把内核那个名字存下来。
			// **只用于展示**：`model` 字段一个字都不能改 —— 派单、白名单、OFM 映射全按原始 id 匹配。
			const dispName = typeof m.name === "string" && m.name.trim() !== "" ? m.name.trim() : null;
			// 视觉能力：内核 `LlmModelInfo.inputModalities` 里有没有 "image"。这是**最权威**的来源
			// （比 OFM 目录全、比名字推断准），所以对已存在的条目也回填 —— 维护方提问「你也能读图、
			// QWEN 也能读图，为啥没有」就是之前根本没问内核，只从 OFM 目录和名字猜。
			const mods = Array.isArray(m.inputModalities) ? m.inputModalities.map((x) => String(x)) : null;
			if (mods !== null && mods.length > 0) {
				const sees = mods.indexOf("image") >= 0;
				const ex = ledger.get(key);
				if (ex !== undefined && (ex.vision !== sees || ex.visionSrc !== "kernel")) {
					ex.vision = sees;
					ex.visionSrc = "kernel";
					visionApplied++;
				}
			}
			// 显示名同样回填老条目（内核换了名字，面板要跟着换；换完就不动，别每次都写盘）
			if (dispName !== null) {
				const ex = ledger.get(key);
				if (ex !== undefined && ex.displayName !== dispName) ex.displayName = dispName;
			}
			if (ledger.has(key)) continue;
			// 台账收哪些：白名单**知道**时只收放行的（内核里挂着官方付费路由，
			// 无差别收录会把付费模型变成可派候选 —— 白名单就是唯一口径）；
			// 白名单**读不到**时全收并标 unknown（见上面 wlKnown 那段：不知道 ≠ 全禁）。
			if (wlKnown && !wl.has(key)) continue;
			ledger.set(key, {
				provider: pid, model: mid, status: "unknown", ctx: "未 advertised", out: "—",
				efforts: "无思考开关（内核不给档位）",
				whitelist: wlKnown ? "allow" : "unknown",
				expiry: "", note: "内核模型清单同步发现", realResult: null, realAt: null,
				errClass: null, lastProbeAt: 0, failStreak: 0, backoffUntil: 0,
				updatedStr: dayStamp(), channel: "",
				vision: mods === null || mods.length === 0 ? null : mods.indexOf("image") >= 0,
				visionSrc: mods === null || mods.length === 0 ? null : "kernel",
				...(dispName === null ? {} : { displayName: dispName }),
			});
			added++;
			appendLedgerHistory(cfg, pid, mid, "内核发现", wlKnown
				? "内核清单里有且白名单放行，状态待实测"
				: "内核清单里有（白名单读不到，先登记为 unknown 不参与派单，配好 allowedModels 后自动转正）");
		}
	}
	// 内核目录已下架 → 台账跟着不可用（2026-11-01 设计确定：的口径）。
	// 设计说明：「DSH 子智能体显示已授权不可用，我们这里就应该直接就不可用，这才是最省事的，
	// 而且不止这一个，好多不可用的都在我们免费台账里是绿灯」。
	// 场景：OFM 远端目录已经不提供 spark-x 了（只剩 Spark-X2.6），DSH 子智能体设置页把它
	// 归进「已保存但当前不可用」，可台账还亮着 ok/allow 绿灯，选路时照样会被挑走 → 必失败。
	// 规矩：**内核 listModels 真的问到了这个 provider、但没列出这条模型 → 台账立即判不可用**。
	// 三层保护，一条都不能省：
	//   1) 该 provider 本次必须 `asked` 成功（没问成 ≠ 已下架，网络抖动不能判死）；
	//   2) 不删条目（历史实测值、seenMax 都留着，模型回来后立刻恢复）；
	//   3) 回来后自动恢复：下次 seen 里有它，就把 delisted 标记撤掉，**并把状态还原**。
	//      2026-11-01 维护方提醒：「万一哪天从不可用出来了，还是要恢复，别跟 QODER 似的只排除不恢复」。
	//      原来这里只清标记、不清 status，结果是模型回来了台账还挂着 invalid —— 等于永远用不了。
	let delisted = 0;
	let relisted = 0;
	if (seenProviders.size > 0) {
		for (const [key, e] of ledger) {
			const pid = String(e.provider || "");
			if (!seenProviders.has(pid)) continue;
			const inSeen = seen.has(key);
			if (!inSeen) {
				// ★ 2026-11-16 修（Updating\03）：原来这里 `if (e.delisted === true) continue;`
				//   —— 判死只做一次，之后谁把它改回 ok 都不再重判。复活路径实测有两条
				//   （liquid/lfm-2.5-2.6b:free、deepseek-ai/deepseek-v4.1-flash），
				//   所以这里改成「已标过就**不重复写 note/历史**，但仍复核状态」。
				const already = e.delisted === true;
				if (!already) {
					e.delisted = true;
					e.delistedAt = Date.now();
				}
				// 只有原本"可派"的才需要判死；已经 invalid 的只补标记。
				// ★ unknown 也判死（2026-11-16 修）：unknown 是「还没实测」，不是「可能活着」——
				//   内核目录都不列它了，等实测等不到。原写法只认 ok，于是 mistral-large-4-1t-a52b
				//   （下架时 status=unknown）在可派池里躺了 14.9 天，最后被派出去撞
				//   UNSUPPORTED_REASONING_EFFORT。
				//   statusBeforeDelist 改成记**实际值**（原来写死 "ok"）：恢复那一支
				//   `prev === "ok" || prev === "lead"` 不接受 "unknown"，会落到 realResult 重判，
				//   else 分支再把 invalid 收回 unknown —— 正是想要的「让下次实测决定」。
				if (e.whitelist === "allow" && (e.status === "ok" || e.status === "unknown")) {
					e.statusBeforeDelist = e.status; // 记下被下架前的状态，回来时照原样还原
					e.status = "invalid";
					delisted++;
				}
				if (!already) {
					e.note = `${String(e.note || "").replace(/；内核目录已下架（[^；]*）/g, "")}；内核目录已下架（${dayStamp()}，历史实测保留）`;
					appendLedgerHistory(cfg, e.provider, e.model, "内核下架", "内核 listModels 不再列出这条（DSH 也标不可用），台账判为不可派");
				}
				continue;
			}
			if (e.delisted === true) {
				e.delisted = false;
				delete e.delistedAt;
				// ★ 恢复状态。三档优先：
				//   ① 之前记下的 statusBeforeDelist（最准，就是下架前的样子）；
				//   ② 没有就按实测 realResult 重判（ok→ok，fail→invalid）；
				//   ③ 都没有就回 unknown，让下一次实测决定，别硬判成可用。
				const prev = e.statusBeforeDelist;
				if (prev === "ok" || prev === "lead") e.status = prev;
				else if (e.realResult === "ok") e.status = "ok";
				else if (e.realResult === "fail") e.status = "invalid";
				else if (e.status === "invalid") e.status = "unknown";
				delete e.statusBeforeDelist;
				e.note = String(e.note || "").replace(/；内核目录已下架（[^；]*）/g, "");
				e.updatedStr = dayStamp();
				relisted++;
				appendLedgerHistory(cfg, e.provider, e.model, "内核恢复", `内核 listModels 又列出这条了，台账恢复为 ${e.status}`);
			}
		}
	}
	// 清掉上一版误收的付费路由（note 带本标记、不在白名单、也没真跑过）——幂等
	// 2026-11-01 修：原判据是**精确等于** note 串，条目一旦被追加过战绩文案就永远匹配不上，
	// 于是永远清不掉。改成前缀匹配。
	// 2026-11-02：白名单读不到时**一条都不清** —— 那时候台账是「全收 + unknown」，
	// 拿不到名单就没资格判「这条没被放行」，清了等于把维护方能看见的内核模型又变没。
	let dropped = 0;
	if (wlKnown) {
		for (const [key, e] of Array.from(ledger.entries())) {
			if (!String(e.note || "").startsWith("内核模型清单同步发现")) continue;
			if (wl.has(key)) continue;
			if (e.realResult === "ok") continue;
			ledger.delete(key);
			dropped++;
			appendLedgerHistory(cfg, e.provider, e.model, "误收清理", "内核清单里有但白名单没放行（付费/未授权），已从台账移除");
		}
	}
	// 白名单回填 + 撤销：维护方从 allowedModels 删掉一条路由时，台账必须跟着收回。
	// 2026-11-01 修：原逻辑只补"不知道"的条目、已 allow/closed 的一律不动，
	// 于是维护方删掉 qoder/qfmodel 后台账永远停在 allow，pickRoute 照旧把它派出去 ——
	// 维护方看到的现象就是「既不在白名单、也不是可用模型，却出现在候选里」。
	// 新规矩：以配置文件为**唯一真相**，台账只做镜像。
	// 只有 ok/fail 实测结论（realResult）保留，因为它记的是这条路由客观上能不能跑。
	// ★ 2026-11-01 维护方提醒：「别跟 QODER 似的只排除不恢复」——
	//   原来 `whitelist === "closed"` 是死胡同，维护方把路由**加回** allowedModels 后台账永远回不来。
	//   现在双向：删掉 → 收回；加回 → 还原（废弃不再适用就恢复可派）。
	let revoked = 0;
	let restored = 0;
	if (wlKnown) {
		for (const [key, e] of ledger) {
			const inWl = wl.has(key);
			if (e.whitelist === "allow" && !inWl) {
				e.whitelist = "closed";
				if (e.status === "ok" || e.status === "lead") {
					e.statusBeforeRevoke = e.status;
					e.status = "invalid"; // 白名单未开 = 配置状态，不是模型死亡（维护规则 §3）
				}
				e.why = `维护方已从 allowedModels 移除（${dayStamp()}），台账收回`;
				e.updatedStr = dayStamp();
				revoked++;
				appendLedgerHistory(cfg, e.provider, e.model, "白名单撤回", "维护方从 allowedModels 删掉了这条，台账已收回（原来真跑过也算数）");
				continue;
			}
			// ★ 恢复路径：曾经被撤回、现在又回到白名单里 → 还原状态，重新可派。
			if (e.whitelist === "closed" && inWl) {
				e.whitelist = "allow";
				const prev = e.statusBeforeRevoke;
				if (prev === "ok" || prev === "lead") e.status = prev;
				else if (e.realResult === "ok") e.status = "ok";
				else if (e.realResult === "fail") e.status = "invalid";
				else e.status = "unknown"; // 没实测过就交回待实测，别硬判可用
				delete e.statusBeforeRevoke;
				delete e.why;
				e.updatedStr = dayStamp();
				restored++;
				appendLedgerHistory(cfg, e.provider, e.model, "白名单恢复", `维护方把这条加回 allowedModels 了，台账恢复为 ${e.status}`);
				continue;
			}
			if (e.whitelist === "allow" || e.whitelist === "closed") continue;
			e.whitelist = inWl ? "allow" : "closed";
			wlApplied++;
		}
	}
	if (added > 0 || wlApplied > 0 || dropped > 0 || visionApplied > 0 || revoked > 0 || restored > 0 || delisted > 0 || relisted > 0) persist();
	// 自证探针：把「这一版代码真的跑到了」写进 .state/sync-probe.json。
	// 排查「改了没生效」时，有没有这个文件就能分清是 index.js 没重载还是 ledger.js 没重载。
	// codeTag 换版必须跟着换（wl-unknown-v3 = 「白名单读不到→全收+unknown」这一版上线了）。
	try {
		const probePath = nodePath.join(stateDirPath(), "sync-probe.json");
		nodeFs.writeFileSync(probePath, JSON.stringify({ at: Date.now(), codeTag: "wl-unknown-v3", seenCount: seen.size, asked, failed, providers: providers.length, revoked, restored, delisted, relisted, whitelistKnown: wlKnown }, null, 1));
	} catch { /* 探针写不进去不影响同步 */ }
	// codeTag / seenCount 让调用方自证「跑的是哪一版代码、内核这次到底列了多少条」。
	return { added, dropped, providers: asked, failed, whitelist: wlKnown ? wlApplied : "未解析（白名单读不到→全收并标 unknown，不参与派单）", whitelistKnown: wlKnown, revoked, restored, delisted, relisted, vision: visionApplied, why, codeTag: "wl-unknown-v3", seenCount: seen.size };
}

/** OFM 版本哨兵（2026-10-29 立，2026-10-31 重写）。
 *
 *  **先纠正一条事实（维护方 2026-10-31 亲口定的）**：
 *  OFM **由插件自己在线更新**（走仓库 `main` 的 feed/manifest.json，逐文件下载+SHA256 校验），
 *  **不走 npm**。而且 **npm 上那个同名包 `dsh-our-free-model` 根本不是同一个东西** ——
 *  npm 最新只到 2.1.0、maintainer 是别人、repository 字段是空的；正版 2.7.3 的
 *  `package.json` 写着 `"private": true`（作者压根没打算发 npm）。
 *  所以「拿 npm 声明推断版本」这件事本身从根上就是错的：只要真让 pnpm 去 npm 取，
 *  装回来的会是**别人的包**。
 *
 *  那这个哨兵还测什么？测一个**真实存在**的风险：
 *  profile 的 `vendor/dsh-our-free-model-X.tgz` 是 pnpm 离线装用的**副本**。
 *  OFM 热更只改 `node_modules`，这份副本不会跟着动 —— 于是 OFM 自更新到 2.8.0 之后，
 *  下一次 `pnpm install`（装/卸任何插件都会触发）会按声明把实装**退回副本那个旧版**。
 *
 *  所以这里比较的是「**vendor 副本版本**」vs「**实装版本**」，不是「npm 声明」。
 *  不一致时的正确动作不是"换凭据"，是**把 vendor 副本同步到实装版本**（实现方来做）。 */
export function ofmVersionState(cfg) {
	const dir = String((cfg === undefined || cfg === null ? undefined : cfg.ofmProfileDir) || "");
	if (dir === "") return { known: false };
	const pkg = loadJson(nodePath.join(dir, "package.json"), null);
	const dep = pkg === null || pkg === undefined ? undefined : (pkg.dependencies || {})["dsh-our-free-model"];
	const spec = typeof dep === "string" ? dep : "";
	const inst = loadJson(nodePath.join(dir, "node_modules", "dsh-our-free-model", "package.json"), null);
	const installed = inst !== null && inst !== undefined && typeof inst.version === "string" ? inst.version : "";
	// 2026-10-31 设计确定：「插件自己看到最新 2.7.4，就把 OFM 弄成没有就装、有更新就更新」。
	// 这条是那次改造的判据 —— 声明成 link:（或装成 junction）时 pnpm 不建硬链接，
	// OFM 自己的 installationIsManaged() 恒为 false，它面板里的「检查更新/热更/升级」才真的可用。
	const linked = /^link:/.test(spec);
	const nodeModulesDir = nodePath.join(dir, "node_modules", "dsh-our-free-model");
	let hardlinked = false;
	try {
		// nlink>1 = 这份拷贝仍与 pnpm store 共享 inode = OFM 判定"由打包者管理"
		hardlinked = nodeFs.statSync(nodePath.join(nodeModulesDir, "package.json")).nlink > 1;
	} catch { /* 没装或读不到，留给 installed === "" 的分支 */ }
	// 只在 spec 指向本地 vendor 副本时才提取版本；指向 registry 名字的（老配置）不当版本用
	const m = /file:.*?(\d+\.\d+\.\d+)/.exec(spec) || spec.match(/(\d+\.\d+\.\d+)/);
	const vendored = m === null ? "" : m[1];
	if (vendored === "" && installed === "") return { known: false };
	// spec 不是本地文件 = 声明指向 npm 仓库 → 那是同名的**另一个包**，必须单独报出来
	const fromRegistry = spec !== "" && !/^file:/.test(spec) && !/^link:/.test(spec);
	const drift = vendored !== "" && installed !== "" && vendored !== installed;
	// 官方最新版是**异步去仓库查**的（见 ofmRemoteState），这里只给本地两份的对照
	const remote = ofmRemoteCache;
	return {
		known: true,
		declared: vendored, // 字段名留作历史兼容，语义已改成"vendor 副本"
		vendored,
		installed,
		spec,
		linked,
		hardlinked,
		// 能自升级 = 声明是 link（或实装不是硬链接）。两者都假 = OFM 面板里那句话的成因。
		selfUpdatable: linked || !hardlinked,
		latest: remote === null || remote === undefined ? null : remote.version,
		// ★ 2026-11-02 发包踩雷第 3 条：drift 单独成字段。
		//   以前只有 ok=false 一个布尔，面板把它和「官方有新版」混成一句「版本状态异常」——
		//   维护方截图那句「OFM 2.8.0 / 官方 2.8.0 · 版本状态异常 | 插件启动时：已是最新（2.8.0）」
		//   自相矛盾就是这来的。三态各有名字：newer（有新版可升）/ drift（已升到 X 但 vendor
		//   副本停在 Y，下次装插件会退版）/ 自升级被关。ok 的定义不动（drift 本来就是该修的事实）。
		drift,
		ok: !drift && !fromRegistry,
		hint: fromRegistry
			? `profile 里 OFM 声明成 ${spec}（指向 npm 仓库）—— **npm 上的 dsh-our-free-model 是另一个包**（最新只有 2.1.0，作者也不同）。`
				+ `请改回 file:./vendor/dsh-our-free-model-<版本>.tgz，否则下一次装/卸插件会装进别人的包。`
			: drift
				? `vendor 副本 ${vendored} / 实装 ${installed} —— OFM 自更新只改 node_modules，副本没跟着动。`
					+ `下一次 pnpm install（装或卸任何插件都会触发）会把实装退回 ${vendored}。`
					+ `要保住 ${installed}：把实装重新打成 vendor/dsh-our-free-model-${installed}.tgz 并刷 lock（或让插件作者出新版）。`
				: hardlinked
					? `实装是 pnpm 硬链接（nlink>1）—— OFM 会判定"由打包者管理"并关闭它自己的检查更新/热更/自升级。`
						// 路径用探测出来的 ofmPkgDir（= 插件建议的 link 目标），不钉任何人的用户名
						+ `插件已经会在启动时替它升级，但要在 OFM 面板里恢复升级按钮，得把 profile 里 ${spec} 改成 link:${String((cfg === null || cfg === undefined ? "" : cfg.ofmPkgDir) || "<.dsh 根>/plugins/dsh-our-free-model").replace(/\\/g, "/")}。`
					: "",
	};
}

/** 官方最新版（异步查，30 分钟缓存）。OFM 走仓库 `main` 的 feed/manifest.json，
 *  所以"有没有新版"只能问那个文件，不能问 npm。
 *  多个镜像轮询：raw.githubusercontent 在某些网络下会被重置（实测 ECONNRESET），
 *  jsdelivr 主域缓存可能落后一两版（实测 2.7.2 时 gcore 已是 2.7.3），所以取**最大版本号**。 */
export const OFM_MANIFEST_URLS = [
	"https://raw.githubusercontent.com/Ebony-Vinyl/dsh-our-free-model/main/feed/manifest.json",
	"https://gcore.jsdelivr.net/gh/Ebony-Vinyl/dsh-our-free-model@main/feed/manifest.json",
	"https://cdn.jsdelivr.net/gh/Ebony-Vinyl/dsh-our-free-model@main/feed/manifest.json",
	"https://gh-proxy.com/https://raw.githubusercontent.com/Ebony-Vinyl/dsh-our-free-model/main/feed/manifest.json",
];
	let ofmRemoteCache = null; // { version, publishedAt, files, at } | null
	let ofmRemoteAt = 0;
	const cmpVer = (a, b) => {
		const pa = String(a || "").split(".").map(Number);
		const pb = String(b || "").split(".").map(Number);
		for (let i = 0; i < 3; i += 1) {
			const x = pa[i] === undefined ? 0 : pa[i];
			const y = pb[i] === undefined ? 0 : pb[i];
			if (x !== y) return x - y;
		}
		return 0;
	};
	export async function refreshOfmRemote() {
		if (Date.now() - ofmRemoteAt < 30 * 60 * 1000) return ofmRemoteCache;
		let best = null;
		for (const url of OFM_MANIFEST_URLS) {
			try {
				const ac = new AbortController();
				const timer = setTimeout(() => ac.abort(), 8000);
				const res = await fetch(url, { signal: ac.signal, redirect: "follow" });
				clearTimeout(timer);
				if (!res.ok) continue;
				const j = await res.json();
				if (j === null || typeof j !== "object" || typeof j.version !== "string") continue;
				if (best === null || cmpVer(j.version, best.version) > 0) best = { version: j.version, publishedAt: j.publishedAt || null, files: Array.isArray(j.files) ? j.files.length : 0 };
			} catch { /* 这个镜像不行，试下一个 */ }
		}
		ofmRemoteAt = Date.now();
		if (best !== null) ofmRemoteCache = { ...best, at: ofmRemoteAt };
		return ofmRemoteCache;
	}
