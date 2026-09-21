//! Gate B Slice 11: Hostile security tests and fault-injection suite.
//!
//! Adversarial inputs, edge cases, fuzz frames, and tampering.
//! Every adversarial input must fail closed (Err, never panic, never accept).

use std::collections::BTreeMap;
use northstar_broker::auth::{
    issue_session, verify_token, BrokerAuth, VerifyError,
};
use northstar_broker::db::{
    insert_job, open_durable, DbError, JobState, ReceiptRecord, MAX_PAYLOAD_BYTES,
};
use northstar_broker::endpoint::{assert_same_owner, AttestationError, PeerIdentity};
use northstar_broker::frame::{decode_frame, FrameError};
use northstar_broker::protocol::BrokerCapability;
use northstar_broker::settle::{
    settle_validate, SettleError, SettleRequest, MAX_CANCEL_RUN_IDS,
    MAX_SETTLEMENT_WINDOW_MS, MIN_SETTLEMENT_WINDOW_MS,
};
use northstar_broker::worker::{EnvGrantError, ScopedEnv};

// Helper: wrap raw JSON slice into length-prefixed frame
fn make_frame(payload: &[u8]) -> Vec<u8> {
    let len = payload.len() as u32;
    let mut f = Vec::with_capacity(4 + payload.len());
    f.extend_from_slice(&len.to_be_bytes());
    f.extend_from_slice(payload);
    f
}

// ---------------------------------------------------------------------------
// 1. Truncated frame (<4 bytes), length prefix > available, trailing garbage
// ---------------------------------------------------------------------------
#[test]
fn test_frame_truncated_fewer_than_4_bytes() {
    assert!(matches!(decode_frame(&[]), Err(FrameError::InvalidFrame)));
    assert!(matches!(decode_frame(&[0]), Err(FrameError::InvalidFrame)));
    assert!(matches!(decode_frame(&[0, 0]), Err(FrameError::InvalidFrame)));
    assert!(matches!(decode_frame(&[0, 0, 0]), Err(FrameError::InvalidFrame)));
}

#[test]
fn test_frame_length_prefix_claiming_more_than_available() {
    // Length prefix claims 100 bytes, but only 4 bytes follow
    let mut frame = Vec::new();
    frame.extend_from_slice(&100u32.to_be_bytes());
    frame.extend_from_slice(b"test");
    assert!(matches!(decode_frame(&frame), Err(FrameError::InvalidFrame)));
}

#[test]
fn test_frame_trailing_garbage_bytes_after_payload() {
    // Length prefix says 4 bytes, but frame has 4 + 4 + 5 = 13 bytes
    let mut frame = Vec::new();
    frame.extend_from_slice(&4u32.to_be_bytes());
    frame.extend_from_slice(b"test");
    frame.extend_from_slice(b"extra_garbage");
    assert!(matches!(decode_frame(&frame), Err(FrameError::InvalidFrame)));
}

// ---------------------------------------------------------------------------
// 2. Valid frame with version 1 Hello (v1-incompatible — must reject since validators pin v2)
// ---------------------------------------------------------------------------
#[test]
fn test_v1_hello_rejected() {
    let json = br#"{"version":1,"kind":"hello","clientId":"c1","projectId":"p1","requestedCapabilities":[]}"#;
    let frame = make_frame(json);
    let res = decode_frame(&frame);
    assert!(matches!(res, Err(FrameError::InvalidFrame)), "v1 hello must fail decode with InvalidFrame");
}

#[test]
fn test_v3_hello_rejected() {
    let json = br#"{"version":3,"kind":"hello","clientId":"c1","projectId":"p1","requestedCapabilities":[]}"#;
    let frame = make_frame(json);
    let res = decode_frame(&frame);
    assert!(matches!(res, Err(FrameError::InvalidFrame)), "v3 hello must fail decode with InvalidFrame");
}

