pub mod agent;
pub mod api;
pub mod cleanup;
pub mod config;
pub mod diff;
pub mod files;
pub mod git;
pub mod graph;
pub mod history;
pub mod i18n;
pub mod model;
pub mod repo;
pub mod shell_env;

use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, RwLock};

pub struct State {
    pub config: RwLock<config::Config>,
    pub config_path: PathBuf,
    pub integration: repo::IntegrationCache,
    pub history: history::HistoryCache,
    /// Branches deleted in this session (key `<project>\0<name>`): the only ones Undo may bring back.
    pub deleted_branches: Mutex<std::collections::HashMap<String, model::DeletedBranch>>,
    /// Agent terminals running in the background.
    pub agents: Arc<agent::Sessions>,
    /// Whether this process may start agents: the app may; the dev bridge only when asked to.
    pub agents_allowed: AtomicBool,
}

impl State {
    pub fn load() -> Arc<Self> {
        let config_path = config::path();
        let config = config::load(&config_path);
        let agents = Arc::new(agent::Sessions::with_path(config_path.with_file_name("agent-sessions.json")));
        Arc::new(Self { config: RwLock::new(config), config_path, integration: Mutex::new(Default::default()), history: Default::default(), deleted_branches: Default::default(), agents, agents_allowed: AtomicBool::new(true) })
    }

    pub fn with_config(config_path: PathBuf) -> Arc<Self> {
        let config = config::load(&config_path);
        let agents = Arc::new(agent::Sessions::with_path(config_path.with_file_name("agent-sessions.json")));
        Arc::new(Self { config: RwLock::new(config), config_path, integration: Mutex::new(Default::default()), history: Default::default(), deleted_branches: Default::default(), agents, agents_allowed: AtomicBool::new(true) })
    }
}
