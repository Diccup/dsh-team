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
// score — 路由评分（可靠性 / 耐力 / 故障构成 / 品质）
//
// 2026-11-01 设计确定：的四档含义（原话）：
//   「推荐就是最好用的，可用就是能用，但是会有小问题的，
//     不稳就是可用但是会经常出问题的，未测不用我说了吧？」
//
// 判据（三档全部落在「置信」和「故障率是否高于全池平均」上，不用手工阈值）：
//   未测 = 样本不足 3 次（OFM 自己也是 3 次起算，MIN_RUNS 与 OFM_MIN_CALLS 同源）
//   推荐 = 置信 ≥ 0.85，且三类故障率**一项都没超过全池平均**（risk 恰为 1.00）
//   可用 = 置信达标，但有某一项故障率高于全池平均（有小问题）
//   不稳 = 置信 < 0.60，或故障率超过全池平均两倍（经常出问题）
//
// **每一个常数都有出处，没有一个是实现方拍的**：
//   z = 1.96        —— 95% 置信区间的标准值
//   0.85            —— 「95% 把握至少 85% 能成」
//   0.60            —— 「大概率能用，但别指望」
//   MIN_RUNS = 3    —— OFM 的样本起算线
//   bS / bQ / bJ    —— 全池三类故障数 ÷ 全池成功轮次（本机实测算出来的基线）
//   wS / wQ / wJ    —— 三类故障在总故障里的实际份额（越常见越该扣分）
//   RISK_POOL_LIMIT = 2 —— 「故障率是全池平均的两倍」。这是语义定义不是调参：
//                          本机池子跑出的 risk 阶梯上，1.702 → 2.721 是第一道 ≥1.5× 断点，
//                          2× 全池平均正是「经常出问题」的读法，两边落在同一处。
// ---------------------------------------------------------------------------

/** 「这条路由根本没被派进去」的报错 —— **既不算失败，也进不了风险**。
 *  每一条都对着本机错误日志里的真实原文写的：
 *   · `上下文超限` / `input_length_exceeded`：任务输入太大，换大 ctx 的路由就好，
 *     不是这条路由的毛病（把它算成失败，等于罚「敢接大活」的路由）；
 *   · `缺Bun-装Bun即好`：`OpenCode free inference requires a local Bun executable`，
 *     本机没装 Bun，装上立刻就好 —— 环境缺件，与模型无关。
 *  除这三条**以外**的任何一条失败都要算进分母（置信），只是不一定进风险。 */
export const NOT_ROUTE_FAULT = new Set(["上下文超限", "input_length_exceeded", "缺Bun-装Bun即好"]);

/** 三类故障（沿用 index.js 既有的分组口径，只收累积日志里真实出现过的类名）。
 *  不属于任何一桶的报错进 `O`（其他）：**算失败（进置信的分母），但不进风险** ——
 *  风险只衡量「这条路由干活会出哪一类毛病」，认不出类就不该瞎猜它属于哪一类；
 *  但它确实是一次没干成，不该像以前那样从分母里凭空消失。 */
export const SELF_CLASSES = new Set(["静默无输出", "思考病态重复", "档位不支持", "effort-unsupported"]);
// 额度类必须与 index.js 的 GROUP_QUOTA_CLASSES **逐条一致**（2026-11-01 补漏）：
// 当初只抄了三条（额度限流 / rate_limit_request_frequency / 渠道暂停-管理员），
// 漏了「模型账号池限流-有解禁时间」「日限已满/本地0点」「free-usage-limit-exhausted」这几条
// —— 后果不是「少扣一点分」，是**这些失败整个从分母里消失**：evidenceOf 的 tries
// = ok + S + Q + J + 截断，落到 null 桶的报错既不降置信也不进风险，
// qodercn 那 6 条撞墙记录就这么在评分表里凭空不见，置信被高估。
// 凡是「整池共享额度」的墙都属于这一类：它证明这条路由今天干不了活。
export const QUOTA_CLASSES = new Set(["额度限流", "rate_limit_request_frequency", "渠道暂停-管理员", "模型账号池限流-有解禁时间", "日限已满", "日限已满-本地0点", "free-usage-limit-exhausted"]);
export const JITTER_CLASSES = new Set(["网关共性", "上游发送失败", "未知"]);

export const MIN_RUNS = 3;
export const CONF_RECOMMEND = 0.85;
export const CONF_USABLE = 0.60;
export const RISK_POOL_LIMIT = 2;

