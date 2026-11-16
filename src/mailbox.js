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
// mailbox — 跨会话 Lead 信箱（内核 sendMessage 只允许直系，靠它做转发）
// 从 index.js 的「跨会话 Lead 信箱」区原样搬来（2026-10-31 模块化第二批）。
// 逻辑一行未改，闭包依赖改为 import。
// ---------------------------------------------------------------------------

import * as nodeFs from "node:fs";
import * as nodePath from "node:path";
import { stateDirPath } from "./config.js";
import { dayStamp, loadJson, saveJson, shortOf } from "./util.js";

// --- 跨会话 Lead 信箱。内核 subagents.sendMessage 只允许「直接父/直接子」，
//     两个顶层对话框之间发不了消息，所以插件自己当邮局：tell 投递到文件，
//     对方下一次调用任何 team 动作时随 notices 带出。不是实时推送。
//
// ★ 2026-11-01 晚：这里原来是**顶层** `const mailPath = join(常量, …)` 且顶层就读盘 ——
//   模块加载那一刻路径定型，cfg 里的 stateDir 改不动它，换台机器就写错地方。
//   现在改成「第一次用到才算路径、才读盘」，路径跟着 apply 里 setStateDir 定的目录走。
export const mailPath = () => nodePath.join(stateDirPath(), "leads-mail.json");
// 面板要能看见实现方之间聊了啥：投递流水单独存一份（不随读信清空）。
export const mailLogPath = () => nodePath.join(stateDirPath(), "leads-mail-log.json");
export const mailBox = {}; // targetSessionId -> [{from, fromShort, at, text}]
export const mailLog = [];
let mailLoaded = false;
/** 首次使用时把盘上的信箱/流水读进内存（幂等）。 */
export function loadMail() {
	if (mailLoaded) return;
	mailLoaded = true;
	try {
		const box = loadJson(mailPath(), {});
		for (const [k, v] of Object.entries(box !== null && typeof box === "object" ? box : {})) mailBox[k] = v;
		const log = loadJson(mailLogPath(), []);
		if (Array.isArray(log)) for (const row of log) mailLog.push(row);
	} catch { /* 读不到就当空，不影响启动 */ }
}

/** 面板「跨会话消息」最多 20 条（取最新 20）；信箱每箱也是 20 条。
 *  2026-10-30 设计确定：**投递流水也只留 20 条**，超出的直接丢弃，不留历史、不显示累计 —
 *  两边都是长跑会话，留 100 条只会让 leads-mail-log.json 无限膨胀。 */
export const MAIL_PANEL_MAX = 20;
export const MAIL_BOX_MAX = 20;
export const MAIL_LOG_MAX = 20;
/** 2026-10-31 维护方报的真事故：c197654c 收到实现方的公告后回了一封信，**正文里根本没有 @b87c7940**，
 *  按老规矩只入信箱 —— 实现方那次正好在跑，等它下次调 team 才看到，等于「报告没人接」。
 *  两条老规矩因此失效：`@` 靠正文认（正文里 URL/邮箱/文件名到处是 @）+ 整封 800 字封顶
 *  （长信被截断，`@` 若在截断点之后 = 永久看不见）。
 *  新规矩（维护方可推翻）：
 *   ① 收信人写在一等公民字段 `to` 上，不靠正文猜；`mentions()` 因此只认「@ 在信头」或
 *      **@ 后面紧跟收信人短号/全 id** 这两种形态 —— 随手一个 @foo 不再误判成点名；
 *   ② 投递不再凭空截断：正文按 `整封原文留档（上限 8K）+ 全文流进 inbox 文件` 走，
 *      截断只发生在给模型看的 preview 上，且**明写「已截断，全文见 …」**；
 *   ③ 长信也不再靠 `@` 触发叫醒 —— 收信人由字段决定，`addressed` 只看 `mentions()` 与 `wake:true`。 */
export const MAIL_BOX_BYTES = 8000;
export const saveMail = () => {
	loadMail();
	try { saveJson(mailPath(), mailBox); } catch { /* 写不进去就只留内存 */ }
};
/** 面板「跨会话消息」一键清除（2026-11-04 设计确定：）。
 *  只清**投递流水 mailLog**（面板给人扫的那 20 条显示），**不碰信箱本体 mailBox** ——
 *  信箱是 Agent 读的那条（每箱 MAIL_BOX_MAX 条兜底），清了它等于把别人还没读的信删掉。
 *  幂等：没读过盘也照清（清的是内存里的活数组），写盘失败就只清内存。 */
