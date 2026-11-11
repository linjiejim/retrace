//! Pull requests through the user's own GitHub CLI (`gh`). Retrace never sees a token: gh uses
//! the login the user already has. The only write is fetching a pull request's commits when the
//! repository doesn't have them yet, as objects only (no ref, no FETCH_HEAD).
//!
//! Images in a pull request's description and discussion are fetched here too, so the page never
//! loads anything remote itself: GitHub's own (attachments, files in the repository) through gh,
//! anything else with the system's curl, without cookies. Only bytes that are an image come back.

use super::model::{Check, PrDiscussion, PrPost, PrReply, PrThread, PreparedPr, PullRequest, PullRequests, RemoteImage};
use super::{git, repo};
use crate::tr;
use anyhow::{bail, Result};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

const FIELDS: &str = "number,title,author,state,isDraft,headRefName,headRefOid,baseRefName,baseRefOid,isCrossRepository,headRepositoryOwner,reviewDecision,statusCheckRollup,mergeable,additions,deletions,changedFiles,createdAt,updatedAt,mergedAt,closedAt,url";
const TIMEOUT: Duration = Duration::from_secs(20);
/// Open pull requests listed at most.
pub const LIST_LIMIT: u32 = 100;

/// Apps started from Finder get a minimal PATH, so look in the usual places first. Not cached:
/// installing gh while Retrace runs works without a restart.
fn binary() -> PathBuf {
    for candidate in ["/opt/homebrew/bin/gh", "/usr/local/bin/gh"] {
        if Path::new(candidate).exists() {
            return PathBuf::from(candidate);
        }
    }
    PathBuf::from("gh")
}

#[derive(Debug, PartialEq)]
pub enum Failure {
    /// gh isn't installed.
    NoGh,
    /// gh isn't logged in to this host.
    NoAuth,
    Other(String),
}

impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Failure::NoGh => f.write_str(&tr!("没有找到 GitHub CLI（gh）", "GitHub CLI (gh) isn't installed")),
            Failure::NoAuth => f.write_str(&tr!("gh 还没有登录：在终端运行 gh auth login", "gh isn't logged in: run gh auth login in a terminal")),
            Failure::Other(m) => f.write_str(m),
        }
    }
}

/// How a finished gh run failed: exit code 4 (or its own hint) means it needs a login.
fn classify(code: Option<i32>, stderr: &str) -> Failure {
    if code == Some(4) || stderr.contains("gh auth login") {
        return Failure::NoAuth;
    }
    let line = stderr.trim().lines().last().unwrap_or("").trim();
    Failure::Other(if line.is_empty() { tr!("gh 运行失败", "gh failed") } else { tr!("gh 运行失败：{line}", "gh failed: {line}") })
}

fn run(dir: &Path, args: &[&str]) -> std::result::Result<String, Failure> {
    let spawned = gh(dir, args).spawn();
    let child = match spawned {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(Failure::NoGh),
        Err(e) => return Err(Failure::Other(tr!("无法运行 gh：{e}", "Can't run gh: {e}"))),
    };
    match git::wait_for(child, TIMEOUT) {
        Ok(Some(done)) if done.ok => Ok(done.stdout),
        Ok(Some(done)) => Err(classify(done.code, &done.stderr)),
        Ok(None) => Err(Failure::Other(tr!("gh 超时（{} 秒）", "gh timed out ({} s)", TIMEOUT.as_secs()))),
        Err(e) => Err(Failure::Other(e.to_string())),
    }
}

fn gh(dir: &Path, args: &[&str]) -> Command {
    let mut cmd = Command::new(binary());
    cmd.args(args)
        .current_dir(dir)
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .env("GH_PAGER", "cat")
        .env("NO_COLOR", "1")
        .env("CLICOLOR", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    cmd
}

/// `https://github.com/o/r` → `github.com/o/r`, the form `gh -R` takes for any host.
pub fn repo_slug(web_url: &str) -> Option<String> {
    let rest = web_url.strip_prefix("https://")?;
    let parts: Vec<&str> = rest.split('/').collect();
    let ok = |p: &str| !p.is_empty() && !p.starts_with('-') && p.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c));
    (parts.len() == 3 && parts.iter().all(|p| ok(p))).then(|| rest.to_string())
}

/// Open pull requests, newest first (gh's order). Never an error: the state says what went wrong.
pub fn list(dir: &Path, web_url: Option<&str>) -> PullRequests {
    let Some(slug) = web_url.and_then(repo_slug) else {
        return PullRequests { state: "noGithub", message: None, items: vec![] };
    };
    let limit = LIST_LIMIT.to_string();
    match run(dir, &["pr", "list", "-R", &slug, "--state", "open", "--limit", &limit, "--json", FIELDS]) {
        Ok(text) => match parse_list(&text) {
            Some(items) => PullRequests { state: "ok", message: None, items },
            None => PullRequests { state: "error", message: Some(tr!("看不懂 gh 的输出", "Couldn't read gh's output")), items: vec![] },
        },
        Err(f) => {
            let state = match f {
                Failure::NoGh => "noGh",
                Failure::NoAuth => "noAuth",
                Failure::Other(_) => "error",
            };
            PullRequests { state, message: Some(f.to_string()), items: vec![] }
        }
    }
}