/** 故障类名 → 三桶；null = 不计入风险。 */
export function faultBucket(className) {
	const c = String(className || "");
	if (SELF_CLASSES.has(c)) return "S";
	if (QUOTA_CLASSES.has(c)) return "Q";
	if (JITTER_CLASSES.has(c)) return "J";
	return null;
}

/** Wilson 95% 置信区间下界。
 *  为什么不用裸成功率：
 *   · 1 次全成 → 100%，会被误判成「最好用的」；
 *   · 34 次 33 成 → 97%，两件事的可信程度天差地别，下界把这个差别算出来。
 *  `mistral-large` 1 次成功 → 0.207，`reflection/beam-free` 343 次 96% → 0.936。 */
export function wilsonLower(k, n, z = 1.96) {
	const K = Number(k) || 0;
	const N = Number(n) || 0;
	if (N <= 0) return 0;
	const p = K / N;
	const z2 = z * z;
	const denom = 1 + z2 / N;
	const center = p + z2 / (2 * N);
	const margin = z * Math.sqrt((p * (1 - p)) / N + z2 / (4 * N * N));
	const v = (center - margin) / denom;
	return v > 0 ? v : 0;
}

/** 累积错误日志（`.state/errors/YYYY-MM-DD.jsonl` 的行）按路由聚成四桶。
 *  S/Q/J = 三类风险故障；O = 认得出是失败、但认不出属于哪一类（只进分母，不进风险）。
 *  带 `repeat` 的行按 repeat 计 —— 插件把 60 秒内同一句合并成了一行。
 *
 *  **不含 `NOT_ROUTE_FAULT` 那三条**（上下文超限 / input_length_exceeded / 缺Bun）：
 *  那些是「没被派进去」或「环境缺件」，根本不构成这条路的一次失败。 */
export function bucketByRoute(errorRows) {
	const per = new Map();
	for (const row of Array.isArray(errorRows) ? errorRows : []) {
		const route = String((row && row.route) || "");
		if (route === "") continue;
		const cls = String((row && row.class) || "");
		if (NOT_ROUTE_FAULT.has(cls)) continue;
		const b = faultBucket(cls);
		const weight = Math.max(1, Number(row.repeat) || 1);
		const cur = per.get(route) || { S: 0, Q: 0, J: 0, O: 0 };
		cur[b === null ? "O" : b] += weight;
		per.set(route, cur);
	}
	return per;
}

/** 全池基线：每类故障「平均一条路由跑一趟会撞几次」+ 每类故障在总故障中的份额。
 *  两个都随数据自己变，不写死。 */
export function poolBaselines(entries, perRoute) {
	const used = (Array.isArray(entries) ? entries : []).filter((e) => Number(e && e.usedRuns) > 0);
	const totalRuns = used.reduce((a, e) => a + Number(e.usedRuns || 0), 0);
	const tot = { S: 0, Q: 0, J: 0 };
	for (const v of perRoute.values()) {
		tot.S += v.S;
		tot.Q += v.Q;
		tot.J += v.J;
	}
	const faults = tot.S + tot.Q + tot.J;
	return {
		totalRuns,
		faults,
		bS: totalRuns > 0 ? tot.S / totalRuns : 0,
		bQ: totalRuns > 0 ? tot.Q / totalRuns : 0,
		bJ: totalRuns > 0 ? tot.J / totalRuns : 0,
		wS: faults > 0 ? tot.S / faults : 0,
		wQ: faults > 0 ? tot.Q / faults : 0,
		wJ: faults > 0 ? tot.J / faults : 0,
	};
}

