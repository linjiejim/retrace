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

use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};

pub struct State {
    pub config: RwLock<config::Config>,
    pub config_path: PathBuf,
    pub integration: repo::IntegrationCache,
    pub history: history::HistoryCache,
}

impl State {
    pub fn load() -> Arc<Self> {
        let config_path = config::path();
        let config = config::load(&config_path);
        Arc::new(Self { config: RwLock::new(config), config_path, integration: Mutex::new(Default::default()), history: Default::default() })
    }

    pub fn with_config(config_path: PathBuf) -> Arc<Self> {
        let config = config::load(&config_path);
        Arc::new(Self { config: RwLock::new(config), config_path, integration: Mutex::new(Default::default()), history: Default::default() })
    }
}
