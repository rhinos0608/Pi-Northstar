//! Capability-scoped worker process launch and lifecycle management.
//! Starts child process from an empty environment with only explicitly granted variables.
//! Fixed argv execution (no shell). Unix process group and termination controls.

use std::collections::{BTreeMap, HashSet};
use std::io;
use std::process::{Child, Command};
use std::time::{Duration, Instant};

#[cfg(unix)]
use std::os::unix::process::CommandExt;

pub const MAX_ENV_VALUE_BYTES: usize = 4096;

pub const DEFAULT_DENIED_PREFIXES: &[&str] = &[
    "AWS_",
    "GCP_",
    "AZURE_",
    "GITHUB_",
    "GH_",
    "NPM_",
    "CARGO_",
    "RUSTUP_",
    "SSH_",
    "DOCKER_",
    "KUBECONFIG",
];

#[derive(Debug, PartialEq, Eq)]
pub enum EnvGrantError {
    InvalidKey(String),
    ValueTooLarge(usize),
    DeniedPrefix(String),
}

impl std::fmt::Display for EnvGrantError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EnvGrantError::InvalidKey(k) => write!(f, "invalid environment key: {k:?}"),
            EnvGrantError::ValueTooLarge(sz) => {
                write!(f, "value size {sz} exceeds maximum {MAX_ENV_VALUE_BYTES}")
            }
            EnvGrantError::DeniedPrefix(k) => {
                write!(f, "environment key {k:?} matches denied prefix")
            }
        }
    }
}

impl std::error::Error for EnvGrantError {}

fn is_valid_key(key: &str) -> bool {
    if key.is_empty() {
        return false;
    }
    let mut chars = key.chars();
    let first = chars.next().unwrap();
    if !(first.is_ascii_uppercase() || first == '_') {
        return false;
    }
    chars.all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScopedEnv {
    grants: BTreeMap<String, String>,
    denied_prefixes: Vec<String>,
    allowed_overrides: HashSet<String>,
}

impl Default for ScopedEnv {
    fn default() -> Self {
        Self::new()
    }
}

impl ScopedEnv {
    pub fn new() -> Self {
        Self {
            grants: BTreeMap::new(),
            denied_prefixes: DEFAULT_DENIED_PREFIXES
                .iter()
                .map(|s| s.to_string())
                .collect(),
            allowed_overrides: HashSet::new(),
        }
    }

    pub fn deny_prefix(&mut self, prefix: impl Into<String>) -> &mut Self {
        self.denied_prefixes.push(prefix.into());
        self
    }

    pub fn allow_override(&mut self, prefix: impl Into<String>) -> &mut Self {
        self.allowed_overrides.insert(prefix.into());
        self
    }

    pub fn grant(&mut self, key: &str, value: &str) -> Result<&mut Self, EnvGrantError> {
        if !is_valid_key(key) {
            return Err(EnvGrantError::InvalidKey(key.to_string()));
        }
        if value.len() > MAX_ENV_VALUE_BYTES {
            return Err(EnvGrantError::ValueTooLarge(value.len()));
        }

        let is_denied = self
            .denied_prefixes
            .iter()
            .any(|prefix| key.starts_with(prefix));

        if is_denied {
            let is_allowed = self
                .allowed_overrides
                .iter()
                .any(|prefix| key.starts_with(prefix));
            if !is_allowed {
                return Err(EnvGrantError::DeniedPrefix(key.to_string()));
            }
        }

        self.grants.insert(key.to_string(), value.to_string());
        Ok(self)
    }

    pub fn build_command_env(&self) -> &BTreeMap<String, String> {
        &self.grants
    }
}

#[derive(Debug, Clone)]
pub struct WorkerSpec {
    pub program: String,
    pub args: Vec<String>,
    pub scoped_env: ScopedEnv,
    pub timeout_ms: u64,
    pub run_as_uid: Option<u32>,
}

#[cfg(target_os = "windows")]
pub fn launch(_spec: &WorkerSpec) -> io::Result<Child> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "Windows unprivileged worker launch unsupported: dispatch via Tier 2 Job Object path instead",
    ))
}

#[cfg(unix)]
pub fn launch(spec: &WorkerSpec) -> io::Result<Child> {
    let mut cmd = Command::new(&spec.program);
    cmd.args(&spec.args);
    cmd.env_clear();
    for (k, v) in spec.scoped_env.build_command_env() {
        cmd.env(k, v);
    }

    cmd.process_group(0);

    if let Some(uid) = spec.run_as_uid {
        cmd.uid(uid);
    }

    cmd.spawn()
}

#[cfg(not(any(unix, target_os = "windows")))]
pub fn launch(_spec: &WorkerSpec) -> io::Result<Child> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "unsupported platform for worker launch",
    ))
}

#[cfg(unix)]
pub fn kill_to_zero(child: &mut Child) -> io::Result<bool> {
    let pid = child.id() as libc::pid_t;
    // Target the process group
    unsafe {
        libc::killpg(pid, libc::SIGKILL);
    }
    child.wait().map(|_| true)
}

#[cfg(not(unix))]
pub fn kill_to_zero(child: &mut Child) -> io::Result<bool> {
    child.kill()?;
    child.wait().map(|_| true)
}

/// Gracefully terminate child process.
/// Sends SIGTERM, waits up to `grace_ms` polling every 25ms.
/// If child has not exited after grace period, sends SIGKILL.
/// Returns Ok(true) if SIGKILL was needed (e.g. TimedOut), Ok(false) if process exited gracefully within window.
#[cfg(unix)]
pub fn terminate_graceful(child: &mut Child, grace_ms: u64) -> io::Result<bool> {
    let pid = child.id() as libc::pid_t;

    // First check if already exited
    if let Some(_status) = child.try_wait()? {
        return Ok(false);
    }

    // Send SIGTERM to process group
    unsafe {
        libc::killpg(pid, libc::SIGTERM);
    }

    let start = Instant::now();
    let grace_duration = Duration::from_millis(grace_ms);
    let poll_interval = Duration::from_millis(25);

    loop {
        if let Some(_status) = child.try_wait()? {
            return Ok(false);
        }

        if start.elapsed() >= grace_duration {
            // Grace window expired, escalate to SIGKILL
            unsafe {
                libc::killpg(pid, libc::SIGKILL);
            }
            child.wait()?;
            return Ok(true);
        }

        let remaining = grace_duration.saturating_sub(start.elapsed());
        let sleep_time = poll_interval.min(remaining);
        std::thread::sleep(sleep_time);
    }
}

#[cfg(not(unix))]
pub fn terminate_graceful(child: &mut Child, _grace_ms: u64) -> io::Result<bool> {
    child.kill()?;
    child.wait()?;
    Ok(true)
}