#[test]
fn test_bogus_kind_goodbye_rejected() {
    let json = br#"{"version":2,"kind":"goodbye","clientId":"c1","projectId":"p1","requestedCapabilities":[]}"#;
    let frame = make_frame(json);
    let res = decode_frame(&frame);
    assert!(matches!(res, Err(FrameError::InvalidFrame)), "goodbye kind with hello fields must fail decode with InvalidFrame");
}

#[test]
fn test_v1_fixtures_rejected() {
    // version:1 on request, response, query, queryResponse, error fixtures must fail decode
    let fixtures = [
        // request
        br#"{"version":1,"kind":"request","token":"t","epoch":"e","sessionId":"s","sequence":1,"projectId":"p","request":{"version":1,"requestId":"req1","method":"status","params":{"runId":"r"}}}"#.as_slice(),
        // response
        br#"{"version":1,"kind":"response","sequence":1,"reply":{"version":1,"requestId":"req1","ok":true,"result":{}}}"#.as_slice(),
        // query
        br#"{"version":1,"kind":"query","token":"t","epoch":"e","sessionId":"s","sequence":1,"projectId":"p","query":{"method":"submissionReceipt","requestId":"req1"}}"#.as_slice(),
        // queryResponse
        br#"{"version":1,"kind":"queryResponse","sequence":1,"receipt":null}"#.as_slice(),
        // error
        br#"{"version":1,"kind":"error","code":"invalid_frame"}"#.as_slice(),
    ];

    for fixture in fixtures {
        let frame = make_frame(fixture);
        let res = decode_frame(&frame);
        assert!(
            matches!(res, Err(FrameError::InvalidFrame)),
            "v1 fixture must be rejected: {}",
            String::from_utf8_lossy(fixture)
        );
    }
}

#[test]
fn test_valid_v2_hello_accepted() {
    let json = br#"{"version":2,"kind":"hello","clientId":"c1","projectId":"p1","requestedCapabilities":[]}"#;
    let frame = make_frame(json);
    let res = decode_frame(&frame);
    assert!(matches!(res, Ok(northstar_broker::protocol::BrokerMessage::Hello(_))));
}

// ---------------------------------------------------------------------------
// 3. Hello with rootSecret field present (v2 forbids client secrets — deny_unknown_fields)
// ---------------------------------------------------------------------------
#[test]
fn test_hello_with_root_secret_rejected() {
    let json = br#"{"version":2,"kind":"hello","clientId":"c1","projectId":"p1","requestedCapabilities":[],"rootSecret":"forbidden_secret"}"#;
    let frame = make_frame(json);
    let res = decode_frame(&frame);
    assert!(res.is_err(), "Hello with rootSecret must be rejected by deny_unknown_fields");
}

// ---------------------------------------------------------------------------
// 4. Request with unknown RPC method, extra top-level field, sequence as float/string
// ---------------------------------------------------------------------------
#[test]
fn test_request_unknown_rpc_method_rejected() {
    let json = br#"{"version":2,"kind":"request","token":"t","epoch":"e","sessionId":"s","sequence":1,"projectId":"p","request":{"version":1,"requestId":"req1","method":"evilMethod","params":{}}}"#;
    let frame = make_frame(json);
    assert!(decode_frame(&frame).is_err(), "Unknown RPC method must fail closed");
}

#[test]
fn test_request_extra_top_level_field_rejected() {
    let json = br#"{"version":2,"kind":"request","token":"t","epoch":"e","sessionId":"s","sequence":1,"projectId":"p","injected":"malicious","request":{"version":1,"requestId":"req1","method":"status","params":{"runId":"runtime_run"}}}"#;
    let frame = make_frame(json);
    assert!(decode_frame(&frame).is_err(), "Extra top-level field on request must fail closed");
}

