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
// dsh-team — browser half. A right-sidebar tab rendering the team goal,
// task flow, live roster, and free-model ledger from /api/dsh-team/snapshot.
// No separate task-history block: it duplicated the goal card with less info.
// Zero context tax: this data never passes through the model.
window.__ModuleLoader__.load({
	id: "dsh-team",
	factory(require) {
		const React = require("react");
		// 2026-11-16 L23：协作任务改版后悬浮窗退役，react-dom 与 useRef 零引用，删（防死代码）。
		const { createElement: h, Fragment, useEffect, useState, useCallback } = React;

		const API = "/api/dsh-team/snapshot";
		const id = "dsh-team";
		const COLLAPSE_N = 1;
		// 2026-10-29 设计确定：免费模型台账折叠时显示 3 条（其余折叠区原本只露 1 条，看不到全貌）
		const LEDGER_COLLAPSE_N = 3;

		// ---- design language: host theme tokens only (light/dark automatic) ----
		const T = {
			bg2: "var(--dsw-alias-bg-layer-2)",
			bg3: "var(--dsw-alias-bg-layer-3)",
			border: "var(--dsw-alias-border-l1)",
			border2: "var(--dsw-alias-border-l2)",
			label: "var(--dsw-alias-label-primary)",
			label2: "var(--dsw-alias-label-secondary)",
			label3: "var(--dsw-alias-label-tertiary)",
			ok: "var(--dsw-alias-state-success-primary, var(--dsw-alias-state-business-primary))",
			warn: "var(--dsw-alias-state-warning-primary)",
			err: "var(--dsw-alias-state-error-primary)",
			biz: "var(--dsw-alias-state-business-primary)",
			viz: "var(--dsw-alias-state-visual-primary, var(--dsw-alias-state-business-primary))",
		};
		const HUES = [T.biz, T.viz, T.ok, T.warn, T.err, "var(--dsw-alias-state-business-secondary, var(--dsw-alias-state-business-primary))"];
		const card = { background: T.bg2, borderRadius: 10, border: "1px solid " + T.border, boxShadow: "var(--dsw-elevation-stroke)" };
		const chip = { padding: "1px 7px", borderRadius: 999, background: T.bg3, color: T.label2, fontSize: 11, lineHeight: "18px", whiteSpace: "nowrap", flex: "none" };
		const mono = { fontFamily: "ui-monospace, var(--dsw-font-mono, monospace)", fontSize: 11 };
		const ell = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 };
		const tint = (color, pct) => "color-mix(in srgb, " + color + " " + pct + "%, transparent)";
		// 2026-10-29 说明：「nvidia/nemotron-3.5-super-vl:free 和 cline-free/nemotron-3.5-super-vl
		// 好难分辨」。同名模型散在不同池子里是常态，所以给主要池子各钉一个色调：
		// 紫=OFM（聚合了 nvidia/z-ai/kilo 等多家）、绿=raccoon、黄=cline、蓝=qodercn，其余灰。
		// 用**写死的色值**，不挂主题变量：主题里 `--dsw-alias-state-warning-primary` 一旦没定义，
		// color-mix 整条失效、background 静默回退成灰底，维护方就会看到「cline 没黄」。
		// 2026-10-29 补充说明：「底色变没事，字体还是用高亮白色啊，要不紫色的太难看清了」——
		// 所以 chip 是**实色底 + 白字**，色值取 700 级深色（黄/绿原色压白字对比度不够：
		// #f59e0b 上白字只有 2.1:1）。现在紫 7.0 / 绿 5.9 / 黄 4.9 / 蓝 6.9，都过 AA。
		const PTONE = { "our-free-model": "#6d28d9", raccoon: "#047857", cline: "#b45309", qodercn: "#1d4ed8" };
		// status color, not identity color: 绿=完成 红=失败 黄=过程中(待领/进行/悬挂).
		// A blue "失败" chip was unreadable and conveyed nothing; status is what people scan for.
		const taskHue = (task) => (task.stale ? T.warn : task.status === "done" ? T.ok : task.status === "failed" ? T.err : T.warn);

		const dur = (ms) => {
			if (ms == null) return "";
			const s = Math.max(0, Math.round(ms / 1000));
			if (s < 60) return s + "s";
			if (s < 3600) return Math.floor(s / 60) + "m" + (s % 60 ? " " + (s % 60) + "s" : "");
			return Math.floor(s / 3600) + "h" + Math.floor((s % 3600) / 60) + "m";
		};

		function useSnapshot(lead) {
			const [snap, setSnap] = useState(null);
			const [failed, setFailed] = useState(false);
			const target = lead ? API + "?lead=" + encodeURIComponent(lead) : API;
			const load = useCallback(async () => {
				try {
					const res = await fetch(target, { cache: "no-store" });
					if (!res.ok) throw new Error(String(res.status));
					setSnap(await res.json());
					setFailed(false);
				} catch {
					setFailed(true);
				}
			}, [target]);
			useEffect(() => {
				void load();
				const timer = setInterval(() => void load(), 2500);
				return () => clearInterval(timer);
			}, [load]);
			return { snap, failed, reload: load };
		}

		function useTick() {
			const [now, setNow] = useState(() => Date.now());
			useEffect(() => {
				const timer = setInterval(() => setNow(Date.now()), 1000);
				return () => clearInterval(timer);
			}, []);
			return now;
		}

		/** 语义版本比较：>0 = a 比 b 新。只比前三位，够用了。 */
		function cmpVer(a, b) {
			const pa = String(a == null ? "" : a).split(".").map((x) => Number(x) || 0);
			const pb = String(b == null ? "" : b).split(".").map((x) => Number(x) || 0);
			for (let i = 0; i < 3; i += 1) {
				const x = pa[i] === undefined ? 0 : pa[i];
				const y = pb[i] === undefined ? 0 : pb[i];
				if (x !== y) return x - y;
			}
			return 0;
		}

		/** 退避倒计时：从"到点时刻"算出人话。超过 1 天写成 "1天3小时"，
		 * 到了 0 就返回 null（行会自己变回可用，不用等下一次快照）。 */
		function countdown(until, now) {
			const left = Number(until) - (now || Date.now());
			if (!Number.isFinite(left) || left <= 0) return null;
			const s = Math.floor(left / 1000);
			const d = Math.floor(s / 86400);
			const hh = Math.floor((s % 86400) / 3600);
			const mm = Math.floor((s % 3600) / 60);
			const ss = s % 60;
			if (d > 0) return d + "天" + hh + "小时";
			if (hh > 0) return hh + "小时" + mm + "分";
			if (mm > 0) return mm + "分" + String(ss).padStart(2, "0") + "秒";
			return ss + "秒";
		}

		const Icon = ({ d, size, style }) => h("svg", { viewBox: "0 0 24 24", width: size || 14, height: size || 14, fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round", style, "aria-hidden": true },
			...d.map((seg, i) => h("path", { key: i, d: seg })));
		const ICONS = {
			user: ["M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z", "M4 20c1.5-3.5 4.5-5 8-5s6.5 1.5 8 5"],
			warn: ["M12 3 2 21h20L12 3Z", "M12 10v5", "M12 18.5v.5"],
			check: ["M4 12.5 9.5 18 20 6.5"],
			clock: ["M12 7v5l3 3", "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z"],
		};

		function Dot({ tone, pulse }) {
			return h("span", {
				"aria-hidden": true,
				style: {
					width: 8, height: 8, borderRadius: 99, flex: "none", display: "inline-block",
					background: tone === "ok" ? T.ok : tone === "warn" ? T.warn : tone === "err" ? T.err : tone === "biz" ? T.biz : T.label3,
					animation: pulse ? "dsht-pulse 1.6s ease-in-out infinite" : undefined,
				},
			});
		}

		function Avatar({ name, active }) {
			const hue = HUES[[...String(name)].reduce((a, c) => a + c.charCodeAt(0), 0) % HUES.length];
			return h("span", {
				"aria-hidden": true,
				style: {
					width: 26, height: 26, borderRadius: 99, flex: "none", display: "inline-flex", alignItems: "center", justifyContent: "center",
					background: tint(hue, 16), color: hue, border: "1.5px solid " + (active ? hue : tint(hue, 45)),
					boxShadow: active ? "0 0 0 3px " + tint(hue, 18) : undefined, transition: "box-shadow .3s, border-color .3s",
				},
			}, h(Icon, { d: ICONS.user, size: 14 }));
		}

		// ---- 总目标+任务流 = 一组：折叠只收任务流列表，其余区独立 ----
		// 目标文本点一下切全文（窄面板里单行省略会看不全）；"展开全部 N 步"只管任务流。
		function GoalCard({ goal, flow, expanded, onToggle, members }) {
			const [full, setFull] = useState(false);
			if (goal === undefined || goal === null) return null;
			const shown = expanded ? flow : flow.slice(0, 1);
			const pct = goal.total > 0 ? Math.round((goal.done / goal.total) * 100) : 0;
			return h("div", { style: { ...card, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 6, borderColor: "color-mix(in srgb, " + T.biz + " 35%, " + T.border + ")" } },
				h("div", { style: { display: "flex", alignItems: "flex-start", gap: 8 } },
					h(Dot, { tone: goal.done === goal.total && goal.total > 0 ? "ok" : "biz", pulse: goal.done < goal.total }),
					h("span", { style: { fontSize: 11, color: T.label3, flex: "none", lineHeight: "18px" } }, goal.explicit ? "总目标" : "会话标题"),
					h("strong", {
						onClick: () => setFull((v) => !v),
						title: full ? "点一下收起到一行" : "点一下看全文",
						style: {
							fontSize: 13, color: T.label, flex: 1, minWidth: 0, cursor: "pointer", fontWeight: full ? 400 : 600,
							...(full
								? { whiteSpace: "pre-wrap", wordBreak: "break-word", lineHeight: "19px" }
								: { overflow: "hidden", display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: 2, whiteSpace: "normal", wordBreak: "break-word", minWidth: 0, lineHeight: "19px" }),
						},
					}, goal.text || "（未命名队伍）"),
					h("button", {
						type: "button",
						style: { border: 0, background: "transparent", color: T.biz, cursor: "pointer", fontSize: 11, padding: 0, flex: "none", lineHeight: "18px" },
						onClick: onToggle,
					}, flow.length > 1 ? (expanded ? "收起任务流 ▴" : "展开全部 " + flow.length + " 步 ▾") : null),
				),
				h("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
					h("div", { style: { flex: 1, height: 4, borderRadius: 2, background: T.bg3, overflow: "hidden" } },
						h("div", { style: { height: "100%", width: pct + "%", background: "linear-gradient(90deg, " + T.biz + ", " + T.ok + ")", transition: "width .5s" } }),
					),
					h("span", { style: { fontSize: 11, color: T.label2, fontVariantNumeric: "tabular-nums", flex: "none" } }, goal.done + "/" + goal.total + " 步 · " + pct + "%"),
					h("span", { style: { ...chip, flex: "none" } }, "成员 " + goal.members),
				),
				flow.length === 0 ? null : h("div", { style: { display: "flex", flexDirection: "column", gap: 6, marginTop: 2 } },
					shown.map((task) => h(TaskCard, { key: task.tid, task, members })),
				),
			);
		}

		function Section({ title, extra, children, expanded, onToggle, count, hint, action }) {
			return h("section", {},
				h("div", { style: { display: "flex", alignItems: "center", gap: 8, margin: "0 2px 6px" } },
					h("span", { style: { fontSize: 12, fontWeight: 600, color: T.label2, letterSpacing: "0.02em", cursor: hint ? "help" : undefined }, title: hint || undefined }, title),
					extra ? h("span", { style: { fontSize: 11, color: T.label3 } }, extra) : null,
					h("span", { style: { marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 8 } },
						count > COLLAPSE_N ? h("button", {
							type: "button",
							style: { border: 0, background: "transparent", color: T.biz, cursor: "pointer", fontSize: 11, padding: 0 },
							onClick: onToggle,
						}, expanded ? "收起 ▴" : "展开全部 " + count + " ▾") : null,
						action,
					),
				),
				children,
			);
		}

		const STATUS_TONE = { running: "ok", idle: "biz", cold: "muted" };
		const STATUS_LABEL = { running: "运行中", idle: "空闲", cold: "休眠" };

		function MemberRow({ m }) {
			const tone = STATUS_TONE[m.status] || "muted";
			const tip = [
				"路由 " + (m.actual || m.want),
				m.want && m.actual !== m.want ? "目标 " + m.want : null,
				m.lastEvent ? "最后事件 " + m.lastEvent + (m.lastEventAgo != null ? "（" + m.lastEventAgo + "s 前）" : "") : null,
				m.status === "running" && m.streamAgo != null ? (m.runningTool ? "正在执行工具（无流属正常）" : m.streamAgo <= 5 ? "模型出流中" : "流停 " + m.streamAgo + "s") : null,
				m.lastError ? "最近报错 " + m.lastError : null,
				m.spawnedAt != null ? "已存活 " + dur(Date.now() - m.spawnedAt) : null,
			].filter(Boolean).join("\n");
			return h("div", { style: { ...card, display: "flex", alignItems: "center", gap: 8, padding: "6px 10px" }, title: tip },
				h(Avatar, { name: m.name, active: m.status === "running" }),
				h("strong", { style: { fontSize: 12.5, color: T.label, flex: "none" } }, m.name),
				h(Dot, { tone, pulse: m.status === "running" }),
				h("span", { style: { ...chip, ...(tone === "ok" ? { background: tint(T.ok, 14), color: T.ok } : {}) } }, STATUS_LABEL[m.status] || m.status),
				m.task ? h("span", { style: { ...chip, background: tint(T.biz, 16), color: T.biz } }, m.task) : null,
				h("span", { style: { ...chip, ...mono, ...ell, maxWidth: 220 } }, m.actual || m.want),
				h("span", { style: { flex: 1, display: "inline-flex", gap: 4, alignItems: "center", fontSize: 11, color: T.label2, ...ell } },
					m.lastEvent ? h(Fragment, {},
						h("span", { style: { color: T.label3 } }, "⚡"),
						h("span", { style: mono }, m.lastEvent),
						m.lastEventAgo != null ? h("span", { style: { color: T.label3 } }, m.lastEventAgo + "s前") : null,
					) : h("span", { style: { color: T.label3 } }, "无事件"),
					m.status === "running" && m.streamAgo != null && !m.runningTool
						? h("span", { style: { color: m.streamAgo <= 5 ? T.ok : T.warn, flex: "none" } }, m.streamAgo <= 5 ? "·出流" : "·流停" + m.streamAgo + "s")
						: null,
				),
				m.lastError ? h("span", { style: { fontSize: 11, color: T.err, flex: "none" } }, "✕") : null,
				m.stuck ? h("span", { style: { ...chip, background: tint(T.warn, 18), color: T.warn, flex: "none" } }, String(m.stuck).length > 26 ? String(m.stuck).slice(0, 26) + "…" : m.stuck) : null,
			);
		}

		const TASK_LABEL = { open: "待领", claimed: "进行", delivered: "待验收", done: "完成", failed: "失败" };

		// "@demo" alone says nothing about WHAT is doing the work. Show its route too, and
		// flag owners that are not real members (a pre-assigned placeholder name).
		const routeShort = (route) => {
			const s = String(route || "");
			const at = s.lastIndexOf("@");
			const base = at >= 0 ? s.slice(0, at) : s;
			const gear = at >= 0 ? s.slice(at) : "";
			const parts = base.split("/");
			return (parts.length > 1 ? parts.slice(1).join("/") : base) + gear;
		};
		const ownerBadge = (task, members) => {
			if (!task.owner) return null;
			const list = Array.isArray(members) ? members : [];
			const ow = list.find((m) => m.name === task.owner);
			if (ow === undefined) return "@" + task.owner + "（非成员）";
			const route = ow.actual && ow.actual !== "?" ? ow.actual : ow.want;
			return "@" + task.owner + (route ? " · " + routeShort(route) : "");
		};

		const demandMark = (task) => {
			const raw = task.demand == null || String(task.demand).trim() === "" ? "2" : String(task.demand).trim();
			return String(raw).toLowerCase() === "max" ? "max" : "d" + raw.replace(/\+/g, "+");
		};
		const taskMarks = (task) => (task.kind || "grunt") + " / " + (task.size || "m") + " / " + demandMark(task) + (task.vision === true ? " / 👁" : "");

		function TaskCard({ task, members }) {
			const hue = taskHue(task);
			const elapsed = task.status === "claimed" && task.claimedAt != null ? dur(Date.now() - task.claimedAt) : null;
			const sinceDone = task.finishedAt != null ? dur(Date.now() - task.finishedAt) : null;
			return h("div", { style: { ...card, padding: "8px 10px", borderLeft: "3px solid " + hue, display: "flex", flexDirection: "column", gap: 4 } },
				// 标题独占一行（2026-11-16 截图评审抓出：状态/类型/Owner 三枚 flex:none 的 chip 和标题挤
				// 同一行，标题被压成 0 宽整个消失）。chip 挪到第二行换行区，标题永远可见。
				h("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
					h("span", { style: { width: 10, height: 10, borderRadius: 99, flex: "none", background: hue, boxShadow: "0 0 0 3px " + tint(hue, 22) } }),
					h("span", { style: { ...ell, flex: "1 1 auto", fontSize: 12.5, color: T.label, fontWeight: 500 } }, task.tid + " · " + task.title),
					h("span", { style: { ...chip, background: tint(hue, 14), color: hue, flex: "none" } }, task.stale ? "悬挂" : TASK_LABEL[task.status] || task.status),
				),
				h("div", { style: { display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: T.label3, flexWrap: "wrap" } },
					h("span", { style: { ...chip, flex: "none", ...mono, color: T.label2 }, title: "kind / size / demand：派活按这三个选路由与档位" }, taskMarks(task)),
					task.owner ? h("span", { style: { ...chip, flex: "0 1 auto", maxWidth: 170, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, ownerBadge(task, members)) : null,
					task.blockedBy && task.blockedBy.length > 0 ? h("span", { style: { ...chip, background: tint(T.warn, 16), color: T.warn, flex: "none" }, title: "上游：这些单没结之前不派" }, "⛓ " + task.blockedBy.join(",")) : null,
					task.blocks && task.blocks.length > 0 ? h("span", { style: { ...chip, background: tint(T.label3, 14), color: T.label3, flex: "none" }, title: "下游：本单结掉后才轮得到这些" }, "→ " + task.blocks.join(",")) : null,
					task.artifacts && task.artifacts.length > 0 ? h("span", { style: { ...chip, flex: "none", ...mono, color: T.label2 }, title: "本单必须落盘（finish 核对存在+mtime）：\n" + task.artifacts.join("\n") }, "落盘 " + task.artifacts.length) : null,
					elapsed != null ? h("span", { style: { display: "inline-flex", gap: 3, alignItems: "center" } }, h(Icon, { d: ICONS.clock, size: 11 }), "进行 " + elapsed) : null,
					sinceDone != null ? h("span", { style: { display: "inline-flex", gap: 3, alignItems: "center", color: task.status === "failed" ? T.err : T.label3 } }, h(Icon, { d: task.status === "failed" ? ICONS.warn : ICONS.check, size: 11 }), (task.status === "failed" ? "失败于 " : "完成于 ") + sinceDone + "前") : null,
					h("span", {}, "p" + task.prio),
					// 派发时间常驻（L23 起看板收起态省行的 compact 退役：列表自己管高度，卡片不再分两档）
					task.createdAt != null ? h("span", { title: new Date(task.createdAt).toLocaleString() }, "派发 " + new Date(task.createdAt).toLocaleTimeString()) : null,
				),
				task.lastReport ? h("div", { style: { fontSize: 11, color: T.label2, ...ell }, title: task.lastReport }, "最新回报 ", h("i", {}, task.lastReport)) : null,
			);
		}

		/** 2026-11-01（拆 OFM）：这条路由干一个 1000 token 的活预计多少秒。
		 *  和后端 `ofmstats.ofmEtaSeconds` 同一把尺子（面板是浏览器端，不能 import src）。
		 *  首字 + 解码两段合起来才是「多久」，只比 tok/s 会选出慢开局的路由：
		 *  真机 z-ai/glm-5.3 是 360 次错 7.2% 的**最稳**路由，却要 93 秒；
		 *  reflection/beam-free 同样稳、只要 9 秒。只写 tok/s 看不出这个差。 */
		function etaOf(ofm) {
			if (!ofm || typeof ofm !== "object") return null;
			if (Number(ofm.calls) < 3) return null;
			const tps = typeof ofm.tps === "number" ? ofm.tps : null;
			if (tps === null || tps <= 0) return null;
			const ttft = typeof ofm.ttftMs === "number" ? Math.max(0, ofm.ttftMs) : 0;
			return Math.round((ttft / 1000 + 1000 / tps) * 10) / 10;
		}

		/** 2026-11-01（拆 OFM）：台账行上的**实测**徽标。
		 *  数据来自 OFM 自己记的 stats.json（后端 annotateOfmLedger 挂到 entry.ofm 上）。
		 *  **绝不改绿点**：历史失败率不是可用性开关（QODER 只排除不恢复的坑）。
		 *
		 *  两次改，都是设计确定：的：
		 *  第一次：「这些（OFM 稳 343次·错3.8%·153tok/s·约9.1s）不要这么长，看不到模型名字了都，
		 *          改成：稳或者不稳，就行了，然后鼠标放上去可以看到」。
		 *  第二次（本版）：「稳跟可用是不是可以合并？不稳得可用直接显示不稳？」
		 *
		 *  所以最终只剩一件事要画：**「可用但不稳」这个矛盾**。
		 *    · solid  → 什么都不画。左边的绿点已经说了「可用」，OFM 也说稳，再写一个「稳」
		 *               是把同一句话说两遍，白占宽度。
		 *    · watch/bad → 画「不稳」。这是绿点**说不出来**的那层信息 —— 现在能用，
		 *               但历史战绩不好，派大活之前该掂量。矛盾才有资格占版面。
		 *  完整读数（次数/失败率/tok/s/约 Ns）走悬停，挂在模型名上，稳的也能看到。 */
		function ofmDetailText(ofm) {
			if (!ofm || typeof ofm !== "object") return null;
			const calls = Number(ofm.calls) || 0;
			if (calls < 3) return null;
			const rate = typeof ofm.failRate === "number" ? ofm.failRate : null;
			const tps = typeof ofm.tps === "number" ? ofm.tps : null;
			const ttft = typeof ofm.ttftMs === "number" ? ofm.ttftMs : null;
			const solid = ofm.state === "solid";
			const eta = etaOf(ofm);
			const bits = [calls + "次"];
			if (rate !== null) bits.push("错" + Math.round(rate * 1000) / 10 + "%");
			if (tps !== null) bits.push(tps + "tok/s");
			if (eta !== null) bits.push("约" + eta + "s");
			const head = "OFM " + (solid ? "稳" : "不稳") + " " + calls + "次"
				+ (rate !== null ? "·错" + Math.round(rate * 1000) / 10 + "%" : "")
				+ (tps !== null ? "·" + tps + "tok/s" : "")
				+ (eta !== null ? "·约" + eta + "s" : "");
			return "\n\n【OFM 实测】" + head + "（" + bits.join("·") + "）"
				+ "\n判档 " + (ofm.state === "solid" ? "稳 solid" : ofm.state === "watch" ? "留意 watch" : "差 bad")
				+ "｜物理请求 " + calls + " 次，失败 " + (Number(ofm.failed) || 0) + " 次"
				+ (rate !== null ? "（失败率 " + (Math.round(rate * 1000) / 10) + "%）" : "")
				+ (tps !== null ? "\n解码速度 " + tps + " tok/s" : "")
				+ (ttft !== null ? "\n首字延迟 " + (Math.round(ttft / 100) / 10) + " 秒" : "")
				+ (eta !== null ? "\n预计干一个 1000 token 的活约 " + eta + " 秒（首字 + 解码）—— 同档里按这个排先后的依据" : "")
				+ (Number(ofm.recoveredTurns) > 0 ? "\n重试救回 " + Number(ofm.recoveredTurns) + " 回合（失败但重试成功，不当纯失败看）" : "")
				+ (ofm.lastSeen ? "\n最近记录 " + String(ofm.lastSeen) : "")
				+ "\n\n**这只是历史表现，不是可用性开关**：模型可能昨天坏今天修好，"
				+ "所以它只影响派单排序（稳的优先、同档里快的优先、差的排后），从不把这条从候选里删掉。";
		}

		/** 这一行**唯一**的结论词。六档：队长 / 成员 / 推荐 / 可用 / 未测 / 不稳。
		 *
		 *  2026-11-01 维护方一路把它逼到实处：
		 *    「所有得都要有统计，要标签是可变得」
		 *    「这两个标签就应该是实际探测结果跟使用结果得结论」
		 *    「不是，为啥要编？OFM给了一堆，我们自己也统计了一堆，这么多数据不够？」
		 *
		 *  所以判据**一个数字都不许自己编**，只用两个现成的实测源：
		 *
		 *   ① OFM 的 `state` —— 它拿自己的样本算好的判档，阈值是它定的（3 次起算、
		 *      15% 进 watch、35% 进 bad）。TEAM 只读不重算。
		 *        solid → 长期跑出来的稳
		 *        watch/bad → 有问题的证据
		 *        thin  → 有记录但样本不够下结论
		 *        none  → 一条记录都没有
		 *
		 *   ② TEAM 自己的真派记录（`realResult` / `realAt` / `truncatedAt`）——
		 *      TEAM 实际派过、实际跑成的结果，不是推测。
		 *
		 *  OFM 有结论就听 OFM 的（它是几十上百次样本），OFM 没结论才退回 TEAM 的真派记录。
		 *  这就是维护方说明的「探测结果 + 使用结果」——两个都是实测，不需要第三个。
		 *
		 *  这修掉了之前的三处「编」：
		 *    · 编了 `calls ≥ 30` —— OFM 自己从 3 次起算，且用 15% 而不是 10% 划档；
		 *    · 编了 `failRate ≤ 10%` —— 那是 OFM_RATE_SOLID(15%) 的活；
		 *    · 编了 `24 小时` 的 realResult 窗口 —— 真派记录本来就是"最近一次"，
		 *      过期与否该看 OFM 每天在变的数据，不该再叠一层自己定的期限。
		 */
		/** 行尾那个词（2026-11-01 维护方重新定的四档含义）：
		 *   推荐 = 最好用的        置信高，且三类故障率一项都没超过全池平均
		 *   可用 = 能用，有小问题   置信达标，但某项故障率高于全池平均
		 *   不稳 = 能用，经常出问题 置信不到六成，或故障率超过全池平均两倍
		 *   未测 = 样本不够，不下结论（3 次以下）
		 *
		 *  判据**只在服务端算一次**（`src/score.js` 的 tierOf，随快照的 `score.tier` 带下来）。
		 *  客户端不再自己判 —— 以前两边各写一份，改漏一处就出现「标签写推荐、派活排最后」。
		 *  这里只保留两个**状态词**，它们不是可靠性判断：
		 *   · 队长 = 这条正被本会话的队长用着（谁在用，和好坏无关）
		 *   · 成员 = 被别的成员占着（同上，占用不是可靠性）
		 */
		function rowWord(e) {
			if (e.status === "lead") return "队长";
			if (e.holders && e.holders.length) return "成员";

			const s = e.score && typeof e.score === "object" ? e.score : null;
			if (s !== null && typeof s.tier === "string") return s.tier;

			// 快照里没带评分（老实例、或这条两个实测源都没有样本）→ 说没测，不猜。
			return "未测";
		}

		/** **右侧显示顺序**（维护方 2026-11-01 定）：队长 → 成员 → 推荐 → 可用 → 未测 → 不稳。
		 *  成员往前放：一眼看到"谁在干活、用哪条"，这是看面板最想知道的事。 */
		const WORD_GRADE = { "队长": 0, "成员": 1, "推荐": 2, "可用": 3, "未测": 4, "不稳": 5 };

		/** **插件派活顺序**（维护方 2026-11-01 两次修正后的最终版）：未测 → 推荐 → 可用 → 被占 → 不稳。
		 *  和显示顺序**故意不同**，因为关心的事不一样：
		 *   · 「未测」排最前 —— 这是**证据采集的死锁**：未测 = 样本 < 3，而样本只能靠真派增长。
		 *     永远从推荐开始挑，未测就永远轮不到，永远攒不到样本，永远判未测。
		 *     设计说明：「先派未测，再派推荐-可用-不稳，否则未测永远是未测，除非前面的全挂了。」
		 *   · 「被占」押后但不除名 —— 那条正被别的成员占着（同一路由不许并发）。
		 *     占用是当前状态不是可靠性，所以不进评分，只在排序时压到可用与不稳之间。
		 *   · 「不稳」永远最后但**永远是候选**（能用但经常出问题 ≠ 不可用）。
		 *  档位号以 src/score.js 的 TIER_ORDER 为准，这里只是面板侧的镜像（只给说明用）。 */
		const DISPATCH_GRADE = { "未测": 0, "推荐": 1, "可用": 2, "成员": 2.5, "不稳": 3 };

		function rowGrade(e) {
			const w = rowWord(e);
			return w === null ? 9 : WORD_GRADE[w];
		}
		/** 派活用的档次（后端 pickRoute 用的是同一套含义，这里是面板侧的镜像，只给"为什么排这么后"的说明用）。 */
		function dispatchGradeOf(e) {
			const w = rowWord(e);
			return w === null ? 9 : (DISPATCH_GRADE[w] === undefined ? 9 : DISPATCH_GRADE[w]);
		}

		/** 行尾那个词。**颜色统一**（维护方 2026-11-01：「现在得不稳有白色有红色，统一成黄色」）：
		 *  队长=金、成员=紫、推荐=绿实心、可用=绿浅、未测=灰、不稳=**黄**（不再分红/白两种）。 */
		function rowChip(e) {
			const w = rowWord(e);
			if (w === null) return null;
			const ofm = e.ofm && typeof e.ofm === "object" ? e.ofm : null;
			const s = e.score && typeof e.score === "object" ? e.score : null;
			// 判据的可读版：置信 / 风险 / 证据来源，全来自服务端同一张评分表。
			const facts = s === null ? "" : "\n\n实测依据："
				+ "\n· 样本 " + Number(s.ok) + " 成 / " + Number(s.tries) + " 次（来源 " + (s.src === "team" ? "TEAM 真派" : "OFM 请求账") + "）"
				+ "\n· 置信（95% 下界）" + Number(s.conf).toFixed(3)
				+ "\n· 风险 " + Number(s.risk).toFixed(2) + "（1.00 = 三类故障率都没超过全池平均；超过 2.00 = 经常出问题）"
				+ (Number(s.hours) > 0 ? "\n· 累计耐力 " + Number(s.hours).toFixed(1) + " 小时" : "")
				+ "\n· 故障：自身 " + Number(s.faults && s.faults.self || 0) + "，" + "限流 " + Number(s.faults && s.faults.quota || 0) + "，" + "抖动 " + Number(s.faults && s.faults.jitter || 0) + (Number(s.faults && s.faults.truncated) ? "，撞顶 " + Number(s.faults.truncated) : "") + (Number(s.faults && s.faults.other) ? "，其他 " + Number(s.faults.other) + "（算失败、不计风险）" : "");
			if (w === "队长") return h("span", { style: { ...chip, background: "#f5c518", color: "#2b1f00", fontWeight: 600, flex: "none" } }, "队长");
			if (w === "成员") return h("span", {
				style: { ...chip, background: "#7c3aed", color: "#ffffff", fontWeight: 600, flex: "none", textShadow: "0 1px 1px rgba(0,0,0,.25)" },
				title: "成员正在用这条路由：\n" + (e.holders || []).map((u) => `${u.team}/${u.member}（${u.state}）`).join("\n") + "\n同一路由同时只许一个，别处要派请优先挑没人占的",
			}, "成员");
			if (w === "推荐") return h("span", {
				style: { ...chip, background: tint(T.ok, 22), color: T.ok, fontWeight: 600, flex: "none" },
				title: "最好用的：置信高，且三类故障率一项都没超过全池平均。" + facts,
			}, "推荐");
			if (w === "可用") return h("span", {
				style: { ...chip, background: tint(T.ok, 14), color: T.ok, flex: "none" },
				title: "能用，但有小问题：置信达标，某项故障率高于全池平均。" + facts,
			}, "可用");
			if (w === "未测") return h("span", {
				style: { ...chip, background: tint(T.label3, 16), color: T.label2, flex: "none" },
				title: "样本不够下结论（不到 3 次实测）。**这不等于差** —— 是「不知道」，试过才知道。"
					+ "\n派活时它排在「可用」之后、「成员」之前（至少它空着）。" + facts,
			}, "未测");
			// 不稳：能用，但经常出问题。颜色**统一黄色**（说明：不要有白有红）。
			return h("span", {
				style: { ...chip, background: tint(T.warn, 16), color: T.warn, flex: "none" },
				title: "能用，但经常出问题：置信不到六成，或故障率超过全池平均两倍。派大活前掂量一下。"
					+ facts + (ofmDetailText(ofm) || ""),
			}, "不稳");
		}

		/** 【已删除 2026-11-01】原来这里有个 ofmChip，给模型名后面钉「稳/不稳」。
		 *  设计确定：「一行只画一个词」之后它和 rowChip 重复（同一行会同时出现两个「不稳」），
		 *  调用点和函数都已删除，现在全由 rowWord + rowChip 负责。 */

		function LedgerRow({ e, pw, now }) {
			// 退避中的路由**不算可用**（维护方 10-30 抓到：qfmodel 只退了 8 分钟，到期变纯绿，
			// 真实解禁却在 2.5 小时后 —— 绿点骗人，派出去就是白烧）。绿点必须排除 backoff。
			// 2026-10-30 第二次：倒计时到点的那一刻自己就变回可用，不必等下一次快照。
			const wallLeft = countdown(e.backoff, now);
			// canDispatch 由面板统一算（白名单读不到时 unknown 也算可派，和后端 dispatchable() 同口径）
			const usable = e.canDispatch === true && wallLeft === null;
			const isLead = e.status === "lead";
			// 成员正占着这条（后端快照 routeOccupancy 带出来的 holders）。
			const holders = e.holders && e.holders.length ? e.holders : null;
			// 三段数据（实测跑过最大输入 / 上游标称上下文 / 单条输出上限）只在悬停 tip 里给：
			// 行上不显示，看的人扫 provider + 模型 + 累计时长就够了。
			const tip = [
				isLead ? "队长正在用这条 —— 规矩上绝不派给成员" : null,
				holders ? "成员正在用这条：" + holders.map((u) => `${u.team}/${u.member}(${u.state})`).join("，") + " —— 同一路由不许并发，它跑完才轮到下一个；挑模型时优先选没人占的" : null,
				e.backoff != null ? "退避中：解禁前不派成员（到点 " + new Date(e.backoff).toLocaleString("zh-CN") + "）" : null,
				"实测跑过最大输入 " + (e.seen ? Number(e.seen).toLocaleString("en-US") + " tokens" + (e.seenTurn != null ? "（turn " + e.seenTurn + "）" : "") : "还没有成功记录"),
				"标称上下文 " + e.ctx + (e.ctxRaw ? "（撞顶实测 " + Number(e.ctxRaw).toLocaleString("en-US") + " tokens，以实测为准）" : "（上游/目录声明值，可能与实际不符）"),
				"最大输出 " + e.out + "（单条回复上限；任务书分段阈值取其 15–20%）",
				"累计正常干活 " + (e.used || "0H") + (e.usedRuns ? "（" + e.usedRuns + " 轮成功回合，按 request→response 时间差累加）" : "（还没有成功回合）"),
				"推理档位 " + (e.efforts || "未advertised"),
				e.real === "ok" && e.realAt != null ? "真派 ok · " + new Date(e.realAt).toLocaleString() : e.real === "fail" && e.realAt != null ? "真派失败 · " + new Date(e.realAt).toLocaleString() + (e.errClass ? "（" + e.errClass + "）" : "") : "今日无真派记录",
				e.whitelist === "closed" ? "白名单未开（改配置即可，非模型失效）" : null,
				e.note ? e.note : null,
			].filter(Boolean).join("\n");
			return h("div", { style: { display: "flex", alignItems: "center", gap: 8, padding: "5px 10px" }, title: tip },
				h(Dot, { tone: isLead ? "warn" : usable ? "ok" : e.status === "invalid" ? "err" : "muted" }),
				(() => {
					// 2026-10-29 设计确定：provider 单独用紫色底 chip，模型名照常显示 —— 一眼认渠道。
					// key 形如 "provider/model"，model 自己还可能带 "/"（our-free-model/z-ai/glm-5.3），
					// 所以只按**第一个**斜杠切。
					const slash = e.key.indexOf("/");
					const pv = slash > 0 ? e.key.slice(0, slash) : "";
					let md = slash > 0 ? e.key.slice(slash + 1) : e.key;
					// 2026-10-29 说明：「nvidia/nemotron-3.5-super-vl:free 和 cline-free/nemotron-3.5-super-vl
					// 好难分辨」——这两条模型名几乎一模一样，真正的差异在**厂商段**。所以把模型名的
					// 第一段拆成 vendor 小标单独显示；和 provider 同源的（cline-free ← cline）直接去掉，
					// 不重复展示。名字短了，三家同一个 nemotron 也一眼分得清。
					const vslash = md.indexOf("/");
					const rawVendor = vslash > 0 ? md.slice(0, vslash) : "";
					const vendor = rawVendor !== "" && (rawVendor === pv || rawVendor.startsWith(pv)) ? "" : rawVendor;
					if (vslash > 0) md = md.slice(vslash + 1);
					// 2026-11-01 设计确定：「免费台账显示改用聊天框下方同一个模型名」。
					// 聊天框那个名字来自内核 catalog 的 model.name（OFM 把 "GLM 5.3" 这类漂亮名字
					// 注册进去），而台账原来显示的是原始 id（z-ai/glm-5.3）。同一条路由两个名字，
					// 维护方得自己翻译一遍 —— 现在显示内核那个名字。
					// **只改展示**：e.key / e.model 一个字不动，派单、白名单、OFM 映射全按原始 id。
					// 内核没给名字（displayName 为 null）就退回原样，绝不自己猜一个。
					const shown = e.displayName ? e.displayName : md;
					return h("div", { style: { flex: 1, minWidth: 0, display: "flex", alignItems: "baseline", gap: 6 } },
						pv === "" ? null : h("span", {
							// 固定宽 provider chip：不然 "O.F.M" 窄、"raccoon" 宽，右边累计时长那列会跟着漂，整排对不齐
							// 2026-10-29 维护方说明两家 nemotron 分不清：顺手给主要池子各一个固定色调，
							// 紫=OFM、绿=raccoon、黄=cline、蓝=qodercn，扫颜色就知道是哪家。
							// 底色实、字写死高亮白（说明：紫字紫底太难看清）；没有专属色的池子退回主题灰底。
							// 宽度按最长池名算（pw 个字符，等宽字体下 1ch = 1 字符），不再是死 60px。
							// 立体阴影试过一版，维护方说明「算了，还是不要立体了」—— 撤掉，只留纯色块。
							style: {
								...chip, fontSize: 10, lineHeight: "16px", padding: "0 6px", flex: "none",
								fontFamily: mono.fontFamily,
								width: "calc(" + (pw || 7) + "ch + 12px)",
								textAlign: "center", overflow: "hidden", textOverflow: "ellipsis", fontWeight: 600,
								background: PTONE[pv] || T.bg3,
								color: PTONE[pv] ? "#ffffff" : T.label2,
								textShadow: PTONE[pv] ? "0 1px 1px rgba(0,0,0,.25)" : "none",
								boxShadow: "none",
							},
							title: "provider: " + pv,
						}, pv === "our-free-model" ? "O.F.M" : pv),
						vendor === "" ? null : h("span", {
							style: { fontSize: 10, lineHeight: "16px", color: T.label3, flex: "none", ...mono },
							title: "厂商 / 上游分组: " + vendor + "（同一个模型在别的池子里就是另一条路由，别混）",
						}, vendor),
						h("span", {
							style: { fontSize: 12, color: isLead ? T.warn : T.label, ...ell, ...mono },
							// 悬停给完整身份：内核给的显示名 + 台账原始的 provider/model id。
							// 维护方在聊天框看到的是前者，真要改配置/报错时得用后者，两个都留着。
							// 2026-11-01 设计确定：「稳跟可用合并」之后，OFM 的完整读数也挪到这里 ——
							// 行上只画「不稳」那个矛盾，稳的读数不占位置但仍要能在悬停里看到。
							title: (e.displayName ? "显示名: " + e.displayName + "\n原始 id: " + e.key + "\n\n" : "") + tip + (ofmDetailText(e.ofm) || ""),
						}, shown),
						// 2026-10-29 设计确定：能读图的模型，名字后面直接跟一个图片图标 —— 不用点开、
						// 不用悬停，扫一眼就知道这条能不能派读图活。悬停给来源（目录 / 名字推断）。
						e.vision === true ? h("span", {
							style: { fontSize: 11, lineHeight: "14px", flex: "none", marginLeft: -1, opacity: 0.9 },
							title: "支持图片输入（能读图）｜来源：" + (e.visionSrc === "catalog" ? "OFM 目录（可信）" : e.visionSrc === "name" ? "模型名推断（未实测，可能不准）" : "未知") + "｜派读图活用 team(spawn/pick, vision:true)",
						}, "🖼") : null,
					);
				})(),
				// 2026-11-01（拆 OFM）：模型名后面不再单独钉「稳/不稳」徽标 ——
				// 「不稳」已经由行尾那个唯一的结论词负责（rowChip），这里再画一次就是重复。
				// 完整读数走模型名的悬停（见上面 title 里的 ofmDetailText）。
				// 2026-10-30 设计确定：命中**已登记规则**的限流（errClass 有值且退避中），在累计时长
				// 前面钉一个蓝底白字「限流 倒计时」——队长选了这种路由也要看得见墙还剩多久，
				// 跟「退避至」橙 chip 的区别：那个给的是到点时刻，这个给的是**还剩多少**。
				// 2026-10-30 第二次修：原来这行只在 `usable` 列表里渲染，而 usable 已经把
				// backoff != null 的全过滤掉了 —— 于是倒计时成了永远跑不到的死代码
				// （维护方抓到的「报错的模型没有倒计时」）。现在退避行单独成组渲染（见 TeamBody）。
				e.errClass && wallLeft !== null ? h("span", {
					style: { ...chip, background: "#2563eb", color: "#ffffff", fontWeight: 600, flex: "none", textShadow: "0 1px 1px rgba(0,0,0,.25)" },
					title: "限流中（规则「" + e.errClass + "」）｜解禁时间：" + new Date(e.backoff).toLocaleString("zh-CN") + "｜还剩 " + wallLeft + "｜到点前成员不派这单，队长可继续用",
				}, "限流 " + wallLeft) : null,
				// 2026-11-01 维护方两次点这件事：
				//   ①「这种长时间运行稳定的是不是可以改成推荐，那样时间哪个 YDH 就不用显示了」
				//   ②「还有哪个 H 没清干净」← 指的就是这一格残留的 "2D06H" 之类
				// 结论：**行上彻底不画累计时长了**。它不影响任何判断 ——
				// 好不好看「推荐/可用/未测/不稳」那个词，跑多久看悬停。
				// 数据没丢：悬停 tip 里「累计正常干活 X」那行照旧在（见上面的 tip 数组）。
				// 2026-11-01 设计确定：六档（队长/成员/推荐/可用/未测/不稳）—— **一行只画一个词**，
				// 由 rowWord 统一判（见上面的函数）。这里不再各写一段，
				// 否则又会出现「可用」和「不稳」并排（今天派成功过 + 历史 92% 失败）。
				// 设计说明：「『可用』和『不稳』同时出现的时候显示不稳，不稳不是不可用」——
				// 不稳仍然能派，它只是排在后面。
				rowChip(e),
				// 【已合并 2026-11-01】原来这里有个独立的「截断」chip，会和「可用」并排出现 ——
				// 维护方问：「可用 截断同时显示，到底是可用还是不可用？」
				// 答案：**能用**（没坏），所以它属于「不稳」那种"能用但有保留"，
				// 现在并进 rowWord（truncated 也算 weak），悬停里说明原因。
				// 这里不再单独画，一行只有一个词。
				// 队长自己也别显示「退避」：那是给成员派的约束，队长这条压根不会被派出去
				wallLeft !== null && !isLead ? h("span", { style: { ...chip, background: tint(T.warn, 16), color: T.warn, flex: "none" }, title: "这条路由在退避期，成员不会被派到它｜解禁时间：" + new Date(e.backoff).toLocaleString("zh-CN") + "｜还剩 " + wallLeft }, "退避 " + wallLeft) : null,
				e.groupHalt != null ? h("span", { style: { ...chip, background: tint(T.err, 16), color: T.err, flex: "none" }, title: "整池熔断：同一份额度被组内任一模型撞空，整组停到配额重置，到期单条探活。OPENCODE free 池按周（下周一 UTC 0 点）、qodercn 按本地 0 点；别的池不受影响" }, "组停") : null,
			);
		}

		// 展开/收起要能记住：以前是 useState(true/false)，切到别的 tab 再切回来组件重挂，
		// 状态回默认——「我明明收起了，切回来又展开了」就是这么来的。现在落到 localStorage。
		function useSticky(key, def) {
			const lsKey = "dsh-team.ui." + key;
			const [v, setV] = useState(() => {
				try { const s = window.localStorage.getItem(lsKey); return s === null ? def : s === "1"; } catch (e) { return def; }
			});
			const set = useCallback((next) => {
				setV((cur) => {
					const nv = typeof next === "function" ? next(cur) : next;
					try { window.localStorage.setItem(lsKey, nv ? "1" : "0"); } catch (e) { /* 隐私模式也别炸 */ }
					return nv;
				});
			}, [lsKey]);
			return [v, set];
		}

		// ---- 2026-11-16 设计确定：右边框面板不要了，只留顶部整页 tab（conversation.view）。----
		// 版式 = 样板 v1（hero 顶卡 + 胶囊计数 + 任务流看板）；成员/台账/跨会话信息复用原组件一字不动。
		// 名字：设计确定：「不叫智能体团队，就叫 dsh-Team」。
		const NAME = "dsh-Team";
		function Hero() {
			return h("div", { style: { borderRadius: 14, padding: "1.5px", background: "linear-gradient(118deg, " + tint(T.viz, 85) + ", " + tint(T.biz, 60) + " 45%, " + tint(T.ok, 55) + " 85%)" } },
				h("div", { style: { background: T.bg2, borderRadius: 13, padding: "14px 18px 12px" } },
					h("div", { style: { fontSize: 11, letterSpacing: ".14em", fontWeight: 600, color: T.viz, textTransform: "uppercase", marginBottom: 3 } }, "TEAM 面板 / 实时"),
					h("div", { style: { display: "flex", alignItems: "center", gap: 10 } },
						h("svg", { width: 21, height: 21, viewBox: "0 0 16 16", fill: "none", stroke: T.viz, strokeWidth: 1.3, "aria-hidden": true },
							h("circle", { cx: 6, cy: 5, r: 2.6 }),
							h("path", { d: "M1.8 13.4c.6-2.4 2.2-3.6 4.2-3.6s3.6 1.2 4.2 3.6" }),
							h("circle", { cx: 11.6, cy: 5.4, r: 2.1 }),
							h("path", { d: "M11.4 9.9c1.7.2 2.6 1.4 3 3" })),
						h("b", { style: { fontSize: 22, fontWeight: 700, color: T.label } }, NAME)),
					h("div", { style: { fontSize: 12.5, color: T.label2, marginTop: 5 } }, "同一时间线上，观察成员状态、任务流转与免费模型派单。")));
		}
		function Pill({ n, t, on }) {
			return h("span", { style: { display: "inline-flex", alignItems: "center", gap: 6, border: "1px solid " + (on ? tint(T.ok, 55) : T.border2), background: T.bg2, borderRadius: 999, padding: "3px 12px", fontSize: 12, color: on ? T.ok : T.label2 } },
				on ? h("span", { style: { width: 7, height: 7, borderRadius: 7, background: T.ok, flex: "none", animation: "dsht-pulse 1.2s infinite" } }) : null,
				h("b", { style: { color: on ? T.ok : T.label, fontVariantNumeric: "tabular-nums" } }, String(n)), " ", t);
		}
		// 协作任务（2026-11-16 设计确定：任务流四列看板换成 dsh-context 编队页「协作任务」那种）。
		// 版式依据 = 编队页实读（client.js 压缩码 lc-pulse-work-* 规则 + 维护方截图）：
		//   标题行（图标+计数+搜索框）→ 分段筛选按钮（全部/进行中/待处理/已完成，带数量）→
		//   单列纵向列表，条目卡 = 2px 顶边随 owner 色 + 斜向渐变底。
		// 设计确定：的高度口径：默认只显示 1 张，点展开后 3 张高、内部上下滚动看全部。
		const WORK_SEGMENTS = [
			["all", "全部", null],
			["in_progress", "进行中", ["claimed"]],
			["pending", "待处理", ["open", "delivered"]],
			["completed", "已完成", ["done", "failed"]],
		];
		const WORK_H = { one: 74, three: 226 }; // 收起=1张卡高，展开=3张卡高（TaskCard 两行版式实测高约 66~70 + gap6）
		function WorkList({ tasks, members, expanded, onToggle }) {
			const [seg, setSeg] = useState("all");
			const [q, setQ] = useState("");
			const segTasks = (st) => (st === null ? tasks : tasks.filter((t) => st.includes(t.status)));
			const counts = WORK_SEGMENTS.map((s) => segTasks(s[2]).length);
			const shown = segTasks(WORK_SEGMENTS.find((s) => s[0] === seg)[2])
				.filter((t) => { const s = q.trim().toLowerCase(); return !s || (t.tid + " " + t.title).toLowerCase().includes(s); });
			return h("div", { style: { ...card, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8, overflow: "hidden" } },
				h("div", { style: { display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" } },
					h("span", { style: { display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 650, color: T.label } },
						h("svg", { width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", stroke: T.biz, strokeWidth: 1.4, "aria-hidden": true },
							h("path", { d: "M2.5 4h11M2.5 8h11M2.5 12h7" }),
							h("circle", { cx: 12.5, cy: 12, r: 1.8, fill: T.biz, stroke: "none" })),
						"协作任务"),
					h("span", { style: { fontSize: 11, color: T.label3, fontVariantNumeric: "tabular-nums" } }, shown.length + "/" + tasks.length + " 个工作项"),
					h("input", {
						type: "search", value: q, placeholder: "搜索工作项…",
						onChange: (e) => setQ(e.target.value),
						style: { marginLeft: "auto", width: 180, fontSize: 11.5, color: T.label, background: T.bg3, border: "1px solid " + T.border, borderRadius: 7, padding: "3px 9px", outline: "none" },
					})),
				h("div", { role: "group", style: { display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6 } },
					WORK_SEGMENTS.map((s, i) => h("button", {
						key: s[0], type: "button", "aria-pressed": seg === s[0],
						style: { border: "1px solid " + (seg === s[0] ? T.biz : T.border2), background: seg === s[0] ? tint(T.biz, 16) : T.bg3, color: seg === s[0] ? T.biz : T.label2, cursor: "pointer", borderRadius: 8, padding: "4px 8px", fontSize: 11, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 5 },
						onClick: () => setSeg(s[0]),
					}, s[1], h("span", { style: { fontVariantNumeric: "tabular-nums", opacity: 0.8 } }, String(counts[i]))))),
				shown.length === 0
					? h("div", { style: { fontSize: 11.5, color: T.label3, padding: "8px 4px", textAlign: "center" } }, q.trim() ? "没有匹配的工作项" : "这个筛选下还没有任务")
					: h("div", {
						style: { display: "flex", flexDirection: "column", gap: 6, overflowY: expanded ? "auto" : "hidden", maxHeight: expanded ? WORK_H.three : WORK_H.one, overscrollBehavior: "contain", scrollbarWidth: "thin", paddingRight: 2 },
					}, shown.map((t) => h(TaskCard, { key: t.tid, task: t, members }))),
				h("button", {
					type: "button",
					style: { border: 0, background: "transparent", color: T.biz, cursor: "pointer", fontSize: 11, padding: "2px 2px 0", textAlign: "left" },
					onClick: () => onToggle((v) => !v),
				}, expanded ? "收起 ▴" : "展开全部 " + shown.length + " ▾"));
		}
		// 宿主没对插件暴露 openView API（app.asar 已核：只作 conversation.view 组件 owner prop 下发），
		// 头部按钮切本页 = 点宿主 tab 的等价实现。
		function clickTab(labelText) {
			const bars = document.querySelectorAll("[data-conversation-tabs]");
			for (const bar of bars) {
				const btns = bar.querySelectorAll("button[role='tab']");
				for (const b of btns) {
					if (b.textContent && b.textContent.includes(labelText)) { b.click(); return true; }
				}
			}
			return false;
		}
		function HeaderTrigger() {
			return h("button", {
				type: "button",
				style: { minHeight: 28, color: T.label3, cursor: "pointer", background: "transparent", border: "0", borderRadius: 6, alignItems: "center", gap: 5, padding: "3px 7px", fontSize: 12, display: "inline-flex" },
				"aria-label": NAME,
				onMouseEnter: (e) => { e.currentTarget.style.color = T.label; },
				onMouseLeave: (e) => { e.currentTarget.style.color = T.label3; },
				onClick: () => clickTab(NAME),
				children: [
					h("svg", { width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.3, "aria-hidden": true },
						h("circle", { cx: 6, cy: 5, r: 2.6 }),
						h("path", { d: "M1.8 13.4c.6-2.4 2.2-3.6 4.2-3.6s3.6 1.2 4.2 3.6" }),
						h("circle", { cx: 11.6, cy: 5.4, r: 2.1 }),
						h("path", { d: "M11.4 9.9c1.7.2 2.6 1.4 3 3" })),
					h("span", {}, NAME),
				],
			});
		}

		function TeamBody(props) {
			// session-scoped slot: scope the panel to its own conversation
			const lead = (props && (props.lead || props.sessionId || (props.session && props.session.sessionId) || (props.standard && props.standard.sessionId))) || undefined;
			const { snap, failed, reload } = useSnapshot(lead);
			const now = useTick();
			// 跨会话消息「一键清除」（2026-11-04 设计确定：）：只清面板显示的那 20 条投递流水，
			// 不碰 Agent 读的信箱本体（每箱 MAIL_BOX_MAX 条兜底）。
			const clearMail = async () => {
				try {
					const res = await fetch("/api/dsh-team/mail/clear", { cache: "no-store" });
					if (!res.ok) throw new Error(String(res.status));
					await reload();
				} catch { /* 清不掉就当没点，面板照旧 */ }
			};
			const [mOpen, setMOpen] = useSticky("members", false);
			const [lOpen, setLOpen] = useSticky("ledger", false);
			// 协作任务展开态（维护方 2026-11-16：默认 1 张、展开 3 张高滚动）
			const [wOpen, setWOpen] = useSticky("worklist", false);
			// 默认收起，只显示最新 1 条（和成员/台账一样：不占地方，点开才铺）
			const [chatOpen, setChatOpen] = useSticky("mail", false);
			if (snap === null) {
				return h("div", { style: { padding: 14, fontSize: 12, color: T.label2 } },
					failed ? h("span", { style: { color: T.err } }, "API 不可达（Host 半未装好或无 web server）") : "加载中…",
					h("button", { type: "button", style: { marginLeft: 8, border: "1px solid " + T.border2, background: "transparent", color: T.label2, borderRadius: 6, padding: "1px 8px", cursor: "pointer", fontSize: 11 }, onClick: () => void reload() }, "重试"),
				);
			}
			const goalRows = (snap.goals && snap.goals.length ? snap.goals : null);
			const members = [...snap.members].sort((a, b) => {
				const rank = (m) => m.status === "running" ? 0 : m.status === "idle" ? 1 : 2;
				return rank(a) - rank(b) || (a.lastEventAgo ?? 1e12) - (b.lastEventAgo ?? 1e12);
			});
			const tasks = snap.tasks;
			const doing = tasks.filter((t) => t.status === "claimed");
			const openT = tasks.filter((t) => t.status === "open");
			const flow = [...doing, ...openT, ...tasks.filter((t) => t.status !== "claimed" && t.status !== "open")]
				.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
			// 白名单读不到的机器上（新装、profile 没配 allowedModels），条目是 unknown 而不是 allow。
			// 后端的 dispatchable() 在这种情况下把 unknown 当候选，面板必须同口径，
			// 否则「可用模型 0/54」和真能派活自相矛盾（2026-11-02 发包踩雷第 4 条的显示面）。
			// 全面板一份判据：给每行打 canDispatch，LedgerRow 的绿点和 usableAll 计数都读它。
			const dispatchableRow = (e) => {
				// 和后端 dispatchable() 同口径（2026-11-02 死锁修复同步）：status=unknown
				// （待实测）是「没证据」不是「死了」，派单池含它（后端排序压后、试跑有收口），
				// 面板不许比后端保守 —— 否则「可派」永远只有 OFM 带实测的那几条，
				// 维护方抓的「其它 36 条去哪了 / 插件根本不派人」就是这么来的。硬闸只留 invalid/lead。
				if (!e || (e.status !== "ok" && e.status !== "unknown")) return false;
				if (e.whitelist === "allow") return true;
				if (e.whitelist !== "unknown") return false;
				return !snap.ledger.some((x) => x.whitelist === "allow" && (x.status === "ok" || x.status === "unknown"));
			};
			const ledger = [...snap.ledger]
				.map((e) => ({ ...e, canDispatch: dispatchableRow(e) }))
				.sort((a, b) => (b.realAt || 0) - (a.realAt || 0)
					|| ((b.canDispatch ? 1 : 0) - (a.canDispatch ? 1 : 0)));
			// 组熔断里的路由**不算可派**：整池没额度，留着只会让人以为还能派（维护方 10-29 指出：
			// 「组停了，但是还在我的右边框能看到」）。它们单独收成一行汇总，不占首屏。
			const haltedRows = ledger.filter((e) => e.groupHalt != null);
			// 2026-10-30 维护方报「自动派出去的成员在台账里没标注、还是可用状态」：
			// 快照现在带 holders（谁正占着这条）。被占的路由仍然可用（同一路由不许并发，
			// 但别人跑完就能用），所以不踢出列表。
			// 2026-10-30 设计确定：（第二次）：被占的行**别丢到最后**，要排在队长后面、空闲行前面 ——
			// 视线一动就看到「谁在干活、用哪条」，空闲的往后放。分两组渲染，不靠 sort 硬扭。
			const held = (e) => (e.holders && e.holders.length ? e.holders : null);
			const usableAll = ledger.filter((e) => e.canDispatch === true && e.groupHalt == null && e.backoff == null);
			// 2026-10-30 维护方第二次报（更重要的一条）：「报错的模型也没有被插件添加倒计时关闭」。
			// 根因：老代码把 backoff != null 的行**整行过滤掉**了，而这些行才是最该被看见的
			// —— 成员正撞着 14 小时的账号池墙，面板一条都不显示，倒计时代码成了死代码。
			// 现在拆成三组渲染：队长 → 可用（被占的在前）→ 退避中（带实时倒计时，按到点先后）。
			// 退避行不参与「可派」计数（stat 卡片照旧只数 usable），但必须被看见。
			const heldRows = usableAll.filter((e) => held(e));
			const freeRows = usableAll.filter((e) => !held(e));
			// 2026-11-01 说明：「排序也可以改成队长，成员，推荐，可用，不稳，这样我一眼就能看出来了」。
			// 按 rowGrade 升序排（0 队长 / 1 成员 / 2 推荐 / 3 可用 / 4 不稳 / 9 其它），
			// 同档里保持原来的相对次序（stable sort）：被占的仍然排在同档前头、
			// 时间近的仍然优先 —— 设计确定：的老规矩一条不删，只是上面加了一层总序。
			// 为什么不用「分五组各画一个标题」：需求方要的是「一眼看出」，五个小标题反而更长；
			// 一行一个词的档次已经够读，靠位置就分得清。
			const usable = [...heldRows, ...freeRows]
				.map((e, i) => ({ e, i, g: rowGrade(e) }))
				.sort((a, b) => a.g - b.g || a.i - b.i)
				.map((x) => x.e);
			// 退避中**且不是队长、不在组熔断**的行单列一组。组熔断照旧一条不列
			// （整池没额度是另一件事，走 Section 尾巴的「· 组停 N」）。
			const backoffRows = ledger
				.filter((e) => e.status !== "lead" && e.groupHalt == null && countdown(e.backoff, now) !== null && !usableAll.includes(e))
				.sort((a, b) => (Number(a.backoff) || 0) - (Number(b.backoff) || 0));
			const leadRows = ledger.filter((e) => e.status === "lead");
			// provider chip 统一宽度 = 实际要显示的最长池名（O.F.M 是缩写，按缩写算）。
			// 维护方 10-29：「按照能显示最长的 PRO 名字定宽就行，要不浪费」——原来是死定 60px，
			// 池名短的时候右边空一截。等宽字体下 1ch 就是一个字符宽，所以直接按字符数定宽。
			const pwMax = ledger.reduce((mx, e) => {
				const i = e.key.indexOf("/");
				const pv = i > 0 ? e.key.slice(0, i) : "";
				const txt = pv === "our-free-model" ? "O.F.M" : pv;
				return Math.max(mx, txt.length);
			}, 5);
			return h("div", { style: { display: "flex", flexDirection: "column", gap: 14, padding: "18px 22px 28px", overflowY: "auto", height: "100%", fontSize: 12, color: T.label } },
				h("style", {}, "@keyframes dsht-pulse{0%,100%{opacity:1}50%{opacity:.35}}"),
				h(Hero),
				h("div", { style: { display: "flex", flexWrap: "wrap", gap: 8 } },
					h(Pill, { n: tasks.length, t: "任务" }),
					h(Pill, { n: members.filter((m) => m.status === "running").length, t: "运行中", on: members.some((m) => m.status === "running") }),
					h(Pill, { n: usable.length, t: "可用模型" }),
					h(Pill, { n: members.length, t: "成员" }),
					h(Pill, { n: Math.min((snap.mail || []).length, 20) + (snap.announce && snap.announce.text ? 1 : 0), t: "消息" })),
				// 2026-11-01 说明：「最顶上这些文字对我没用」——身份牌（dsh-team · 多工人任务板 /
				// 总目标 → 拆单 → 派活 → 收汇报）和台账读数那两句说明全删了，面板挨着别的 tab
				// 本来就是维护方自己开的，不用自我介绍；读数口径写在台账标题的 tooltip 里。
				// 维护方 11-01：「第一行 OFM 是不是不需要提醒我看了，反正现在都是自动更新了，去掉吧」。
				// 同意：版本号是背景事实，不是要人动手的事。现在只有**真出事**才浮出来
				// （有新版没升上去 / 自升级被关 / 状态不正常：warn 色 + 修复说明），平时整行不占地方。
				// ★ 2026-11-02 发包踩雷第 3 条：状态拆三态，别再写一句含混的「版本状态异常」。
				//   维护方截图那句「OFM 2.8.0 / 官方 2.8.0 · 版本状态异常｜插件启动时：已是最新（2.8.0）」
				//   读起来像坏了，其实两件事都是真的：已是最新 + vendor 副本落后（下次 pnpm install 会退版）。
				//   现在 drift 单独一个字段（后端 ofmVersionState），这里按事各说一句人话。
				(() => {
					const o = snap.ofm;
					if (!o || !o.known) return null;
					const newer = o.latest != null && o.installed !== "" && cmpVer(o.latest, o.installed) > 0;
					const selfUp = o.selfUpdatable !== false;
					const registrySpec = o.spec !== "" && !/^(file:|link:)/.test(String(o.spec));
					if (!newer && selfUp && o.ok !== false) return null;
					const a = o.auto;
					const head = "OFM " + (o.installed || "?") + (o.latest != null ? " / 官方 " + o.latest : "");
					const state = newer ? "官方有新版"
						: registrySpec ? "profile 声明指向 npm 仓库（那是同名的另一个包）"
						: o.drift === true ? "已升到 " + o.installed + "，但 vendor 副本停在 " + (o.vendored || "?") + "（下次装/卸插件会退回旧版）"
						: selfUp ? "版本对照不一致" : "自升级被关";
					const autoLine = a && a.did && a.did !== "没动" ? "｜插件启动时：" + a.did
						: a && a.error ? "｜插件：" + String(a.error).slice(0, 90) : "";
					const fix = !selfUp
						? "｜装/卸插件会让它退版并关闭升级按钮：profile 里改成 link:.dsh/plugins/dsh-our-free-model"
						: o.drift === true ? "｜修法：把实装重打成 vendor/dsh-our-free-model-" + o.installed + ".tgz 并刷 lock（找实现方，或自己按 hint 做）"
						: "";
					return h("div", { title: o.hint || "", style: { ...card, padding: "7px 10px", fontSize: 11, color: T.warn } },
						head + " · " + state + autoLine + fix);
				})(),
				// 维护方 11-01：「自动刷新 · 18:38:27 / 刷新 也去掉，我从来点这个」。
				// 两样都删：时间戳是噪音（数据本来每 10 秒自己刷），按钮从来没被点过。
				// reload 仍然被「API 不可达」那块的重试按钮用着，函数留着。
				// 整页版式：目标卡只留目标本体（任务流挪到下面看板，不再嵌卡里重复铺）。
				goalRows === null ? null : goalRows.map((g) => h(GoalCard, { key: g.lead, goal: g, flow: [], expanded: false, onToggle: () => {}, members })),
				// 任务流（2026-11-16 设计确定：）：编队「协作任务」样式列表——默认 1 张高，展开 3 张高可滚动。
				h(WorkList, { tasks: flow, members, expanded: wOpen, onToggle: setWOpen }),
				// 2026-11-01 说明：「把这行字也去掉吧，没用（其他队 3 个（只读摘要）…）」。
				// 其他队是只读摘要，跟本队的活没关系，永远只是噪音。删掉整块。
				h(Fragment, {},
					h(Section, { title: "成员", extra: members.length + " 名", expanded: mOpen, onToggle: () => setMOpen((v) => !v), count: members.length },
						members.length === 0
							? h("div", { style: { ...card, padding: 12, color: T.label3, textAlign: "center" } }, "还没有成员 — 建单后插件会自动起人；要指定型号才用 team(spawn)")
							: h("div", { style: { display: "flex", flexDirection: "column", gap: 6 } },
								(mOpen ? members : members.slice(0, COLLAPSE_N)).map((m) => h(MemberRow, { key: m.name, m }))),
					),
					h(Section, { title: "免费模型台账", hint: "累计干活：全队总运行时长（没有年/天就省掉）｜实测最大输入 / 标称上下文 / 输出上限 —— 两头是真跑出来的，中间是上游自己说的", extra: "可派 " + usable.length + " / 共 " + ledger.length + (leadRows.length ? " · 队长 " + leadRows.length : "") + (backoffRows.length ? " · 退避 " + backoffRows.length : "") + (haltedRows.length ? " · 组停 " + haltedRows.length : ""), expanded: lOpen, onToggle: () => setLOpen((v) => !v), count: usable.length },
						h("div", { style: { ...card, padding: "4px 0", overflow: "hidden" } },
							leadRows.map((e) => h(LedgerRow, { key: e.key, e, pw: pwMax, now })),
							// 组熔断的行**一条都不列**（维护方 10-29：反正都属于不可用，还省事）。
							// 只留 Section 标题尾巴那个「· 组停 N」—— 不占首屏、不出现在可派列表里。
							(lOpen ? usable : usable.slice(0, LEDGER_COLLAPSE_N)).map((e) => h(LedgerRow, { key: e.key, e, pw: pwMax, now })),
							// 退避中的行放在可用之后：它们不能派，但**必须被看见**（带倒计时）。
							// 收起时也列（最多 3 条，最急的那几条），因为"为什么没派活"的答案就在这里。
							backoffRows.length === 0 ? null : h("div", { style: { padding: "6px 10px 2px", fontSize: 10.5, color: T.label3, borderTop: "1px solid " + T.border2, marginTop: 2 } },
								"退避中（到点前不派成员；倒计时到 0 自动变回可用）"),
							(lOpen ? backoffRows : backoffRows.slice(0, LEDGER_COLLAPSE_N)).map((e) => h(LedgerRow, { key: e.key, e, pw: pwMax, now }))),
					),
					// 跨会话信息（2026-11-16 设计确定：公告 + 跨会话消息合并成一个区「跨会话信息」）：
					// 公告并入区内最上面一块（数据源 announce 照旧、仍不要回执、5 分钟一条），
					// 下来是跨会话消息列表 —— 只合显示，数据结构不动。
					h(Section, { title: "跨会话信息", extra: ((snap.announce && snap.announce.text) ? "公告 1 · " : "") + (snap.mail && snap.mail.length ? Math.min(snap.mail.length, 20) + " 条 · " : "") + "直接 tell 发信", expanded: chatOpen, onToggle: () => setChatOpen((v) => !v), count: (snap.mail || []).length,
						action: h("button", {
							type: "button",
							title: (snap.mail && snap.mail.length) ? "只清面板显示的跨会话消息，不清 Agent 读的信箱（每箱 20 条兜底）" : "现在没有跨会话消息可清",
							disabled: !(snap.mail && snap.mail.length),
							style: { border: 0, background: "transparent", color: (snap.mail && snap.mail.length) ? T.err : T.label3, cursor: (snap.mail && snap.mail.length) ? "pointer" : "default", fontSize: 11, padding: 0, opacity: (snap.mail && snap.mail.length) ? 1 : 0.45 },
							onClick: () => void clearMail(),
						}, "清除") },
						h("div", { style: { ...card, padding: "6px 10px", display: "flex", flexDirection: "column", gap: 5 } },
							// 公告块（2026-11-16 设计确定：公告 + 跨会话消息合并成「跨会话信息」）：
							// 原来公告是一条独立 card 挂在 Section 外面，现在并进本区第一块；
							// waitSec>0 才提示还差几秒能发，「现在可发」没信息量不再占行。
							(snap.announce && snap.announce.text) ? h("div", { style: { display: "flex", flexDirection: "column", gap: 3, paddingBottom: 5, borderBottom: "1px solid " + T.border2 } },
								h("div", { style: { display: "flex", gap: 8, alignItems: "baseline" } },
									h("span", { style: { ...chip, background: tint(T.warn, 16), color: T.warn } }, "📢 公告"),
									h("span", { style: { fontSize: 11.5, color: T.label2, flex: 1, lineHeight: 1.5 } }, snap.announce.text),
									h("span", { style: { ...mono, color: T.label3, flex: "none" } }, snap.announce.from + " · " + new Date(snap.announce.at).toLocaleTimeString())),
								snap.announce.waitSec > 0 ? h("div", { style: { fontSize: 10.5, color: T.label3 } },
									'发公告：team(action:"announce", text:"…")｜全体 5 分钟最多一条（还要等 ' + snap.announce.waitSec + " 秒）") : null)
								: null,
							// 2026-11-04 设计确定：在消息列表上面加一行，显示当前对话跨会话消息的 ID。
							// 信箱按会话 id 建箱，这个 id 就是本会话的信箱钥匙（告诉对方用它发信）。
							h("div", { style: { fontSize: 10.5, color: T.label3, paddingBottom: 5, lineHeight: 1.5, wordBreak: "break-all" } },
								"当前对话跨会话消息的ID：", h("span", { style: { ...mono, color: T.label } }, lead || "（全局/未限定）")),
							chatOpen
								? h("div", { style: { fontSize: 10.5, color: T.label3, paddingBottom: 4, borderBottom: "1px solid " + T.border2, lineHeight: 1.5 } },
									h("span", { style: mono }, 'team(action:"tell", to:"<对方短号>", text:"…")'),
									" —— 只入信箱、不叫醒对方（信里 @ 了它或加 wake:true 才会叫）；短号见上一条消息的 from/to。",
									h("div", { style: { marginTop: 2 } }, h("span", { style: mono }, 'team(action:"announce", text:"…")'), " —— 全局公告（全体 5 分钟最多一条，活着的会话都收到，不要回执）。"))
								: null,
							// 收起时只留最新 1 条（以前收起仍然全量平铺，"收起"等于没收起）
							(snap.mail && snap.mail.length)
								? (chatOpen ? snap.mail.slice().reverse() : snap.mail.slice(-1)).map((m, i) => h("div", { key: m.at + "-" + i, style: { fontSize: 11.5, color: T.label2, lineHeight: 1.45 } },
									h("span", { style: { ...mono, color: T.label3, marginRight: 6 } }, new Date(m.at).toLocaleTimeString()),
									h("span", { style: { ...mono, color: T.biz, marginRight: 6 } }, m.from + " → " + m.to),
									h("span", {}, m.text)))
								: h("div", { style: { fontSize: 11, color: T.label3, lineHeight: 1.5 } }, "还没有跨会话消息 —— 别人用 team(tell) 发信才会进来（「清除」只清面板显示，不清 Agent 读的信箱）"),
						)),
				),
			);
		}

		function apply(ctx) {
			// 2026-11-16 设计确定：右栏面板整体退役，UI 只挂顶部整页 tab + 头部按钮。
			ctx.effect(() => ctx.slots.inject("conversation.view", () => ctx.slots.register({
				name: "conversation.view",
				id,
				order: 45, // chat=0 trajectory=10 context=20 fleet=30 stats=40（已核宿主与 dsh-context 注册值）
				label: () => NAME,
				// session-scoped slot: the inject factory receives this tab's session id
				inject: (sessionId) => ({ lead: sessionId }),
			}, TeamBody)), "dsh-team: conversation view");
			ctx.effect(() => ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
				name: "conversation.session.header.actions",
				id,
				order: -20,
				inject: () => ({}),
			}, () => h(HeaderTrigger))), "dsh-team: header trigger");
		}

		return { inject: ["slots"], apply };
	},
});
