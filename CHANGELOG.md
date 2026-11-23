# Changelog

[中文](CHANGELOG.zh-CN.md)

## 0.7.6 · 2026-11-20

### Improved

- **No "Projects" heading.** In a narrow sidebar the word was squeezed into an ellipsis, so the projects bar no longer shows a title.
- **One + for adding.** Add project (⌘O) and New group now share the menu on a single plus button.

## 0.7.5 · 2026-11-19

### New

- **Your projects in the menu bar.** Retrace's icon at the top right of the screen lists every project, pinned ones first and the rest by group, with a check on the one that's open. Pick one to bring the window up with it; the menu also has Open Retrace, Add Project… and Quit Retrace.
- **Right-click a file.** In *Changes* and *Files*, right-click a file to show it in Finder or open it in your editor.
- **Resize focus mode.** Drag the line between the changes and the diff in focus mode (F); the size is remembered, and View → Restore Default Layout puts it back.
- **The logo, top left.** Retrace's logo sits at the left of the title bar.

### Improved

- **Closing the window doesn't quit.** The red button or ⌘W now hides the window and Retrace stays in the menu bar (and keeps fetching, if that's on). Get it back from the menu bar icon or the Dock; ⌘Q quits. In full screen, closing leaves full screen first.

### Fixed

- **No more stray Reload menu.** Right-clicking the page no longer brings up the web view's own menu. Text fields and selected text keep Cut, Copy and Paste.

## 0.7.4 · 2026-11-17

### New

- **Resize views from the keyboard.** Tab to the divider between two views and use the arrow keys (16 px a step); Home and End jump to the smallest and largest size. A drag now saves the layout once, when you let go, and the divider's highlight no longer stays lit after a mouse drag.

### Improved

- **Notifications out of the way.** Notifications now sit at the top right, just below the title bar, so they no longer cover its buttons. Every notification has a ✕ in its corner to dismiss it at once, and error notifications get the faint red tint they were meant to have.
- **Copy a hash without a popup.** The full commit hash is selectable text, with a copy button beside it that answers on the spot (「已复制」 / "Copied") instead of raising a notification.
- **Explanations you can click.** In branch cleanup, the notes on deleting the worktrees' branches and deleting on origin sit behind an ⓘ that opens on a click or tap, not only on hover.
- **Clearer for screen readers.** The notification area and its ✕ have proper names, and icon buttons no longer read their keyboard shortcut as part of their name.

## 0.7.3 · 2026-11-11

### New

- **Each branch, one row.** With other branches shown, every branch besides `main` and the one you're on folds into a single row in its lane colour: its name, how many commits it has of its own, and one line down to the newest `main` commit it's built on. Click the row for everything the branch adds to `main`; open it with ▸ to see its commits, ▾ folds it again. A branch stacked on another takes one row, and a branch whose tip only merged `main` in reads as its latest real commit. Turn it off under Graph options → *Fold each branch into one row*, or in the View menu.
- **Search whole commit messages.** A new button at the end of the filter box also searches message bodies, not just subjects, authors and hashes. Git does the search once typing pauses; it's off by default.

### Fixed

- **No more empty merges.** With merged commits folded, a merge that only brought `main` into a branch no longer offers a ▸ that opens onto nothing. It shows as a plain merge, with a line to `main` when that commit is below it.

## 0.7.2 · 2026-11-11

### New

- **Screenshots in pull requests.** Images in a PR's description and comments now show right in Retrace, including attachments in private repositories. Retrace fetches them itself (GitHub's own through your `gh`, other hosts over https), so the app still never sees a token and the page loads nothing remote.
- **The conversation, in a side panel.** A new 💬 button on the PR card opens comments, reviews and line comments in time order. Each thread shows its file, line and the code it's on, and jumps to that file's diff in one click.

### Improved

- **A PR opens as its description.** Opening a pull request shows its description across the full width, with no file picked. Pick a file in *Changes* for its diff, and click it again to go back. A skeleton shows while the PR loads.

## 0.7.1 · 2026-11-10

### New

- **Fold merged commits.** A new switch in *Graph options* (and *View → Fold Merged Commits*) keeps every branch to its own first-parent line, so `main` reads as a clean list of its merge commits instead of a tangle of side lanes and "merge main into …" commits.
- **Open a merge in place.** Each folded merge gets a ▸. Click it to lay out the commits that merge brought in right below it, with commits already on `main` left where they are. Click ▾ to fold it again. Your scroll position stays put.
- Off by default, and a file's history is never folded.

## 0.7.0 · 2026-11-10

### New

- **Pull requests, read in Retrace.** GitHub projects get a **PRs** menu next to the worktree groups, listing open pull requests through your own GitHub CLI (`gh`): Retrace never sees a token. Pick one to read it like a branch: its commits in the graph, its whole change exactly as GitHub's *Files changed* shows it, and its description, review status and checks above the diff.
- **From a branch to its PR.** Worktrees and branches with an open pull request show its number, and their *Everything since main* row opens it.
- **Every check.** Click the checks summary for each check, its duration and a link to its page.
- **Still read-only.** When a pull request's commits haven't been fetched yet (pushed since the last fetch, from a fork, or with its branch deleted), Retrace fetches only those commits: no ref, no `FETCH_HEAD`, no submodules.
- Listing pull requests needs `gh` installed and logged in (`brew install gh`, then `gh auth login`). Without it, everything else works as before.

### Improved

- **PR links open here.** A squash or merge commit's **PR #N** button now opens the pull request inside Retrace, merged ones included; the icon next to it still opens GitHub.

## 0.6.1 · 2026-11-08

### New

- Click an already open commit again to deselect it and show the current worktree's uncommitted changes and files. Focus mode also works with no graph row selected.

