//! Changed files for a target (commit, uncommitted, compare) and both sides of one file.

use crate::tr;
use super::git;
use super::model::*;
use anyhow::{bail, Result};
use std::path::Path;

/// Larger files are listed but not rendered.
pub const MAX_BLOB: u64 = 2 * 1024 * 1024;
const MAX_UNTRACKED: usize = 3000;

fn status_word(code: char) -> &'static str {
    match code {
        'A' => "added",
        'D' => "deleted",
        'R' => "renamed",
        'C' => "copied",
        'T' => "typechange",
        'U' => "conflicted",
        _ => "modified",
    }
}

/// Parses `--raw --numstat -z` output: all raw records first, then numstat records in the same order.
pub fn parse_raw_numstat(bytes: &[u8]) -> Vec<FileChange> {
    let tokens = git::nul_tokens(bytes);
    let mut files: Vec<FileChange> = Vec::new();
    let mut i = 0;
    // raw section
    while i < tokens.len() {
        let t = tokens[i].trim_start_matches('\n');
        if !t.starts_with(':') {
            if t.is_empty() {
                i += 1;
                continue;
            }
            break;
        }
        let fields: Vec<&str> = t.split_whitespace().collect();
        let code = fields.get(4).and_then(|s| s.chars().next()).unwrap_or('M');
        let mode_changed = fields.first().map(|m| m.trim_start_matches(':')) != fields.get(1).copied();
        if code == 'R' || code == 'C' {
            let old = tokens.get(i + 1).cloned();
            let new = tokens.get(i + 2).cloned().unwrap_or_default();
            files.push(FileChange { path: new, old_path: old, status: status_word(code), additions: None, deletions: None, binary: false, mode_changed });
            i += 3;
        } else {
            let path = tokens.get(i + 1).cloned().unwrap_or_default();
            files.push(FileChange { path, old_path: None, status: status_word(code), additions: None, deletions: None, binary: false, mode_changed });
            i += 2;
        }
    }
    // numstat section, matched by path: unmerged entries have a raw record but no numstat line
    let mut stats: std::collections::HashMap<String, (&str, &str)> = std::collections::HashMap::new();
    while i < tokens.len() {
        let t = tokens[i].trim_start_matches('\n');
        if t.is_empty() {
            i += 1;
            continue;
        }
        let mut parts = t.splitn(3, '\t');
        let adds = parts.next().unwrap_or("-");
        let dels = parts.next().unwrap_or("-");
        let path = parts.next().unwrap_or("");
        if path.is_empty() {
            if let Some(new) = tokens.get(i + 2) {
                stats.insert(new.clone(), (adds, dels));
            }
            i += 3;
        } else {
            stats.insert(path.to_string(), (adds, dels));
            i += 1;
        }
    }
    for f in files.iter_mut() {
        if let Some((adds, dels)) = stats.get(&f.path) {
            if *adds == "-" && *dels == "-" {
                f.binary = true;
            } else {
                f.additions = adds.parse().ok();
                f.deletions = dels.parse().ok();
            }
        }
    }
    files
}

pub(super) fn has_head(dir: &Path) -> bool {
    matches!(git::code(dir, &["rev-parse", "--verify", "-q", "HEAD^{commit}"]), Ok((0, _)))
}

fn empty_tree(dir: &Path) -> String {
    git::text(dir, &["hash-object", "-t", "tree", "/dev/null"]).map(|s| s.trim().to_string()).unwrap_or_else(|_| "4b825dc642cb6eb9a060e54bf8d69288fbee4904".into())
}

pub fn merge_base(dir: &Path, a: &str, b: &str) -> Result<String> {
    Ok(git::text(dir, &["merge-base", a, b])?.trim().to_string())
}

pub(super) fn first_parent(dir: &Path, hash: &str) -> Result<Option<String>> {
    let out = git::text(dir, &["rev-list", "--parents", "-n1", hash, "--"])?;
    Ok(out.split_whitespace().nth(1).map(str::to_string))
}