/// One pull request, with its description.
pub fn view(dir: &Path, web_url: Option<&str>, number: u32) -> Result<PullRequest> {
    let Some(slug) = web_url.and_then(repo_slug) else {
        bail!(tr!("这个项目没有 GitHub 远程仓库", "This project has no GitHub remote"));
    };
    let fields = format!("{FIELDS},body");
    let text = run(dir, &["pr", "view", &number.to_string(), "-R", &slug, "--json", &fields]).map_err(|f| anyhow::anyhow!(f.to_string()))?;
    let v: Value = serde_json::from_str(&text).map_err(|_| anyhow::anyhow!(tr!("看不懂 gh 的输出", "Couldn't read gh's output")))?;
    parse_pr(&v).ok_or_else(|| anyhow::anyhow!(tr!("看不懂 gh 的输出", "Couldn't read gh's output")))
}

// ---------- images ----------

/// The largest image fetched; GitHub's own attachment limit is 10 MB.
pub const IMAGE_LIMIT: usize = 20 * 1024 * 1024;

/// A description with dozens of screenshots asks for all of them at once: a few downloads at a
/// time, the rest wait their turn.
static DOWNLOADS: git::Gate = git::Gate::new(4);

/// Where an image in a pull request is fetched from.
#[derive(Debug, PartialEq)]
pub enum ImageSource {
    /// `gh api <endpoint>`, signed in to `host`: attachments and files in a (private) repository.
    Gh { endpoint: String, host: String, raw: bool },
    /// Anywhere else on the web, with curl and no credentials.
    Web(String),
}

/// Which way an image URL goes. `gh_host` is the project's GitHub host (`github.com`, or an
/// Enterprise host). `None`: not a URL Retrace fetches (not https, odd characters, a local name).
pub fn image_source(url: &str, gh_host: &str) -> Option<ImageSource> {
    if url.len() > 4096 || url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return None;
    }
    let rest = url.strip_prefix("https://")?;
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..end];
    let host = authority.split(':').next().unwrap_or("").to_ascii_lowercase();
    let local = host == "localhost" || host.ends_with(".localhost") || host.ends_with(".local") || host.parse::<std::net::Ipv4Addr>().is_ok() || !host.contains('.');
    if host.is_empty() || authority.contains('@') || authority.starts_with('[') || local {
        return None;
    }
    let gh_host = gh_host.to_ascii_lowercase();
    let path = rest[end..].split(['?', '#']).next().unwrap_or("");
    let query = rest[end..].split('#').next().unwrap_or("").split_once('?').map(|(_, q)| q).unwrap_or("");
    let segments: Vec<&str> = path.split('/').filter(|p| !p.is_empty()).collect();
    let name_ok = |p: &str| !p.is_empty() && !p.starts_with('-') && p.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c));
    // A file in a repository: read it through the contents API, which works for private ones too.
    let contents = |owner: &str, repo: &str, at: &[&str]| -> Option<ImageSource> {
        let (git_ref, file) = match at {
            ["refs", kind @ ("heads" | "tags"), name, file @ ..] => (format!("refs/{kind}/{name}"), file),
            [name, file @ ..] => (name.to_string(), file),
            _ => return None,
        };
        let safe = |p: &str| !p.starts_with('.') && p.chars().all(|c| !"?#{}\\".contains(c));
        if !name_ok(owner) || !name_ok(repo) || file.is_empty() || !file.iter().all(|p| safe(p)) || !git_ref.split('/').all(safe) {
            return None;
        }
        Some(ImageSource::Gh { endpoint: format!("repos/{owner}/{repo}/contents/{}?ref={git_ref}", file.join("/")), host: gh_host.clone(), raw: true })
    };
    if host == "raw.githubusercontent.com" && gh_host == "github.com" {
        if let [owner, repo, at @ ..] = segments.as_slice() {
            return contents(owner, repo, at);
        }
        return None;
    }
    if host == gh_host {
        let raw_query = query.split('&').any(|kv| kv == "raw=true");
        match segments.as_slice() {
            [owner, repo, "raw", at @ ..] => return contents(owner, repo, at),
            [owner, repo, "blob", at @ ..] if raw_query => return contents(owner, repo, at),
            _ => {}
        }
        // Attachments (`/user-attachments/assets/…`) need the user's login on private repositories.
        return Some(ImageSource::Gh { endpoint: url.to_string(), host: gh_host, raw: false });
    }
    Some(ImageSource::Web(url.to_string()))
}