export function clearMailLog() {
	loadMail();
	mailLog.length = 0;
	try { saveJson(mailLogPath(), mailLog); } catch { /* 写不进去就只留内存 */ }
	return mailLog.length;
}
export function deliverMail(toId, fromId, fromShort, text, addressedTo) {
	loadMail();
	const raw = String(text || "");
	// 只入档，不丢内容：超长按字节上限裁，但裁时留「截断标记 + 全文落盘路径」。
	// 剪枝优先砍两头空白 + 保留首尾各 4K，中间不硬拼（避免一句被砍成两半看不懂）。
	const entry = {
		from: String(fromId), fromShort: String(fromShort), at: Date.now(),
		text: raw.length > MAIL_BOX_BYTES ? raw.slice(0, 4000) + "\n…（原文过长已折叠，全文见同目录 mail-full）…\n" + raw.slice(-4000) : raw,
		full: raw.length > MAIL_BOX_BYTES ? saveMailFull(raw) : undefined,
		chars: raw.length,
		addressedTo: addressedTo === true,
	};
	const list = mailBox[String(toId)] || [];
	list.push(entry);
	while (list.length > MAIL_BOX_MAX) list.shift();
	mailBox[String(toId)] = list;
	saveMail();
	// 面板「跨会话消息」：一律只留 300 字摘要（面板是给人扫一眼的，不是信箱本体）——
	// 原来这里也按 800 字截断，长信在面板上只能看到半截、且看不出来被截了。
	mailLog.push({
		from: String(fromShort), to: String(toId).replace(/^session-/, "").slice(0, 8), at: Date.now(),
		text: raw.length > 300 ? raw.slice(0, 300) + "…（共 " + raw.length + " 字，全文见收件人信箱）" : raw,
	});
	while (mailLog.length > MAIL_LOG_MAX) mailLog.shift();
	saveJson(mailLogPath(), mailLog);
	return entry;
}
/** 长信原文单独落盘（不进 leads-mail.json，避免任何一次读写把 8K 以上的正文再截一遍）。 */
export function saveMailFull(raw) {
	try {
		const dir = nodePath.join(stateDirPath(), "mail-full");
		nodeFs.mkdirSync(dir, { recursive: true });
		const name = `mail-${dayStamp()}-${Date.now()}.txt`;
		nodeFs.writeFileSync(nodePath.join(dir, name), raw, "utf8");
		return nodePath.join(dir, name);
	} catch { return undefined; }
}
export function drainMail(leadId) {
	loadMail();
	const key = String(leadId);
	const list = mailBox[key];
	if (!Array.isArray(list) || list.length === 0) return [];
	delete mailBox[key];
	saveMail();
	// 2026-10-31 修：原来这里是「@ 了才标 ❗」，长信还会被 800 字砍掉尾巴。
	// 现在按「整封」交付：没 @ 也整封送到（收信人已经由 tell 的 to 决定，不存在认错），
	// 只把**明确点名的那几封**在行首加 ❗ 标一下，方便一眼分主次。
	return list.map((m) => {
		const head = m.addressedTo === true ? `❗@你 · 📨 来自 ${m.fromShort}` : `📨 来自 ${m.fromShort}`;
		const size = typeof m.chars === "number" && m.chars !== String(m.text || "").length ? `（原文 ${m.chars} 字）` : "";
		const tail = typeof m.full === "string" ? `\n（原文过长，全文已落盘：${m.full} —— 需要完整细节就 read 它）` : "";
		return `${head}${size}：${m.text}${tail}`;
	});
}
/** `@` 只认「明确点名收信人」这一种形态，不再把正文里任何一个 @ 都算作点名：
 *  - `@<收信人短号>` / `@<收信人完整 id>` / `@session-<id>` 才算；
 *  - 信头 `@你` / `@对方` 也认（成员/队长自己写的"@你"是口语，不指具体 id）；
 *  - 其它 `@foo`（群名、邮箱、URL 里的 userinfo、文件名）一律不认。
 *  2026-10-30 设计确定：的「不主动打断」原则照旧：没点名的信只进信箱。 */
export function mentions(text, toId) {
	const s = String(text || "");
	if (s.indexOf("@") < 0) return false;
	const full = String(toId || "");
	const short = shortOf(full);
	const body = full.replace(/^session-/, "");
	// 强形态：直接写短号 / 完整 id
	if (s.includes("@" + short)) return true;
	if (full !== "" && s.includes("@" + full)) return true;
	if (body !== "" && short !== "" && s.includes("@" + "session-" + body)) return true;
	// 口语形态：信头第一行就写 `@你`（只认第一行，避免正文里"@你们""@大家"误伤）
	const head = s.split("\n")[0] || "";
	if (/@(你|对方|收信人)\s*[:：,，]?/.test(head)) return true;
	return false;
}