fn count_lines(path: &Path) -> (Option<u32>, bool) {
    let Ok(meta) = std::fs::metadata(path) else { return (None, false) };
    if !meta.is_file() || meta.len() > MAX_BLOB {
        return (None, false);
    }
    let Ok(bytes) = std::fs::read(path) else { return (None, false) };
    if is_binary(&bytes) {
        return (None, true);
    }
    let mut n = bytes.iter().filter(|b| **b == b'\n').count() as u32;
    if !bytes.is_empty() && !bytes.ends_with(b"\n") {
        n += 1;
    }
    (Some(n), false)
}

/// Above this many files a commit is listed without per-file line counts: `--numstat` reads every
/// blob (a 20k-file commit takes ~2s with it, ~50ms without).
pub const MAX_NUMSTAT: usize = 2000;

/// Plumbing only (`diff-tree`, `diff-index`, `ls-files`): porcelain `git diff` against the working
/// tree rewrites the index when it meets touched-but-unchanged files, even with optional locks off.
pub fn changes(dir: &Path, target: &Target) -> Result<Vec<FileChange>> {
    // Tree to tree: names first, line counts only when the change is not huge.
    let tree_diff = |range: &[&str]| -> Result<Vec<FileChange>> {
        let mut args = vec!["diff-tree", "-r", "-z", "-M", "--raw"];
        args.extend(range);
        args.push("--");
        let mut out = git::run(dir, &args)?;
        if parse_raw_numstat(&out).len() <= MAX_NUMSTAT {
            let mut args = vec!["diff-tree", "-r", "-z", "-M", "--numstat"];
            args.extend(range);
            args.push("--");
            out.extend(git::run(dir, &args)?);
        }
        Ok(parse_raw_numstat(&out))
    };
    match target {
        Target::Commit { hash } => match first_parent(dir, hash)? {
            Some(parent) => tree_diff(&[&parent, hash]),
            None => tree_diff(&["--root", "--no-commit-id", hash]),
        },
        Target::Compare { base, tip } => tree_diff(&[&merge_base(dir, base, tip)?, tip]),
        Target::Worktree { tree } => {
            let tree = Path::new(tree);
            let base = if has_head(tree) { "HEAD".to_string() } else { empty_tree(tree) };
            let mut files = parse_raw_numstat(&git::run(tree, &["diff-index", "-z", "-M", "--raw", "--numstat", &base, "--"])?);
            // Without an index refresh, a file that was only touched still gets a raw record, but
            // numstat skips it because the content is identical: no numstat line, no change.
            files.retain(|f| !(f.status == "modified" && f.additions.is_none() && f.deletions.is_none() && !f.binary && !f.mode_changed));
            // Unmerged paths appear once per stage; keep one entry and mark it.
            let conflicted: Vec<String> = git::nul_tokens(&git::run(tree, &["ls-files", "-u", "-z"])?)
                .into_iter()
                .filter_map(|t| t.split_once('\t').map(|(_, p)| p.to_string()))
                .collect();
            files.dedup_by(|a, b| a.path == b.path);
            for f in files.iter_mut() {
                if conflicted.contains(&f.path) {
                    f.status = "conflicted";
                }
            }
            let untracked = git::nul_tokens(&git::run(tree, &["ls-files", "--others", "--exclude-standard", "-z"])?);
            for path in untracked.into_iter().take(MAX_UNTRACKED) {
                let (lines, binary) = count_lines(&tree.join(&path));
                files.push(FileChange { path, old_path: None, status: "untracked", additions: lines, deletions: Some(0), binary, mode_changed: false });
            }
            Ok(files)
        }
    }
}

/// Patches larger than this are cut at a file boundary.
pub const MAX_PATCH: usize = 8 * 1024 * 1024;

