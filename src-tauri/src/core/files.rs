//! Every file in one version (a commit, a branch tip, or a worktree on disk), and one file's content
//! for previewing: text, or an image as base64.

use super::diff::{check_path, first_parent, has_head, is_binary, merge_base, read_at, read_on_disk, Read, MAX_BLOB};
use super::git;
use super::model::*;
use anyhow::Result;
use base64::Engine;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// Lists stop here (the page says so).
pub const MAX_FILES: usize = 200_000;
/// Images are previewed up to this size; text up to `MAX_BLOB`.
pub const MAX_IMAGE: u64 = 8 * 1024 * 1024;

pub fn image_mime(path: &str) -> Option<&'static str> {
    let ext = path.rsplit_once('.')?.1.to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "bmp" => "image/bmp",
        "avif" => "image/avif",
        _ => return None,
    })
}

pub fn files(dir: &Path, target: &Target) -> Result<FileList> {
    let mut paths = match target {
        Target::Worktree { tree } => worktree_files(Path::new(tree))?,
        Target::Commit { hash } => tree_files(dir, hash)?,
        Target::Compare { tip, .. } => tree_files(dir, tip)?,
    };
    paths.sort();
    paths.dedup();
    let truncated = paths.len() > MAX_FILES;
    paths.truncate(MAX_FILES);
    Ok(FileList { paths, truncated })
}

fn tree_files(dir: &Path, rev: &str) -> Result<Vec<String>> {
    let out = git::run(dir, &["ls-tree", "-r", "-z", "--full-tree", rev])?;
    Ok(git::nul_tokens(&out)
        .into_iter()
        .filter_map(|record| {
            let (meta, path) = record.split_once('\t')?;
            // `<mode> <type> <object>`: submodules are commits, not files.
            (meta.split(' ').nth(1) == Some("blob")).then(|| path.to_string())
        })
        .collect())
}

/// What's on disk: tracked files that still exist, plus untracked ones that aren't ignored.
fn worktree_files(tree: &Path) -> Result<Vec<String>> {
    let deleted: HashSet<String> = git::nul_tokens(&git::run(tree, &["ls-files", "-z", "--deleted"])?).into_iter().collect();
    let mut paths: Vec<String> = git::nul_tokens(&git::run(tree, &["ls-files", "-z", "--stage"])?)
        .into_iter()
        .filter_map(|record| {
            // `<mode> <object> <stage>\t<path>`; mode 160000 is a submodule.
            let (meta, path) = record.split_once('\t')?;
            (!meta.starts_with("160000") && !deleted.contains(path)).then(|| path.to_string())
        })
        .collect();
    let others = git::run(tree, &["ls-files", "-z", "--others", "--exclude-standard"])?;
    // A nested repository is listed as `dir/`; it isn't a file of this one.
    paths.extend(git::nul_tokens(&others).into_iter().filter(|p| !p.ends_with('/')));
    Ok(paths)
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Side {
    /// The version the target shows (the commit, the branch tip, the file on disk).
    New,
    /// What it is compared with (first parent, merge base, HEAD) — the same pair as `file_pair`.
    Old,
}

enum Source {
    Rev(PathBuf, String),
    Disk(PathBuf),
    Missing,
}

fn source(dir: &Path, target: &Target, side: Side) -> Result<Source> {
    Ok(match (target, side) {
        (Target::Commit { hash }, Side::New) => Source::Rev(dir.to_path_buf(), hash.clone()),
        (Target::Commit { hash }, Side::Old) => match first_parent(dir, hash)? {
            Some(parent) => Source::Rev(dir.to_path_buf(), parent),
            None => Source::Missing,
        },
        (Target::Compare { tip, .. }, Side::New) => Source::Rev(dir.to_path_buf(), tip.clone()),
        (Target::Compare { base, tip }, Side::Old) => Source::Rev(dir.to_path_buf(), merge_base(dir, base, tip)?),
        (Target::Worktree { tree }, Side::New) => Source::Disk(PathBuf::from(tree)),
        // Each worktree has its own HEAD: read it inside that tree.
        (Target::Worktree { tree }, Side::Old) if has_head(Path::new(tree)) => Source::Rev(PathBuf::from(tree), "HEAD".into()),
        (Target::Worktree { .. }, Side::Old) => Source::Missing,
    })
}

/// One side of a file. `None` when it doesn't exist in that version.
pub fn file_content(dir: &Path, target: &Target, path: &str, side: Side, old_path: Option<&str>) -> Result<Option<FileContent>> {
    check_path(path)?;
    if let Some(old) = old_path {
        check_path(old)?;
    }
    let path = if side == Side::Old { old_path.unwrap_or(path) } else { path };
    let mime = image_mime(path);
    let limit = if mime.is_some() { MAX_IMAGE } else { MAX_BLOB };
    let read = match source(dir, target, side)? {
        Source::Rev(dir, rev) => read_at(&dir, &rev, path, limit)?,
        Source::Disk(tree) => read_on_disk(&tree, path, limit)?,
        Source::Missing => None,
    };
    Ok(read.map(|r| content(mime, r)))
}

fn content(mime: Option<&'static str>, read: Read) -> FileContent {
    let bytes = match read {
        Read::TooLarge(size) => return FileContent { size, too_large: true, ..Default::default() },
        Read::Bytes(bytes) => bytes,
    };
    let size = bytes.len() as u64;
    let binary = is_binary(&bytes);
    // SVG is an image and text at once: send both, the view picks.
    let text = (!binary && (mime.is_none() || mime == Some("image/svg+xml")) && size <= MAX_BLOB).then(|| String::from_utf8_lossy(&bytes).into_owned());
    let data = mime.map(|_| base64::engine::general_purpose::STANDARD.encode(&bytes));
    FileContent { text, data, mime: mime.map(str::to_string), size, binary, too_large: false }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn knows_image_types_by_extension() {
        assert_eq!(image_mime("a/b/Logo.PNG"), Some("image/png"));
        assert_eq!(image_mime("icon.svg"), Some("image/svg+xml"));
        assert_eq!(image_mime("README.md"), None);
        assert_eq!(image_mime("Makefile"), None);
    }

    #[test]
    fn images_come_as_base64_and_svg_also_as_text() {
        let png = content(Some("image/png"), Read::Bytes(vec![0x89, b'P', b'N', b'G', 0, 1]));
        assert_eq!(png.data.as_deref(), Some("iVBORwAB"));
        assert!(png.binary && png.text.is_none());
        let svg = content(Some("image/svg+xml"), Read::Bytes(b"<svg/>".to_vec()));
        assert_eq!(svg.text.as_deref(), Some("<svg/>"));
        assert!(svg.data.is_some());
        let big = content(None, Read::TooLarge(3 << 20));
        assert!(big.too_large && big.text.is_none());
    }
}
