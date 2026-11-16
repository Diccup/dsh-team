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
# reinstall-team.ps1 — TEAM 一键重装 / 一键安装（探测式，2026-11-02 设计确定：稿）
#
# 维护方的设计（原话）：「先探测电脑系统盘是否安装DSH，安装了以后直接找插件目录放，
#                      并注册那2条信息不就行了？」
# 落地成三步走，**本机零写死路径**：
#   0 detect  : 探测 DSH 根 → profile 目录 → 插件安装目录 → 现有 stateDir（从 patch 里读回来）
#               → node/pnpm 运行时 → Harness 可执行文件。
#               ★ 维护方 2026-11-02 定：**检测不到 DSH 就 BREAK**（打印「本插件仅支持 DSH，
#                 请先安装 DSH 再执行」，退出码 2），绝不瞎猜路径往下写。
#   2 wipe    : 演练用——清 C 的 .state / 真库改名挪开 / .dsh\team 改名 / 拆注册两条 + 链接
#   3 install : 放文件 + 注册 package.json（deps 行 + bundles）+ 注册 cordis.patch.yml（insert 块）
#               + 建 node_modules 链接 + pnpm install 尽力跑
#   4 start   : 拉起 Harness
#   5 check   : node reinstall-check.mjs 机器化验收
#
# 用法：
#   pwsh -File reinstall-team.ps1                       # 全流程（第 1 步会关 Harness，会话内跑会自断，用 -FromStep 2 续）
#   pwsh -File reinstall-team.ps1 -ToStep 3 -SkipWipe   # **纯安装**：新机器/首次装机就这一条
#   pwsh -File reinstall-team.ps1 -FromStep 2 -Force    # 演练：清+装（进程没关时 -Force 明知故犯）
#   pwsh -File reinstall-team.ps1 -Restore <备份目录>    # 回退：注册面+数据原样铺回
#   pwsh -File reinstall-team.ps1 -DryRun               # 只报不动
#   假树预演：-DshRoot <dir> -ProfileDir <dir> -LiveDir <dir> -LibDir <dir>（给了就跳过探测）

param(
    [int]$FromStep = 1,
    [int]$ToStep = 5,
    [string]$Restore = '',
    [switch]$DryRun,
    [switch]$Force,
    [switch]$SkipWipe,
    # 新机器模拟（演练用）：注册时往 profile patch 写 stateDir=<安装目录>\.state 的**覆盖块**，
    # 插件长出一全新空库，**绝不碰检测到的旧数据目录**（旧库留作探测器：复活=覆盖没生效判红）。
    # 不给这个开关 = 正规纯装：只注册两条、不写 patch，数据目录跟插件源码默认走。
    [switch]$Fresh,
    # 源目录（从这里 robocopy 到插件安装位）。默认 = 脚本所在目录的上一级：
    #   开发仓库里脚本在 Updating\ → 上一级=仓库根；发包里脚本在 setup\ → 上一级=包根。
    #   两种布局同一个默认值都对，发包不需要改任何路径。
    [string]$RepoDir = '',
    [string]$DshRoot = '',
    [string]$ProfileDir = '',
    [string]$LiveDir = '',
    [string]$LibDir = '',
    [string]$Exe = '',
    # 显式指定运行时：假树预演时用它把真 node/pnpm 借进来，验证 pnpm install 这一步
    [string]$Node = '',
    [string]$Pnpm = ''
)

$ErrorActionPreference = 'Stop'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
# RepoDir 空 = 脚本所在目录的上一级：开发仓库（Updating\）和发包（setup\）两种布局同一个
# 默认值都对 —— 发包不需要为装机脚本改任何路径。
if ($RepoDir -eq '') { $RepoDir = Split-Path $PSScriptRoot -Parent }

function Log($m) { Write-Host ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m) }
function Guard($p) {
    if (-not (Test-Path $p)) { throw "目标路径不存在，拒绝继续: $p" }
    Log ("  操作目标: $p")
}
function HarnessAlive {
    return (Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Measure-Object).Count -gt 0
}

