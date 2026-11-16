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
// accounting — 全局兜底监听（进程级 agent 失败事件）
// 从 index.js 的「全局兜底监听」区原样搬来（2026-10-31 模块化第三批）。
 //
 // 背景（维护方 10-29 追问「怎么没看到触发轮询」后加的）：
 //   attachAccounting 是**按会话实例**挂的：那个对话没有活的插件实例就什么都收不到。
 //   10-29 14:13 那个会话（某次实测）撞 laguna 569984 > 262112 就是这种情况：
 //   报错打了 5 次重试，插件当天一条都没记，自检自然也没触发。
 //   `{global:true}` 是 dsh-purge 用的同一手法：绕过 scope 过滤，全进程的 agent 都能听见。
 //   多个会话实例会同时收到 → 5 秒内同 (会话, 报错) 只处理一次；跨实例重复由
 //   archiveError 的文件级去重和 lead-errors 的签名合并吸收。
 //
 // 逻辑一行未改；ctx / members / recordRealRun 原是闭包依赖，改为工厂参数。
 // ---------------------------------------------------------------------------

import * as nodeFs from "node:fs";
import * as nodePath from "node:path";
import { stateDirPath } from "./config.js";

/**
 * @param {object} deps
 * @param {object} deps.ctx 内核 ctx（读 agents.get / root）
 * @param {Map} deps.members 成员名册
 * @param {Function} deps.recordRealRun 记账函数（被动实测）
 */
export function createAccounting({ ctx, members, recordRealRun }) {
	const globalSeen = new Map();
	/** 诊断用：把「到底有没有收到事件」写下来。10-29 14:48 那次 xingchen 报错没进台账，
	 *  光看 .state 分不清是「没收到事件」还是「收到了没写」，所以每次都留一行，事后可查。 */
	function debugSeen(sid, raw, via) {
		try {
			const p = nodePath.join(stateDirPath(), "seen-events.jsonl");
			let size = 0;
			try { size = nodeFs.statSync(p).size; } catch { /* 首次 */ }
			if (size > 200 * 1024) nodeFs.writeFileSync(p, "");
			nodeFs.appendFileSync(p, JSON.stringify({ at: Date.now(), sid: String(sid || "").slice(-8), via: via || "?", raw: String(raw || "").replace(/\s+/g, " ").slice(0, 200) }) + "\n");
		} catch { /* 诊断写不进去就算了，不影响记账 */ }
	}
	function globalFailure(agent, raw0, via) {
		if (agent === undefined || agent === null) return;
		const sid = agent.session && agent.session.id ? String(agent.session.id) : "";
		if (sid === "") return;
		const raw = String(raw0 === undefined || raw0 === null || raw0 === "" ? "request failed (no message)" : raw0);
		debugSeen(sid, raw, via);
		const sig = `${sid}|${raw.slice(0, 100)}`;
		const now = Date.now();
		const prev = globalSeen.get(sig);
		if (prev !== undefined && now - prev < 5000) return;
		globalSeen.set(sig, now);
		if (globalSeen.size > 200) for (const [k, v] of globalSeen) if (now - v > 60000) globalSeen.delete(k);
		const header = agent.session.requestHeader ? agent.session.requestHeader() : undefined;
		const config = header && header.config;
		if (config === undefined || config === null) { debugSeen(sid, "NO-CONFIG", via); return; }
		const member = members.get(sid);
		recordRealRun(config.provider, config.model, "fail", raw, config.reasoningEffort, member === undefined ? null : member.name, sid);
	}
	const globalReqHandler = (payload, next) => {
		const failure = (payload && payload.failure) || {};
		globalFailure(payload && payload.agent, failure.message || ((payload && payload.failure && payload.failure.code) || ""), "req");
		return typeof next === "function" ? next() : undefined;
	};
	const globalErrHandler = (payload) => {
		const err = payload && payload.error;
		globalFailure(payload && payload.agent, err instanceof Error ? err.message : String(err === undefined ? "" : err), "err");
	};
	/** `api-session/error(sessionId, message)`：**不带 Agent scope** 的进程级失败通知，
	 *  「One Agent failed outside a durable turn position」。10-29 14:48 那次就是漏在这条上：
	 *  agent/* 全是被 scope 过滤的，跨会话实例收不到；这条没有过滤。路由从活着的 agent 上补。
	 *  10-31 之后也一样：哪怕 agent 已经不在，也至少把消息写进诊断文件。 */
	const globalSessionErrHandler = (sessionId, message) => {
		const sid = String(sessionId === undefined || sessionId === null ? "" : sessionId);
		debugSeen(sid, message, "api-session");
		if (sid === "") return;
		let agent;
		try {
			agent = ctx.agents !== undefined && typeof ctx.agents.get === "function" ? ctx.agents.get(sid) : undefined;
		} catch { agent = undefined; }
		if (agent === undefined || agent === null) {
			debugSeen(sid, "NO-AGENT（只有消息没有路由）", "api-session");
			return;
		}
		globalFailure(agent, message, "api-session");
	};

	return { debugSeen, globalFailure, globalReqHandler, globalErrHandler, globalSessionErrHandler };
}
