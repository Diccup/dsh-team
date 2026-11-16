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
// config — 配置默认值与状态目录
// 从 index.js 的「CONFIG_DEFAULTS / STATE_DIR_DEFAULT」原样搬来（2026-10-31 模块化）。
// 逻辑一行未改：只把顶层 const 换成 export const，让 index.js 与新模块共用同一份。
//
// ★ 2026-11-01 晚：默认值全部改成「按插件自身位置推导」，不再写死实现方这台机器的盘符。
//   原因：这份插件要发给别人用，别人的机器没有 F:\ 盘。原来 8 个路径 + 状态目录全是
//   绝对路径常量，装上去要么启动就炸（状态目录不存在），要么功能静默全空（读不到文件）。
//
//   两种默认值的区别，别混：
//     · 能在**插件安装位置**推出来的（状态目录、成员徽章、OFM 包目录），默认就推 ——
//       装完零改动可用。
//     · 跟**用户自己的工程目录**有关的（工作区根、队伍档案、历史记录位置），推不出来，
//       给一个 .dsh 根下的合理默认保证「不配也不崩」，真要用自己的目录就在 profile 里配
//       （见 INSTALL.md 第 4 节）。
// ---------------------------------------------------------------------------

import * as nodeFs from "node:fs";
import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";

/** 插件自己的安装目录（src/ 的上一级）。注意：不能用 process.cwd() ——
 *  插件是被内核 import 的，cwd 是用户当时的目录，随时会变。 */
export const PKG_DIR = nodePath.dirname(nodePath.dirname(fileURLToPath(import.meta.url)));

/** `.dsh` 根：往上逐级找**名字就叫 `.dsh` 的那一级目录**。
 *  为什么不写死「往上数两级」：插件可能装在 `<dsh>/.dsh/plugins/dsh-team/`（正常安装），
 *  也可能在开发时放在任意工程目录下（比如仓库里）。数级数在两种情况下算出来的完全不同，
 *  而且目录层级一变就失效。往上找目录名是可移动的，也不依赖具体盘符。
 *  找不到（比如开发时仓库不在 .dsh 下）→ 退回「插件的上一级」，仍然是个合法路径，
 *  只是推出来的默认值落在仓库旁边，开发时够用。 */
export const DSH_ROOT = (() => {
	let cur = PKG_DIR;
	for (let i = 0; i < 8; i += 1) {
		if (nodePath.basename(cur) === ".dsh") return cur;
		const up = nodePath.dirname(cur);
		if (up === cur) break; // 到根了
		cur = up;
	}
	return nodePath.dirname(PKG_DIR);
})();

/** 读一个 profile 的三件事实：有没有声明 dsh-team、有没有声明 OFM、
 *  cordis.patch.yml 里能不能看到 allowedModels。
 *  这里只做**存在性判断**，不解析名单（真解析在 src/ledger.js 的 whitelistFromPatch，
 *  那个模块 import 了本文件，反向 import 会成环）。
 *  @param {string} dir profile 目录绝对路径 */
function profileFacts(dir) {
	const out = { dir, name: nodePath.basename(dir), declaresTeam: false, declaresOfm: false, hasAllowedModels: false };
	let pkg = null;
	try { pkg = JSON.parse(nodeFs.readFileSync(nodePath.join(dir, "package.json"), "utf8")); } catch { pkg = null; }
	const deps = pkg === null || pkg === undefined || typeof pkg !== "object"
		? {}
		: Object.assign({}, pkg.dependencies, pkg.devDependencies);
	const teamSpec = typeof deps["dsh-team"] === "string" ? deps["dsh-team"] : "";
	out.declaresTeam = teamSpec !== "";
	out.teamSpec = teamSpec;
	out.declaresOfm = typeof deps["dsh-our-free-model"] === "string" && deps["dsh-our-free-model"] !== "";
	try {
		const y = nodeFs.readFileSync(nodePath.join(dir, "cordis.patch.yml"), "utf8");
		out.hasAllowedModels = /^\s*allowedModels\s*:/m.test(y);
	} catch { /* 没有 patch 文件就是没有 */ }
	return out;
}