/// What kind of image the bytes are; never what the server says. SVG is safe in `<img>`: its
/// scripts don't run there.
pub fn sniff(bytes: &[u8]) -> Option<&'static str> {
    let at = |i: usize, sig: &[u8]| bytes.get(i..i + sig.len()) == Some(sig);
    if at(0, b"\x89PNG\r\n\x1a\n") {
        return Some("image/png");
    }
    if at(0, b"\xff\xd8\xff") {
        return Some("image/jpeg");
    }
    if at(0, b"GIF87a") || at(0, b"GIF89a") {
        return Some("image/gif");
    }
    if at(0, b"RIFF") && at(8, b"WEBP") {
        return Some("image/webp");
    }
    if at(4, b"ftypavif") || at(4, b"ftypavis") {
        return Some("image/avif");
    }
    if at(0, b"BM") && bytes.len() > 14 {
        return Some("image/bmp");
    }
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(1024)]).to_ascii_lowercase();
    let head = head.trim_start_matches('\u{feff}').trim_start();
    if (head.starts_with("<?xml") || head.starts_with("<svg") || head.starts_with("<!--")) && head.contains("<svg") {
        return Some("image/svg+xml");
    }
    None
}

fn curl() -> PathBuf {
    let system = Path::new("/usr/bin/curl");
    if system.exists() { system.to_path_buf() } else { PathBuf::from("curl") }
}

/// An image referenced in a pull request, as base64 with the type its bytes show.
pub fn image(dir: &Path, web_url: Option<&str>, url: &str) -> Result<RemoteImage> {
    let gh_host = web_url.and_then(repo_slug).and_then(|s| s.split('/').next().map(str::to_string)).unwrap_or_else(|| "github.com".into());
    let Some(source) = image_source(url, &gh_host) else {
        bail!(tr!("不加载这个地址的图片", "Images from this address aren't loaded"));
    };
    let limit = IMAGE_LIMIT.to_string();
    let mut cmd = match &source {
        ImageSource::Gh { endpoint, host, raw } => {
            let accept = if *raw { "Accept: application/vnd.github.raw" } else { "Accept: */*" };
            let mut args = vec!["api", endpoint.as_str(), "-H", accept];
            // A full URL carries its host; an endpoint needs it said.
            if !endpoint.starts_with("https://") {
                args.extend(["--hostname", host.as_str()]);
            }
            gh(dir, &args)
        }
        ImageSource::Web(url) => {
            let mut cmd = Command::new(curl());
            // -q first: no ~/.curlrc. https only, also after redirects; no cookies, no netrc.
            cmd.args(["-q", "--silent", "--show-error", "--fail", "--location", "--max-redirs", "5", "--proto", "=https", "--proto-redir", "=https"])
                .args(["--max-time", &TIMEOUT.as_secs().to_string(), "--max-filesize", &limit, "--user-agent", "Retrace", "--output", "-", "--url", url])
                .current_dir(dir)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            cmd
        }
    };
    let tool = if matches!(source, ImageSource::Gh { .. }) { "gh" } else { "curl" };
    let _turn = DOWNLOADS.enter();
    let child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound && tool == "gh" => bail!(Failure::NoGh.to_string()),
        Err(e) => bail!(tr!("无法运行 {tool}：{e}", "Can't run {tool}: {e}")),
    };
    let done = match git::wait_for_bytes(child, TIMEOUT, Some(IMAGE_LIMIT))? {
        Some(done) => done,
        None => bail!(tr!("图片下载超时（{} 秒）", "The image timed out ({} s)", TIMEOUT.as_secs())),
    };
    if done.cut {
        bail!(tr!("图片超过 {} MB", "The image is over {} MB", IMAGE_LIMIT / 1024 / 1024));
    }
    if !done.ok {
        if tool == "gh" {
            bail!(classify(done.code, &done.stderr).to_string());
        }
        let line = done.stderr.trim().lines().last().unwrap_or("").trim().to_string();
        bail!(tr!("图片下载失败：{line}", "Couldn't download the image: {line}"));
    }
    let Some(mime) = sniff(&done.stdout) else {
        bail!(tr!("不是图片", "Not an image"));
    };
    use base64::Engine;
    Ok(RemoteImage { mime, data: base64::engine::general_purpose::STANDARD.encode(&done.stdout) })
}

// ---------- discussion ----------

const DISCUSSION: &str = "query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){pullRequest(number:$n){\
comments(first:100){totalCount nodes{author{login} body createdAt url isMinimized}}\
reviews(first:100){totalCount nodes{id author{login} body state submittedAt url}}\
reviewThreads(first:100){totalCount nodes{isResolved isOutdated path line startLine originalLine diffSide \
comments(first:100){totalCount nodes{author{login} body createdAt url diffHunk pullRequestReview{id}}}}}}}}";

