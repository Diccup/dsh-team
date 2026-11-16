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
// errbook — 报错账本（原始归档 / 累积 JSONL / 规则表 / 时间墙）
// 从 index.js 的「错误归档 + 错误规则表」区原样搬来（2026-10-31 模块化）。
// 逻辑一行未改。
//
// 这些函数原来都在 apply 里，靠闭包读 cfg。搬出来后改成工厂：
// createErrbook(cfg) 返回同一组函数 —— 依赖方向明确，行为不变。
// ---------------------------------------------------------------------------

import * as nodeFs from "node:fs";
import * as nodePath from "node:path";
import { stateDirPath } from "./config.js";
import { localDate, loadJson, saveJson } from "./util.js";

/** 从报错原文里认出「报错实际涉及哪个 provider/model」。
 *
 *  为什么需要（2026-11-16 · Updating\04 · 遗留 2）：
 *  `index.js` 的 `noteAttemptFailure` / `recordFailure` 原来一律用 `header.config.model`
 *  （**本次请求登记的**路由）记 `route`，但内核报错文本里经常写着**另一个**模型。
 *  实测 mistral 那次：
 *    route 记成 `cline/thinkingmachines/inkling-2-small:free`
 *    raw   写 `provider "our-free-model" model "mistralai/mistral-large-4-1t-a52b" does not support …`
 *  结果看 route 会去查 cline，真正的凶手逃掉（归因、规则匹配、面板统计全挂错对象）。
 *
 *  判据：**报错自己说的最可信**。内核有两种写法（都见过实物）：
 *    · `provider "X" model "Y" does not support reasoning effort …`
 *    · `pi-ai provider "X" model "Y" …`（前缀不影响正则）
 *  只认**成对出现**的写法；只有 model 或只有 provider 时**不猜**，返回 null 让调用方退回 header
 *  （宁可记登记的，也不要把 raw 里偶然出现的模型名当凶手）。
 *
 *  ★ 放在**模块级**而不是 createErrbook 工厂内：它是纯函数、不读 cfg，
 *    测试可以直接 import 验证（`Updating\verify\verify-syncinfo.mjs` §三）。
 *
 *  @param {string} text 报错原文
 *  @returns {{provider:string, model:string}|null}
 */
