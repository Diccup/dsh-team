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
// selfreload — 把磁盘上的新代码换进正在跑的进程，不用重启宿主。
//
// 取自 dsh-our-free-model@2.7.4 的 src/reload.js（2026-11-01 拆解后移植）。
// 原文件已经把原理、边界和坑写清楚了，这里保留它的骨架，改了三处：
//
//   1. **包根支持多个基址**。TEAM 是靠 profile 里的 `link:`（Junction）进来的：
//      模块缓存里的键可能是真实的 `.dsh/plugins/dsh-team/…`，也可能是
//      `profiles/desktop/node_modules/dsh-team/…`。只匹配一个基址就会漏掉另一半，
//      漏掉的那个正是 `src/*.js` —— 于是 index.js 换了、模块还是旧的。
//      这里把所有候选基址（字面路径 + realpath）一起算。
//   2. **多一个 dry 探针** `probeReload(ctx)`：只报「能不能重载、会清掉哪些键」，
//      一个字节都不动。先看再动手，是维护方 2026-10-31 定的规矩。
//   3. 日志前缀和 global 符号换成 dsh-team。
//
// 为什么要这个（血的教训）：内核的 HMR 监视器 `ignored` 默认含 `**/node_modules`，
// 而本插件恰好是从 node_modules 下的 Junction 进来的 —— 所以 src/*.js 的改动
// **永远不会**被它看见。`pluginManager.reload()` 能让 apply() 重跑，但它走的是
// 同一条 HMR 路径，仍然只换 index.js。
//
// 这条路径不经过任何监视器：直接按包根前缀把 loader 的 loadCache 里属于本包的
// 模块全清掉，再 import(index.js) 让它重新求值，最后拆旧 fiber、按原配置注册新 fiber。
// 失败回滚：缓存恢复、旧插件重新注册，并把 `restored` 如实报出来（不谎报成功）。
// ---------------------------------------------------------------------------

import * as nodeFs from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

/** 本模块所在包名，只用于日志和 global 符号。 */
export const PACKAGE_NAME = "dsh-team";
const LAST_RELOAD = Symbol.for("dsh-team.last-reload");

let inFlight = null;

/** 当前是否正在重载（防重入：两次并发换代码会把 registry 搅烂）。 */
export function isReloading() {
	return inFlight !== null;
}

/** 最近一次重载的结果（跨实例可读，因为挂在 globalThis 上）。 */
export function lastReload() {
	return globalThis[LAST_RELOAD] ?? null;
}

/** 包根目录（带尾斜杠的 file:// URL）。本文件在 src/ 下，所以是上一层。 */
export function packageUrlOf(entryModuleUrl = import.meta.url) {
	return new URL("../", entryModuleUrl).href;
}

/** 入口文件 index.js 的 file:// URL。 */
export function entryUrlOf(entryModuleUrl = import.meta.url) {
	return new URL("../index.js", entryModuleUrl).href;
}

/**
 * 把「包根 URL」和「缓存键」归一成同一把尺子：去 `file://`、反斜杠转正斜杠、
 * 去开头多余的斜杠、转小写、去尾斜杠。
 *
 * 这一步非做不可：缓存键是 `file:///C:/...` 形式，而 realpath 拿到的是
 * `C:\...\` 形式，直接比永远不相等 —— 比不上的那个正是 `src/*.js`。
 */
function normPath(value) {
	let v = String(value);
	if (v.startsWith("file://")) v = v.slice(7);
	try { v = decodeURIComponent(v); } catch { /* 保持原样 */ }
	v = v.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
	return v.toLowerCase();
}

/**
 * 所有可能出现在模块缓存键里的包根基址（已归一，带尾斜杠）。
 * 含字面路径与 realpath —— Junction 两边都要认。
 */
export function packageBases(entryModuleUrl = import.meta.url, extra = []) {
	const out = new Set();
	const add = (url) => {
		const normalized = normPath(url);
		if (normalized !== "") out.add(normalized + "/");
	};
	add(packageUrlOf(entryModuleUrl));
	for (const url of extra) add(url);
	// realpath：Junction 与真实目录两种写法都要覆盖
	for (const base of [...out]) {
		try {
			add(nodeFs.realpathSync.native(base.slice(0, -1)));
		} catch { /* 目录不存在就算了，字面基址仍然有效 */ }
	}
	return [...out];
}

/** 缓存里属于本包的所有键（大小写与百分号编码都要容错）。 */
export function packageCacheKeys(loadCache, bases) {
	const list = Array.isArray(bases) ? bases : [bases];
	const keys = [];
	if (loadCache === null || loadCache === undefined || typeof loadCache.keys !== "function") return keys;
	for (const key of loadCache.keys()) {
		if (typeof key !== "string") continue;
		const normalized = normPath(key);
		if (list.some((base) => normalized.startsWith(base))) keys.push(key);
	}
	return keys;
}

/**
 * 宿主是否支持安全热重载。
 * 判据和 OFM 一致：loader 得能 import、能 unwrapExports，且缓存里真的有本包的条目
 * —— 缓存里一条都没有说明这个宿主根本不走 loadCache，重载无从谈起。
 */
