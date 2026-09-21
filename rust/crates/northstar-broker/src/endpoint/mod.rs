//! Native endpoint binding and kernel peer attestation.
//! 
//! Tier 1 (CI): validates mock UID/SID mismatch rejection logic.
//! Tier 2 (privileged): validates real per-job cross-UID denial with worker service.

pub mod unix;

#[cfg(target_os = "windows")]
pub mod windows;

use std::io;

/// Peer identity as resolved by kernel attestation.
#[derive(Debug, Clone, PartialEq)]
pub struct PeerIdentity {
    /// Effective UID of the connecting process (Unix) or SID string (Windows).
    pub uid: u32,
    /// PID of the connecting process (best-effort; subject to TOCTOU on macOS).
    pub pid: Option<u32>,
}

/// Attestation error: caller identity could not be verified.
#[derive(Debug)]
pub enum AttestationError {
    /// Peer UID/SID does not match the server's owner identity.
    UnauthorizedPeer,
    /// Peer credentials could not be retrieved from the kernel.
    CredentialsUnavailable(io::Error),
}

impl std::fmt::Display for AttestationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AttestationError::UnauthorizedPeer => write!(f, "unauthorized peer identity"),
            AttestationError::CredentialsUnavailable(e) => write!(f, "credentials unavailable: {e}"),
        }
    }
}
impl std::error::Error for AttestationError {}

/// Validate that the resolved peer identity matches the expected owner UID.
/// Returns Ok(identity) when peer is verified, Err when denied.
pub fn assert_same_owner(peer: &PeerIdentity, expected_uid: u32) -> Result<(), AttestationError> {
    if peer.uid != expected_uid {
        Err(AttestationError::UnauthorizedPeer)
    } else {
        Ok(())
    }
}
