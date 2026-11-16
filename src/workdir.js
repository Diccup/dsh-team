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
// workdir — 写根解析（成员的 cwd 就是它的 workspace-write 边界）
// 从 index.js 的「write roots」区 + outsideWorkspace 原样搬来（2026-10-31 第二批）。
// 逻辑一行未改；cfg 原是闭包变量，改为工厂参数。
// ---------------------------------------------------------------------------

import * as nodeFs from "node:fs";
import * as nodePath from "node:path";
import { boards } from "./state.js";
import { boardFor } from "./board.js";
import { DSH_ROOT } from "./config.js";

/**
 * @param {object} cfg 插件配置（读 runsDir / teamDir / workspaceRoot）
 */
export function createWorkdir(cfg) {
// --- write roots: a member's cwd IS its workspace-write boundary
// (sandbox-policy: workspaceRoot = session.header.cwd), so the team hands out
// one directory per member and pins the member's mode to workspace-write.
//
// 2026-11-01 晚：这两行的兜底原来是写死的本机路径
//   `"F:\\workspace"` / `"F:\\workspace\\LongMem\\Teamstate"`
// —— 意思是「cfg 里没配就按实现方这台机器的盘」。别人装上去 cfg 里当然没配，
// 于是每个成员都被指到一台不存在盘上的目录，写一次拒一次。
// 现在兜底改成按插件位置推出来的 DSH_ROOT（见 src/config.js）：
// 别人的机器推出来是他自己的 `.dsh` 根，不是实现方的 F: 盘。
// 这两行只是**兜底**：正常路径永远是 cfg 里的 workspaceRoot / teamDir。
const WORKSPACE_ROOT = String((cfg !== undefined && cfg !== null && cfg.workspaceRoot) || DSH_ROOT);
function runsRoot() {
	return String(cfg.runsDir || nodePath.join(cfg.teamDir || nodePath.join(DSH_ROOT, "team"), "runs"));
}
/** Task-intro slug: safe as a Windows directory name, readable, bounded.
 *  Chinese punctuation is stripped too — it used to ride into paths as "，；：（". */
function slugify(text, max = 12) {
	const cleaned = String(text || "")
		.replace(/[\\\/:*?"<>|\r\n\t]+/g, " ")
		.replace(/[，、；：！？“”‘’（）【】《》〈〉…—～·．,;:!?()\[\]{}"'`]+/g, " ")
		.replace(/[\s_]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^[-.\s]+|[-.\s]+$/g, "")
		.slice(0, max);
	return cleaned === "" ? "team" : cleaned;
}
function teamMeta(leadId, hint) {
	const board = boardFor(leadId);
	if (board.meta !== null && board.meta !== undefined && board.meta.root) return board.meta;
	const now = new Date();
	const pad = (n) => String(n).padStart(2, "0");
	const stamp = `${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
	const slug = "T-" + slugify(hint) + "-" + stamp;
	board.meta = { slug, root: nodePath.join(runsRoot(), slug), createdAt: Date.now() };
	return board.meta;
}
/** 队里的「默认写根基底」。2026-10-30 隔壁实测的根因：队长用 spawn(workdir:"F:\...\workspace-A")
 *  把成员放在指定目录，可**自动补员**只认 `cfg.runsDir`，于是 auto 成员的写根落在
 *  `Teamstate\runs\T-auto1-...\<名字>`，产物全写错位置。
 *  规则：谁在这个队上第一次显式给了绝对写根，它就成为该队的基底（记在 board.meta.base），
 *  之后所有缺省写根（自动补员 / spawn 不传 / adopt）都长在它下面：`<base>\<成员名>`。
 *  基底不写则回落 runsDir（老行为）。基底只认 workspace 内路径，避免把队友带去盘外。 */
function writeBaseOf(leadId) {
	const board = boards.get(leadId);
	const meta = board !== undefined && board.meta !== null && board.meta !== undefined ? board.meta : null;
	const base = meta === null ? "" : String(meta.base || "");
	return base !== "" && outsideWorkspace(base) === false ? base : "";
}
function rememberWriteBase(leadId, dir) {
	if (dir === "" || outsideWorkspace(dir)) return;
	const board = boardFor(leadId);
	if (board.meta === null || board.meta === undefined) {
		const slug = "T-" + slugify(nodePath.basename(dir)) + "-" + Date.now().toString(36);
		board.meta = { slug, root: dir, base: dir, createdAt: Date.now() };
		return;
	}
	board.meta.base = dir;
	board.meta.root = dir;
}
/** 成员写根解析：绝对路径优先，缺省长在队基底下面，最后才回落队目录。
 *  spawn / 自动补员 / adopt 三处都用这一个函数，不许各自拼路径。 */
function memberWorkdir(leadId, name2, rawRoot) {
	const raw = String(rawRoot === undefined || rawRoot === null ? "" : rawRoot).trim();
	const base = writeBaseOf(leadId);
	if (raw !== "" && raw !== "team" && nodePath.isAbsolute(raw)) {
		const abs = nodePath.resolve(raw);
		rememberWriteBase(leadId, abs);
		return abs;
	}
	if (base !== "") return nodePath.join(base, name2);
	return nodePath.join(teamMeta(leadId, name2).root, name2);
}
function ensureWriteRoot(dir) {
	try {
		nodeFs.mkdirSync(dir, { recursive: true });
		return undefined;
	} catch (error) {
		return String(error && error.message ? error.message : error);
	}
}

function outsideWorkspace(dir) {
	const norm = nodePath.resolve(dir).toLowerCase();
	return !(norm === WORKSPACE_ROOT.toLowerCase() || norm.startsWith(WORKSPACE_ROOT.toLowerCase() + nodePath.sep));
}

	return { WORKSPACE_ROOT, runsRoot, slugify, teamMeta, writeBaseOf, rememberWriteBase, memberWorkdir, ensureWriteRoot, outsideWorkspace };
}