# ============================================================ 0) 探测
function Find-DshRoot {
    $cands = [System.Collections.Generic.List[string]]::new()
    if ($env:DSH_HOME) { $cands.Add($env:DSH_HOME) }
    if ($env:USERPROFILE) { $cands.Add((Join-Path $env:USERPROFILE '.dsh')) }
    # 系统盘 + 其它固定盘的 Users\*\.dsh 与根 .dsh（维护方这台 DSH 在 F 盘、数据在 C 盘，必须全盘找）
    # 测试口子：DSH_TEAM_REINSTALL_NO_SCAN=1 时跳过扫盘（只认 env），用来在装过 DSH 的机器上
    # 复现「新机器没装 DSH」那条 BREAK 分支 —— 除此之外没有别的作用。
    if ($env:DSH_TEAM_REINSTALL_NO_SCAN -eq '1') {
        $hits = [System.Collections.Generic.List[object]]::new()
        return $hits
    }
    foreach ($drv in [System.IO.DriveInfo]::GetDrives()) {
        if ($drv.DriveType -ne 'Fixed' -or -not $drv.IsReady) { continue }
        $r = $drv.RootDirectory.FullName.TrimEnd('\')
        $cands.Add("$r\.dsh")
        if (Test-Path "$r\Users") {
            foreach ($u in (Get-ChildItem "$r\Users" -Directory -ErrorAction SilentlyContinue)) {
                $cands.Add((Join-Path $u.FullName '.dsh'))
            }
        }
    }
    $hits = [System.Collections.Generic.List[object]]::new()
    $seen = [System.Collections.Generic.HashSet[string]]::new()
    foreach ($c in $cands) {
        if (-not $c) { continue }
        try {
            if (-not (Test-Path $c)) { continue }
            # 去重：env 给的、C:\.dsh、C:\Users\*\.dsh 常常是同一个目录的三种写法
            $rp = (Resolve-Path $c).ProviderPath
            $key = $rp.TrimEnd('\').ToLowerInvariant()
            if (-not $seen.Add($key)) { continue }
            $hasProfiles = Test-Path (Join-Path $rp 'profiles')
            $hasPlugins = Test-Path (Join-Path $rp 'plugins')
            if ($hasProfiles -or $hasPlugins) {
                $hits.Add([pscustomobject]@{ dir = $rp; profiles = $hasProfiles; plugins = $hasPlugins })
            }
        } catch { continue }
    }
    # 「profiles 和 plugins 都齐」的最先，其次 profiles-only
    $hits = @($hits | Sort-Object -Property @{e={ if ($_.profiles -and $_.plugins) { 2 } elseif ($_.profiles) { 1 } else { 0 } }; Descending=$true })
    return [System.Collections.Generic.List[object]]($hits)
}

function Find-ProfileDirs($root) {
    $rows = [System.Collections.Generic.List[object]]::new()
    $pdir = Join-Path $root 'profiles'
    if (-not (Test-Path $pdir)) { return $rows }
    foreach ($d in (Get-ChildItem $pdir -Directory -ErrorAction SilentlyContinue)) {
        $pj = Join-Path $d.FullName 'package.json'
        if (-not (Test-Path $pj)) { continue }
        $j = $null
        try { $j = Get-Content $pj -Raw | ConvertFrom-Json } catch { }
        $bundles = @()
        if ($j -and $j.dsh -and $j.dsh.profile -and $j.dsh.profile.bundles) { $bundles = @($j.dsh.profile.bundles) }
        $hasTeam = ($bundles -contains 'dsh-team') -or ($j -and $j.dependencies.PSObject.Properties['dsh-team'])
        $patch = Join-Path $d.FullName 'cordis.patch.yml'
        $patchTxt = ''
        if (Test-Path $patch) { $patchTxt = Get-Content $patch -Raw }
        $rows.Add([pscustomobject]@{
                dir        = $d.FullName
                name       = $d.Name
                hasTeam    = [bool]$hasTeam
                bundles    = $bundles.Count
                hasPatch   = [bool](Test-Path $patch)
                hasAllowed = [bool]($patchTxt -match 'allowedModels')
           })
    }
    # 排序：已声明 dsh-team 的优先 → 有 bundles 的 → 有 allowedModels 的 → bundles 多的
    return $rows | Sort-Object -Property @{e={ $_.hasTeam }; Descending=$true},
                                         @{e={ $_.bundles }; Descending=$true},
                                         @{e={ $_.hasAllowed }; Descending=$true}
}

function Get-PatchStateDir($profileDirPath, $pluginDir) {
    # 从现有注册里把「数据现在到底写哪」读回来 —— 真库位置的唯一可信来源，不靠记忆写死。
    # 找的顺序：profile patch → 插件自带 patch（bundle patch 也算现配置）；
    # 任何顶层 `- xxx` 块（insert / id 覆盖块都罩），块内含 dsh-team 且写了 stateDir 才算数。
    foreach ($pf in @((Join-Path $profileDirPath 'cordis.patch.yml'), $(if ($pluginDir) { Join-Path $pluginDir 'cordis.patch.yml' } else { $null }))) {
        if (-not $pf -or -not (Test-Path $pf)) { continue }
        $txt = Get-Content $pf -Raw
        $blocks = [regex]::Matches($txt, '(?ms)^- [^\r\n]*(?:\r?\n(?!\S)[^\r\n]*)*')
        foreach ($b in $blocks) {
            if ($b.Value -notmatch 'dsh-team') { continue }
            $m = [regex]::Match($b.Value, "stateDir:\s*'([^']+)'|stateDir:\s`"([^`"]+)`"|stateDir:\s*(\S+)")
            if ($m.Success) {
                foreach ($g in 1..3) { if ($m.Groups[$g].Value) { return ($m.Groups[$g].Value -replace '\\\\', '\') } }
            }
        }
    }
    return ''
}

function Find-NodeRuntime($root) {
    $pats = @(
        (Join-Path $root 'dsh-runtimes\*\dependencies\node\bin\node.exe'),
        (Join-Path $root 'dsh-runtimes\*\node\bin\node.exe'),
        (Join-Path $root 'runtime*\**\node.exe')
    )
    foreach ($p in $pats) {
        $f = Get-ChildItem -Path $p -File -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($f) { return $f.FullName }
    }
    $w = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
    if ($w) { return $w }
    return ''
}
function Find-PnpmCli($root, $nodePath) {
    foreach ($p in @((Join-Path $root 'dsh-runtimes\*\dependencies\pnpm\bin\pnpm.cjs'),
                     (Join-Path $root 'dsh-runtimes\*\pnpm\bin\pnpm.cjs'))) {
        $f = Get-ChildItem -Path $p -File -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($f) { return $f.FullName }
    }
    if ($nodePath) {
        $side = Join-Path (Split-Path (Split-Path $nodePath -Parent) -Parent) 'pnpm\bin\pnpm.cjs'
        if (Test-Path $side) { return $side }
    }
    return ''
}
function Find-HarnessExe {
    $pr = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($pr -and $pr.Path) { return $pr.Path }
    # ★ 发布版可移植化（2026-11-16）：原先钉死 F:\ / C:\ 盘两个位置。
    #   现在扫所有固定盘根下的 "Ds harness\DeepSeek Harness.exe" 与
    #   "<盘>\Users\<用户>\AppData\Local\Programs\DeepSeek Harness\..." 等常见安装位。
    foreach ($drv in [System.IO.DriveInfo]::GetDrives()) {
        if ($drv.DriveType -ne 'Fixed' -or -not $drv.IsReady) { continue }
        $r = $drv.RootDirectory.FullName.TrimEnd('\')
        foreach ($rel in @('Ds harness\DeepSeek Harness.exe',
                           'Program Files\DeepSeek Harness\DeepSeek Harness.exe',
                           'Program Files (x86)\DeepSeek Harness\DeepSeek Harness.exe')) {
            $c = Join-Path $r $rel
            if (Test-Path $c) { return $c }
        }
    }
    return ''
}

# ---- 探测落定（给了参数就按参数，跳过探测）
Log '== 0/5 探测本机 DSH 安装 =='
$detLog = [ordered]@{}
if (-not $DshRoot) {
    $found = Find-DshRoot
    if ($found.Count -eq 0) {
        Write-Host ''
        Write-Host '=================================================================='
        Write-Host '  BREAK：这台机器上没有检测到 DSH（DeepSeek Harness）。'
        Write-Host '  本插件（dsh-team）仅支持 DSH —— 它是 DSH 的插件，'
        Write-Host '  注册要写进 DSH 的 profile 目录，没有 DSH 就没有注册的地方。'
        Write-Host '  请先安装 DSH 并至少启动过一次（让它建出 .dsh\profiles），'
        Write-Host '  再重新执行本脚本。'
        Write-Host '=================================================================='
        exit 2
    }
    if ($found.Count -gt 1) {
        $marks = @($found | ForEach-Object { $_.dir + $(if ($_.profiles) { ' [有profiles]' } else { '' }) })
        Log ("  发现多个候选: " + ($marks -join ' , '))
    }
    # 取「有 profiles」里排最前的；都一致时取第一个
    $pref = @($found | Where-Object { $_.profiles })
    if ($pref.Count -eq 0) { $pref = @($found) }
    $DshRoot = $pref[0].dir
}
$detLog['DSH根'] = $DshRoot
Guard $DshRoot | Out-Null

if (-not $LiveDir) { $LiveDir = Join-Path $DshRoot 'plugins\dsh-team' }
$detLog['插件安装目录'] = $LiveDir

if (-not $ProfileDir) {
    $profs = Find-ProfileDirs $DshRoot
    if ($profs.Count -eq 0) {
        Write-Host ''
        Write-Host '=================================================================='
        Write-Host "  BREAK：$DshRoot 下没有可用的 DSH profile（profiles\<x>\package.json）。"
        Write-Host '  本插件（dsh-team）仅支持 DSH —— 请确认 DSH 已安装**并启动过一次**'
        Write-Host '  （首次启动才会建出 profile 目录），再重新执行本脚本。'
        Write-Host '=================================================================='
        exit 2
    }
    $top = @($profs)[0]
    if ($profs.Count -gt 1) {
        Log ("  profile 候选: " + ((@($profs) | ForEach-Object { $_.name + "(team=$($_.hasTeam),bundles=$($_.bundles),allowed=$($_.hasAllowed))" }) -join ' | '))
    }
    $ProfileDir = $top.dir
}
$detLog['profile'] = $ProfileDir

# 现有 stateDir（数据目录位置）：优先参数 → patch（profile 覆盖块或插件自带）里读回来的
#   → 安装目录\.state。★ 本机特例：仓库版 config.js 把默认钉在 F 盘真库（LEGACY_STATE），
#   patch 里没 stateDir 时**真正在用的就是那个**——读不到任何 stateDir 配置、且这份源码是
#   仓库版（LEGACY_STATE 是绝对路径），就按 LEGACY_STATE 报，别让探测把数据目录指错地方。
if (-not $LibDir) {
    $sd = Get-PatchStateDir $ProfileDir $LiveDir
    if ($sd -and (Test-Path $sd)) {
        $LibDir = $sd
        $detLog['现有 stateDir(patch读)'] = $sd
    } else {
        # 问这份源码自己：import config.js 拿 DEF.stateDir（发包版=安装目录\.state，仓库版=F 盘真库）
        $detLog['现有 stateDir(patch读)'] = if ($sd) { "$sd（路径不存在，忽略）" } else { '(patch 里没有 stateDir 行)' }
        $srcDef = ''
        $cfgJs = Join-Path $LiveDir 'src\config.js'
        if (Test-Path $cfgJs) {
            $jn = Find-NodeRuntime $DshRoot
            if ($jn) {
                try {
                    # import 必须走 file:/// URL（裸反斜杠 Windows 路径 Node 不认）；整条 -e 用双引号包，
                    # JS 侧参数用单引号，路径里的反斜杠全换成正斜杠
                    $url = 'file:///' + $cfgJs.Replace('\', '/').Replace(' ', '%20')
                    $js = "import { STATE_DIR_DEFAULT } from '$url'; console.log(STATE_DIR_DEFAULT)"
                    $probe = & $jn --input-type=module -e $js 2>$null
                    if ($LASTEXITCODE -eq 0 -and $probe) { $srcDef = (@($probe) | Select-Object -First 1).Trim() }
                } catch { }
            }
        }
        if ($srcDef) {
            $LibDir = $srcDef
            $detLog['数据目录(源码默认)'] = $srcDef
        } else {
            $LibDir = Join-Path $LiveDir '.state'
        }
    }
}
$detLog['数据目录'] = $LibDir
$detLog['node 运行时'] = Find-NodeRuntime $DshRoot
$detLog['pnpm cli'] = Find-PnpmCli $DshRoot $detLog['node 运行时']
$detLog['Harness exe'] = Find-HarnessExe
$detLog['Harness 进程'] = if (HarnessAlive) { '在跑' } else { '未跑' }
foreach ($k in $detLog.Keys) { Log ("  {0}: {1}" -f $k, $(if ($detLog[$k]) { $detLog[$k] } else { '(未探测到)' })) }

$repo = $RepoDir
$lib = $LibDir
$live = $LiveDir
$profile_ = $ProfileDir
$dshRoot = $DshRoot
if ($Node) { $detLog['node 运行时'] = $Node }
if ($Pnpm) { $detLog['pnpm cli'] = $Pnpm }
$node = $detLog['node 运行时']
$exe = if ($Exe) { $Exe } else { $detLog['Harness exe'] }

if ($ToStep -le 0 -and $Restore -eq '') { Log '只探测（-ToStep 0）：以上路径就是本脚本接下来会动的东西，未做任何修改。'; exit 0 }

# ============================================================ restore
if ($Restore -ne '') {
    $bk = $Restore
    Guard $bk
    Log "== 回退模式：从 $bk 恢复 =="
    if ((HarnessAlive) -and (-not $Force) -and (-not $DryRun)) { throw 'Harness 还活着，恢复前先关它（或加 -Force）' }
    # 真库原址 = 演练时被改名挪走的那个 .state（探测器）。先把它改回来，这是第一优先。
    $libParent = Split-Path $lib -Parent
    $origState = Join-Path $libParent '.state'
    $aside = @(Get-ChildItem $libParent -Directory -Filter '.state.pre-reinstall-*' -ErrorAction SilentlyContinue) |
             Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($aside -and -not (Test-Path $origState)) {
        if (-not $DryRun) { Move-Item $aside.FullName $origState }
        Log ("  数据目录改名回来: $($aside.Name) -> .state")
    } elseif ($aside -and (Test-Path $origState)) {
        $nowDir = Join-Path $libParent ".state.drill-$stamp"
        if (-not $DryRun) { Move-Item $origState $nowDir }
        Log ("  演练期间的新库让位 -> $nowDir（真库仍停在 $($aside.Name)，下一步用备份铺回）")
    }
    foreach ($pair in @(
        @{ s = Join-Path $bk 'state-真库';   d = $origState },
        @{ s = Join-Path $bk '注册面\package.json';        d = Join-Path $profile_ 'package.json' },
        @{ s = Join-Path $bk '注册面\cordis.patch.yml';    d = Join-Path $profile_ 'cordis.patch.yml' },
        @{ s = Join-Path $bk '注册面\pnpm-workspace.yaml'; d = Join-Path $profile_ 'pnpm-workspace.yaml' },
        @{ s = Join-Path $bk 'team目录';     d = Join-Path $dshRoot 'team' }
    )) {
        if (-not (Test-Path $pair.s)) { Log ("  跳过（备份无此项）: " + $pair.s); continue }
        if ($DryRun) { Log ("  [dry] " + $pair.s + " -> " + $pair.d); continue }
        if ((Get-Item $pair.s).PSIsContainer) {
            New-Item -ItemType Directory -Path $pair.d -Force | Out-Null
            robocopy $pair.s $pair.d /E /NFL /NDL /NJH /NJS | Out-Null
            if ($LASTEXITCODE -ge 8) { throw ("恢复失败 " + $pair.s) }
        } else {
            Copy-Item $pair.s $pair.d -Force
        }
        Log ("  已恢复 -> " + $pair.d)
    }
    $nmLink = Join-Path $profile_ 'node_modules\dsh-team'
    if (-not (Test-Path $nmLink) -and (Test-Path $live)) {
        New-Item -ItemType Junction -Path $nmLink -Target $live | Out-Null
        Log '  重建 node_modules 链接'
    }
    Log '恢复完。重启 DSH 后回到演练前状态（stateDir 回原默认=真库）。'
    exit 0
}

# ============================================================ 1) close
if ($FromStep -le 1 -and $ToStep -ge 1 -and -not $SkipWipe) {
    Log '== 1/5 关闭 DeepSeek Harness =='
    if (-not (HarnessAlive)) { Log '  没在跑，跳过' }
    elseif ($DryRun) { Log '  [dry] 跳过 Stop-Process' }
    else {
        Log '  ⚠ 会话内跑到这里会被切断（预期内），外部续跑: -FromStep 2'
        Stop-Process -Name 'DeepSeek Harness' -Force -ErrorAction SilentlyContinue
        $t = 0
        while ((HarnessAlive) -and ($t -lt 30)) { Start-Sleep -Seconds 1; $t++ }
        Log ("  等进程退净 $t 秒")
    }
}
if ($ToStep -le 1) { exit 0 }

# ============================================================ 2) wipe
if ($FromStep -le 2 -and $ToStep -ge 2 -and -not $SkipWipe) {
    Log '== 2/5 清空（演练专用；纯安装加 -SkipWipe 跳过这步） =='
    if ((HarnessAlive) -and (-not $Force) -and (-not $DryRun)) {
        throw 'Harness 还活着：内存态会把刚清的数据写回来，测不出真问题。先跑第 1 步，或 -Force 明知故犯。'
    }
    $cState = Join-Path $live '.state'
    if (Test-Path $cState) {
        Guard $cState
        if (-not $DryRun) { Remove-Item $cState -Recurse -Force }
        Log '  删 安装目录\.state'
    }
    foreach ($d in (Get-ChildItem $live -Directory -Filter '.state.bak-*' -ErrorAction SilentlyContinue)) {
        if (-not $DryRun) { Remove-Item $d.FullName -Recurse -Force }
        Log ("  删旧备份 " + $d.Name)
    }
    # 数据目录：**不删**，改名挪开（第二份备份 + 「不指现库」的探测器）
    if (Test-Path $lib) {
        Guard $lib
        $aside = $lib + ".pre-reinstall-$stamp"
        if (-not $DryRun) { Move-Item $lib $aside }
        Log ("  数据目录已挪开 -> $aside")
    }
    $teamDir = Join-Path $dshRoot 'team'
    if (Test-Path $teamDir) {
        Guard $teamDir
        if (-not $DryRun) { Move-Item $teamDir (Join-Path $dshRoot ("team.gone-$stamp")) }
        Log '  <.dsh>\team 已改名挪走（不是删）'
    }
    # 拆注册两条 + 链接
    $reg = Join-Path $profile_ 'package.json'
    Guard $reg
    if ($DryRun) { Log '  [dry] 跳过拆注册' } else {
        Copy-Item $reg ($reg + ".bak-$stamp") -Force
        $j = Get-Content ($reg + ".bak-$stamp") -Raw | ConvertFrom-Json
        if ($j.dependencies.PSObject.Properties['dsh-team']) {
            $j.dependencies.PSObject.Properties.Remove('dsh-team')   # PSCustomObject 没有 RemoveProperty() 方法（假树预演炸出来的）
        }
        if ($j.dsh -and $j.dsh.profile -and $j.dsh.profile.bundles) {
            $j.dsh.profile.bundles = @($j.dsh.profile.bundles | Where-Object { $_ -ne 'dsh-team' })
        }
        $j | ConvertTo-Json -Depth 10 | Set-Content $reg -Encoding UTF8
        Log '  package.json 去注册（deps+bundles，已 .bak）'

        $patch = Join-Path $profile_ 'cordis.patch.yml'
        Copy-Item $patch ($patch + ".bak-$stamp") -Force
        $blocks = [System.Collections.Generic.List[System.Collections.Generic.List[string]]]::new()
        $cur = $null
        $header = [System.Collections.Generic.List[string]]::new()
        foreach ($l in (Get-Content ($patch + ".bak-$stamp"))) {
            if ($l -match '^- ') {
                if ($cur) { $blocks.Add($cur) }
                $cur = [System.Collections.Generic.List[string]]::new()
                $cur.Add($l)
            } elseif ($null -eq $cur) { $header.Add($l) } else { $cur.Add($l) }
        }
        if ($cur) { $blocks.Add($cur) }
        $out = [System.Collections.Generic.List[string]]::new()
        foreach ($l in $header) { $out.Add($l) }
        $dropped = 0
        foreach ($b in $blocks) {
            if (($b -join "`n") -match 'dsh-team') { $dropped++; continue }
            foreach ($l in $b) { $out.Add($l) }
        }
        if ($dropped -gt 0) {
            [System.IO.File]::WriteAllLines($patch, $out)
            Log ("  cordis.patch.yml 去注册（整块删 $dropped 块，已 .bak）")
        } else { Log '  cordis.patch.yml 本就没有 dsh-team 块（无动作）' }

        $nmLink = Join-Path $profile_ 'node_modules\dsh-team'
        if (Test-Path $nmLink) {
            cmd /c "rmdir `"$nmLink`"" | Out-Null
            if (Test-Path $nmLink) { throw "拆链接失败: $nmLink" }
            Log '  拆 node_modules\dsh-team 链接（只拆链接本体）'
        }
    }
}
if ($ToStep -le 2) { Log '到达 -ToStep=2：清完。回退用 -Restore <备份>。'; exit 0 }

# ============================================================ 3) install
if ($FromStep -le 3) {
    Log '== 3/5 放文件 + 注册两条（维护方的定稿做法） =='
    if ($DryRun) { Log '  [dry] 跳过'; }
    else {
        Guard $repo
        # 3a 放文件：整包镜像，开发物全排除（setup\ = 发包里的装机脚本目录，也不进安装位）
        New-Item -ItemType Directory -Path $live -Force | Out-Null
        robocopy $repo $live /MIR /XD Updating retired .state node_modules __pycache__ setup /XF '*.bak-*' /NFL /NDL /NJH /NJS | Out-Null
        if ($LASTEXITCODE -ge 8) { throw 'robocopy 铺文件失败' }
        Log ("  铺文件 -> $live")

        # 3b 注册第一条：profile\package.json —— dependencies 的 link + dsh.profile.bundles
        $reg = Join-Path $profile_ 'package.json'
        Guard $reg
        Copy-Item $reg ($reg + ".bak-$stamp") -Force
        $j = Get-Content $reg -Raw | ConvertFrom-Json
        $linkVal = 'link:' + $live.Replace('\', '/')
        $j.dependencies | Add-Member -Force -MemberType NoteProperty -Name 'dsh-team' -Value $linkVal
        if (-not $j.dsh) { $j | Add-Member -Force -MemberType NoteProperty -Name 'dsh' -Value ([pscustomobject]@{ profile = [pscustomobject]@{ bundles = @() } }) }
        if (-not $j.dsh.profile) { $j.dsh | Add-Member -Force -MemberType NoteProperty -Name 'profile' -Value ([pscustomobject]@{ bundles = @() }) }
        if (-not $j.dsh.profile.bundles) { $j.dsh.profile | Add-Member -Force -MemberType NoteProperty -Name 'bundles' -Value @() }
        if (@($j.dsh.profile.bundles) -notcontains 'dsh-team') {
            $j.dsh.profile.bundles = @($j.dsh.profile.bundles) + 'dsh-team'
        }
        $j | ConvertTo-Json -Depth 10 | Set-Content $reg -Encoding UTF8
        Log ("  注册 package.json: dsh-team = $linkVal（+ bundles）")

        # 3c 配置覆盖块（**只有 -Fresh 演练才写**）：cordis.patch.yml 写 `- id: dsh-team` 覆盖块
        #    把 stateDir 钉到 <安装目录>\.state = 模拟新机空库、绝不碰检测到的旧数据目录。
        #    正规纯装不跑这段：只注册两条，数据目录跟源码默认走（本机=旧库原样接上）。
        #    为什么是覆盖块而不是 insert 块（2026-11-02 对着内核源码查实的）：
        #      · 插件 package.json 有 "dsh":{"bundle":{"patch":"./cordis.patch.yml"}}，那份自带
        #        patch 里的 `- insert:`（顶层无 id）走 `data.push` 把条目追加进树 —— bundles 列了
        #        它条目就存在（本机实测：desktop 的 patch 里根本没有 dsh-team 块，插件照样跑）。
        #      · profile 再写一遍 `- insert:` = 同 id 双份注册，绝不做；改配置的正确形状是
        #        `- id:` + `config:`（源码 104-107 行=覆盖已有条目字段，条目不存在只 warn 跳过）。
        if ($Fresh) {
        $patch = Join-Path $profile_ 'cordis.patch.yml'
        if (-not (Test-Path $patch)) {
            Log "  profile 里没有 cordis.patch.yml，新建一份"
            Set-Content $patch "# dsh-team 装机生成的注册文件`n" -Encoding UTF8
        } else {
            Copy-Item $patch ($patch + ".bak-$stamp") -Force
        }
        $escLive = $live.Replace('\', '\\')
        $escRoot = $dshRoot.Replace('\', '\\')
        $block = @(
            '- id: dsh-team'
            '  config:'
            '    renderLedger: true'
            "    stateDir: '$escLive\\.state'"
            "    workspaceRoot: '$escRoot'"
        )
        $ptxt = Get-Content $patch -Raw
        # 已有该 id 的覆盖块 → 替换（幂等）；没有 → 追加
        $re = [regex]'(?ms)^- id: dsh-team[\s\S]*?(?=^- |\z)'
        if ($re.IsMatch($ptxt)) {
            $new = $re.Replace($ptxt, (($block -join "`r`n") + "`r`n"), 1)
            [System.IO.File]::WriteAllText($patch, $new, [System.Text.UTF8Encoding]::new($false))
            Log '  cordis.patch.yml：覆盖块已存在，原位更新（幂等）'
        } elseif ($ptxt -match "name: '?dsh-team'?") {
            # profile 里是老的 insert 块形状（别人照旧版 INSTALL.md 手写的）：不再叠加，只提示
            [System.IO.File]::AppendAllText($patch, (($block -join "`r`n") + "`r`n"), [System.Text.UTF8Encoding]::new($false))
            Log '  ⚠ profile 里已有 dsh-team 的 insert 块，实现方又追加了覆盖块；两条并存时以内核后读的覆盖块为准，建议人工删掉老的 insert 块'
        } else {
            [System.IO.File]::AppendAllText($patch, ("`r`n" + (($block -join "`r`n") + "`r`n")), [System.Text.UTF8Encoding]::new($false))
            Log "  cordis.patch.yml 追加配置覆盖块（stateDir=$live\.state）"
        }
        } else { Log '  正规装：不写 profile patch（配置走插件自带那份），只注册两条。' }

        # 3d node_modules 链接：优先 pnpm，建不成手搭 Junction
        $nmLink = Join-Path $profile_ 'node_modules\dsh-team'
        $pnpm = $detLog['pnpm cli']
        $done = $false
        if ($pnpm -and $node) {
            try {
                Push-Location $profile_
                $outp = & $node $pnpm install --prefer-offline 2>&1
                Pop-Location
                $done = Test-Path $nmLink
                $linkMsg = if ($done) { '成' } else { '未成' }
                Log ("  pnpm install: " + ((@($outp) | Select-Object -Last 2) -join ' | ') + " -> 链接 $linkMsg")
            } catch {
                Pop-Location
                Log ("  pnpm install 异常: " + $_.Exception.Message.Substring(0, [Math]::Min(90, $_.Exception.Message.Length)))
            }
        } else { Log '  没探测到 pnpm，直接手搭链接' }
        if (-not (Test-Path $nmLink)) {
            New-Item -ItemType Junction -Path $nmLink -Target $live | Out-Null
            Log "  Junction: $nmLink -> $live"
        }
        Log '  正规两条齐了（package.json 的 dependencies + bundles）。'
        Log '  生效检查：新建会话发 team(status)，出 JSON 即成 —— 装了 HMR 的宿主会当场重组树'
        Log '  （2026-11-02 真机实测免重启）。没反应再完全退出重开 DSH（兜底，不是必然）。'
    }
}
if ($ToStep -le 3) { Log '到达 -ToStep=3：装好了，没启动。检查后 -FromStep 4 续。'; exit 0 }

# ============================================================ 4) start
if ($FromStep -le 4 -and $ToStep -ge 4) {
    Log '== 4/5 启动 DSH =='
    if ($DryRun) { Log '  [dry] 跳过' }
    else {
        if (-not $exe) { throw '探测不到 DeepSeek Harness.exe，手给 -Exe 或自己开' }
        Guard $exe
        Start-Process $exe
        Start-Sleep -Seconds 5
    }
}
if ($ToStep -le 4) { exit 0 }

# ============================================================ 5) check
if ($FromStep -le 5) {
    Log '== 5/5 机器化验收 =='
    if ($DryRun -or -not $node) { Log '  跳过（-DryRun 或没有 node）' }
    else {
        # GUI 端口每次重启都可能换：从新起的 Harness 进程监听端口里拿，喂给 check 优先试
        $ports = @()
        foreach ($pp in (Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)) {
            try {
                $ports += (Get-NetTCPConnection -State Listen -OwningProcess $pp.Id -ErrorAction SilentlyContinue |
                    Where-Object { $_.LocalAddress -match '^(127\.|0\.0\.0\.0|::1)' } |
                    ForEach-Object { [string]$_.LocalPort })
            } catch { }
        }
        $ports = @($ports | Select-Object -Unique)
        Log ("  新进程监听端口: " + $(if ($ports.Count) { $ports -join ',' } else { '(没抓到，check 退回老端口名单)'}))
        $argp = @()
        if ($ports.Count) { $argp = @('--ports', ($ports -join ',')) }
        # check 脚本跟本脚本放一起（仓库=Updating\，发包=setup\），$PSScriptRoot 两种布局都对
        & $node (Join-Path $PSScriptRoot 'reinstall-check.mjs') --wait 60 --live $live --libstate $lib @argp
        Log ("  check 退出码 $LASTEXITCODE（红项=重装暴露的问题）")
    }
}
Log '完。人工收尾：新会话发 team(status) 应为空板 JSON；team(scan) 应能收模型。'
