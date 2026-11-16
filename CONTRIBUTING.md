# Contributing

感谢参与。

## 提交信息规范（Conventional Commits）

```
<type>(<scope>): <简短描述>

[正文：为什么这么改，不是改了什么]

[脚注：BREAKING CHANGE / Closes #123]
```

**type**（必须小写）：

| type | 用在哪 |
|---|---|
| `feat` | 新功能 |
| `fix` | 修 bug |
| `docs` | 只改文档 |
| `refactor` | 不改行为的重构 |
| `perf` | 性能 |
| `test` | 测试 |
| `build` | 构建 / 打包 / 依赖 |
| `ci` | CI 配置 |
| `chore` | 杂务 |
| `revert` | 回退 |

**scope**：模块名（`config` / `engine` / `client` / `docs` / `scripts` …），可省略。

示例：

```
feat(engine): 03-fetch 支持自定义落点目录

outDir 之前只能落在固定的 F 盘路径，别人机器上必然失败。
改成参数优先，缺省走系统临时目录。
```

```
fix(client): 菜单项在深色主题下不换行

宿主菜单宽度算漏了换行，删除按钮文字被截断。
```

## 规矩

1. **一次提交一件事**。不要把重构和功能混在一个 commit。
2. **正文写"为什么"**。改了什么看 diff 就知道，为什么改只有你知道。
3. **提交前跑自测**。各插件的离线自测见 `README.md` 的"一键验"段。
4. **不要提交运行数据**（`.state/`、`backups/`、`out/` 等）——已在 `.gitignore` 里，提交前用
   `git status` 确认。
5. **不要写死本机路径**。任何绝对路径必须走环境变量 / `os.homedir()` / `os.tmpdir()` /
   相对插件位置的探测。这是本仓库的**硬规矩**：别人机器上没有你的盘符。

## 跑自测

```bash
node engine/verify/all.mjs      # 各包自测入口见 README
```

## 报告问题

开 issue 时附上：DSH 版本、Node 版本、操作系统、以及复现步骤。