export function canSafelyHotReload(loader, bases = packageBases()) {
	if (typeof loader?.import !== "function" || typeof loader?.unwrapExports !== "function") return false;
	const cache = loader?.internal?.loadCache;
	return cache !== null && cache !== undefined && typeof cache.keys === "function"
		&& typeof cache.get === "function" && typeof cache.delete === "function"
		&& packageCacheKeys(cache, bases).length > 0;
}

/**
 * 把本包的模块从 ESM loadCache 和 CJS require.cache 里摘出来，返回备份。
 *
 * loadCache 是鸭子类型访问的：Node 24.12+ 把它换成了自己的结构，`instanceof Map`
 * 为假但 keys/get/delete 还在。真的是 Map 时用 Map.prototype 的方法（Node 24 早期
 * 版本的 LoadCache.delete 只清类型槽，不删条目）。
 */
export function purgeCaches(internal, bases) {
	const backup = { esm: new Map(), cjs: new Map() };
	const cache = internal?.loadCache;
	if (cache !== null && cache !== undefined && typeof cache.keys === "function"
		&& typeof cache.get === "function" && typeof cache.delete === "function") {
		const read = (key) => {
			try { return Map.prototype.get.call(cache, key); } catch { try { return cache.get(key); } catch { return undefined; } }
		};
		const drop = (key) => {
			try { Map.prototype.delete.call(cache, key); return; } catch { /* 不是真 Map，走下面 */ }
			try { cache.delete(key); } catch { /* 尽力而为 */ }
		};
		for (const key of packageCacheKeys(cache, bases)) {
			backup.esm.set(key, read(key));
			drop(key);
		}
	}
	// CJS 侧：本包没有 CJS 入口，但换个宿主/换个打包方式就可能出现，留着无害。
	const require = createRequire(import.meta.url);
	for (const key of backup.esm.keys()) {
		try {
			const filePath = fileURLToPath(key);
			if (require.cache[filePath] !== undefined) {
				backup.cjs.set(filePath, require.cache[filePath]);
				delete require.cache[filePath];
			}
		} catch { /* 非 file: URL，CJS 侧无事可做 */ }
	}
	return backup;
}

/** 回滚：把 purge 的备份放回去。 */
export function restoreCaches(internal, backup) {
	const cache = internal?.loadCache;
	for (const [key, job] of backup.esm) {
		try { Map.prototype.set.call(cache, key, job); } catch { try { cache.set(key, job); } catch { /* 尽力而为 */ } }
	}
	const require = createRequire(import.meta.url);
	for (const [filePath, module] of backup.cjs) require.cache[filePath] = module;
}

/**
 * 干跑探针：不动任何东西，只回答「能不能重载，会清掉什么」。
 *
 * 这是维护方 2026-10-31 定的规矩：先看，再动手。也是排查「为什么重载了还是旧代码」
 * 的第一现场 —— 如果 `cacheKeys` 里没有 `src/` 下的条目，就说明基址算错了。
 */
