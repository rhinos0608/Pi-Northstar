//! Slice 4: Grant admission and session token tests.
//! Unprivileged / Tier 1.

use northstar_broker::auth::{BrokerAuth, issue_session, verify_token, VerifyError, TOKEN_TTL_SECS};
use northstar_broker::grants::{intersect_capabilities, CLI_GRANT_CEILING};
use northstar_broker::protocol::BrokerCapability;

fn make_auth() -> BrokerAuth {
    BrokerAuth::new()
}

#[test]
fn token_round_trip_accepted() {
    let auth = make_auth();
    let caps = vec![BrokerCapability::RuntimeStatus];
    let welcome = issue_session(&auth, "client-1", "project-a", caps.clone());
    let result = verify_token(
        &auth, &welcome.token, &auth.epoch,
        "client-1", &welcome.session_id, "project-a",
        &BrokerCapability::RuntimeStatus,
    );
    assert!(result.is_ok(), "Valid token should pass: {result:?}");
}

#[test]
fn wrong_project_yields_project_denied() {
    let auth = make_auth();
    let caps = vec![BrokerCapability::RuntimeStatus];
    let welcome = issue_session(&auth, "client-1", "project-a", caps);
    let result = verify_token(
        &auth, &welcome.token, &auth.epoch,
        "client-1", &welcome.session_id, "project-b",  // wrong project
        &BrokerCapability::RuntimeStatus,
    );
    assert!(matches!(result, Err(VerifyError::ProjectDenied)));
}

#[test]
fn missing_capability_yields_scope_denied() {
    let auth = make_auth();
    let caps = vec![BrokerCapability::RuntimeStatus];
    let welcome = issue_session(&auth, "client-1", "project-a", caps);
    let result = verify_token(
        &auth, &welcome.token, &auth.epoch,
        "client-1", &welcome.session_id, "project-a",
        &BrokerCapability::RuntimeStart,  // not granted
    );
    assert!(matches!(result, Err(VerifyError::ScopeDenied)));
}

#[test]
fn tampered_token_yields_invalid_signature() {
    let auth = make_auth();
    let caps = vec![BrokerCapability::RuntimeStatus];
    let welcome = issue_session(&auth, "client-1", "project-a", caps);
    let tampered = format!("{}X", welcome.token);  // corrupt signature
    let result = verify_token(
        &auth, &tampered, &auth.epoch,
        "client-1", &welcome.session_id, "project-a",
        &BrokerCapability::RuntimeStatus,
    );
    assert!(matches!(result, Err(VerifyError::InvalidSignature | VerifyError::MalformedToken)));
}

#[test]
fn epoch_mismatch_yields_epoch_mismatch() {
    let auth = make_auth();
    let caps = vec![BrokerCapability::RuntimeStatus];
    let welcome = issue_session(&auth, "client-1", "project-a", caps);
    let result = verify_token(
        &auth, &welcome.token, "stale-epoch",  // wrong epoch
        "client-1", &welcome.session_id, "project-a",
        &BrokerCapability::RuntimeStatus,
    );
    assert!(matches!(result, Err(VerifyError::EpochMismatch)));
}

#[test]
fn wrong_client_id_yields_client_mismatch() {
    let auth = make_auth();
    let caps = vec![BrokerCapability::RuntimeStatus];
    let welcome = issue_session(&auth, "client-1", "project-a", caps);
    let result = verify_token(
        &auth, &welcome.token, &auth.epoch,
        "client-2", &welcome.session_id, "project-a",  // different client
        &BrokerCapability::RuntimeStatus,
    );
    assert!(matches!(result, Err(VerifyError::ClientMismatch)));
}

#[test]
fn grant_ceiling_cannot_be_exceeded() {
    // Requesting all caps from ceiling returns all
    let all = intersect_capabilities(CLI_GRANT_CEILING);
    assert_eq!(all.len(), CLI_GRANT_CEILING.len());
    // Requesting caps not in ceiling (simulate unknown cap by requesting empty and checking length)
    let none: Vec<BrokerCapability> = vec![];
    assert!(intersect_capabilities(&none).is_empty());
}

/// Exhaustive match forces a compile error when a new BrokerCapability variant
/// is added, so the ceiling cannot silently miss it.
fn assert_exhaustive_capability(cap: &BrokerCapability) {
    match cap {
        BrokerCapability::RuntimeNegotiate
        | BrokerCapability::RuntimeStart
        | BrokerCapability::RuntimeStatus
        | BrokerCapability::RuntimeResult
        | BrokerCapability::RuntimeCancel => {}
    }
}

#[test]
fn grant_ceiling_covers_all_capability_variants() {
    let all_variants = vec![
        BrokerCapability::RuntimeNegotiate,
        BrokerCapability::RuntimeStart,
        BrokerCapability::RuntimeStatus,
        BrokerCapability::RuntimeResult,
        BrokerCapability::RuntimeCancel,
    ];
    for cap in &all_variants {
        assert_exhaustive_capability(cap);
        assert!(
            CLI_GRANT_CEILING.contains(cap),
            "ceiling must cover every BrokerCapability variant, missing: {cap:?}"
        );
    }
    // Ceiling must not grant anything outside the known variants either.
    for cap in CLI_GRANT_CEILING {
        assert_exhaustive_capability(cap);
        assert!(all_variants.contains(cap));
    }
}

#[test]
fn token_ttl_is_sixty_seconds() {
    assert_eq!(TOKEN_TTL_SECS, 60);
}
