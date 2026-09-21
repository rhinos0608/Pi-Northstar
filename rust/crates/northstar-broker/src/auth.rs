//! Memory-only HMAC-SHA256 session token authority.
//! Root signing key never leaves broker process memory.
//! Token lifetime: 60 seconds. Verified with constant-time comparison.

use hmac::{Hmac, Mac};
use sha2::Sha256;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::protocol::BrokerCapability;

pub const TOKEN_TTL_SECS: u64 = 60;

type HmacSha256 = Hmac<Sha256>;

use zeroize::ZeroizeOnDrop;

/// In-memory broker authentication authority.
/// rootSecret is zeroized on Drop via ZeroizeOnDrop from zeroize crate.
#[derive(ZeroizeOnDrop)]
pub struct BrokerAuth {
    #[zeroize(skip)]
    pub epoch: String,
    root_secret: [u8; 32],
}

impl BrokerAuth {
    /// Generate a new BrokerAuth with a fresh CSPRNG root secret.
    pub fn new() -> Self {
        let mut secret = [0u8; 32];
        rand::rng().fill_bytes(&mut secret);
        let epoch = new_epoch();
        BrokerAuth { epoch, root_secret: secret }
    }

    /// Re-key with a new epoch (e.g., after broker restart).
    pub fn rotate_epoch(&mut self) {
        self.epoch = new_epoch();
    }
}

fn new_epoch() -> String {
    let mut bytes = [0u8; 16];
    rand::rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

#[derive(Serialize, Deserialize)]
struct TokenClaims {
    epoch: String,
    client_id: String,
    session_id: String,
    project_id: String,
    capabilities: Vec<BrokerCapability>,
    expires_at: u64,
    nonce: String,
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn sign(secret: &[u8; 32], body: &str) -> String {
    let mut mac = HmacSha256::new_from_slice(secret).expect("HMAC key valid");
    mac.update(body.as_bytes());
    URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
}

fn verify_signature(secret: &[u8; 32], body: &str, sig: &str) -> bool {
    let mut mac = HmacSha256::new_from_slice(secret).expect("HMAC key valid");
    mac.update(body.as_bytes());
    let expected = mac.finalize().into_bytes();
    let actual = match URL_SAFE_NO_PAD.decode(sig) {
        Ok(b) => b,
        Err(_) => return false,
    };
    // Constant-time comparison
    if expected.len() != actual.len() { return false; }
    expected.iter().zip(actual.iter()).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0
}

/// Session welcome issued after peer attestation succeeds.
pub struct SessionWelcome {
    pub session_id: String,
    pub token: String,
    pub expires_at: u64,
    pub capabilities: Vec<BrokerCapability>,
    pub epoch: String,
}

/// Issue a session token after intersecting capabilities with ceiling.
/// Does NOT accept client rootSecret; admission is by kernel peer attestation.
pub fn issue_session(
    auth: &BrokerAuth,
    client_id: &str,
    project_id: &str,
    granted_caps: Vec<BrokerCapability>,
) -> SessionWelcome {
    let mut session_bytes = [0u8; 16];
    rand::rng().fill_bytes(&mut session_bytes);
    let session_id = URL_SAFE_NO_PAD.encode(session_bytes);
    let mut nonce_bytes = [0u8; 16];
    rand::rng().fill_bytes(&mut nonce_bytes);
    let nonce = URL_SAFE_NO_PAD.encode(nonce_bytes);
    let expires_at = now_secs() + TOKEN_TTL_SECS;

    let claims = TokenClaims {
        epoch: auth.epoch.clone(),
        client_id: client_id.to_string(),
        session_id: session_id.clone(),
        project_id: project_id.to_string(),
        capabilities: granted_caps.clone(),
        expires_at,
        nonce,
    };
    let body = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).unwrap());
    let sig = sign(&auth.root_secret, body.as_str());
    let token = format!("{body}.{sig}");

    SessionWelcome { session_id, token, expires_at, capabilities: granted_caps, epoch: auth.epoch.clone() }
}

#[derive(Debug)]
pub enum VerifyError {
    MalformedToken,
    InvalidSignature,
    EpochMismatch,
    ProjectDenied,
    ScopeDenied,
    ExpiredToken,
    ClientMismatch,
}

/// Verify a session token for a specific capability on a request.
pub fn verify_token(
    auth: &BrokerAuth,
    token: &str,
    expected_epoch: &str,
    client_id: &str,
    session_id: &str,
    project_id: &str,
    capability: &BrokerCapability,
) -> Result<(), VerifyError> {
    let mut parts = token.splitn(2, '.');
    let body = parts.next().ok_or(VerifyError::MalformedToken)?;
    let sig = parts.next().ok_or(VerifyError::MalformedToken)?;

    if !verify_signature(&auth.root_secret, body, sig) {
        return Err(VerifyError::InvalidSignature);
    }

    let decoded = URL_SAFE_NO_PAD.decode(body).map_err(|_| VerifyError::MalformedToken)?;
    let claims: TokenClaims = serde_json::from_slice(&decoded).map_err(|_| VerifyError::MalformedToken)?;

    if claims.epoch != expected_epoch || claims.epoch != auth.epoch {
        return Err(VerifyError::EpochMismatch);
    }
    if claims.client_id != client_id || claims.session_id != session_id {
        return Err(VerifyError::ClientMismatch);
    }
    if claims.project_id != project_id {
        return Err(VerifyError::ProjectDenied);
    }
    if claims.expires_at <= now_secs() {
        return Err(VerifyError::ExpiredToken);
    }
    if !claims.capabilities.contains(capability) {
        return Err(VerifyError::ScopeDenied);
    }
    Ok(())
}