export function parseRouteFromError(text) {
	const s = String(text === undefined || text === null ? "" : text);
	if (s === "") return null;
	// ① `provider "X" model "Y"`（中间允许任意空白/换行）
	const m = /provider\s+"([^"]+)"\s*model\s+"([^"]+)"/i.exec(s);
	if (m !== null) return { provider: m[1].trim(), model: m[2].trim() };
	// ② `provider "X" / model "Y"`（有的层带斜杠）
	const m2 = /provider\s+"([^"]+)"\s*\/\s*model\s+"([^"]+)"/i.exec(s);
	if (m2 !== null) return { provider: m2[1].trim(), model: m2[2].trim() };
	return null;
}

/**
 * @param {object} cfg 插件配置（只读 workspaceStatePath 等字段）
 * @returns 错误账本 API
 */
export function createErrbook(cfg) {
	// Raw error archive (#16b): classification is lossy, so keep the last N originals
	// on disk — the owner's "Qwen 用 max 报错但忘了原话" gets answerable later.
	const errorsPath = nodePath.join(stateDirPath(), "errors.json");
	const ARCHIVE_MAX = 60;
	// Cumulative fault log (#21): one append-only JSONL per local day under
	// `.state/errors/`. The ring above is for a quick read; this one is the
	// long-term evidence base for auto-routing (D2) — a route's real failure
	// history must outlive restarts and the 60-row window.
	const errorsDir = nodePath.join(stateDirPath(), "errors");
	const ERRLOG_MAX_BYTES = 8 * 1024 * 1024; // per-day cap: stop appending, never truncate history
	function appendErrorLog(row) {
		try {
			nodeFs.mkdirSync(errorsDir, { recursive: true });
			const file = nodePath.join(errorsDir, localDate(new Date(row.at || Date.now())) + ".jsonl");
			let size = 0;
			try { size = nodeFs.statSync(file).size; } catch { /* first row of the day */ }
			if (size >= ERRLOG_MAX_BYTES) return row;
			// 去重下沉到写文件这一层：读文件里最后一行（不依赖任何进程内状态），
			// 同一个「路由+错误类+原文前 80 字」在 60 秒内只留一行，后面的把 repeat 加一。
			// 为什么要下沉：队长自己对话的请求失败由那个会话的插件实例记，各实例不共享内存，
			// 实测一次 gpt-oss-20b 越界被重试 12 次、5 毫秒间隔写了 12 行一模一样的。
			const sigOf = (r) => `${r.route || ""}|${r.class || ""}|${String(r.raw || "").slice(0, 80)}`;
			if (size > 0) {
				const tailLen = Math.min(size, 8192);
				const tail = Buffer.alloc(tailLen);
				const fd = nodeFs.openSync(file, "r");
				try { nodeFs.readSync(fd, tail, 0, tailLen, size - tailLen); } finally { nodeFs.closeSync(fd); }
				let endPos = tailLen;
				while (endPos > 0 && (tail[endPos - 1] === 0x0a || tail[endPos - 1] === 0x0d)) endPos -= 1;
				let startPos = endPos;
				while (startPos > 0 && tail[startPos - 1] !== 0x0a) startPos -= 1;
				if (endPos > startPos) {
					let last = null;
					try { last = JSON.parse(tail.subarray(startPos, endPos).toString("utf8")); } catch { last = null; }
					if (last !== null && sigOf(last) === sigOf(row) && Number(row.at) - Number(last.at || 0) < 60000) {
						const merged = { ...last, at: Number(row.at || Date.now()), repeat: Number(last.repeat || 1) + 1 };
						// 用字节偏移截断（不能按字符下标：行里有中文，UTF-16 下标 ≠ 字节偏移）
						const cut = size - tailLen + startPos;
						nodeFs.truncateSync(file, cut);
						nodeFs.appendFileSync(file, JSON.stringify(merged) + "\n", "utf8");
						return merged;
					}
				}
			}
			nodeFs.appendFileSync(file, JSON.stringify(row) + "\n", "utf8");
		} catch { /* bookkeeping never breaks a dispatch */ }
		return row;
	}
	function archiveError(row) {
		const full = { at: Date.now(), kind: "run-fail", ...row };
		// 同路由 + 同错误类 60s 内不重复记：昨夜 sensenova 那条 1 分钟刷了 8 条一模一样的
		// 「does not support reasoning effort "none"」，把当天日志全淹了，翻起来像 8 个不同故障。
		const sig = `${full.route || ""}|${full.class || ""}`;
		const rows = loadJson(errorsPath, []);
		const list = Array.isArray(rows) ? rows : [];
		const last = list.length === 0 ? undefined : list[list.length - 1];
		if (last !== undefined && `${last.route || ""}|${last.class || ""}` === sig && full.at - Number(last.at || 0) < 60000) {
			last.repeat = Number(last.repeat || 1) + 1;
			last.at = full.at;
			saveJson(errorsPath, list);
			return full;
		}
		appendErrorLog(full);
		list.push(full);
		saveJson(errorsPath, list.slice(-ARCHIVE_MAX));
	}

	// --- 错误规则表（设计确定：已知报错直接按规则办，没见过的报给 Lead 判、判完登记）
	// Classification used to be hardcoded regexes. It is now a growing table: a matched
	// rule is handled without asking; an UNMATCHED error is reported to the Lead with its
	// raw text, the Lead classifies it once, and the next occurrence is automatic.
	const errorRulesPath = nodePath.join(stateDirPath(), "error-rules.json");
	/** `/body/flags` = explicit regex; plain text containing regex metacharacters
	 *  (a `|`, `.*`, …) is ALSO treated as regex — otherwise a Lead's
	 *  "context length|too many tokens" would be looked up as one literal string and
	 *  never match anything. Plain words fall back to a case-insensitive substring. */
	function ruleMatcher(match) {
		const s = String(match || "").trim();
		const last = s.lastIndexOf("/");
		const explicit = s.length > 2 && s.startsWith("/") && last > 0;
		const body = explicit ? s.slice(1, last) : s;
		const flags = explicit ? (s.slice(last + 1).replace(/[^gimsuy]/g, "") || "i") : "i";
		const looksRegex = /[|.*+?[\](){}^$\\]/.test(body);
		if (!explicit && !looksRegex) {
			const t = body.toLowerCase();
			return (m) => String(m).toLowerCase().includes(t);
		}
		try {
			const re = new RegExp(body, flags);
			return (m) => re.test(m);
		} catch {
			const t = body.toLowerCase();
			return (m) => String(m).toLowerCase().includes(t);
		}
	}
	// gear rejection needs BOTH sides (see classifyError note); kept as a predicate
	const gearRejectRe = /reasoning|thinking|effort|budget|\b(low|medium|high|xhigh|maximal|minimal)\b/i;
	const gearRefuseRe = /unsupported|not supported|does not support|invalid|unknown|must be|allowed/i;
	// OpenRouter 系免费路由的**每日请求数**上限（区别于每分钟的瞬时限流）：
	// "Daily limit reached for thinkingmachines/inkling-small:free via Thinking Machines ...
	//  limit_rpd/thinkingmachines/inkling-small-20260730/..." + X-RateLimit-Limit: 1000。
	// 这种 429 退避几分钟没用，只能等次日 UTC 0 点重置。
	const DAILY_CAP_RE = /Daily limit reached|limit_rpd|daily (quota|limit) (reached|exceeded)/i;
	/** Qoder 中国版（qodercn）的日限原文是 `qoder: Billing daily count exceeded` ——
	 *  一个 "Daily limit reached" 都不带，所以上面那条正则**认不出来**。
	 *  实测后果（2026-11-01 维护方抓到）：它落到指数退避 `60s×2^1 ≈ 2 分钟`，
	 *  面板绿着、派单照派，每 2 分钟再撞一次同一堵墙，整晚空转。
	 *
	 *  它和 OpenRouter 那条还有一个关键差别：**重置点是本地 0 点，不是 UTC 0 点**。
	 *  证据是上游自己给的解禁时刻（10-30 那次原文）：`将于 2026-10-31 00:00:00 解禁`——
	 *  不带时区标注，按本机时区（北京）解析就是本地 0 点；按 UTC 算会等到本地早上 8 点，
	 *  白白多停 8 小时。所以这一类单独成一个常量、单独一个解禁函数，绝不和 UTC 日限混。 */
	const BILLING_DAILY_RE = /Billing daily count exceeded|daily count exceeded/i;
	/** 次日 UTC 0 点 + 5 分钟缓冲（上游按 UTC 日切，别卡在边界上再撞一次）。 */
	function nextUtcMidnight(nowMs) {
		const d = new Date(nowMs);
		return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) + 5 * 60 * 1000;
	}
	/** 次日**本地** 0 点 + 5 分钟缓冲（qodercn 口径：上游说的 00:00 就是本机时区的 00:00）。 */
	function nextLocalMidnight(nowMs) {
		const d = new Date(nowMs);
		return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 5, 0, 0).getTime();
	}
	// OPENCODE 免费池（our-free-model 的 channel:"free" 那 9 条）是**整池共享额度**，
	// 而且按**周**重置：报错只写 "Free usage limit reached. Free models work in OpenCode…"，
	// 不给重置时刻。维护方 10-29 点出这条 —— 退避几分钟纯空转，得停到下周配额刷新。
	const WEEKLY_CAP_RE = /Free usage limit reached/i;
	/** 下周一 UTC 0 点 + 5 分钟（和 nextUtcMidnight 同口径，只在周边界上多跳几天）。 */
	function nextUtcMonday(nowMs) {
		const d = new Date(nowMs);
		const sinceMon = (d.getUTCDay() + 6) % 7; // 0=周一
		const days = 7 - sinceMon;
		return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + days) + 5 * 60 * 1000;
	}
	// 上游报错直接写明恢复时刻（Qoder 中国版：「最近一个将于 2026-10-31 00:00:00 解禁」）。
	// 这种带明确时间的墙，指数退避纯属自欺：8 分钟后放行再撞一次，白烧一轮（维护方 10-30 抓到：
	// qfmodel 17:42 撞墙只退到 17:50，真实解禁是次日 00:00，中间 2.5 小时面板显示纯绿"可用"）。
	// 解析出来就直接退避到那个点（+2 分钟缓冲）；原文不带时区标注的按本机时区算（维护方机器=北京）。
	// 2026-10-30 第二次修：原来只认「将于 <时间> 解禁」这一种写法。cline 的账号池墙是
	// 「当日免费额度已用尽（HTTP 429），预计 14 小时后重置（2026/10/31 13:41:17）」——
	// 时间戳写在括号里、前面跟的是「重置」，老正则一条都不匹配，于是 14 小时的墙被当成
	// 普通退避（2 分钟），到点就放出去再撞一次。现在把「将于/重置/解禁/恢复/可用」都算上，
	// 时间戳可以带括号也可以不带。
	const RESUME_AT_RE = /(?:将于|重置|解禁|恢复|可用)[^\d（(]{0,12}[（(]?(\d{4})[-/](\d{1,2})[-/](\d{1,2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?/;
	function explicitResumeMs(errRaw) {
		const m = RESUME_AT_RE.exec(errRaw);
		if (m === null) return null;
		const t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], m[5] === undefined ? 0 : +m[5], m[6] === undefined ? 0 : +m[6]).getTime() + 2 * 60 * 1000;
		return t > Date.now() ? t : null;
	}
	/** 上游给的是「大墙」（明确解禁时刻还早于这么久）时，成员不能干等：
	 *  它是打工人，不是队长 —— 队长可以自己决定要不要换模型，成员的任务必须有人干。
	 *  2026-10-30 维护方抓到的实录：auto1 撞 cline 14 小时墙，插件只退避不换路由，
	 *  整队从 23:44 一直停摆到次日 13:43。退避 2 分钟的抖动不在此列（换了也一样撞）。 */
	const WALL_ROTATE_MS = 15 * 60 * 1000;
	/** 长墙自愈的节流：`sessionId|route` → 上次尝试时刻。没这条的话，
	 *  池子里真没有能跑的路由时，每 10 秒就往队长那里推一条「换路由失败」。 */
	const wallHealAt = new Map();
	/** 「成员被墙挡住」提示的节流：`lead|member|route|reason` → 上次提示时刻。
	 *  没这条的话，一个卡住的成员每 10 秒就往队长那里推一条同样的告警。 */
	const stallNoticeAt = new Map();
	/** 台账条目是不是「还没到点的墙」。面板和选路都看这一条，口径只在这里写一次。 */
	function wallUntil(entry) {
		const until = Number(entry && entry.backoffUntil);
		return Number.isFinite(until) && until > Date.now() ? until : null;
	}
	const BUILTIN_ERROR_RULES = [
		// 必须排在 b1 之前：日限原文里也带 429，但处置完全不同（退避到次日 vs 退避几分钟）。
		{ id: "b0", match: "/Daily limit reached|limit_rpd|daily (quota|limit) (reached|exceeded)/i", class: "日限已满", fix: "backoff" },
		// qodercn 专属日限（2026-11-01 维护方抓到）：原文 `qoder: Billing daily count exceeded`
		// 不带 "Daily limit"，b0 认不出 → 落到 2 分钟指数退避 → 每 2 分钟重撞一整晚。
		// 单独成类，好让 nextLocalMidnight 那条**本地** 0 点口径生效（b0 是 UTC 口径，别混）。
		{ id: "b11", match: "/Billing daily count exceeded|daily count exceeded/i", class: "日限已满-本地0点", fix: "backoff" },
		{ id: "b1", match: "/Free usage limit reached|Sign up for free to continue|soft_rate|\\b429\\b|usage will reset/i", class: "额度限流", fix: "backoff" },
		// 网关 5xx：2026-10-29 维护方抓到的实例 —— raccoon 返回整页 HTML
		// `<title>502 Bad Gateway</title>`，被归成「未知」，看着像模型坏了。
		// OFM 2.7.3（2026-10-30 发布）起，OpenCode 官方免费车道**默认用本机 Bun 做传输**，
		// 找不到 bun.exe 时插件直接抛这句（src/egress.js + bun-fetch.js 的原文）。
		// 这是**环境缺件**，不是模型坏：永远退避、永远换路由都没用 —— 装上 Bun 立刻就好。
		// fix=dead 是故意的（对这条路由判死，别再派），报告里给出安装动作。
		// 必须排在 b5 之前：原文里带 "failed"，会被 b5 的 aborted/failed 系列吃掉。
		{ id: "b10", match: "/Bun executable not found|requires a local Bun|OUR_FREE_MODEL_BUN|OUR_FREE_MODEL_FREE_TRANSPORT/i", class: "缺Bun-装Bun即好", fix: "dead" },
		// 5xx 是网关/上游抖动，跟模型无关：退避重试，绝不判死。
		{ id: "b9", match: "/\\b50[234]\\b|Bad Gateway|Service Unavailable|Gateway Time-?out|upstream connect error/i", class: "网关共性", fix: "retry" },
		// 模型要求历史 assistant 消息回传 reasoning_content；DSH 不保存那份 → 一旦会话变长
		// 必然 400。不是这群路由坏了，是这条历史带不动，换一条重派（跨池）。
		{ id: "b2", match: "/reasoning_content/i", class: "推理回传缺失", fix: "rotate" },
		// 内核在这条路由上拒绝某个档（实测 raccoon 传 none 直接 400）：降一档再试，别整轮失败。
		{ id: "b6", match: "/does not support reasoning effort|UNSUPPORTED_REASONING_EFFORT/i", class: "档位不支持", fix: "downshift" },
		{ id: "b3", match: "/not allowed for this Session/i", class: "白名单未开", fix: "dead" },
		{ id: "b4", match: "/not available in your country|RegionError|\\b403\\b/i", class: "地区封锁", fix: "dead" },
		// 输入超模型真实上限：换到 ctx 更大的路由重派（也该顺手把实测上限记进台账）。
		// 必须排在 b5 之前——这条原文里同时带 "Provider returned error"，否则被当网关抖动重试。
		// 注意：这条只管**成员轮换**；队长自己撞了不归它管（队长换不换模型由维护方决定）。
		{ id: "b7", match: "/maximum allowed input length|exceeds the maximum (input|context)|maximum context length|context_length_exceeded/i", class: "上下文超限", fix: "rotate" },
		{ id: "b5", match: "/STREAM_CUT|Stream ended without finish_reason|UPSTREAM|aborted|EAC_UPSTREAM_FAILED|RATE_LIMIT|no eligible anonymous exit|Provider returned error/i", class: "网关共性", fix: "retry" },
	].map((r) => ({ ...r, test: ruleMatcher(r.match), source: "builtin" }));

	let errorRules = (() => {
		const rows = loadJson(errorRulesPath, []);
		return (Array.isArray(rows) ? rows : []).map((r) => ({ ...r, test: ruleMatcher(r.match), source: "lead" }));
	})();
	function saveErrorRules() {
		saveJson(errorRulesPath, errorRules.map(({ test: _t, source: _s, ...rest }) => rest));
	}
	/** 规则匹配的文本 = `[route] provider/model` + 换行 + 报错原文。
	 *  2026-10-29 设计确定：报错原文本来就该带上 provider+model —— 同一个模型换个网关
	 *  就是另一条路由，判死活、学上限、配规则都该按 route 走。带上前缀后：
	 *  ① 老规则（只写错误特征）行为完全不变，因为原文还在文本里；
	 *  ② 新规则可以只对某条路由生效：`match:"\\[route\\] cline/x/y:free"`，
	 *     或者 `"maximum context[\\s\\S]*\\[route\\] cline/"`；
	 *  ③ 不用额外加 provider/model 字段，规则表结构不动。
	 *  route 放**开头**是故意的：现存规则没有一条用 `^` 锚定，安全；
	 *  放开头写路由限定规则最自然。 */
	function matchTextOf(message, routeKey) {
		const raw = String(message || "");
		const key = routeKey === undefined || routeKey === null ? "" : String(routeKey);
		return key === "" ? raw : `[route] ${key}\n${raw}`;
	}
	/** First match wins: Lead-registered rules (newest first, they are more specific)
	 *  then built-ins, then the compound gear predicate. undefined = never seen before. */
	function matchErrorRule(message, routeKey) {
		const raw = matchTextOf(message, routeKey);
		for (let i = errorRules.length - 1; i >= 0; i -= 1) {
			if (errorRules[i].test(raw)) return { ...errorRules[i], source: "lead" };
		}
		for (const r of BUILTIN_ERROR_RULES) if (r.test(raw)) return r;
		if (gearRejectRe.test(raw) && gearRefuseRe.test(raw)) return { id: "b6", class: "档位不支持", fix: "downshift", source: "builtin" };
		return undefined;
	}
	const FIX_VALUES = ["downshift", "rotate", "backoff", "dead", "retry", "none"];

	/** What to DO with an error: the rule's `fix`, or "unknown" when nothing matched.
	 *  Unknown means "the Lead has not classified this yet" — never a guess by the plugin.
	 *  `routeKey`（`provider/model`）会拼进匹配文本，供按路由限定的规则使用。 */
	function diagnoseError(message, routeKey) {
		const hit = matchErrorRule(message, routeKey);
		if (hit === undefined) return { class: "未知", fix: "retry", ruleId: null, source: "none", known: false };
		return { class: hit.class, fix: FIX_VALUES.includes(hit.fix) ? hit.fix : "retry", ruleId: hit.id, source: hit.source, known: true };
	}

	return { errorsPath, ARCHIVE_MAX, errorsDir, ERRLOG_MAX_BYTES, appendErrorLog, archiveError, errorRulesPath, ruleMatcher, wallHealAt, stallNoticeAt, BUILTIN_ERROR_RULES, errorRules, saveErrorRules, matchTextOf, matchErrorRule, FIX_VALUES, diagnoseError, parseRouteFromError, DAILY_CAP_RE, BILLING_DAILY_RE, nextUtcMidnight, nextLocalMidnight, WEEKLY_CAP_RE, nextUtcMonday, RESUME_AT_RE, explicitResumeMs, WALL_ROTATE_MS, wallUntil };
}