#[test]
fn test_request_sequence_as_float_rejected() {
    let json = br#"{"version":2,"kind":"request","token":"t","epoch":"e","sessionId":"s","sequence":1.5,"projectId":"p","request":{"version":1,"requestId":"req1","method":"status","params":{"runId":"runtime_run"}}}"#;
    let frame = make_frame(json);
    assert!(decode_frame(&frame).is_err(), "Sequence as float must fail closed");
}

#[test]
fn test_request_sequence_as_string_rejected() {
    let json = br#"{"version":2,"kind":"request","token":"t","epoch":"e","sessionId":"s","sequence":"1","projectId":"p","request":{"version":1,"requestId":"req1","method":"status","params":{"runId":"runtime_run"}}}"#;
    let frame = make_frame(json);
    assert!(decode_frame(&frame).is_err(), "Sequence as string must fail closed");
}

// ---------------------------------------------------------------------------
// 5. Token with wrong segment count, tampered signature byte, expired claims, cross-client replay
// ---------------------------------------------------------------------------
#[test]
fn test_token_wrong_segment_count() {
    let auth = BrokerAuth::new();
    let welcome = issue_session(&auth, "client-1", "project-a", vec![BrokerCapability::RuntimeStatus]);

    // No dot (single segment)
    let no_dot = welcome.token.replace('.', "");
    let res1 = verify_token(
        &auth, &no_dot, &auth.epoch,
        "client-1", &welcome.session_id, "project-a",
        &BrokerCapability::RuntimeStatus,
    );
    assert!(matches!(res1, Err(VerifyError::MalformedToken | VerifyError::InvalidSignature)));

    // Three segments
    let three_parts = format!("{}.extra", welcome.token);
    let res2 = verify_token(
        &auth, &three_parts, &auth.epoch,
        "client-1", &welcome.session_id, "project-a",
        &BrokerCapability::RuntimeStatus,
    );
    // splitn(2, '.') stops at first dot, but the second part has an extra dot that won't match signature
    assert!(matches!(res2, Err(VerifyError::InvalidSignature | VerifyError::MalformedToken)));
}

#[test]
fn test_token_tampered_signature_byte() {
    let auth = BrokerAuth::new();
    let welcome = issue_session(&auth, "client-1", "project-a", vec![BrokerCapability::RuntimeStatus]);

    let mut parts = welcome.token.splitn(2, '.');
    let body = parts.next().unwrap();
    let sig = parts.next().unwrap();

    // Corrupt one char in sig
    let mut tampered_sig = sig.to_string();
    let last_char = tampered_sig.pop().unwrap();
    let replacement = if last_char == 'A' { 'B' } else { 'A' };
    tampered_sig.push(replacement);

    let tampered_token = format!("{body}.{tampered_sig}");
    let res = verify_token(
        &auth, &tampered_token, &auth.epoch,
        "client-1", &welcome.session_id, "project-a",
        &BrokerCapability::RuntimeStatus,
    );
    assert!(matches!(res, Err(VerifyError::InvalidSignature)));
}

#[test]
fn test_token_expired_claims_against_rotated_epoch() {
    let mut auth = BrokerAuth::new();
    let welcome = issue_session(&auth, "client-1", "project-a", vec![BrokerCapability::RuntimeStatus]);

    // Rotate epoch (simulating broker restart)
    auth.rotate_epoch();

    let res = verify_token(
        &auth, &welcome.token, &welcome.epoch, // passing old epoch as expected, but auth has rotated
        "client-1", &welcome.session_id, "project-a",
        &BrokerCapability::RuntimeStatus,
    );
    assert!(matches!(res, Err(VerifyError::EpochMismatch)));
}

#[test]
fn test_cross_client_replay() {
    let auth = BrokerAuth::new();
    let welcome_a = issue_session(&auth, "client-A", "project-a", vec![BrokerCapability::RuntimeStatus]);

    // Verified as client-B must fail with ClientMismatch
    let res = verify_token(
        &auth, &welcome_a.token, &auth.epoch,
        "client-B", &welcome_a.session_id, "project-a",
        &BrokerCapability::RuntimeStatus,
    );
    assert!(matches!(res, Err(VerifyError::ClientMismatch)));
}

