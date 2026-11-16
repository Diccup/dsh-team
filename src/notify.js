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
// notify — Lead 通知队列（插件唯一合法的「告诉队长」通道）
// 从 index.js 的「Lead notices」区原样搬来（2026-10-31 模块化第二批）。
// 走下一个 team 调用把话带回，不伪造日志、不冒充用户回合。逻辑一行未改。
// ---------------------------------------------------------------------------

import * as nodePath from "node:path";
import { stateDirPath } from "./config.js";
import { loadJson, saveJson } from "./util.js";

// --- Lead notices: the plugin's only legal way to "tell the Lead" is to hand
// the line back on the next team call (send_message needs a live, resident
// sender; appending to the Lead's log would forge a user turn). Anything the
// Lead must know rides here and is drained on first read.
// notices 也落盘：#2 之前只活在内存里，插件重启（每次改代码都要重装）就全丢，
// 跨队协作和虚报取证全靠它，丢了等于那段交涉没发生。
//
// ★ 2026-11-01 晚：这里原来是**顶层** `const noticesPath = join(常量, …)` 且顶层
//   `loadJson` 读盘 —— 模块加载那一刻路径就定型了，cfg 里改 stateDir 也改不动它，
//   别人的机器装上去照样去写实现方那台机器的 F:\ 盘。
//   现在改成「第一次用到时才定路径、才读盘」，路径跟着 apply 里 setStateDir 定的目录走。
export const noticesPath = () => nodePath.join(stateDirPath(), "notices.json");
export const notices = new Map(); // leadId -> [{at, kind, text}]
let noticesLoaded = false;
/** 首次使用时把盘上的通知读进内存（幂等）。apply 里定了 stateDir 之后才第一次读，
 *  所以读到的是**正确目录**里的文件。 */
export function loadNotices() {
	if (noticesLoaded) return notices;
	noticesLoaded = true;
	try {
		const j = loadJson(noticesPath(), {});
		for (const [k, v] of Object.entries(j !== null && typeof j === "object" ? j : {})) notices.set(k, v);
	} catch { /* 读不到就当空，不影响启动 */ }
	return notices;
}
export const saveNotices = () => {
	loadNotices();
	try { saveJson(noticesPath(), Object.fromEntries(notices)); } catch { /* 写不进去就只留内存 */ }
};
export function pushNotice(leadId, kind, text) {
	if (leadId === undefined || leadId === null) return;
	const list = notices.get(String(leadId)) || [];
	const k = String(kind || "info");
	const body = String(text || "").slice(0, 1200);
	// 同一条内容 20 秒内不重复入队：全局监听下多个会话实例会同时听见同一次失败
	if (list.slice(-3).some((n) => n.kind === k && n.text === body && Date.now() - Number(n.at || 0) < 20000)) return;
	list.push({ at: Date.now(), kind: k, text: body });
	if (list.length > 20) list.shift();
	notices.set(String(leadId), list);
	saveNotices();
}