/// A pull request's comments, reviews and line comments, read-only.
pub fn discussion(dir: &Path, web_url: Option<&str>, number: u32) -> Result<PrDiscussion> {
    let Some(slug) = web_url.and_then(repo_slug) else {
        bail!(tr!("这个项目没有 GitHub 远程仓库", "This project has no GitHub remote"));
    };
    let mut parts = slug.split('/');
    let (Some(host), Some(owner), Some(name)) = (parts.next(), parts.next(), parts.next()) else {
        bail!(tr!("这个项目没有 GitHub 远程仓库", "This project has no GitHub remote"));
    };
    let (owner, name, n, query) = (format!("owner={owner}"), format!("name={name}"), format!("n={number}"), format!("query={DISCUSSION}"));
    // -f: owner and name stay strings (-F would turn "123" into a number and "@x" into a file).
    let text = run(dir, &["api", "graphql", "--hostname", host, "-f", &owner, "-f", &name, "-F", &n, "-f", &query]).map_err(|f| anyhow::anyhow!(f.to_string()))?;
    let v: Value = serde_json::from_str(&text).map_err(|_| anyhow::anyhow!(tr!("看不懂 gh 的输出", "Couldn't read gh's output")))?;
    parse_discussion(&v).ok_or_else(|| anyhow::anyhow!(tr!("看不懂 gh 的输出", "Couldn't read gh's output")))
}

fn author(v: &Value) -> String {
    // A deleted account comes back as null; GitHub shows it as "ghost".
    login(v, "author").unwrap_or_else(|| "ghost".into())
}

fn line_no(v: &Value, key: &str) -> Option<u32> {
    v.get(key).and_then(Value::as_u64).and_then(|n| u32::try_from(n).ok())
}

/// `nodes`, and whether `totalCount` says there are more.
fn nodes<'a>(v: &'a Value, key: &str) -> (&'a [Value], bool) {
    let list = v.get(key).and_then(|c| c.get("nodes")).and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
    let total = v.get(key).and_then(|c| c.get("totalCount")).and_then(Value::as_u64).unwrap_or(0);
    (list, total > list.len() as u64)
}

pub fn parse_discussion(v: &Value) -> Option<PrDiscussion> {
    let pr = v.get("data")?.get("repository")?.get("pullRequest")?;
    if !pr.is_object() {
        return None;
    }
    let (comments, more_comments) = nodes(pr, "comments");
    let (reviews, more_reviews) = nodes(pr, "reviews");
    let (threads, more_threads) = nodes(pr, "reviewThreads");
    let mut truncated = more_comments || more_reviews || more_threads;

    let mut posts: Vec<PrPost> = Vec::new();
    for c in comments {
        // Hidden on GitHub (spam, off-topic, outdated): hidden here too.
        if c.get("isMinimized").and_then(Value::as_bool).unwrap_or(false) {
            continue;
        }
        posts.push(PrPost { kind: "comment", id: None, author: author(c), body: s(c, "body").to_string(), state: None, at: time(s(c, "createdAt")), url: s(c, "url").to_string() });
    }
    for r in reviews {
        let state = match s(r, "state") {
            "APPROVED" => "approved",
            "CHANGES_REQUESTED" => "changesRequested",
            "COMMENTED" => "commented",
            "DISMISSED" => "dismissed",
            // PENDING: the viewer's own review, not submitted yet.
            _ => continue,
        };
        posts.push(PrPost {
            kind: "review",
            id: Some(s(r, "id").to_string()).filter(|i| !i.is_empty()),
            author: author(r),
            body: s(r, "body").to_string(),
            state: Some(state),
            at: time(s(r, "submittedAt")),
            url: s(r, "url").to_string(),
        });
    }
    posts.sort_by_key(|p| p.at.unwrap_or(i64::MAX));

    let mut out_threads = Vec::new();
    for t in threads {
        let (list, more) = nodes(t, "comments");
        truncated |= more;
        let Some(first) = list.first() else { continue };
        let comments = list.iter().map(|c| PrReply { author: author(c), body: s(c, "body").to_string(), at: time(s(c, "createdAt")), url: s(c, "url").to_string() }).collect();
        out_threads.push(PrThread {
            path: s(t, "path").to_string(),
            line: line_no(t, "line"),
            start_line: line_no(t, "startLine"),
            original_line: line_no(t, "originalLine"),
            old_side: s(t, "diffSide") == "LEFT",
            resolved: t.get("isResolved").and_then(Value::as_bool).unwrap_or(false),
            outdated: t.get("isOutdated").and_then(Value::as_bool).unwrap_or(false),
            review_id: first.get("pullRequestReview").map(|r| s(r, "id").to_string()).filter(|i| !i.is_empty()),
            diff_hunk: s(first, "diffHunk").to_string(),
            comments,
        });
    }
    Some(PrDiscussion { posts, threads: out_threads, truncated })
}

// ---------- parsing ----------

pub fn parse_list(text: &str) -> Option<Vec<PullRequest>> {
    let v: Value = serde_json::from_str(text).ok()?;
    Some(v.as_array()?.iter().filter_map(parse_pr).collect())
}

fn s<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}

fn login(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(|o| o.get("login")).and_then(Value::as_str).filter(|l| !l.is_empty()).map(str::to_string)
}

