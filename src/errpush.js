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
// errpush — 报错推送盒子（唯一的路由层）  2026-11-01
//
// 设计确定：的（两句话就是全部规格）：
//   「有报错直接发给报错模块处理，报错模块根据实际情况推送，这样也不用这里改一点那里改一点」
//   「报错的时候直接带上队长+成员编号信息什么的，错误能给插件处理的优先给插件，
//     不行的队员推给他的队长，他的队长不行的推给其他队空闲的队长，一个盒子搞定了」
//
// 所以这个模块只做三件事，**不记账、不改台账、不选路、不改任务状态**：
//   ① 认人：这条错是谁撞的（会话 id 唯一，名字不唯一 —— auto1..auto9 每队都有）
//   ② 定级：插件能不能自己处理（能 → 插件办完只说一句；不能 → 往上递）
//   ③ 定路：递到谁手上。四层兜底，从近到远：
//        插件自己 → 他的队长 → 别的队空闲的队长 → 认不出人时广播
//
// 为什么必须逐级往上递（维护方 2026-11-01 明确交代）：
//   「他的队长不行的推给其他队空闲的队长」—— 队长自己也撞在墙上时，
//   把它队里的错交给**别的队的空闲队长**，才是唯一还有人能处理的路径。
//   所以跨队投递是**设计**，不是 bug。被删的只有「同一条错乱发给不该收的人」。
//
// 报错身份证（每条推送都带，需求方要的「带上队长+成员编号信息」）：
//   成员 auto4「探针B」 · 队长 <某队长> · t54 · cline/x/x@medium · 额度限流
//   认不出来的人就写会话短号 + 路由，绝不写「?」糊过去。
//
// 和 index.js 的边界：本模块不 import 内核、不碰磁盘、不发通知（pushNotice 由调用方注入）。
// 于是它能被 verify 脚本直接喂真实用例跑（见 Updating/verify/verify-errpush.mjs）。
// ---------------------------------------------------------------------------

/** 插件自己能处理完、不必惊动队长的那些错（判据是「fix」而不是「类名」）。
 *  这些错插件已经降档/换路由/退避掉了，往上递只会变成噪音：
 *  队长看不到成员的模型细节，也不该由它来决定换哪条路由。
 *  ★ 但**不是不推**：插件办完仍要给队长一句话（kind 用「已自愈」），
 *    否则队长看着一个换了模型的人在跑，还以为跑的是原来那个。 */
export const PLUGIN_SELF_HEAL_FIXES = new Set(["downshift", "rotate", "backoff", "retry"]);

/** 插件处理不了的：只能由人（队长）决定换不换模型/要不要拆单。 */
export const NEEDS_HUMAN_FIXES = new Set(["dead", "none"]);

/**
 * @typedef {object} Deps
 * @property {Map} members         在册成员 Map<sessionId, MemberRecord>
 * @property {Map} retiredMembers  退役成员 Map<sessionId, {name,parentSessionId,at}>
 * @property {Function} agentsGet  (sessionId) => agent|undefined
 * @property {Function} resolveLead (agent) => 根会话 id
 * @property {Function} pushNotice (sessionId, kind, text) => void
 * @property {Function} [leadHealth] (leadSessionId) => "ok"|"wall"|"halt"|"unknown"
 *   队长的路由健不健康。返回 wall/halt = 他自己也干不了 → 往下一层递。
 *   不给（undefined）= 一律当他健康（保守：先给最近的队长）。
 * @property {Function} [idleOtherLeads] (excludeLeadId) => string[]
 *   别的队**空闲**的队长清单（内核清单里在线、不在跑回合、非子会话、非空白）。
 *   这是第四层兜底的目标池。
 * @property {Function} [onDrop] (reason, detail) => void  诊断用，不发通知
 */

/**
 * 会话 id 两种形态都认：members 的 key 是裸 childId，boards/parentSessionId 带 "session-"。
 * sweep 从会话目录名读到的是裸 uuid，别的路径可能带前缀 —— 都试一遍。
 * @param {string} id
 * @returns {string[]}
 */
export function idFormsOf(id) {
	if (id === "" || id === undefined || id === null) return [];
	const s = String(id);
	const bare = s.startsWith("session-") ? s.slice(8) : s;
	return s === bare ? [bare, "session-" + bare] : [s, bare];
}

/** 会话短号：面板和通知里统一用它，比整串 uuid 好认。 */
export function shortOf(sessionId) {
	const s = String(sessionId || "").replace(/^session-/, "");
	return s.slice(0, 8);
}