### Improved

- **Files** now comes before **Changes** in the file panel tabs.

## 0.6.0 · 2026-11-08

### New

- **Pin projects to the top.** Right-click a project and choose **Pin to top**: it moves into a **Pinned** section above your groups and keeps its group for when you unpin it. Drag a project into or out of Pinned to pin or unpin it.
- **Reorder groups by dragging.** Press and drag a group's header to move it; a plain click still folds it. **New group…** now asks for the name first.
- **Clean up worktrees whose folder you already deleted.** A merged worktree whose folder is gone shows up in the cleanup list; removing it only clears git's record of it. It's offered only when nothing is staged in that record and no merge or rebase is in progress.
- **Optionally delete the branch on origin too.** The cleanup menu has a new switch, **Also delete the branches on origin**, off every time you open it. When ticked, a deleted branch's own copy on origin goes with it (`git push` guarded by `--force-with-lease`), but only if its commits are in the trunk and origin hasn't moved since the last fetch. Undo brings back the local branch only.

## 0.5.3 · 2026-11-08

### Fixed

- **Update progress no longer covers its own text.** While an update downloads after you check for one, the spinner sits at the start of "Downloading Retrace …" instead of in the middle of it.
- **Menus line up.** A submenu such as **Move to group** now opens with its first item level with the row that opened it, and right-click and **⋯** menus share one source, so they can't drift apart.

## 0.5.2 · 2026-11-08

### New

- **Project groups.** Sort projects into groups that fold away: use the folder button above the list, right-click a project → **Move to group**, or drag a project into a group (nudge the pointer right to nest it). Groups can be renamed, reordered and deleted; deleting one keeps its projects and can be undone.
- **Right-click menus.** Projects and groups open the same menu as their **⋯** button on right-click.
- **One file's history.** In **Files**, pick a file and the graph keeps only the commits that changed it, still drawn as a connected graph, with any uncommitted changes on top. Click a commit, then **See changes**, and step through the file's history one diff at a time. The history button in the diff header turns this on or off from **Changes** too. Earlier names of a renamed file aren't followed.
- **File icon themes.** The changes and files lists show icons by file type, in four themes under **Settings → Appearance → File icons**: Minimal, Outline, Color (the default) and Letters.

### Improved

- **A new app icon**: an R drawn as a commit graph, on a dark background.

## 0.5.1 · 2026-11-06

### Heads-up

- **Coming from 0.5.0 or earlier?** Those versions can't update themselves yet, so download this one by hand once. Every release after it arrives on its own.

### New

- **Retrace now updates itself.** At launch and every few hours it looks at the latest release on GitHub, downloads the new version in the background, checks it against the signing key built into the app, and asks you to **Restart** when it's ready. Check by hand with **Retrace → Check for Updates…**, or turn it off in **Settings → Updates**. Nothing is hosted anywhere else: the update and its signature are the files on the release page.
- Updates are signed: a download that doesn't match the key, or wasn't signed for the version it claims to be, is refused and the app stays as it is.

## 0.5.0 · 2026-11-06

### New

- **Merged branches, cleaned up in one go.** Local branches without a worktree that are already in `main` — merged, fast-forwarded or squash-merged, even when `main` later changed the same lines — now sit in **Merged** next to merged worktrees. They are ticked for you; one click removes them, and **Undo** right after brings them back with their settings. **Branches** now only lists work still in progress (commits ahead, last commit, a note when its remote branch was deleted) and branches you keep.
- **Nothing in use gets deleted.** Every branch is checked again right before it goes, and deleted only while it still points at the commit you saw. Branches checked out, being rebased or bisected in any worktree, the integration branch (whatever remote it comes from), long-lived names like `develop` and `release/*`, and branches you pin with **Keep** are never offered. Branches touched in the last 15 minutes are listed but not ticked.

### Fixed

- Removing a merged worktree with **Also delete the worktrees' branches** now deletes squash-merged branches too, which `git branch -d` refused.

## 0.4.1 · 2026-11-06

### New

- **Open on GitHub** from a project's **…** menu in the projects list, and from **Project → Open on GitHub** in the menu bar, whenever the repository has a GitHub remote.
- The README now credits the projects that inspired Retrace: [Git Graph](https://marketplace.visualstudio.com/items?itemName=mhutchie.git-graph) for VS Code and [FoldGit](https://foldgit.com/).

### Improved

- **The commit filter is always open** at the top right of the graph: no click needed first. ⌘F still jumps into it, and it narrows as the graph view gets narrower.

## 0.4.0 · 2026-11-05

The first public release of **Retrace** — a read-only macOS app for reviewing Git history across many repositories and worktrees, built for the age of coding agents.

### New

- **Many repositories, one window**, with the integration branch pinned to column 0 of a compact commit graph.
- **Worktrees folded** into *Active*, *Merged* and *Branches*; merged worktrees can be removed safely (no `--force`, every tree checked again, branches only via `git branch -d`).
- **Commits as you'd review them**: click a row for its full message, a **PR #N** link for squash / merge commits, and a side-by-side diff. Click again to close.
- **Diffs that read well**: side by side, no wrapping, highlighted off the main thread; one file at a time or the whole commit; changed images before and after.
- **Browse any version**: the whole tree at any commit, with code, images and Markdown rendered like GitHub.
- **Dockable layout**, native menu bar, keyboard first, light and dark, **English and 中文**.
- **Read-only by design**: `GIT_OPTIONAL_LOCKS=0`, plumbing that never touches the index; the only writes are `git fetch` and removing merged worktrees after you confirm.

---

Downloads for every version are on [GitHub Releases](https://github.com/linjiejim/retrace/releases).
