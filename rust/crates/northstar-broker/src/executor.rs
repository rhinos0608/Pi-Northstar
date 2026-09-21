//! Upstream native executor client over Unix Domain Socket.
//! Connects to an upstream executor, attests peer UID == own euid,
//! length-prefix frames RPC request, and receives reply with strict timeout.

use std::io::{Read, Write};
use std::os::unix::fs::MetadataExt;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::endpoint::unix::get_peer_identity;
use crate::frame::BROKER_MAX_FRAME_BYTES;

#[derive(Debug)]
pub enum ExecutorError {
    /// Failure before request dispatch (connect failed, UID mismatch, write/flush error).
    /// Safe to retry.
    BeforeDispatch(String),
    /// Failure after request dispatch (timeout waiting for reply, truncated reply, connection dropped).
    /// State is ambiguous; caller maps mutations to outcome_unknown.
    AfterDispatch(String),
}

impl std::fmt::Display for ExecutorError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ExecutorError::BeforeDispatch(msg) => write!(f, "executor error before dispatch: {msg}"),
            ExecutorError::AfterDispatch(msg) => write!(f, "executor error after dispatch: {msg}"),
        }
    }
}

impl std::error::Error for ExecutorError {}

#[derive(Debug, Clone)]
pub struct ExecutorUpstream {
    socket_path: PathBuf,
    token_file: Option<PathBuf>,
}

impl ExecutorUpstream {
    pub fn new<P: Into<PathBuf>>(socket_path: P) -> Self {
        Self {
            socket_path: socket_path.into(),
            token_file: None,
        }
    }

    pub fn with_token_file<P: Into<PathBuf>, T: Into<PathBuf>>(
        socket_path: P,
        token_file: T,
    ) -> Self {
        Self {
            socket_path: socket_path.into(),
            token_file: Some(token_file.into()),
        }
    }

    pub fn socket_path(&self) -> &Path {
        &self.socket_path
    }

    /// Connect to socket and attest that peer UID matches our EUID.
    pub fn connect(&self) -> Result<UnixStream, ExecutorError> {
        let stream = UnixStream::connect(&self.socket_path)
            .map_err(|e| ExecutorError::BeforeDispatch(format!("connect failed: {e}")))?;

        let raw_fd = std::os::unix::io::AsRawFd::as_raw_fd(&stream);
        let my_euid = unsafe { libc::geteuid() };

        match get_peer_identity(raw_fd) {
            Ok(peer) => {
                if peer.uid != my_euid {
                    return Err(ExecutorError::BeforeDispatch(format!(
                        "peer UID mismatch: peer {} != self {}",
                        peer.uid, my_euid
                    )));
                }
            }
            Err(e) => {
                // macOS getpeereid fallback on unnamed socket pair or OS error:
                // check file metadata UID if kernel peer identity fails
                if let Ok(meta) = std::fs::metadata(&self.socket_path) {
                    if meta.uid() != my_euid {
                        return Err(ExecutorError::BeforeDispatch(format!(
                            "socket file UID mismatch: file {} != self {}",
                            meta.uid(),
                            my_euid
                        )));
                    }
                } else {
                    return Err(ExecutorError::BeforeDispatch(format!(
                        "peer identity unavailable: {e}"
                    )));
                }
            }
        }

        let mut stream = stream;
        if let Some(ref token_file_path) = self.token_file {
            let mut token_bytes = std::fs::read(token_file_path).map_err(|e| {
                ExecutorError::BeforeDispatch(format!(
                    "failed to read executor token file {:?}: {e}",
                    token_file_path
                ))
            })?;

            let auth_payload = serde_json::json!({
                "token": String::from_utf8_lossy(&token_bytes).trim().to_string()
            });

            // Zeroize sensitive buffer immediately
            for b in token_bytes.iter_mut() {
                *b = 0;
            }
            std::sync::atomic::compiler_fence(std::sync::atomic::Ordering::SeqCst);

            let auth_bytes = match serde_json::to_vec(&auth_payload) {
                Ok(b) => b,
                Err(e) => {
                    return Err(ExecutorError::BeforeDispatch(format!(
                        "failed serializing auth frame: {e}"
                    )));
                }
            };

            if auth_bytes.len() > BROKER_MAX_FRAME_BYTES {
                return Err(ExecutorError::BeforeDispatch(
                    "auth frame exceeds maximum frame bytes".to_string(),
                ));
            }

            let len = auth_bytes.len() as u32;
            let mut auth_frame = Vec::with_capacity(4 + auth_bytes.len());
            auth_frame.extend_from_slice(&len.to_be_bytes());
            auth_frame.extend_from_slice(&auth_bytes);

            if let Err(e) = stream.write_all(&auth_frame) {
                return Err(ExecutorError::BeforeDispatch(format!(
                    "failed sending auth frame: {e}"
                )));
            }
            if let Err(e) = stream.flush() {
                return Err(ExecutorError::BeforeDispatch(format!(
                    "failed flushing auth frame: {e}"
                )));
            }
        }

        Ok(stream)
    }

    /// Send a request JSON payload length-prefixed and wait for reply.
    pub fn execute(&self, request_json: &[u8], timeout: Duration) -> Result<Vec<u8>, ExecutorError> {
        if request_json.len() > BROKER_MAX_FRAME_BYTES {
            return Err(ExecutorError::BeforeDispatch(
                "request payload exceeds maximum frame bytes".to_string(),
            ));
        }

        let mut stream = self.connect()?;

        // Send length-prefix + body
        let len = request_json.len() as u32;
        let mut req_frame = Vec::with_capacity(4 + request_json.len());
        req_frame.extend_from_slice(&len.to_be_bytes());
        req_frame.extend_from_slice(request_json);

        if let Err(e) = stream.write_all(&req_frame) {
            return Err(ExecutorError::BeforeDispatch(format!("write failed: {e}")));
        }
        if let Err(e) = stream.flush() {
            return Err(ExecutorError::BeforeDispatch(format!("flush failed: {e}")));
        }

        // After successful dispatch, any read failure is AfterDispatch
        if let Err(e) = stream.set_read_timeout(Some(timeout)) {
            return Err(ExecutorError::AfterDispatch(format!(
                "set_read_timeout failed: {e}"
            )));
        }

        let mut len_buf = [0u8; 4];
        if let Err(e) = stream.read_exact(&mut len_buf) {
            return Err(ExecutorError::AfterDispatch(format!(
                "failed reading reply length: {e}"
            )));
        }

        let reply_len = u32::from_be_bytes(len_buf) as usize;
        if reply_len > BROKER_MAX_FRAME_BYTES {
            return Err(ExecutorError::AfterDispatch(
                "reply frame too large".to_string(),
            ));
        }

        let mut reply_body = vec![0u8; reply_len];
        if let Err(e) = stream.read_exact(&mut reply_body) {
            return Err(ExecutorError::AfterDispatch(format!(
                "failed reading reply body: {e}"
            )));
        }

        Ok(reply_body)
    }
}