pub fn parse_pr(v: &Value) -> Option<PullRequest> {
    let number = u32::try_from(v.get("number")?.as_u64()?).ok()?;
    let head_ref_oid = s(v, "headRefOid");
    let base_ref_oid = s(v, "baseRefOid");
    if !is_oid(head_ref_oid) || !is_oid(base_ref_oid) {
        return None;
    }
    let n = |key: &str| v.get(key).and_then(Value::as_u64).unwrap_or(0);
    Some(PullRequest {
        number,
        title: s(v, "title").to_string(),
        author: login(v, "author").unwrap_or_default(),
        state: match s(v, "state") {
            "MERGED" => "merged",
            "CLOSED" => "closed",
            _ => "open",
        },
        is_draft: v.get("isDraft").and_then(Value::as_bool).unwrap_or(false),
        head_ref_name: s(v, "headRefName").to_string(),
        head_ref_oid: head_ref_oid.to_ascii_lowercase(),
        base_ref_name: s(v, "baseRefName").to_string(),
        base_ref_oid: base_ref_oid.to_ascii_lowercase(),
        is_cross_repository: v.get("isCrossRepository").and_then(Value::as_bool).unwrap_or(false),
        head_owner: login(v, "headRepositoryOwner"),
        review_decision: match s(v, "reviewDecision") {
            "APPROVED" => Some("approved"),
            "CHANGES_REQUESTED" => Some("changesRequested"),
            "REVIEW_REQUIRED" => Some("reviewRequired"),
            _ => None,
        },
        mergeable: match s(v, "mergeable") {
            "MERGEABLE" => "mergeable",
            "CONFLICTING" => "conflicting",
            _ => "unknown",
        },
        additions: n("additions"),
        deletions: n("deletions"),
        changed_files: n("changedFiles"),
        checks: parse_checks(v.get("statusCheckRollup")),
        created_at: time(s(v, "createdAt")),
        updated_at: time(s(v, "updatedAt")),
        merged_at: time(s(v, "mergedAt")),
        closed_at: time(s(v, "closedAt")),
        url: s(v, "url").to_string(),
        body: v.get("body").and_then(Value::as_str).map(str::to_string),
    })
}

/// Check runs and commit statuses in one list. A re-run check appears once, as its latest run.
pub fn parse_checks(v: Option<&Value>) -> Vec<Check> {
    let mut out: Vec<Check> = Vec::new();
    for c in v.and_then(Value::as_array).into_iter().flatten() {
        let check = if c.get("__typename").and_then(Value::as_str) == Some("StatusContext") {
            Check {
                name: s(c, "context").to_string(),
                workflow: None,
                state: match s(c, "state") {
                    "SUCCESS" => "success",
                    "FAILURE" | "ERROR" => "failure",
                    _ => "pending",
                },
                url: Some(s(c, "targetUrl").to_string()).filter(|u| !u.is_empty()),
                started_at: time(s(c, "startedAt")),
                completed_at: None,
            }
        } else {
            let done = s(c, "status") == "COMPLETED";
            Check {
                name: s(c, "name").to_string(),
                workflow: Some(s(c, "workflowName").to_string()).filter(|w| !w.is_empty()),
                state: if !done {
                    "pending"
                } else {
                    match s(c, "conclusion") {
                        "SUCCESS" => "success",
                        "SKIPPED" => "skipped",
                        "NEUTRAL" => "neutral",
                        "CANCELLED" => "cancelled",
                        _ => "failure",
                    }
                },
                url: Some(s(c, "detailsUrl").to_string()).filter(|u| !u.is_empty()),
                started_at: time(s(c, "startedAt")),
                completed_at: if done { time(s(c, "completedAt")) } else { None },
            }
        };
        if check.name.is_empty() {
            continue;
        }
        match out.iter_mut().find(|o| o.name == check.name && o.workflow == check.workflow) {
            Some(o) if check.started_at > o.started_at => *o = check,
            Some(_) => {}
            None => out.push(check),
        }
    }
    out
}