/**
 * 这个会话是谁？—— **一律按会话 id 认，不按名字**。
 * 名字在每个队里都会重复（auto1..auto9），按名字 find 会跨队认错人；
 * 成员被回收后从 members 消失、会话却还在跑，按名字查不到就会把它误判成队长，
 * 于是一条成员限流被贴上「队长报错」推进它自己那个成员会话里。
 * （实测：19 个不同会话各收到一条 `Sign up for free...`，全是子代理会话。）
 *
 * @param {string} sessionId
 * @param {Deps} deps
 * @returns {{name:string, parentSessionId:string, retired?:true, sessionId:string} | undefined}
 */
export function whoAmI(sessionId, deps) {
	const { members, retiredMembers } = deps;
	for (const f of idFormsOf(sessionId)) {
		const live = members.get(f);
		if (live !== undefined) return { ...live, sessionId: String(f) };
		const old = retiredMembers.get(f);
		// 离册成员照样能报回它的队长 —— 否则它会变成「幽灵队长」，自己给自己发报错。
		if (old !== undefined) return { name: old.name, parentSessionId: old.parentSessionId, retired: true, sessionId: String(f) };
	}
	return undefined;
}

/**
 * 报错身份证：一条推送里必须把「谁、在哪个队、哪一单、哪条路由、什么错」写全。
 * 设计说明：「报错的时候直接带上队长+成员编号信息什么的」。
 *
 * @param {object} fault
 * @param {Deps} deps
 * @returns {string} 形如 `auto4《探针B》· 队长 <某队长> · t54 · cline/x@medium · 额度限流`
 */
export function faultTag(fault, deps) {
	const f = fault === undefined || fault === null ? {} : fault;
	const who = whoAmI(f.sessionId, deps);
	const parts = [];
	if (who !== undefined) {
		parts.push(`${who.name}${who.retired === true ? "(已离册)" : ""}${f.taskTitle ? `《${String(f.taskTitle).slice(0, 20)}》` : ""}`);
		parts.push(`队长 ${shortOf(who.parentSessionId)}`);
	} else {
		const sid = String(f.sessionId || "");
		// 认不出来就写会话短号 + 是不是子会话，绝不写「?」糊过去
		parts.push(sid === "" ? "会话未知" : `会话 ${shortOf(sid)}${f.isSub === true ? "(子会话)" : ""}`);
		if (f.rootId) parts.push(`根 ${shortOf(f.rootId)}`);
	}
	if (f.tid) parts.push(String(f.tid));
	if (f.route) parts.push(`${f.route}${f.effort ? "@" + f.effort : ""}`);
	if (f.errClass) parts.push(String(f.errClass));
	return parts.join(" · ");
}

/**
 * 这条错插件能不能自己兜住？返回 { selfHeal, why }。
 * 判据只看 `fix`（规则表给的处置），不看类名 —— 同一条 429 在不同规则下处置不同。
 *
 * @param {string} fix   diagnoseError / 规则表给出的 fix
 * @param {string} memberName  撞错的人是不是队伍成员
 * @returns {{selfHeal:boolean, why:string}}
 */
export function pluginCanHandle(fix, memberName) {
	const fx = String(fix || "");
	// 不是队伍成员（队长自己、或任何非成员会话）：插件**永远不动**它的模型 ——
	// 换不换模型是维护方的事。所以对队长来说"插件能处理"恒为 false，必须往上递。
	if (memberName === undefined || memberName === null || String(memberName) === "") {
		return { selfHeal: false, why: "非队伍成员：插件不替它换模型，交给人" };
	}
	if (PLUGIN_SELF_HEAL_FIXES.has(fx)) return { selfHeal: true, why: `成员活，插件按 fix=${fx} 自己办（降档/换路由/退避）` };
	if (NEEDS_HUMAN_FIXES.has(fx)) return { selfHeal: false, why: `fix=${fx} 只能由人决定（换模型/拆单）` };
	// 空 fix / 未知 fix：不敢自己办 —— 宁可往上递，也不要拿维护方的额度试错
	return { selfHeal: false, why: fx === "" ? "规则表没给处置（fix 空）：不敢自己办，往上递" : `未知处置 fix=${fx}：往上递` };
}