export function probeReload(ctx, options = {}) {
	const entryUrl = options.entryUrl ?? entryUrlOf(options.entryUrlFrom ?? import.meta.url);
	const bases = packageBases(options.entryUrlFrom ?? import.meta.url, options.extraBases ?? []);
	const loader = ctx === null || ctx === undefined ? undefined : ctx.loader;
	const registry = ctx === null || ctx === undefined ? undefined : ctx.registry;
	const cache = loader?.internal?.loadCache;
	const keys = packageCacheKeys(cache, bases);
	return {
		ok: true,
		pkg: PACKAGE_NAME,
		bases,
		entryUrl,
		hasLoader: loader !== undefined && loader !== null,
		hasRegistry: registry !== undefined && registry !== null,
		hasFiber: ctx?.fiber !== undefined && ctx?.fiber !== null,
		hasRuntimeCallback: ctx?.fiber?.runtime?.callback !== undefined && ctx?.fiber?.runtime?.callback !== null,
		importReady: typeof loader?.import === "function",
		unwrapReady: typeof loader?.unwrapExports === "function",
		cacheReadable: cache !== null && cache !== undefined && typeof cache.keys === "function",
		canReload: canSafelyHotReload(loader, bases),
		cacheKeyCount: keys.length,
		cacheKeys: keys.map((k) => { try { return decodeURIComponent(k); } catch { return k; } }).sort(),
		srcKeys: keys.filter((k) => /\/src\//.test(k.replace(/\\/g, "/"))).length,
		rootKeys: keys.filter((k) => !/\/src\//.test(k.replace(/\\/g, "/"))).length,
		lastReload: lastReload(),
	};
}

/**
 * 就地换掉正在跑的插件实例。
 *
 * @param {object} ctx apply() 收到的上下文
 * @param {{logger?:object, entryUrlFrom?:string, extraBases?:string[], expectedVersion?:string}} [options]
 * @returns {Promise<{ok:true, fibers:number} | {ok:false, error:string, restored:boolean, restartRequired?:boolean}>}
 */
export function selfReload(ctx, options = {}) {
	if (inFlight !== null) return inFlight;
	inFlight = (async () => {
		const logger = options.logger ?? console;
		const from = options.entryUrlFrom ?? import.meta.url;
		const bases = packageBases(from, options.extraBases ?? []);
		const entryUrl = options.entryUrl ?? entryUrlOf(from);
		const loader = ctx?.loader;
		const registry = ctx?.registry;
		if (loader === undefined || loader === null || registry === undefined || registry === null) {
			return { ok: false, error: "上下文里没有 loader/registry，这个宿主不支持自热重载", restored: true };
		}
		// 插件身份 = registry 用来索引运行时的那个 exports 对象
		const previous = ctx?.fiber?.runtime?.callback;
		if (previous === undefined || previous === null) {
			return { ok: false, error: "没有可重载的运行时（插件不是按常规方式注册的）", restored: true };
		}
		const runtime = registry.get(previous);
		const fibers = [...(runtime?.fibers ?? [])].map((fiber) => {
			const entry = fiber.entry?.fiber?.uid === fiber.uid ? fiber.entry : undefined;
			const plugin = typeof previous === "function"
				? { apply: previous, inject: { ...fiber.inject }, Config: runtime.Config, name: runtime.name }
				: previous;
			return { fiber, entry, plugin, config: entry === undefined ? fiber._config : entry.options.config };
		});
		if (fibers.length === 0) return { ok: false, error: "运行时里没有活着的 fiber", restored: true };

		const internal = loader.internal;
		const backup = purgeCaches(internal, bases);
		if (backup.esm.size === 0) {
			logger.warn?.("dsh-team: 宿主模块缓存不可用，热重载需要重启宿主");
			return { ok: false, error: "这个宿主不支持安全热重载；请重启宿主以加载已安装的文件", restored: true, restartRequired: true };
		}
		logger.info?.(`dsh-team: 热重载清掉 ${backup.esm.size} 个缓存模块`);

		const importFresh = async (url) => loader.unwrapExports(await loader.import(url, () => []));
		let replacement;
		try {
			replacement = await importFresh(entryUrl);
			if (replacement === undefined || typeof replacement.apply !== "function") throw new Error("重载出来的模块没有 apply()");
			// 宿主把缓存又还回来了（基址算错 / 缓存是另一套）：这是「假成功」，必须说清楚
			if (replacement === previous || replacement.apply === previous
				|| (typeof previous.apply === "function" && replacement.apply === previous.apply)) {
				restoreCaches(internal, backup);
				return { ok: false, error: "清缓存后宿主仍返回旧模块；请重启宿主", restored: true, restartRequired: true };
			}
			if (options.expectedVersion !== undefined && replacement.version !== options.expectedVersion) {
				throw new Error(`版本对不上：期望 ${options.expectedVersion}，拿到 ${String(replacement.version ?? "(缺失)")}`);
			}
		} catch (error) {
			restoreCaches(internal, backup);
			return { ok: false, error: `重新 import 失败，旧代码仍在跑（${String((error && error.message) || error)}）`, restored: true };
		}
		globalThis[LAST_RELOAD] = { at: Date.now(), purged: backup.esm.size, src: backup.esm.size };

		try {
			registry.delete(previous);
			await Promise.all(fibers.map(({ fiber }) => fiber.await()));
		} catch (error) {
			// 旧 fiber 无论如何已经没了；下面照样注册新实例，只把错误记下来
			logger.warn?.(`dsh-team: 热重载销毁旧实例时报错 ${String((error && error.message) || error)}`);
		}

		try {
			const created = [];
			for (const { fiber, entry, config } of fibers) {
				const registered = fiber.parent.registry.plugin(replacement, config);
				const fresh = registered.ctx.fiber;
				if (entry !== undefined) {
					fresh.entry = entry;
					entry.fiber = fresh;
				}
				created.push(fresh);
			}
			await Promise.all(created.map((fiber) => fiber.await()));
			logger.info?.(`dsh-team: 热重载完成，重新注册 ${created.length} 个 fiber`);
			return { ok: true, fibers: created.length };
		} catch (error) {
			// 新代码起不来：缓存和 registry 都回滚到旧版
			restoreCaches(internal, backup);
			try { registry.delete(replacement); } catch { /* 可能根本没起来 */ }
			try {
				const restored = [];
				for (const { fiber, entry, plugin, config } of fibers) {
					const registered = fiber.parent.registry.plugin(plugin, config);
					const fresh = registered.ctx.fiber;
					if (entry !== undefined) {
						fresh.entry = entry;
						entry.fiber = fresh;
					}
					restored.push(fresh);
				}
				await Promise.all(restored.map((fiber) => fiber.await()));
				return { ok: false, error: `新代码启动失败，已恢复旧版（${String((error && error.message) || error)}）`, restored: true };
			} catch (restoreError) {
				return {
					ok: false,
					error: `新代码启动失败（${String((error && error.message) || error)}），回滚也失败（${String((restoreError && restoreError.message) || restoreError)}）`,
					restored: false,
				};
			}
		}
	})();
	return inFlight.finally(() => { inFlight = null; });
}
