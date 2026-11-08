# Contributing

Thanks for helping. Retrace is small and opinionated: a read-only window onto many Git repositories. Bug reports, fixes and focused improvements are welcome; for a larger feature, open an issue first so we can agree on the shape.

## Setup

You need Rust (stable), Node 22 and pnpm.

```bash
pnpm install
pnpm tauri dev                 # the desktop app
```

Most UI work is quicker in a browser. The dev bridge serves the app's commands over HTTP on `127.0.0.1:5198`, and Vite proxies `/api` to it:

```bash
RETRACE_CONFIG_DIR=/tmp/retrace-dev cargo run --manifest-path src-tauri/Cargo.toml --bin retrace-devbridge
pnpm dev                       # http://localhost:1420
```

`RETRACE_CONFIG_DIR` keeps your real project list out of the way.

## Before you open a pull request

```bash
pnpm typecheck
pnpm test
cargo test --manifest-path src-tauri/Cargo.toml
```

CI runs the same three on macOS.

## Ground rules

- **Read-only stays read-only.** Retrace must never commit, stage, merge, rebase or rewrite anything in a user's repository. Every git call runs with `GIT_OPTIONAL_LOCKS=0`; list changes with plumbing that doesn't touch the index. The only writes are `git fetch` and, after the user confirms, removing worktrees and local branches already in the trunk (a branch only while it still points at the commit that was checked, with Undo), and, when the user ticks it, a deleted branch's own copy on origin (`git push` with `--force-with-lease`, only if its commits are in the trunk) — new write paths need a strong case and an issue first.
- **Strings go through `t()`.** Write the English text in code (`t("Pick a project")`, or `tp(one, other, n)` for counts) and add the Chinese to `src/locales/zh.ts`. `pnpm test` fails when a translation is missing or Chinese text is left in the code. Backend messages use `tr!("中文", "English")`.
- **UI follows jim-uiux.** Components in `src/components/ui/` come from the [jim-uiux](https://design.linjiejim.com) registry; prefer them and the theme tokens over new styles. The design guards in `pnpm test` reject raw colours and off-scale type.
- **Tests with the change.** Git behaviour is tested end to end against throwaway repositories in `src-tauri/tests/scenarios.rs`; layout and helpers have unit tests next to them.

## The website

`site/` is the website at retrace.linjiejim.com: plain HTML, CSS and JS, no build step. Preview it with `python3 -m http.server --directory site`; pushing changes under `site/` to `main` deploys it to GitHub Pages. The screenshots in `site/screens/` are shared with the README.

## Commits

Conventional Commits (`feat(scope): …`, `fix: …`), one concern per commit.