/**
 * 这条报错该递到谁手上？**纯函数**，只读入参，返回投递计划（不产生副作用）。
 *
 * 四层，从近到远：
 *   ① 插件自己（selfHeal=true）→ targets=[]，不打搅任何人（可选 selfNote 给队长一句）
 *   ② 他的队长            → 队长路由健康就给队长
 *   ③ 别的队空闲的队长     → 队长自己也撞墙/组停，就换一个能动的队长
 *   ④ 认不出人 / 全都没有  → 广播给所有队长（最后一道，绝不静默丢弃）
 *
 * @param {object} fault
 * @param {string} [fault.sessionId]
 * @param {string} [fault.memberName]
 * @param {string} [fault.fix]
 * @param {string} [fault.rootId]     子代理会话的根（认人失败时用来判断"这是谁的子代理"）
 * @param {boolean} [fault.isSub]
 * @param {string[]} [fault.leads]    第四层的广播名单（boards/goals/成员父会话合集）
 * @param {Deps} deps
 * @returns {{targets:string[], reason:string, layer:1|2|3|4, selfHeal:boolean, who:object|undefined}}
 */
export function routeFault(fault, deps) {
	const f = fault === undefined || fault === null ? {} : fault;
	const { members, leadHealth, idleOtherLeads } = deps;
	const sid = f.sessionId !== undefined && f.sessionId !== null ? String(f.sessionId) : "";
	const handle = pluginCanHandle(f.fix, f.memberName);
	const byId = whoAmI(sid, deps);

	// ● 第 0 层：插件自己兜住了 → 不惊动任何人。
	//   （调用方想给队长留一句「已自愈」，用 pushFault 的 kind/force 自己发。）
	if (handle.selfHeal === true) {
		return { targets: [], reason: `第0层：${handle.why}`, layer: 1, selfHeal: true, who: byId };
	}

	// ● 第 1 层：推给他的队长（成员的正路 —— 队长才知道要不要换人/拆单）
	if (byId !== undefined) {
		const lead = String(byId.parentSessionId || "");
		if (lead === "") return { targets: [], reason: "第1层：成员无队长（孤儿成员），无人可递", layer: 2, selfHeal: false, who: byId };
		const health = typeof leadHealth === "function" ? String(leadHealth(lead) || "unknown") : "ok";
		// 队长自己的路由也在墙上 → 递给他等于递进死信箱，往下一层走
		if (health === "ok" || health === "unknown") {
			return { targets: [lead], reason: `第1层：成员→它的队长（队长路由 ${health}）`, layer: 2, selfHeal: false, who: byId };
		}
		// ● 第 2 层：队长干不了 → 找一个别的队空闲的队长
		const others = typeof idleOtherLeads === "function" ? idleOtherLeads(lead) || [] : [];
		const uniq = Array.from(new Set(others.map((x) => String(x || "")).filter((x) => x !== "" && x !== lead)));
		if (uniq.length > 0) {
			return { targets: uniq.slice(0, 2), reason: `第2层：队长(${shortOf(lead)}) 也 ${health}，递给别的队空闲队长 ${uniq.length} 个里的前 2 个`, layer: 3, selfHeal: false, who: byId };
		}
		// 别的队也没人空闲 → 还是回队长（宁可给撞墙的队长，也不能没人管）
		return { targets: [lead], reason: `第2层：队长 ${health} 且没有别的空闲队长，退回队长`, layer: 3, selfHeal: false, who: byId };
	}

	// 名字兜底：**只在唯一命中**时敢认。同名两人（跨队）一律不认 ——
	// 宁可当队长记一笔，也不要把 A 队的错算到 B 队头上。
	const nm = f.memberName !== undefined && f.memberName !== null ? String(f.memberName) : "";
	if (nm !== "" && members !== undefined) {
		const hits = Array.from(members.values()).filter((m) => m.name === nm);
		if (hits.length === 1 && String(hits[0].parentSessionId || "") !== "") {
			return { targets: [String(hits[0].parentSessionId)], reason: "第1层：按名字唯一命中→它的队长", layer: 2, selfHeal: false, who: hits[0] };
		}
	}

	// ● 子代理会话（不是成员但挂在某个根下）→ 递到根对话。子代理自己就是报错的那个，
	//   推给它等于让坏模型自述病历；根队长才是能动手的人。
	if (f.isSub === true && f.rootId !== undefined && String(f.rootId) !== "" && String(f.rootId) !== sid) {
		const root = String(f.rootId);
		const health = typeof leadHealth === "function" ? String(leadHealth(root) || "unknown") : "ok";
		if (health === "ok" || health === "unknown") {
			return { targets: [root], reason: `第1层：子代理会话→它的根对话（根路由 ${health}）`, layer: 2, selfHeal: false, who: undefined };
		}
		const others = typeof idleOtherLeads === "function" ? idleOtherLeads(root) || [] : [];
		const uniq = Array.from(new Set(others.map((x) => String(x || "")).filter((x) => x !== "" && x !== root)));
		if (uniq.length > 0) {
			return { targets: uniq.slice(0, 2), reason: `第2层：根对话(${shortOf(root)}) 也 ${health}，递给别的队空闲队长`, layer: 3, selfHeal: false, who: undefined };
		}
		return { targets: [root], reason: `第2层：根对话 ${health} 且没有别的空闲队长，退回根`, layer: 3, selfHeal: false, who: undefined };
	}

	// ● 第 3 层：是本队队长自己撞的（自己就是根）→ 先推它自己（它得知道自己的模型废了），
	//   同时如果它已经撞墙，再递一份给别的队空闲队长 —— 双管，因为它可能已经读不到信了。
	if (sid !== "" && f.isSub !== true) {
		const health = typeof leadHealth === "function" ? String(leadHealth(sid) || "unknown") : "ok";
		if (health === "ok" || health === "unknown") {
			return { targets: [sid], reason: `第1层：顶层会话→只推它自己（路由 ${health}）`, layer: 2, selfHeal: false, who: undefined };
		}
		const others = typeof idleOtherLeads === "function" ? idleOtherLeads(sid) || [] : [];
		const uniq = Array.from(new Set(others.map((x) => String(x || "")).filter((x) => x !== "" && x !== sid)));
		return {
			targets: [sid, ...uniq.slice(0, 1)],
			reason: `第2层：顶层会话 ${shortOf(sid)} 自己 ${health} → 自己也推（它可能读不到了）+ 别的队空闲队长 1 个`,
			layer: 3, selfHeal: false, who: undefined,
		};
	}

	// ● 第 3 层：连会话都拿不到 → 才退回广播。
	//   ★ 这条是维护方点名的兜底：「他的队长不行的推给其他队空闲的队长」。
	const leads = Array.isArray(f.leads) ? f.leads : [];
	const uniq = Array.from(new Set(leads.map((x) => String(x || "")).filter((x) => x !== "")));
	return {
		targets: uniq,
		reason: uniq.length > 0 ? "第3层：认不出人→广播给所有队长" : "第3层：认不出人且无处可报",
		layer: 4, selfHeal: false, who: undefined,
	};
}