/** 一条路由的**证据**。两个源都是实测，只有一个能同时出现：
 *  ① TEAM 自己的真派战绩（usedRuns / usedMs / 累积错误日志）—— 带故障分类，能算风险；
 *  ② OFM 的请求账（calls / failed / 逐日 decodeMs）—— 不带分类，只算置信与耐力。
 *  有 TEAM 战绩就用 TEAM 的（它带分类，能回答「是哪一种毛病」）；没有才用 OFM 的。
 *
 *  为什么 OFM 那条也能算耐力：`days[].models[id].decodeMs` 是逐日的**实际解码耗时**，
 *  和 TEAM 的 usedMs 是同一件事的另一种记法，都是「这条路由真扛过多久活」。
 *
 *  **2026-11-01 修的真 bug（维护方提问「为啥未测还有 6 个？隔壁调用了好几次了」）：**
 *  原来这里写的是 `if (runs > 0)`，runs 只等于 `usedRuns`（成功回合数）。
 *  而 usedRuns 只在**成功**回合累加（index.js 的 recordUsedTime 要求真正跑完），
 *  失败回合只写 failStreak / errClass，**永远不进 usedRuns**。
 *  于是「派进去 25 次、次次失败」的路由 tries=0 → 判「未测」。
 *
 *  实测受害：`cline/recursive/flint-v1.0:free` 错误日志里 3+6+2+12+2 = 25 次
 *  上游发送失败、failStreak=10，评分表却说它「样本不够，不下结论」。
 *  同批还有 liquid/lfm-2.5-2.6b:free、thinkingmachines/inkling:free、
 *  poolside/laguna-xs-2.1:free、cohere/north-mini-code:free、openai/gpt-6.1-terra-pro。
 *
 *  这不只是分类难看，它**卡住派活**：未测排在派活顺序最前面（TIER_ORDER.未测=0），
 *  于是这些路由被反复派、反复失败、反复判未测 —— 死循环。
 *  而失败证据其实早就记着，只是没算进分母。
 *
 *  判据回到维护方的原话：「未测 = 样本不够，不下结论」。
 *  派进去 25 次全失败不叫样本不够，叫结论很清楚 —— 它是不稳。
 *  只有在**一个证据都没有**（没成功过、也没有任何失败记录）时才是未测。 */
export function evidenceOf(entry, perRoute, ofmHours) {
	const e = entry || {};
	const key = `${e.provider || ""}/${e.model || ""}`;
	const runs = Number(e.usedRuns) || 0;
	const f = perRoute.get(key) || { S: 0, Q: 0, J: 0, O: 0 };
	const truncated = Number(e.truncatedN) || 0;
	const fails = f.S + f.Q + f.J + Number(f.O || 0) + truncated;
	// 只要「成功过」或者「失败过」其中之一，这条路由就**有证据**，走 team 分支。
	// 以前只判 runs>0，于是「派过但一次没成」的整条路由被当成没测过（见上面的长注释）。
	if (runs > 0 || fails > 0) {
		// 分母 = 成功 + 三类风险故障 + 认不出类的失败(O) + 撞顶。
		// O 那部分以前漏掉，等于「认不出是哪一类」的失败就不算失败 ——
		// 实测受害最深的是 cline/poolside/laguna-s-2.1-free（12 条网关转发失败 +
		// 上下文超限混着），置信被高估成 0.811，而它真实成功率只有一半。
		return {
			src: "team", ok: runs, tries: runs + fails,
			hours: (Number(e.usedMs) || 0) / 3600000,
			perRoute: f, truncated,
			hasClass: true,
		};
	}
	const ofm = e.ofm && typeof e.ofm === "object" ? e.ofm : null;
	const calls = ofm === null ? 0 : Number(ofm.calls) || 0;
	if (calls > 0) {
		const failed = Math.max(0, Math.min(calls, Number(ofm.failed) || 0));
		return {
			src: "ofm", ok: calls - failed, tries: calls,
			hours: Math.max(0, Number(ofmHours) || 0),
			perRoute: { S: 0, Q: 0, J: 0 }, truncated: 0,
			hasClass: false,
			ofmState: String(ofm.state || "none"),
		};
	}
	return { src: "none", ok: 0, tries: 0, hours: 0, perRoute: { S: 0, Q: 0, J: 0 }, truncated: 0, hasClass: false };
}

