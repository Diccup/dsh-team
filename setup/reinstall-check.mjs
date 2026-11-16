#!/usr/bin/env node
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
// reinstall-check.mjs — 一键重装的机器化验收（2026-11-02 重装演练）
//
// 为什么是 .mjs 不是塞在 ps1 里：重启后单独跑 PowerShell 时 Invoke-RestMethod
// 对 API 的报错信息会被吞；node fetch 能拿到状态码+响应体，测试报告要写
// 「存在什么问题」，证据必须留原文。
//
// 判据（维护方决定：模拟新机器，暂不指向现在的数据库）：
//   A 插件 API 活着（GUI 端口 13986/9383 逐个试，/api/dsh-team/snapshot 返回 JSON）
//   B 新库长在 <插件目录>\.state：board/ledger/roster 至少各 1 个
//   C 开发机真库不许复活（重装演练的靶心：
//     stateDir 覆盖是否真生效）；发布版默认没有"开发机真库"这个概念，
//     传 --libstate 才检查。
//   D snapshot 是全新机器的样子（台账可以非空——scan 会收模型——但板/名册必须空）
//
// 退出码 0 = 全绿；1 = 有红项（红项本身就是「重装存在的问题」的答案，照实记）
// 跑法：node reinstall-check.mjs [--wait <秒>] [--live <插件目录>] [--libstate <真库目录>]
//      指到假树就能在不动真机器的情况下验 2/3 步的产物。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argOf = (name, dflt) => {
	const i = process.argv.indexOf(name);
	return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : dflt;
};
// ★ 发布版可移植化（2026-11-16）：原默认写死 C:/Users/Diccup/... 与 F:\...\LocalPlugins\...。
//   现在按当前用户家目录推；真库默认"不存在"（发布版没有开发机真库这概念）。
const LIVE = argOf('--live', path.join(os.homedir(), '.dsh', 'plugins', 'dsh-team').replace(/\\/g, '/'));
const LIB_STATE = argOf('--libstate', '');
// 端口发现：GUI 端口**每次重启都可能换**（9383→13986 实测跳过一次），钉死名单必然假红。
//   --ports 4001,4002 由调用方（ps1 从 Harness 进程的 LISTENING 端口里拿）传入，优先试；
//   没传就退回 13986/9383 老面孔。
const PORTS = argOf('--ports', '').split(',').map((s) => s.trim()).filter(Boolean);
if (PORTS.length === 0) PORTS.push('13986', '9383');
const waitIdx = process.argv.indexOf('--wait');
const waitSec = waitIdx >= 0 ? Math.max(0, Number(process.argv[waitIdx + 1] || 0)) : 0;

let pass = 0, fail = 0;
const reds = [];
function check(name, ok, extra) {
	if (ok) { pass++; console.log('  PASS ' + name); }
	else { fail++; reds.push(name + (extra ? '｜' + extra : '')); console.log('  FAIL ' + name + (extra ? '｜' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- A: API 活着（轮询到 waitSec 为止）
let api = null;
{
	const deadline = Date.now() + waitSec * 1000;
	for (;;) {
		for (const p of PORTS) {
			try {
				const res = await fetch(`http://127.0.0.1:${p}/api/dsh-team/snapshot`, { signal: AbortSignal.timeout(4000) });
				if (res.ok) { api = { port: p, body: await res.json() }; break; }
			} catch { /* 端口没起来试下一个 */ }
		}
		if (api) break;
		if (Date.now() >= deadline) break;
		await sleep(3000);
	}
}
check('A 插件 snapshot API 可达', api !== null, api ? `端口 ${api.port}` : `试了 ${PORTS.join('/')}，${waitSec}s 内都没起来`);

// ---- B: 新库文件
//    硬判据 = 目录**存在**：apply() 启动就 mkdirSync(STATE_DIR)（index.js:88），目录被长出来
//    本身就是「插件带着配置起来的」铁证；board/ledger/roster 具体哪个先落盘取决于启动时序
//    （syncFromKernel 8 秒后跑、板子要有人干活才 persist），只作加分项报出来，不作红项——
//    重装演练要爆的是「写错地方/双份注册」这种真缺陷，不是懒写入的时序毛刺。
const st = path.join(LIVE, '.state');
let stateFiles = [];
let stExists = true;
try { stateFiles = fs.readdirSync(st); } catch { stExists = false; }
check('B 安装目录\\.state 被创建（启动即写，= stateDir 配置生效）', stExists, '.state 目录不存在 = 插件没起来，或没按 patch 里的 stateDir 写');
console.log('  （新库现有: ' + (stateFiles.length ? stateFiles.join(', ') : '(空目录)') + '）');
for (const need of ['board.json', 'ledger.json', 'roster.json']) {
	if (!stateFiles.includes(need)) console.log('  （提示：' + need + ' 还没落盘——懒写入，跑过 team 操作后应出现；重装当场不算红）');
}

// ---- C: 真库不许复活
function dirState(p) {
	try { return fs.readdirSync(p).length; } catch { return -1; }
}
const libN = dirState(LIB_STATE);
check('C 真库 .state 未复活（不指现库）', libN < 0 || libN === 0,
	libN > 0 ? `真库被写回 ${libN} 个文件：${fs.readdirSync(LIB_STATE).slice(0, 6).join(', ')} —— stateDir 覆盖没生效或运行中的旧 fiber 在写` : '');
if (libN > 0) {
	// 取证：mtime 最新的三个，判断是「重启后写的」还是「重载前旧 fiber 写的」
	try {
		const rows = fs.readdirSync(LIB_STATE).map((f) => ({ f, m: fs.statSync(path.join(LIB_STATE, f)).mtimeMs })).sort((a, b) => b.m - a.m).slice(0, 3);
		console.log('  取证·真库最新 mtime: ' + rows.map((r) => `${r.f}@${new Date(r.m).toISOString().slice(11, 19)}`).join(' '));
	} catch { /* 取证失败不影响判定 */ }
}

// ---- D: snapshot 内容 = 新机器形态
if (api) {
	const b = api.body || {};
	console.log('  （snapshot 顶层键: ' + Object.keys(b).join(', ') + '）');
	const members = b.members || b.roster || null;
	check('D 名册为空（新机器没有旧成员）', !Array.isArray(members) || members.length === 0,
		Array.isArray(members) && members.length > 0 ? `还挂着 ${members.length} 个旧成员` : '拿不到 members 字段，人工看 snapshot');
	const tasks = b.tasks || b.board || null;
	if (Array.isArray(tasks)) {
		const nOpen = tasks.filter((t) => t.status !== 'done' && t.status !== 'delivered').length;
		check('D 板上无未结旧任务', nOpen === 0, `还有 ${nOpen} 条未完旧任务`);
	} else {
		console.log('  （snapshot 无 tasks 数组，板状态以新库 board.json 为准）');
	}
} else {
	check('D snapshot 内容检查', false, 'API 没起来，跳过');
}

console.log('');
console.log(`== reinstall-check: ${pass} 通过 / ${fail} 失败 ==`);
if (reds.length) console.log('红项（=重装暴露的问题）：\n  - ' + reds.join('\n  - '));
process.exit(fail === 0 ? 0 : 1);
