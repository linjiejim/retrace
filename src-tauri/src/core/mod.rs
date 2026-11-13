pub mod acp;
pub mod agent;
pub mod api;
pub mod chat;
pub mod cleanup;
pub mod config;
pub mod diff;
pub mod files;
pub mod git;
pub mod github;
pub mod graph;
pub mod history;
pub mod i18n;
pub mod model;
pub mod opencode_server;
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
    /// Agent sessions running in the background.
    pub agents: Arc<agent::Sessions>,
    /// Whether this process may start agents: the app may; the dev bridge only when asked to.
    pub agents_allowed: AtomicBool,
    /// This machine's OpenCode server, where background sessions run.
    pub opencode: Arc<opencode_server::Host>,
    /// The environment agents start with, when not the login shell's (tests).
    pub agent_env: Option<shell_env::Env>,
}

impl State {
    pub fn load() -> Arc<Self> {
        let config_path = config::path();
        let config = config::load(&config_path);
        let agents = Arc::new(agent::Sessions::with_path(config_path.with_file_name("agent-sessions.json")));
        // Caches, unless the config lives somewhere of its own (a sandbox): then next to it.
        let server_dir = match std::env::var_os("RETRACE_CONFIG_DIR") {
            Some(dir) => PathBuf::from(dir).join("agents"),
            None => dirs::cache_dir().unwrap_or_else(std::env::temp_dir).join("me.jimlin.retrace").join("agents"),
        };
        let opencode = Arc::new(opencode_server::Host::new(server_dir));
        Arc::new(Self { config: RwLock::new(config), config_path, integration: Mutex::new(Default::default()), history: Default::default(), deleted_branches: Default::default(), agents, agents_allowed: AtomicBool::new(true), opencode, agent_env: None })
    }

    pub fn with_config(config_path: PathBuf) -> Arc<Self> {
        let config = config::load(&config_path);
        let agents = Arc::new(agent::Sessions::with_path(config_path.with_file_name("agent-sessions.json")));
        let opencode = Arc::new(opencode_server::Host::new(config_path.with_file_name("agents")));
        Arc::new(Self { config: RwLock::new(config), config_path, integration: Mutex::new(Default::default()), history: Default::default(), deleted_branches: Default::default(), agents, agents_allowed: AtomicBool::new(true), opencode, agent_env: None })
    }

    /// The same, with a given OpenCode server and environment for agents (tests).
    pub fn with_server(config_path: PathBuf, opencode: Arc<opencode_server::Host>, agent_env: shell_env::Env) -> Arc<Self> {
        let config = config::load(&config_path);
        let agents = Arc::new(agent::Sessions::with_path(config_path.with_file_name("agent-sessions.json")));
        Arc::new(Self { config: RwLock::new(config), config_path, integration: Mutex::new(Default::default()), history: Default::default(), deleted_branches: Default::default(), agents, agents_allowed: AtomicBool::new(true), opencode, agent_env: Some(agent_env) })
    }
}