/** 分类打分的核心：一条证据 → 置信 / 风险 / 分数 / 档。 */
export function scoreEvidence(key, ev, base, qualityAvg) {
	const ok = Math.max(0, Number(ev.ok) || 0);
	const tries = Math.max(0, Number(ev.tries) || 0);
	const conf = wilsonLower(ok, tries);
	const hours = Math.max(0, Number(ev.hours) || 0);
	const f = ev.perRoute || { S: 0, Q: 0, J: 0 };
	const n = ok;
	const rateS = n > 0 ? f.S / n : 0;
	const rateQ = n > 0 ? f.Q / n : 0;
	const rateJ = n > 0 ? f.J / n : 0;
	const exS = Math.max(0, rateS - base.bS);
	const exQ = Math.max(0, rateQ - base.bQ);
	const exJ = Math.max(0, rateJ - base.bJ);
	// 风险 = 1 + 每类「超出池基线的倍数」× 该类在总故障中的份额。
	// 没超基线就一点不扣 —— 不许因为「太完美」反而被罚。
	const risk = 1
		+ (exS > 0 && base.bS > 0 ? (exS / base.bS) * base.wS : 0)
		+ (exQ > 0 && base.bQ > 0 ? (exQ / base.bQ) * base.wQ : 0)
		+ (exJ > 0 && base.bJ > 0 ? (exJ / base.bJ) * base.wJ : 0);
	// 品质：队长人工打分 1~5 → 乘数。**没有打分就 ×1.00，这一维完全不参与**
	// （维护方 2026-11-01：「没队长打分的时候忽略不计」）。
	//
	// 换算为什么是 0.6 + (平均分 − 1) × 0.2：
	//   · 1 分（胡编乱造）→ ×0.60：产出不可信，耐力再长也不该排在前面；
	//   · 3 分（合格）    → ×1.00：**基准**，等于「和没打分一样」——
	//                      这样「先给一个平均值」时既有分又不会整体抬高/压低全池；
	//   · 5 分（很好）    → ×1.40：好产出值得优先派。
	// 每档 0.2 是 5 分制四格均分 ((1.40 − 0.60) / 4 = 0.20)，不是拍的。
	const quality = Number.isFinite(qualityAvg) && qualityAvg > 0 ? 0.6 + (qualityAvg - 1) * 0.2 : 1;
	const score = ev.src === "none" ? 0 : (conf * Math.log(1 + hours) * quality) / risk;
	return {
		key, src: ev.src, ok, tries, hours,
		conf, risk, score,
		// `other` = 认得出是失败、但认不出类别的那些（进置信分母，不进风险）。
		// 单独列出来，是为了面板上能看清「这条为什么置信低却风险 1.00」。
		faults: { self: f.S, quota: f.Q, jitter: f.J, other: Number(f.O || 0), truncated: Number(ev.truncated) || 0 },
		rate: { self: rateS, quota: rateQ, jitter: rateJ },
		tier: tierOf({ tries, conf, risk }),
	};
}

/** 四档。判据见文件头。 */
export function tierOf(v) {
	const tries = Number(v && v.tries) || 0;
	const conf = Number(v && v.conf) || 0;
	const risk = Number(v && v.risk) || 1;
	if (tries < MIN_RUNS) return "未测";              // 样本不够，不下结论
	if (conf < CONF_USABLE) return "不稳";            // 置信不到「大概能成」：经常出问题
	if (risk > RISK_POOL_LIMIT) return "不稳";        // 故障率超全池平均两倍：经常出问题
	if (conf >= CONF_RECOMMEND && risk <= 1.0000001) return "推荐"; // 高置信且一项都没超线
	return "可用";                                     // 能用，但有某项毛病高于池子平均
}

// 2026-11-01 维护方报的 BUG（派活顺序）：「插件派人顺序要改改，要先派未测，再派推荐-可用-不稳，
// 否则未测永远是未测，除非前面的全挂了。」
//
// 原因的数学本质：未测 = 样本 < MIN_RUNS。只要派活永远从「推荐」开始挑，
// 未测的路由**永远没有机会被派一次**，样本永远是 0，于是永远判「未测」。
// 这不是排序偏好问题，是**证据采集的死锁**：一个只能靠实测转正的状态，
// 被排在实测机会的队尾，它就永远转不了正。
// 所以派活顺序必须把未测顶到最前：先给它一次机会，跑够 MIN_RUNS 次它自然落进
// 推荐/可用/不稳，之后按老顺序走。这只是**顺序**，候选集不变 —— 一条未测路由
// 一跑就崩，它照样是候选，只是下一次会带着这次失败进分母。
//
// 显示顺序**不动**（队长→成员→推荐→可用→未测→不稳），那是给人扫的；
// 这个常量只管派活，给机器挑的。
export const TIER_ORDER = { 未测: 0, 推荐: 1, 可用: 2, 不稳: 3 };

/** 整张表。`ofmHoursOf(key)` 给 OFM 车道的耐力（逐日 decodeMs 之和）。 */
export function buildScoreTable(entries, perRoute, qualityAvg, ofmHoursOf) {
	const base = poolBaselines(entries, perRoute);
	const hoursOf = typeof ofmHoursOf === "function" ? ofmHoursOf : () => 0;
	const table = new Map();
	for (const e of Array.isArray(entries) ? entries : []) {
		const key = `${(e && e.provider) || ""}/${(e && e.model) || ""}`;
		const ev = evidenceOf(e, perRoute, hoursOf(key));
		table.set(key, scoreEvidence(key, ev, base, qualityAvg));
	}
	return { table, base };
}