/** 进程内去重窗口：一个错可能从「成员分支」和「子代理分支」两个判据都走到同一个人。
 *  notify.pushNotice 里也有一层（20 秒同 kind 同文），这里是同一口径的第二道。 */
const recent = new Map();

/**
 * 投递。**带身份证 + 逐级兜底 + 去重**，三件事一次做完。
 *
 * @param {object} fault  同 routeFault（外加 taskTitle / tid / route / effort / errClass）
 * @param {object} opts
 * @param {string} opts.kind   通知种类（「已自愈」「成员模型故障」「队长报错」…），由调用方定
 * @param {string} opts.text   正文（**不含身份证**，函数会自己拼在最前面）
 * @param {boolean} [opts.force] true = 即使插件能自愈也发（用于「已自愈」那一条告知）
 * @param {Deps} deps
 * @returns {{delivered:string[], reason:string, layer:number, tag:string}}
 */
export function pushFault(fault, opts, deps) {
	const o = opts === undefined || opts === null ? {} : opts;
	const plan = routeFault(fault, deps);
	const tag = faultTag(fault, deps);
	const kind = String(o.kind || "报错");
	const body0 = String(o.text || "");
	const text = tag === "" ? body0 : `【${tag}】${body0}`;
	if (plan.selfHeal === true && o.force !== true) {
		if (typeof deps.onDrop === "function") deps.onDrop(plan.reason, kind);
		return { delivered: [], reason: plan.reason, layer: plan.layer, tag };
	}
	const now = Date.now();
	const delivered = [];
	for (const to of plan.targets) {
		const sig = `${to}|${kind}|${text.slice(0, 80)}`;
		const prev = recent.get(sig);
		if (prev !== undefined && now - prev < 20000) continue;
		recent.set(sig, now);
		if (typeof deps.pushNotice === "function") deps.pushNotice(to, kind, text);
		delivered.push(to);
	}
	if (recent.size > 400) for (const [k, v] of recent) if (now - v > 60000) recent.delete(k);
	if (delivered.length === 0 && typeof deps.onDrop === "function") deps.onDrop(plan.reason, kind);
	return { delivered, reason: plan.reason, layer: plan.layer, tag };
}
