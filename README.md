# Retrace

多仓库 git 审查复盘工具：一个窗口看多个项目的历史、分支和 worktree，集成分支（main）固定在提交图最左列，点提交看提交说明和并排 diff，或连续阅读整个提交；也能按任一版本浏览整个项目的文件（代码高亮、图片、Markdown 渲染）。不提交、不暂存、不合并；唯一的写操作是 fetch 和删除已合并的 worktree。

macOS 优先（Tauri 2），Windows 以后补。设计例外见 [docs/DESIGN.md](docs/DESIGN.md)。

## 用法

- 默认布局：左列上「项目」下「改动 / 文件」，右列上「提交图」下「diff」。diff 默认关闭：点提交行打开（顶部是提交说明），再点同一行收起。
- 项目栏 `+`：选一个仓库，或一个装着仓库的父文件夹（之后勾选要加的仓库）；拖动可以排序。
- 提交图顶栏：主树、「进行中 N ▾」（有改动或没合并的 worktree）、「已合并 N ▾」（干净且已合并，可查看、可删除）、「分支 N ▾」（没有 worktree 的分支）；右边是筛选、提交图选项（集成分支、显示其他分支 / 远程分支）、刷新。
- 改动：改动树（可切列表、全部折叠）；diff：单个文件或连续阅读，并排 / 合并，默认不换行；图片显示改前改后。
- 文件：选中版本的整个目录（未提交行 = 磁盘上的文件，提交 = 那次提交时的文件），可筛选、全部折叠；点文件在右边预览，Markdown 默认渲染（可切源码）。
- 菜单栏：设置、添加项目、在 Finder / 终端 / 编辑器打开当前 worktree、视图开关（项目栏、diff、并排、换行、连续阅读、其他分支）、恢复默认布局。
- 布局：每块视图标题栏左边的把手可以拖到别的视图的上下左右（停靠）或中间（交换）；每块视图有最小尺寸，挤不坏。

| 快捷键 | 作用 |
| --- | --- |
| ↑ ↓ / j k | 上一个 / 下一个提交；在改动或文件列表里是上一个 / 下一个文件 |
| → / Enter | 从提交进入改动，打开 diff |
| ← | 回到提交图 |
| F | 专注：只留改动和 diff |
| Esc | 退出专注 → 关闭 diff → 清空筛选 |
| ⌘J | 打开 / 关闭 diff |
| ⌘F | 筛选提交 |
| ⌘R | 刷新并从远程获取 |
| ⌘\ | 收起 / 展开项目栏 |
| ⌘O | 添加项目 |
| ⇧⌘F / ⌃\` / ⇧⌘A | 在 Finder / 终端 / 编辑器打开当前 worktree |
| ⌘, | 设置 |

## 开发

需要 Rust、Node 22、pnpm。

```bash
pnpm install
pnpm tauri dev                 # 桌面 App
```

只调界面时可以用浏览器：开发桥把同一套命令挂在 `127.0.0.1:5198`，Vite 把 `/api` 代理过去。

```bash
cargo run --manifest-path src-tauri/Cargo.toml --bin retrace-devbridge
pnpm dev                       # http://localhost:1420
```

`RETRACE_CONFIG_DIR=/tmp/retrace-dev` 可以让 App 和开发桥用一份临时配置，不碰真实的项目列表（默认在 `~/Library/Application Support/me.jimlin.retrace/config.json`）。

## 检查

```bash
cargo test --manifest-path src-tauri/Cargo.toml   # 车道算法、解析、临时仓库里的端到端场景
pnpm test                                         # 改动树 + jim-uiux 设计守卫
pnpm typecheck
pnpm tauri build                                  # 产出 Retrace.app 和 dmg
```

## 结构

```text
src-tauri/src/core/   git 调用（只读环境）、仓库与 worktree、车道算法、历史、改动与文件内容、命令分发
src-tauri/src/watch.rs 监听当前项目的 .git 和工作区；定时 fetch
src-tauri/src/bin/retrace-devbridge.rs  开发用 HTTP 桥
src/components/app/   四块视图：项目、改动 / 文件、提交图、diff / 预览（diff 用 @pierre/diffs，Markdown 用 react-markdown，都懒加载）
src/lib/commands.ts   菜单栏、快捷键和按钮共用的命令；src/lib/menu.ts 是 macOS 菜单栏
src/components/layout/ 可拖动停靠的平铺布局；布局模型在 src/lib/layout.ts
src/components/ui/    jim-uiux 组件（registry 安装，别手改）
```

## 只读约定

所有 git 调用都带 `GIT_OPTIONAL_LOCKS=0`，不抢 agent 正在用的 `index.lock`；列改动只用 `diff-tree` / `diff-index` 这类不碰 index 的命令；判断 squash 合并用的 `merge-tree --write-tree` 写在临时对象目录里，不往仓库写对象。

写操作只有两个：

- `git fetch`：只更新远程分支，可在设置里关掉；
- 删除已合并的 worktree：只在你确认后执行，不加 `--force`，执行前逐棵复验；分支只用 `git branch -d` 删。