/// One unified patch for everything in the target (continuous reading), plumbing only like
/// `changes`. Untracked files get a synthesized "new file" patch.
pub fn patch(dir: &Path, target: &Target) -> Result<PatchText> {
    const FLAGS: [&str; 4] = ["-p", "-M", "--no-ext-diff", "--no-textconv"];
    let mut out: Vec<u8> = match target {
        Target::Commit { hash } => {
            let mut args = vec!["diff-tree", "-r"];
            args.extend(FLAGS);
            let parent = first_parent(dir, hash)?;
            match &parent {
                Some(p) => args.extend([p.as_str(), hash.as_str()]),
                None => args.extend(["--root", "--no-commit-id", hash.as_str()]),
            }
            args.push("--");
            git::run_limited(dir, &args, MAX_PATCH)?.0
        }
        Target::Compare { base, tip } => {
            let mb = merge_base(dir, base, tip)?;
            let mut args = vec!["diff-tree", "-r"];
            args.extend(FLAGS);
            args.extend([mb.as_str(), tip.as_str(), "--"]);
            git::run_limited(dir, &args, MAX_PATCH)?.0
        }
        Target::Worktree { tree } => {
            let tree = Path::new(tree);
            let base = if has_head(tree) { "HEAD".to_string() } else { empty_tree(tree) };
            let mut args = vec!["diff-index"];
            args.extend(FLAGS);
            args.extend([base.as_str(), "--"]);
            let mut out = git::run_limited(tree, &args, MAX_PATCH)?.0;
            let untracked = git::nul_tokens(&git::run(tree, &["ls-files", "--others", "--exclude-standard", "-z"])?);
            for path in untracked.into_iter().take(MAX_UNTRACKED) {
                if out.len() > MAX_PATCH {
                    break;
                }
                out.extend(new_file_patch(tree, &path));
            }
            out
        }
    };
    let truncated = out.len() > MAX_PATCH;
    if truncated {
        let cut = out[..MAX_PATCH].windows(12).rposition(|w| w == b"\ndiff --git ").map(|i| i + 1).unwrap_or(0);
        out.truncate(cut);
    }
    Ok(PatchText { patch: String::from_utf8_lossy(&out).into_owned(), truncated })
}

fn new_file_patch(tree: &Path, path: &str) -> Vec<u8> {
    let mut p = format!("diff --git a/{path} b/{path}\nnew file mode 100644\n").into_bytes();
    let Ok(blob) = blob_on_disk(tree, path) else { return vec![] };
    match blob {
        Some(Blob { text: Some(text), .. }) if !text.is_empty() => {
            let lines: Vec<&str> = text.split_inclusive('\n').collect();
            p.extend(format!("--- /dev/null\n+++ b/{path}\n@@ -0,0 +1,{} @@\n", lines.len()).into_bytes());
            for line in &lines {
                p.push(b'+');
                p.extend(line.as_bytes());
            }
            if !text.ends_with('\n') {
                p.extend(b"\n\\ No newline at end of file\n");
            }
        }
        Some(Blob { text: Some(_), .. }) => {}
        Some(_) => p.extend(format!("Binary files /dev/null and b/{path} differ\n").into_bytes()),
        None => return vec![],
    }
    p
}

pub fn is_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8000).any(|b| *b == 0)
}

/// One version of a file, read only when it fits the caller's limit.
pub(super) enum Read {
    Bytes(Vec<u8>),
    TooLarge(u64),
}

/// `rev:path` from the object store; `None` when the file isn't in that revision.
pub(super) fn read_at(dir: &Path, rev: &str, path: &str, limit: u64) -> Result<Option<Read>> {
    let spec = format!("{rev}:{path}");
    let (code, out) = git::code(dir, &["cat-file", "-s", &spec])?;
    if code != 0 {
        return Ok(None);
    }
    let size: u64 = String::from_utf8_lossy(&out).trim().parse().unwrap_or(0);
    if size > limit {
        return Ok(Some(Read::TooLarge(size)));
    }
    Ok(Some(Read::Bytes(git::run(dir, &["cat-file", "blob", &spec])?)))
}