/** 探测**当前这台机器上运行的那个 profile 目录**。
 *  ★ 这条是发包踩出来的雷（2026-11-02，维护方报的第 4 条）★
 *  原来 `ofmProfileDir` / `whitelistPatchPath` 把 profile 名**写死成 `desktop`** ——
 *  那是实现方这台机器的名字。别人机器上 profile 叫 web / default / 任何名字，
 *  结果是一整条链断掉：
 *    读不到 cordis.patch.yml → whitelistFromPatch 返回 null →
 *    syncFromKernel 里 `if (wl === null) continue` 一条都不收 →
 *    新装机的「免费台账」是**空的** → 没有可派路由 → 整个插件等于没装。
 *  排序规则（取第一个命中的，全都不满足才退回字面量 desktop）：
 *    ① 声明了 dsh-team 且 patch 里能看到 allowedModels —— 就是本机现在跑的那份
 *    ② 声明了 dsh-team（本插件是被它装起来的，这个信号最硬）
 *    ③ patch 里能看到 allowedModels
 *    ④ 声明了 dsh-our-free-model
 *    ⑤ 都没有 → desktop（保持老行为；读不到就走「白名单未知」分支，不再是「谁都不许」）
 *  @returns {{dir:string,name:string,probed:boolean,why:string}} */