// ---------------------------------------------------------------------------
// 6. Capability escalation: token granted status-only verified for start -> ScopeDenied
// ---------------------------------------------------------------------------
#[test]
fn test_capability_escalation_status_only_verified_for_start() {
    let auth = BrokerAuth::new();
    let welcome = issue_session(&auth, "client-1", "project-a", vec![BrokerCapability::RuntimeStatus]);

    let res = verify_token(
        &auth, &welcome.token, &auth.epoch,
        "client-1", &welcome.session_id, "project-a",
        &BrokerCapability::RuntimeStart, // escalation attempt
    );
    assert!(matches!(res, Err(VerifyError::ScopeDenied)));
}

// ---------------------------------------------------------------------------
// 7. Oversized payload: receipt_payload > 4096 -> PayloadTooLarge;
//    runIds 65 -> TooManyRunIds; duplicate runIds -> DuplicateRunIds;
//    settlementWindowMs 0 and 10001 -> WindowOutOfBounds.
// ---------------------------------------------------------------------------
#[test]
fn test_oversized_payload_insert_job_payload_too_large() {
    let conn = open_durable(":memory:").expect("open in-memory db");
    let huge_payload = "A".repeat(MAX_PAYLOAD_BYTES + 1);
    let record = ReceiptRecord {
        job_id: "job-huge".to_string(),
        client_id: "client-1".to_string(),
        request_id: "req-1".to_string(),
        state: JobState::Pending,
        submitted_at: 1000,
        receipt_payload: Some(huge_payload),
        request_digest: None,
    };
    let res = insert_job(&conn, &record);
    assert!(matches!(res, Err(DbError::PayloadTooLarge)));
}

#[test]
fn test_settle_validation_65_run_ids_too_many() {
    let run_ids: Vec<String> = (0..=MAX_CANCEL_RUN_IDS)
        .map(|i| format!("run_{i:04}"))
        .collect();
    assert_eq!(run_ids.len(), 65);

    let req = SettleRequest {
        run_ids,
        settlement_window_ms: 500,
    };
    let res = settle_validate(&req);
    assert!(matches!(res, Err(SettleError::TooManyRunIds)));
}

#[test]
fn test_settle_validation_duplicate_run_ids() {
    let req = SettleRequest {
        run_ids: vec!["run_alpha".to_string(), "run_beta".to_string(), "run_alpha".to_string()],
        settlement_window_ms: 500,
    };
    let res = settle_validate(&req);
    assert!(matches!(res, Err(SettleError::DuplicateRunIds)));
}

#[test]
fn test_settle_validation_window_out_of_bounds() {
    // 0 ms (< MIN_SETTLEMENT_WINDOW_MS = 1)
    let req_zero = SettleRequest {
        run_ids: vec!["run_1".to_string()],
        settlement_window_ms: MIN_SETTLEMENT_WINDOW_MS - 1, // 0
    };
    assert!(matches!(settle_validate(&req_zero), Err(SettleError::WindowOutOfBounds)));

    // 10001 ms (> MAX_SETTLEMENT_WINDOW_MS = 10000)
    let req_over = SettleRequest {
        run_ids: vec!["run_1".to_string()],
        settlement_window_ms: MAX_SETTLEMENT_WINDOW_MS + 1, // 10001
    };
    assert!(matches!(settle_validate(&req_over), Err(SettleError::WindowOutOfBounds)));
}