/// A file in a worktree on disk. A symlink reads as its target path, like git stores it.
pub(super) fn read_on_disk(tree: &Path, path: &str, limit: u64) -> Result<Option<Read>> {
    let full = tree.join(path);
    // A tracked folder replaced by a symlink must not let us read files outside the worktree:
    // resolve the parent folders (not the file itself) and require them to stay inside.
    let root = std::fs::canonicalize(tree)?;
    match full.parent().map(std::fs::canonicalize) {
        Some(Ok(parent)) if parent.starts_with(&root) => {}
        _ => return Ok(None),
    }
    let Ok(meta) = std::fs::symlink_metadata(&full) else { return Ok(None) };
    if meta.file_type().is_symlink() {
        return Ok(Some(Read::Bytes(std::fs::read_link(&full)?.to_string_lossy().into_owned().into_bytes())));
    }
    if !meta.is_file() {
        return Ok(None);
    }
    if meta.len() > limit {
        return Ok(Some(Read::TooLarge(meta.len())));
    }
    Ok(Some(Read::Bytes(std::fs::read(&full)?)))
}

fn to_blob(read: Read) -> Blob {
    let bytes = match read {
        Read::TooLarge(size) => return Blob { text: None, size, binary: false, too_large: true },
        Read::Bytes(bytes) => bytes,
    };
    let size = bytes.len() as u64;
    if is_binary(&bytes) {
        return Blob { text: None, size, binary: true, too_large: false };
    }
    Blob { text: Some(String::from_utf8_lossy(&bytes).into_owned()), size, binary: false, too_large: false }
}

fn blob_at(dir: &Path, rev: &str, path: &str) -> Result<Option<Blob>> {
    Ok(read_at(dir, rev, path, MAX_BLOB)?.map(to_blob))
}

fn blob_on_disk(tree: &Path, path: &str) -> Result<Option<Blob>> {
    Ok(read_on_disk(tree, path, MAX_BLOB)?.map(to_blob))
}

/// Paths come from the frontend: relative, no `..`.
pub(super) fn check_path(path: &str) -> Result<()> {
    if path.is_empty() || path.starts_with('/') || path.split('/').any(|p| p == "..") {
        bail!(tr!("文件路径无效", "Invalid file path"));
    }
    Ok(())
}

pub fn file_pair(dir: &Path, target: &Target, path: &str, old_path: Option<&str>) -> Result<FilePair> {
    check_path(path)?;
    let old_path = old_path.unwrap_or(path);
    check_path(old_path)?;
    match target {
        Target::Commit { hash } => {
            let old = match first_parent(dir, hash)? {
                Some(parent) => blob_at(dir, &parent, old_path)?,
                None => None,
            };
            Ok(FilePair { old, new: blob_at(dir, hash, path)? })
        }
        Target::Compare { base, tip } => {
            let mb = merge_base(dir, base, tip)?;
            Ok(FilePair { old: blob_at(dir, &mb, old_path)?, new: blob_at(dir, tip, path)? })
        }
        Target::Worktree { tree } => {
            let tree = Path::new(tree);
            let old = if has_head(tree) { blob_at(tree, "HEAD", old_path)? } else { None };
            Ok(FilePair { old, new: blob_on_disk(tree, path)? })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_raw_and_numstat_with_rename_and_binary() {
        let raw = b":100644 100644 aaa bbb M\0src/a.rs\0:100644 100644 ccc ddd R087\0old/name.rs\0new/name.rs\0:000000 100644 000 eee A\0logo.png\0\x003\t1\tsrc/a.rs\x005\t2\t\0old/name.rs\0new/name.rs\0-\t-\tlogo.png\0";
        let files = parse_raw_numstat(raw);
        assert_eq!(files.len(), 3);
        assert_eq!(files[0], FileChange { path: "src/a.rs".into(), old_path: None, status: "modified", additions: Some(3), deletions: Some(1), binary: false, mode_changed: false });
        assert_eq!(files[1].status, "renamed");
        assert_eq!(files[1].old_path.as_deref(), Some("old/name.rs"));
        assert_eq!(files[1].path, "new/name.rs");
        assert_eq!((files[1].additions, files[1].deletions), (Some(5), Some(2)));
        assert!(files[2].binary && files[2].status == "added");
    }
}
