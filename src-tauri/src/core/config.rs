//! Persisted settings: the project list and a few preferences.
//! Lives at `<config dir>/me.jimlin.retrace/config.json`, shared by the app and the dev bridge.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    pub projects: Vec<ProjectEntry>,
    pub prefs: Prefs,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ProjectEntry {
    pub path: String,
    pub trunk: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Prefs {
    /// Application name passed to `open -a`.
    pub editor: String,
    pub terminal: String,
    /// 0 turns automatic fetch off.
    pub fetch_minutes: u32,
    /// For web links (pull requests, links in Markdown); empty = the system's default browser.
    pub browser: String,
}

impl Default for Prefs {
    fn default() -> Self {
        Self { editor: "Visual Studio Code".into(), terminal: "Terminal".into(), fetch_minutes: 10, browser: String::new() }
    }
}

pub fn path() -> PathBuf {
    if let Ok(dir) = std::env::var("RETRACE_CONFIG_DIR") {
        return PathBuf::from(dir).join("config.json");
    }
    dirs::config_dir().unwrap_or_else(std::env::temp_dir).join("me.jimlin.retrace").join("config.json")
}

pub fn load(path: &PathBuf) -> Config {
    std::fs::read_to_string(path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

pub fn save(path: &PathBuf, config: &Config) -> anyhow::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(config)?)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}
