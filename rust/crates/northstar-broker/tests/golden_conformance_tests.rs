use std::fs;
use std::path::Path;
use northstar_broker::frame::{decode_frame, encode_frame, BROKER_MAX_FRAME_BYTES};

fn fixture_dir() -> std::path::PathBuf {
    // Go up from tests/ to crate root, then to repo root
    let manifest = std::env::var("CARGO_MANIFEST_DIR").unwrap();
    Path::new(&manifest).join("../../../test/fixtures/rpc-golden")
}

#[test]
fn broker_v2_fixtures_round_trip() {
    let dir = fixture_dir();
    let entries: Vec<_> = fs::read_dir(&dir)
        .expect("fixture dir missing")
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().and_then(|s| s.to_str()) == Some("json"))
        .filter(|e| e.path().file_name().and_then(|s| s.to_str()).unwrap_or("").starts_with("broker-v2-"))
        .collect();

    assert!(!entries.is_empty(), "No broker-v2 fixtures found");

    for entry in entries {
        let path = entry.path();
        let name = path.file_name().unwrap().to_str().unwrap().to_string();
        let content = fs::read_to_string(&path).unwrap_or_else(|_| panic!("Cannot read {name}"));
        let raw_bytes = content.as_bytes();
        // Build a length-prefixed frame from raw JSON
        let len = raw_bytes.len() as u32;
        let mut frame = Vec::with_capacity(4 + raw_bytes.len());
        frame.extend_from_slice(&len.to_be_bytes());
        frame.extend_from_slice(raw_bytes);
        // Decode
        let msg = decode_frame(&frame).unwrap_or_else(|e| panic!("Failed to decode {name}: {e}"));
        // Re-encode and decode again (round-trip)
        let re_encoded = encode_frame(&msg).unwrap_or_else(|e| panic!("Failed to encode {name}: {e}"));
        let re_decoded = decode_frame(&re_encoded).unwrap_or_else(|e| panic!("Failed to re-decode {name}: {e}"));
        assert_eq!(msg, re_decoded, "Round-trip mismatch for {name}");
    }
}

#[test]
fn frame_rejects_oversized_payload() {
    let big = "x".repeat(BROKER_MAX_FRAME_BYTES + 1);
    let len = big.len() as u32;
    let mut frame = Vec::with_capacity(4 + big.len());
    frame.extend_from_slice(&len.to_be_bytes());
    frame.extend_from_slice(big.as_bytes());
    let result = decode_frame(&frame);
    assert!(matches!(result, Err(northstar_broker::frame::FrameError::TooLarge)));
}

#[test]
fn frame_rejects_unknown_fields() {
    // A Hello with an extra unknown field must fail
    let json = r#"{"version":2,"kind":"hello","clientId":"c","projectId":"p","requestedCapabilities":[],"extraField":"bad"}"#;
    let raw = json.as_bytes();
    let len = raw.len() as u32;
    let mut frame = Vec::with_capacity(4 + raw.len());
    frame.extend_from_slice(&len.to_be_bytes());
    frame.extend_from_slice(raw);
    let result = decode_frame(&frame);
    assert!(result.is_err(), "Should reject unknown fields in Hello");
}

#[test]
fn frame_rejects_invalid_rpc_method() {
    // A Request with an unknown RPC method must fail
    let json = r#"{"version":2,"kind":"request","token":"t","epoch":"e","sessionId":"s","sequence":1,"projectId":"p","request":{"version":1,"requestId":"r","method":"admin","params":{}}}"#;
    let raw = json.as_bytes();
    let len = raw.len() as u32;
    let mut frame = Vec::with_capacity(4 + raw.len());
    frame.extend_from_slice(&len.to_be_bytes());
    frame.extend_from_slice(raw);
    let result = decode_frame(&frame);
    assert!(result.is_err(), "Should reject unknown RPC method");
}