// ---------------------------------------------------------------------------
// 8. Scoped env: grant GITHUB_TOKEN without override -> rejected;
//    override then granted;
//    child env map from a granted-only builder contains zero ambient keys
// ---------------------------------------------------------------------------
#[test]
fn test_scoped_env_denied_without_override_then_granted_with_override() {
    let mut env = ScopedEnv::new();

    // GITHUB_TOKEN without override -> DeniedPrefix
    let err = env.grant("GITHUB_TOKEN", "secret123").unwrap_err();
    assert!(matches!(err, EnvGrantError::DeniedPrefix(k) if k == "GITHUB_TOKEN"));

    // Override prefix "GITHUB_"
    env.allow_override("GITHUB_");
    let res = env.grant("GITHUB_TOKEN", "secret123");
    assert!(res.is_ok(), "Should succeed after explicit override");
}

#[test]
fn test_scoped_env_zero_ambient_keys_in_child_map() {
    // Set a probe var in the current test process
    let probe_key = "NORTHSTAR_HOSTILE_PROBE_SECRET";
    let probe_val = "ambient_secret_value_xyz";
    unsafe {
        std::env::set_var(probe_key, probe_val);
    }

    let mut env = ScopedEnv::new();
    env.grant("ALLOWED_FOO", "bar").expect("grant valid key");

    let built_map: &BTreeMap<String, String> = env.build_command_env();

    // Map must only contain explicit grants and zero ambient variables
    assert!(!built_map.contains_key(probe_key), "Ambient probe secret leaked into scoped env!");
    assert_eq!(built_map.len(), 1);
    assert_eq!(built_map.get("ALLOWED_FOO").unwrap(), "bar");

    // Clean up test env var
    unsafe {
        std::env::remove_var(probe_key);
    }
}

// ---------------------------------------------------------------------------
// 9. UID mismatch: assert_same_owner(peer uid 1001, owner 1000) -> UnauthorizedPeer;
//    uid 0 vs owner 1000 -> reject
// ---------------------------------------------------------------------------
#[test]
fn test_uid_mismatch_assert_same_owner() {
    let peer = PeerIdentity {
        uid: 1001,
        pid: Some(500),
    };
    let res = assert_same_owner(&peer, 1000);
    assert!(matches!(res, Err(AttestationError::UnauthorizedPeer)));

    let root_peer = PeerIdentity {
        uid: 0,
        pid: Some(1),
    };
    let res_root = assert_same_owner(&root_peer, 1000);
    assert!(matches!(res_root, Err(AttestationError::UnauthorizedPeer)));
}

// ---------------------------------------------------------------------------
// 10. Fuzz-lite: 50 pseudo-random byte frames (deterministic xorshift seed)
//     every decode must return Err, never panic
// ---------------------------------------------------------------------------
struct XorShift64 {
    state: u64,
}

impl XorShift64 {
    fn new(seed: u64) -> Self {
        Self { state: if seed == 0 { 0xdeadbeef } else { seed } }
    }

    fn next_u32(&mut self) -> u32 {
        let mut x = self.state;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.state = x;
        x as u32
    }

    fn fill_bytes(&mut self, buf: &mut [u8]) {
        for chunk in buf.chunks_mut(4) {
            let val = self.next_u32().to_le_bytes();
            for (dest, src) in chunk.iter_mut().zip(val.iter()) {
                *dest = *src;
            }
        }
    }
}

#[test]
fn test_fuzz_lite_pseudo_random_frames_fail_closed_never_panic() {
    let mut rng = XorShift64::new(0x4a9b2c1d8e7f0123);

    for i in 0..50 {
        // Generate pseudo-random length between 0 and 512 bytes
        let len = (rng.next_u32() % 512) as usize;
        let mut frame_bytes = vec![0u8; len];
        rng.fill_bytes(&mut frame_bytes);

        // Catch panic if any (should never panic, must return Err)
        let decode_result = std::panic::catch_unwind(|| {
            decode_frame(&frame_bytes)
        });

        assert!(
            decode_result.is_ok(),
            "decode_frame panicked on fuzz iteration {i} with frame length {len}!"
        );
        let res = decode_result.unwrap();
        assert!(
            res.is_err(),
            "Pseudo-random bytes must not parse as valid BrokerMessage on iteration {i}!"
        );
    }
}