/// `2026-11-08T04:39:41Z` → unix seconds. GitHub's zero time (`0001-01-01…`) and blanks are `None`.
pub fn time(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let num = |r: std::ops::Range<usize>| s.get(r)?.parse::<i64>().ok();
    let (y, m, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (hh, mm, ss) = (num(11..13)?, num(14..16)?, num(17..19)?);
    if y < 1971 || !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    // Days from the civil date (Howard Hinnant's algorithm).
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    // Offsets other than Z (gh always sends UTC, but be exact if it doesn't).
    let offset = match s.get(19..).map(|t| t.trim_start_matches(|c: char| c == '.' || c.is_ascii_digit())) {
        Some(t) if t.len() == 6 && (t.starts_with('+') || t.starts_with('-')) => {
            let sign = if t.starts_with('-') { -1 } else { 1 };
            sign * (t.get(1..3)?.parse::<i64>().ok()? * 3600 + t.get(4..6)?.parse::<i64>().ok()? * 60)
        }
        _ => 0,
    };
    Some(days * 86_400 + hh * 3600 + mm * 60 + ss - offset)
}

/// A full SHA-1 or SHA-256 object id.
pub fn is_oid(s: &str) -> bool {
    (s.len() == 40 || s.len() == 64) && s.chars().all(|c| c.is_ascii_hexdigit())
}

// ---------- commits ----------

fn has_commit(dir: &Path, oid: &str) -> bool {
    matches!(git::code(dir, &["cat-file", "-e", &format!("{oid}^{{commit}}")]), Ok((0, _)))
}

/// Objects only: no remote-tracking branch moves (`--refmap=`), no FETCH_HEAD, no tags, no gc,
/// and no submodule fetches (those would move the submodules' own remote-tracking branches).
fn fetch_objects(dir: &Path, remote: &str, refspec: &str) -> Result<()> {
    git::run_with_timeout(
        dir,
        &["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--no-auto-gc", "--no-recurse-submodules", "--refmap=", remote, refspec],
        Duration::from_secs(120),
    )
}

/// Makes sure the pull request's head and base commits are here, then counts its commits.
pub fn prepare(dir: &Path, remote: Option<&str>, number: u32, head: &str, base: &str, base_ref: &str) -> Result<PreparedPr> {
    if !is_oid(head) || !is_oid(base) {
        bail!(tr!("提交标识无效", "Invalid commit id"));
    }
    let remote = remote.filter(|r| !r.starts_with('-'));
    if !has_commit(dir, head) {
        if let Some(remote) = remote {
            fetch_objects(dir, remote, &format!("refs/pull/{number}/head"))?;
        }
    }
    if !has_commit(dir, base) {
        if let Some(remote) = remote.filter(|_| valid_branch(dir, base_ref)) {
            fetch_objects(dir, remote, &format!("refs/heads/{base_ref}"))?;
        }
    }
    if !has_commit(dir, head) || !has_commit(dir, base) {
        bail!(tr!("本地和远程仓库里都找不到 PR #{number} 的提交", "PR #{number}'s commits aren't here or on the remote"));
    }
    let (ahead, _) = repo::ahead_behind(dir, base, head)?;
    Ok(PreparedPr { ahead })
}

fn valid_branch(dir: &Path, name: &str) -> bool {
    !name.is_empty() && !name.starts_with('-') && matches!(git::code(dir, &["check-ref-format", "--branch", name]), Ok((0, _)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const HEAD: &str = "ffedb5300f059bce82d6be9f40930578dd6184ad";
    const BASE: &str = "a8326d10e317c2717f4cd588e5b14de456ad9f31";

    #[test]
    fn slugs_for_gh() {
        assert_eq!(repo_slug("https://github.com/linjiejim/retrace").as_deref(), Some("github.com/linjiejim/retrace"));
        assert_eq!(repo_slug("https://github.example.com/team/app").as_deref(), Some("github.example.com/team/app"));
        assert_eq!(repo_slug("https://github.com/linjiejim"), None);
        assert_eq!(repo_slug("http://github.com/a/b"), None);
        assert_eq!(repo_slug("https://github.com/-a/b"), None);
    }

    #[test]
    fn reads_times() {
        assert_eq!(time("1970-01-02T00:00:00Z"), None, "before 1971 is GitHub's zero time");
        assert_eq!(time("2026-11-08T04:39:41Z"), Some(1_794_112_781));
        assert_eq!(time("2026-11-08T12:39:41+08:00"), Some(1_794_112_781));
        assert_eq!(time("2026-11-08T04:39:41.250Z"), Some(1_794_112_781));
        assert_eq!(time("0001-01-01T00:00:00Z"), None);
        assert_eq!(time(""), None);
        assert_eq!(time("2000-02-29T00:00:00Z"), Some(951_782_400));
    }

    #[test]
    fn parses_a_pull_request() {
        let v = json!({
            "number": 5, "title": "feat: pins", "author": {"login": "linjiejim", "name": "Jim"},
            "state": "MERGED", "isDraft": false, "headRefName": "feat/pin", "headRefOid": HEAD,
            "baseRefName": "main", "baseRefOid": BASE, "isCrossRepository": false,
            "headRepositoryOwner": {"login": "linjiejim"}, "reviewDecision": "", "mergeable": "UNKNOWN",
            "additions": 976, "deletions": 119, "changedFiles": 21,
            "createdAt": "2026-11-08T04:30:00Z", "updatedAt": "2026-11-08T04:40:00Z", "mergedAt": "2026-11-08T04:41:00Z", "closedAt": null,
            "url": "https://github.com/linjiejim/retrace/pull/5", "statusCheckRollup": []
        });
        let pr = parse_pr(&v).unwrap();
        assert_eq!((pr.number, pr.state, pr.author.as_str(), pr.review_decision, pr.mergeable), (5, "merged", "linjiejim", None, "unknown"));
        assert_eq!((pr.additions, pr.deletions, pr.changed_files), (976, 119, 21));
        assert_eq!(pr.closed_at, None);
        assert!(pr.merged_at.is_some() && pr.body.is_none());

        let mut bad = v.clone();
        bad["headRefOid"] = json!("--upload-pack=x");
        assert!(parse_pr(&bad).is_none(), "an oid that isn't hex never reaches git");
        assert_eq!(parse_list(&format!("[{v}, {bad}]")).unwrap().len(), 1);
        assert!(parse_list("not json").is_none());
    }

    #[test]
    fn folds_checks_and_statuses() {
        let rollup = json!([
            {"__typename": "CheckRun", "name": "check", "workflowName": "CI", "status": "COMPLETED", "conclusion": "FAILURE", "startedAt": "2026-11-08T04:00:00Z", "completedAt": "2026-11-08T04:01:00Z", "detailsUrl": "https://x/1"},
            {"__typename": "CheckRun", "name": "check", "workflowName": "CI", "status": "COMPLETED", "conclusion": "SUCCESS", "startedAt": "2026-11-08T05:00:00Z", "completedAt": "2026-11-08T05:01:00Z", "detailsUrl": "https://x/2"},
            {"__typename": "CheckRun", "name": "lint", "workflowName": "CI", "status": "IN_PROGRESS", "conclusion": "", "startedAt": "2026-11-08T05:00:00Z", "completedAt": "0001-01-01T00:00:00Z"},
            {"__typename": "CheckRun", "name": "deploy", "workflowName": "", "status": "COMPLETED", "conclusion": "SKIPPED"},
            {"__typename": "CheckRun", "name": "slow", "status": "COMPLETED", "conclusion": "TIMED_OUT"},
            {"__typename": "StatusContext", "context": "vercel", "state": "ERROR", "targetUrl": "https://v"},
            {"__typename": "StatusContext", "context": "ci/legacy", "state": "PENDING", "targetUrl": ""}
        ]);
        let checks = parse_checks(Some(&rollup));
        let by = |n: &str| checks.iter().find(|c| c.name == n).unwrap();
        assert_eq!(checks.len(), 6, "the re-run counts once");
        assert_eq!((by("check").state, by("check").url.as_deref()), ("success", Some("https://x/2")));
        assert_eq!((by("lint").state, by("lint").completed_at), ("pending", None));
        assert_eq!((by("deploy").state, by("deploy").workflow.as_deref()), ("skipped", None));
        assert_eq!(by("slow").state, "failure");
        assert_eq!(by("vercel").state, "failure");
        assert_eq!((by("ci/legacy").state, by("ci/legacy").url.as_deref()), ("pending", None));
        assert!(parse_checks(None).is_empty());
    }

    #[test]
    fn login_failures_are_told_apart() {
        assert_eq!(classify(Some(4), ""), Failure::NoAuth);
        assert_eq!(classify(Some(1), "To get started with GitHub CLI, please run:  gh auth login"), Failure::NoAuth);
        assert!(matches!(classify(Some(1), "GraphQL: Could not resolve to a Repository\n"), Failure::Other(m) if m.contains("Could not resolve")));
    }

    #[test]
    fn oids() {
        assert!(is_oid(HEAD) && is_oid(&"a".repeat(64)));
        assert!(!is_oid("ffedb53") && !is_oid("-ffedb5300f059bce82d6be9f40930578dd6184a") && !is_oid(&"g".repeat(40)));
    }

    #[test]
    fn routes_image_urls() {
        use ImageSource::*;
        let gh = |e: &str, raw: bool| Some(Gh { endpoint: e.into(), host: "github.com".into(), raw });
        let att = "https://github.com/user-attachments/assets/bcf10404-41dd-424f-a588-d42d3affb266";
        assert_eq!(image_source(att, "github.com"), gh(att, false), "attachments need the login");
        assert_eq!(image_source("https://raw.githubusercontent.com/o/r/main/docs/a%20b.png", "github.com"), gh("repos/o/r/contents/docs/a%20b.png?ref=main", true));
        assert_eq!(image_source("https://raw.githubusercontent.com/o/r/refs/heads/feat/x.png", "github.com"), gh("repos/o/r/contents/x.png?ref=refs/heads/feat", true));
        assert_eq!(image_source("https://github.com/o/r/blob/abc123/shot.png?raw=true", "github.com"), gh("repos/o/r/contents/shot.png?ref=abc123", true));
        assert_eq!(image_source("https://github.com/o/r/raw/HEAD/shot.png", "github.com"), gh("repos/o/r/contents/shot.png?ref=HEAD", true));
        assert_eq!(image_source("https://github.com/o/r/raw/HEAD/../x.png", "github.com"), None, "no climbing out of the path");
        assert_eq!(image_source("https://raw.githubusercontent.com/-o/r/main/x.png", "github.com"), None);
        let cos = "https://pr-assets.cos.ap-hongkong.myqcloud.com/a/b.png?x=1";
        assert_eq!(image_source(cos, "github.com"), Some(Web(cos.into())));
        assert_eq!(image_source("https://private-user-images.githubusercontent.com/1/2.png?jwt=x", "github.com"), Some(Web("https://private-user-images.githubusercontent.com/1/2.png?jwt=x".into())));
        assert_eq!(
            image_source("https://ghe.example.com/user-attachments/assets/1", "ghe.example.com"),
            Some(Gh { endpoint: "https://ghe.example.com/user-attachments/assets/1".into(), host: "ghe.example.com".into(), raw: false })
        );
        for bad in ["http://example.com/a.png", "https://localhost/a.png", "https://127.0.0.1/a.png", "https://[::1]/a.png", "https://intranet/a.png", "https://u@example.com/a.png", "https://example.com/a b.png", "https://printer.local/a.png", "file:///etc/hosts"] {
            assert_eq!(image_source(bad, "github.com"), None, "{bad}");
        }
    }

    #[test]
    fn sniffs_images_not_headers() {
        assert_eq!(sniff(b"\x89PNG\r\n\x1a\n...."), Some("image/png"));
        assert_eq!(sniff(b"\xff\xd8\xff\xe0..."), Some("image/jpeg"));
        assert_eq!(sniff(b"GIF89a.."), Some("image/gif"));
        assert_eq!(sniff(b"RIFF\0\0\0\0WEBPVP8 "), Some("image/webp"));
        assert_eq!(sniff(b"\0\0\0\x1cftypavif"), Some("image/avif"));
        assert_eq!(sniff(b"\xef\xbb\xbf  <?xml version=\"1.0\"?>\n<svg xmlns=\"x\"/>"), Some("image/svg+xml"));
        assert_eq!(sniff(b"<!doctype html><html><svg></svg>"), None, "a page isn't an image");
        assert_eq!(sniff(b"404: Not Found"), None);
        assert_eq!(sniff(b""), None);
    }

    #[test]
    fn parses_a_discussion() {
        let v = json!({"data": {"repository": {"pullRequest": {
            "comments": {"totalCount": 3, "nodes": [
                {"author": {"login": "a"}, "body": "later", "createdAt": "2026-11-08T05:00:00Z", "url": "u1", "isMinimized": false},
                {"author": null, "body": "spam", "createdAt": "2026-11-08T04:10:00Z", "url": "u2", "isMinimized": true},
                {"author": null, "body": "first", "createdAt": "2026-11-08T04:00:00Z", "url": "u3", "isMinimized": false}
            ]},
            "reviews": {"totalCount": 2, "nodes": [
                {"id": "R1", "author": {"login": "b"}, "body": "", "state": "CHANGES_REQUESTED", "submittedAt": "2026-11-08T04:30:00Z", "url": "r1"},
                {"id": "R2", "author": {"login": "me"}, "body": "draft", "state": "PENDING", "submittedAt": null, "url": "r2"}
            ]},
            "reviewThreads": {"totalCount": 1, "nodes": [
                {"isResolved": true, "isOutdated": false, "path": "src/a.rs", "line": 6, "startLine": 5, "originalLine": 6, "diffSide": "LEFT",
                 "comments": {"totalCount": 2, "nodes": [
                    {"author": {"login": "b"}, "body": "why?", "createdAt": "2026-11-08T04:29:00Z", "url": "t1", "diffHunk": "@@ -1 +1 @@\n-x\n+y", "pullRequestReview": {"id": "R1"}},
                    {"author": {"login": "a"}, "body": "because", "createdAt": "2026-11-08T04:40:00Z", "url": "t2", "diffHunk": "", "pullRequestReview": {"id": "R3"}}
                 ]}}
            ]}
        }}}});
        let d = parse_discussion(&v).unwrap();
        let bodies: Vec<&str> = d.posts.iter().map(|p| p.body.as_str()).collect();
        assert_eq!(bodies, ["first", "", "later"], "in time order, hidden and pending ones left out");
        assert_eq!((d.posts[0].author.as_str(), d.posts[1].kind, d.posts[1].state, d.posts[1].id.as_deref()), ("ghost", "review", Some("changesRequested"), Some("R1")));
        let t = &d.threads[0];
        assert_eq!((t.path.as_str(), t.line, t.start_line, t.old_side, t.resolved, t.review_id.as_deref()), ("src/a.rs", Some(6), Some(5), true, true, Some("R1")));
        assert_eq!((t.comments.len(), t.diff_hunk.as_str()), (2, "@@ -1 +1 @@\n-x\n+y"));
        assert!(!d.truncated);

        let mut more = v.clone();
        more["data"]["repository"]["pullRequest"]["reviewThreads"]["nodes"][0]["comments"]["totalCount"] = json!(150);
        assert!(parse_discussion(&more).unwrap().truncated);
        assert!(parse_discussion(&json!({"data": {"repository": {"pullRequest": null}}})).is_none());
    }
}