export function probeProfileDir(dshRoot = DSH_ROOT, pkgDir = PKG_DIR) {
	const root = nodePath.join(String(dshRoot || ""), "profiles");
	const fallback = { dir: nodePath.join(root, "desktop"), name: "desktop", probed: false, why: "profiles 目录不存在或没有一个 profile 能对上，退回 desktop" };
	let names = [];
	try {
		names = nodeFs.readdirSync(root, { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => e.name)
			.sort();
	} catch {
		return fallback;
	}
	if (names.length === 0) return fallback;
	const facts = names.map((n) => profileFacts(nodePath.join(root, n)));
	// pkgDir 里那份安装位置也当证据：spec 指向谁的 link/file: 就是谁装的这份插件
	const want = String(pkgDir || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
	const pick = (cond) => {
		const hit = facts.find(cond);
		return hit === undefined ? null : { dir: hit.dir, name: hit.name, probed: true, why: "" };
	};
	return pick((f) => f.declaresTeam && f.hasAllowedModels)
		|| pick((f) => f.declaresTeam && want !== "" && String(f.teamSpec || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase().includes(want))
		|| pick((f) => f.declaresTeam)
		|| pick((f) => f.hasAllowedModels)
		|| pick((f) => f.declaresOfm)
		|| fallback;
}

/** OFM 包目录探测（发包踩雷第 2 条：只按「跟本插件同级」推，装在 node_modules 里的
 *  那种形态永远找不到 → 面板「这台机器上还没装 OFM」→ 永远不自更新）。
 *  三路按序：① `<.dsh>/plugins/dsh-our-free-model`（link 装法，和插件同级）
 *  ② `<profile>/node_modules/dsh-our-free-model`（pnpm / file:vendor 装法）
 *  ③ 都没有 → 还是返回 ①，让调用方的报错说「期望在这儿、实际没有」，比返回空串好查。
 *  @returns {{dir:string,found:boolean,src:string}} */
export function probeOfmPkgDir(dshRoot = DSH_ROOT, pkgDir = PKG_DIR, profileDir = "") {
	const sibling = nodePath.join(nodePath.dirname(pkgDir), "dsh-our-free-model");
	const inNodeModules = profileDir === "" ? "" : nodePath.join(profileDir, "node_modules", "dsh-our-free-model");
	const has = (p) => {
		if (typeof p !== "string" || p === "") return false;
		try { return nodeFs.statSync(nodePath.join(p, "package.json")).isFile(); } catch { return false; }
	};
	if (has(sibling)) return { dir: sibling, found: true, src: "plugins-sibling" };
	if (has(inNodeModules)) return { dir: inNodeModules, found: true, src: "profile-node_modules" };
	return { dir: sibling, found: false, src: "not-found" };
}

/** 默认值。函数形式：每次取都按传进来的位置算（测试里可以把包拷到临时目录再验）。
 *  @param {string} [pkgDir] 插件安装目录
 *  @param {string} [dshRoot] .dsh 根
 *  @param {string|null} [stateDirOverride] 强制指定状态目录（测试/打包用）
 *  @param {string|null} [profileDirOverride] 强制指定 profile 目录（测试用；不给就探测） */
export function defaultPaths(pkgDir = PKG_DIR, dshRoot = DSH_ROOT, stateDirOverride = null, profileDirOverride = null) {
	// ---------------------------------------------------------------------
	// 状态目录
	//
	// ★ 发布版（2026-11-16）：原母本这一行写死本机真库
	//   `F:\workspace\LongMem\LocalPlugins\dsh-team\.state`（那是**本机**的 92 条台账、
	//   板子、名册、437 行报错历史所在，母本必须指它）。
	//   但发出去的这份别人机器上没有 F 盘 → 一启动就去写不存在的盘。
	//   所以发布版改成**跟着安装位置走**，并留两个显式口子：
	//     1) 环境变量 `DSH_TEAM_STATE_DIR`（最高优先）
	//     2) 默认 `<插件安装目录>\.state`（装完零配置可用）
	//   想放别处还可以在 profile 的 cordis.patch.yml 里加 `- id: dsh-team` 覆盖块写 stateDir。
	const stateDir = typeof stateDirOverride === "string" && stateDirOverride !== ""
		? stateDirOverride
		: (String(process.env.DSH_TEAM_STATE_DIR ?? "").trim() !== ""
			? String(process.env.DSH_TEAM_STATE_DIR).trim()
			: nodePath.join(pkgDir, ".state"));
	// profile 目录：探测出来的（本机自然命中 desktop，别人机器命中他自己的名字）。
	// 显式传参优先，给测试和「维护方就想钉某个 profile」留口子。
	const probed = typeof profileDirOverride === "string" && profileDirOverride !== ""
		? { dir: profileDirOverride, name: nodePath.basename(profileDirOverride), probed: true, why: "显式指定" }
		: probeProfileDir(dshRoot, pkgDir);
	const ofmProbe = probeOfmPkgDir(dshRoot, pkgDir, probed.dir);
	return {
		stateDir,
		// ★ 探测结果原样带出去，给面板/status 用 —— 猜错 profile 名的时候，
		//   「为什么台账是空的」必须能一眼看出来，不用翻源码。
		profileDir: probed.dir,
		profileProbed: probed.probed === true,
		profileProbeWhy: probed.why,
		// OFM 包目录：先找同级（link 装法），再找 profile 的 node_modules（pnpm/tgz 装法）。
		// 两处都没有就报同级那个位置（调用方的提示会说「期望在这、实际没有」）。
		ofmPkgDir: ofmProbe.dir,
		ofmPkgDirFound: ofmProbe.found,
		ofmPkgDirSrc: ofmProbe.src,
		ofmDataDir: nodePath.join(dshRoot, "our-free-model"),
		ofmProfileDir: probed.dir,
		availabilityPath: nodePath.join(dshRoot, "our-free-model", "availability.json"),
		whitelistPatchPath: nodePath.join(probed.dir, "cordis.patch.yml"),
		workspaceStatePath: nodePath.join(dshRoot, "storages", "workspace.json"),
		// 下面这几项跟**用户工程**有关，插件推不出来 —— 给一个 .dsh 根下的合理默认，
		// 保证不崩；要用自己的目录就在 profile 里改对应的键。
		workspaceRoot: dshRoot,
		teamDir: nodePath.join(dshRoot, "team"),
		ledgerHistoryPath: nodePath.join(dshRoot, "team", "ledger-history.md"),
		memberBadgePath: nodePath.join(pkgDir, "member-badge.md"),
	};
}

const DEF = defaultPaths();

export const CONFIG_DEFAULTS = {
	// 2026-11-01：pythonExe / scanScript 删了。python 扫描器 2026-10-29 就已退役
	// （scan_free_models.py 随 FreeProviderModels 归档到 Oldversion），剩下的只是两行
	// 配置和一个永远返回 {ok:false} 的子进程壳。新模型的发现只走两条：
	//   syncFromOfm（OFM catalog.json + 探活）/ syncFromKernel（内核 llm listProviders+listModels）
	// 两条都在 src/ledger.js 里，都跟 python 无关。要恢复每日全扫，得先把扫描器本体找回来。
	availabilityPath: DEF.availabilityPath,
	// OFM 版本哨兵用的 profile 根：读 package.json 的声明 + node_modules 的实装版本做对照。
	// pnpm install 永远按声明装，声明钉旧包时任何一次重装都会把实装退回旧版（2026-10-26 就是这么丢的 2.7.2）。
	// ★ 2026-11-02：原来是写死 `profiles\desktop`。那是实现方这台机器的 profile 名，别人机器上
	//   对不上 → 白名单读不到 → 台账空。现在跟 whitelistPatchPath 一起走探测（见 probeProfileDir）。
	ofmProfileDir: DEF.ofmProfileDir,
	// 探测用的 profile 目录本身 + 探测说明（诊断用：猜错名字时面板/status 要能说清为什么）。
	profileDir: DEF.profileDir,
	profileProbed: DEF.profileProbed,
	profileProbeWhy: DEF.profileProbeWhy,
	// 2026-11-01 晚：OFM 自动升级用的那两个目录原来是 index.js 里的字面量常量
	// （`C:\Users\Diccup\.dsh\plugins\dsh-our-free-model`），config 覆盖不了。
	// 现在提到这里来，跟其它路径一样可配。
	ofmPkgDir: DEF.ofmPkgDir,
	// 探测命中没有 / 命中在哪一路（"plugins-sibling" | "profile-node_modules" | "not-found"）。
	// 给 autoUpdateOfm 的提示用：没找到时要说清找过哪两个位置。
	ofmPkgDirFound: DEF.ofmPkgDirFound,
	ofmPkgDirSrc: DEF.ofmPkgDirSrc,
	ofmDataDir: DEF.ofmDataDir,
	// 2026-10-29 设计确定：台账真源 = .state/ledger.json，面板是唯一查看口。
	// md 归档在 F:\workspace\LongMem\FreeProviderModels 当历史，插件不再读它、也不再写它。
	// 要恢复「和 md 同步」就填回路径：F:\\workspace\\LongMem\\FreeProviderModels\\DSH免费模型当前额度台账.md
	ledgerMdPath: null,
	// 2026-10-29 维护方提问「历史记录为什么不能新建一个 MD」——能。台账 md 退役了，但历史记录继续写，
	// 换个新文件、由插件自己追加（真派结果 / 实测下界 / OFM 增删 / 探活翻转），人可读，不是数据源。
	ledgerHistoryPath: DEF.ledgerHistoryPath,
	// 白名单来源：名单里有的 = 放行，没有的 = 白名单未开（改配置即可，非模型失效）。
	whitelistPatchPath: DEF.whitelistPatchPath,
	// 2026-10-29 设计确定：归档的对话不算队长。GUI 归档只在内核 storages/workspace.json 的
	// global.archivedSessionIds 里留痕，插件读它把归档会话从队长集里剔掉。
	workspaceStatePath: DEF.workspaceStatePath,
	ledgerPath: null,
	// 成员的写根必须落在这个「工作区根」里面，越界会被拒（成员 cwd 就是它的
	// workspace-write 边界）。**搬家必改** —— 它跟用户的工程放哪有关，插件推不出来。
	// 以前这个常量焊死在 src/workdir.js 里，接手的人得翻源码才找得到；2026-11-01 晚
	// 又发现默认值本身也写死了实现方的盘符，一并改成可配。
	workspaceRoot: DEF.workspaceRoot,
	teamDir: DEF.teamDir,
	runsDir: null, // default: <teamDir>\runs — per-team / per-member write roots
	detectWorkspace: true, // record whether a member's write root sits outside the workspace root
	memberBadgePath: DEF.memberBadgePath,
	suppressAgentsMd: true,
	// 状态目录（台账/名册/板子/报错账/锁表/信箱/通知全在这一个目录里）。
	// 2026-11-01 晚：原来是模块级常量 STATE_DIR_DEFAULT，只有 config.js 自己能改，
	// 别人装上去必须手改源码。现在进 CONFIG_DEFAULTS，profile 里写 stateDir 就能覆盖。
	stateDir: DEF.stateDir,
	maxConcurrent: 8,
	maxPerRoute: 1, // same provider, different models: allowed in parallel
	maxPerProvider: null, // deprecated alias, kept for old configs
	// silent-hang watch: the kernel aborts a stream after streamIdleTimeoutMs
	// (default 300s) and auto-retries the same route up to 5 times, so a hung
	// model looks like "running with zero output" for ~25 min. Warn before that.
	stallNoticeSec: 120,
	stallEscalateSec: 900,
	// #11: how long a rejected gear stays rejected. A/B evidence (downshift then a
	// clean run at the lower gear) writes the ceiling; after the TTL it may retry.
	effortCapTtlHours: 24,
	// 文件占用表（维护方 2026-10-30 定）：同一文件同时只允许一个成员改，其余排队，
	// 放锁后**只通知队首**。持有超过这个秒数没有成功的写入心跳 = 成员可能崩了，
	// 插件自动释放并把原因留在表里（谁接手都看得见）。
	lockStaleSeconds: 600,
	// 压缩发生时的提醒（维护方 2026-10-30 定稿）：
	//   「只需要在压缩发生的时候提醒，你的上下文内容被压缩，最终产出不可仅凭记忆。
	//     如果全程不出现压缩，压根都不要提醒」
	// 所以这里没有任何占用率阈值 —— 不预测、不扫描、不猜压缩线。
	// 只在 kernel 真的写入 `compaction/end` 事件那一刻发一次话；没压缩就一直静默。
	compactNoticeMinGapMs: 600000, // 同一成员10分钟内最多提醒一次（连压两次也只说一次）
	autoClaim: true,
	// 自动伸缩（设计确定：上线 8 人；空闲回收=从名册移除，不是只打断）
	maxMembers: 8,
	autoRecycle: true,
	recycleIdleSec: 600,
	recycleManual: false, // 只回收插件自动补的成员；手动 spawn 的一律不碰
	// D2 step 2: 有 open 活、队里没人空闲、又没到 maxMembers 时，插件自己补一个临时工
	autoFill: true,
	autoFillCooldownSec: 30,
	// 2026-11-02 设计确定：（「每次起一个成员都是新调用一个子智能体，完全没有复用」）：
	// 退役成员（回收/换路由/移除）的**子会话**进「成员池」，补员挑到同队同路由的旧人
	// 就先唤醒复用（内核 coldResume 从盘上原样拉起，persona/路由都还原），
	// 唤醒失败才新起。队长 kill remove / disband 明确不要的人不进池。
	// 池是纯登记簿，只记不删会话；上限条数按最近退役淘汰。0 = 关复用。
	memberPoolMax: 24,
	// 2026-11-02 禁用名单（设计确定：「判断一个成员已经混乱的前提下，禁用这个成员，新开一个」）：
	// 队长判产出混乱 → ban 拉黑那个子会话（永不复用）。内核没有真清空上下文的原语，
	// /compact 会把混乱摘进摘要继续带毒，retool 同会话换模型也是带毒上岗 —— 只有
	// 「禁用+新起」这一条干净路。上限条数最久先淘汰；只影响插件侧闸门，不动内核会话。
	banListMax: 50,
	// 输出撞顶自动续写（维护方 2026-11-01 定）：GUI 写着「发送“继续”可让模型接着输出」，
	// 可没人会替它发 —— 队长撞顶干等维护方手敲，成员撞顶被插件直接退单，上半截产出挂在那儿。
	// 插件自己认得 turn/end.reason.kind === "max-tokens"，于是隔几秒给同一个会话发一次「继续」。
	autoContinue: true,
	autoContinueDelaySec: 10,
	autoContinueMaxRuns: 3, // 同一会话连续撞顶的续写上限，用尽就收手并交给队长
	// D2 step 3: 战绩账本。只记账、不参与选路（scoreWeighted 默认关），
	// 等某个「路由@档位 × kind」攒够样本再谈权重。聚合存储，不记流水。
	scoreRecord: true,
	scoreWeighted: false,
	scoreHalfLifeDays: 14,
	scoreMaxKeys: 1500,
	// 2026-10-31 验收门（采纳隔壁 c197654c 建议，实现由实现方定）：finish → delivered 待验收，
	// 队长 accept 才 done 并解锁下游。插件只能验"文件在不在"，验不了"内容真不真"，
	// 空心交付全靠这一关。设 false 回到老行为（finish 即 done）。
	acceptGate: true,
	// 2026-11-01：rescanDailyHour 删了（每日 python 扫描早就退役，那个钟点没人读）。
	// 想改发现节奏就改 reprobeEveryMinutes —— 它才是现在唯一在跑的定时器。
	reprobeEveryMinutes: 15,
	renderLedger: false,
};

/** 状态目录的可变句柄。**必须在 apply 开头调一次 setStateDir(cfg.stateDir)**，之后所有
 *  模块读到的是同一个引用。为什么用可变引用而不是各模块自己算：
 *  locks / notify / mailbox / announce / errbook / lederr / ledger / accounting 这 8 个模块
 *  在**模块加载那一刻**就用它拼好了路径（`const noticesPath = join(STATE_DIR_DEFAULT, ...)`），
 *  mailbox / notify 还立刻把文件读进了内存。那种写法在 import 阶段就定型，纯传参注入只能
 *  改一部分。导出一个可变对象，8 个模块 import 到的是同一个引用，apply 里改一次全体生效。 */
export const stateCtx = { dir: DEF.stateDir };

/** apply 开头调用：定下这次运行的状态目录，并返回它。幂等。 */
export function setStateDir(dir) {
	const raw = dir === undefined || dir === null ? "" : String(dir).trim();
	stateCtx.dir = raw === "" ? DEF.stateDir : raw;
	return stateCtx.dir;
}

/** **当前**状态目录。所有模块拼路径都必须走这个函数 ——
 *  不要再用 `STATE_DIR_DEFAULT`（那是常量，等于「默认值」，不跟着 apply 走）。
 *  返回真字符串，可以直接喂 path.join（导出一个对象代理是行不通的：path.join 只认
 *  `typeof === "string"`，会抛 "The path argument must be of type string"）。 */
export function stateDirPath() {
	return stateCtx.dir;
}

/** 默认状态目录（常量形式，保留给「拿默认值跟当前值作比较」这种用途）。
 *  **拼路径请用 stateDirPath()**，否则自定义 stateDir 时拼出来还是默认路径。 */
export const STATE_DIR_DEFAULT = DEF.stateDir;

export { DEF as DEFAULT_PATHS };
