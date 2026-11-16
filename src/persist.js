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
// persist — 原子写盘（取自 OFM 的写法，2026-11-01）。
//
// 为什么要有这个（说明：「主要是他的程序写法，看看我们有必要抄吗」）：
//
//   TEAM 原来所有的 .state/*.json 都走 util.saveJson → writeFileSync 直接覆盖。
//   这条路有两个洞，且都已经在生产上出现过：
//
//   1. **截断**：writeFileSync 写到一半断电/被杀，文件就是半个 JSON。下次 loadJson
//      读不出来 → fallback → 整个台账/板子/锁表变空，而且**没有任何报错**。
//   2. **并发**：DSH 会同时写 cordis.patch.yml，Windows 的杀软/索引器也会短暂
//      独占文件，rename 偶尔 EPERM。一次失败就静默丢写。
//
//   OFM 的 updater 是这么做的：写到 `<file>.ofm-new` 再 rename 覆盖目标，EPERM 重试。
//   rename 在 NTFS 上是原子的（MoveFileEx + REPLACE_EXISTING），所以目标文件
//   要么是旧的完整版、要么是新的完整版，**不存在半个**。
//
//   这里把它做成 TEAM 自己的通用件，并补上 OFM 也没做的两件事：
//   - 写失败不再静默：记进 `lastWriteError`，面板/工具能读出来；
//   - 临时名带 pid + 随机后缀，多进程/多实例不会互相踩。
// ---------------------------------------------------------------------------

import * as nodeFs from "node:fs";
import * as nodePath from "node:path";

/** 最近一次写盘失败的原因；null = 一切正常。给诊断用，不要拿来当开关。 */
let lastWriteError = null;

export function persistDiagnostics() {
	return { lastWriteError };
}

export function clearPersistError() {
	lastWriteError = null;
}

/** 同步睡眠（只有 retry 用，最长几十毫秒，不阻塞事件循环里的别的活）。 */
function sleepSync(ms) {
	try {
		const sab = new Int32Array(new SharedArrayBuffer(4));
		Atomics.wait(sab, 0, 0, ms);
	} catch {
		// 某些环境禁 SharedArrayBuffer；退化成忙等（只发生在失败重试路径上）
		const until = Date.now() + ms;
		while (Date.now() < until) { /* spin */ }
	}
}

// Windows 的 EPERM/EBUSY 基本都是索引器或杀软短暂持有，等一下就好。
const TRANSIENT = new Set(["EPERM", "EBUSY", "EACCES", "ENOTEMPTY"]);

/**
 * 原子写文本：临时文件 → rename 覆盖。
 *
 * @param {string} file 目标绝对路径
 * @param {string} text 内容
 * @param {{retries?:number, delayMs?:number, mkdir?:boolean}} [options]
 * @returns {boolean} true = 目标文件已是新内容
 */
export function writeFileAtomic(file, text, options = {}) {
	const retries = Number.isSafeInteger(options.retries) ? options.retries : 3;
	const delayMs = Number.isSafeInteger(options.delayMs) ? options.delayMs : 40;
	const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
	try {
		if (options.mkdir !== false) nodeFs.mkdirSync(nodePath.dirname(file), { recursive: true });
	} catch (error) {
		lastWriteError = { file, at: Date.now(), code: String((error && error.code) || "EMKDIR"), message: String((error && error.message) || error) };
		return false;
	}
	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			nodeFs.writeFileSync(tmp, text, "utf8");
			nodeFs.renameSync(tmp, file);
			lastWriteError = null;
			return true;
		} catch (error) {
			const code = String((error && error.code) || "EUNKNOWN");
			// 最后一次也失败：清掉临时文件，记下原因，返回 false（调用方自己决定要不要提示）
			if (attempt === retries || !TRANSIENT.has(code)) {
				try { nodeFs.rmSync(tmp, { force: true }); } catch { /* 清不掉就算了，不留垃圾更重要 */ }
				lastWriteError = { file, at: Date.now(), code, message: String((error && error.message) || error), attempts: attempt + 1 };
				return false;
			}
			sleepSync(delayMs * (attempt + 1));
			try { nodeFs.rmSync(tmp, { force: true }); } catch { /* 下一轮会重写同名以外的临时名 */ }
		}
	}
	return false;
}

/**
 * 原子写 JSON。缩进 0（省盘；TEAM 的 state 文件没人肉读，面板走接口）。
 * 值本身序列化失败（循环引用等）时返回 false 并记录，不抛。
 */
export function writeJsonAtomic(file, value, options = {}) {
	let text;
	try {
		text = JSON.stringify(value);
	} catch (error) {
		lastWriteError = { file, at: Date.now(), code: "ESTRINGIFY", message: String((error && error.message) || error) };
		return false;
	}
	if (typeof text !== "string") {
		lastWriteError = { file, at: Date.now(), code: "ESTRINGIFY", message: "JSON.stringify 返回了非字符串" };
		return false;
	}
	return writeFileAtomic(file, text, options);
}

/**
 * 带容量上限的追加日志（seen-events / sweep-debug / accounting 这类 jsonl）。
 *
 * 原来每个调用点都自己抄一遍「超过 N KB 就清空再 append」，抄错一处就是无限长文件。
 * 这里统一：超过 capBytes 时整体清空重开（这些日志只用于最近诊断，历史不需要）。
 */
export function appendLine(file, line, options = {}) {
	const capBytes = Number.isSafeInteger(options.capBytes) ? options.capBytes : 120 * 1024;
	try {
		nodeFs.mkdirSync(nodePath.dirname(file), { recursive: true });
		let size = 0;
		try { size = nodeFs.statSync(file).size; } catch { size = 0; }
		if (size > capBytes) nodeFs.writeFileSync(file, "", "utf8");
		nodeFs.appendFileSync(file, String(line) + "\n", "utf8");
		return true;
	} catch (error) {
		lastWriteError = { file, at: Date.now(), code: String((error && error.code) || "EAPPEND"), message: String((error && error.message) || error) };
		return false;
	}
}
