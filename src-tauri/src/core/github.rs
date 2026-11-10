//! Pull requests through the user's own GitHub CLI (`gh`). Retrace never sees a token: gh uses
//! the login the user already has. The only write is fetching a pull request's commits when the
//! repository doesn't have them yet, as objects only (no ref, no FETCH_HEAD).

use super::model::{Check, PreparedPr, PullRequest, PullRequests};
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
    let spawned = Command::new(binary())
        .args(args)
        .current_dir(dir)
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .env("GH_PAGER", "cat")
        .env("NO_COLOR", "1")
        .env("CLICOLOR", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();
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
}
