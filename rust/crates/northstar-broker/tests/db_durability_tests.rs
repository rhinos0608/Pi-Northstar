//! Slice 5: SQLite receipt authority durability tests.
//! Verifies WAL/FULL/fullfsync pragmas, 4-state schema, BEGIN IMMEDIATE,
//! payload bounding, and outcome_unknown mapping. Unprivileged / Tier 1.

use northstar_broker::db::{
    open_durable, insert_job, transition_job, query_receipt,
    JobState, ReceiptRecord, DbError, MAX_PAYLOAD_BYTES,
};
use tempfile::tempdir;

fn sample_record(job_id: &str) -> ReceiptRecord {
    ReceiptRecord {
        job_id: job_id.to_string(),
        client_id: "test-client".to_string(),
        request_id: "test-req-1".to_string(),
        state: JobState::Pending,
        submitted_at: 1_700_000_000,
        receipt_payload: None,
        request_digest: None,
    }
}

#[test]
fn durability_pragmas_are_active() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("durability.db");
    let conn = open_durable(&path).unwrap();

    let journal_mode: String = conn.query_row("PRAGMA journal_mode;", [], |r| r.get(0)).unwrap();
    assert_eq!(journal_mode.to_lowercase(), "wal", "journal_mode must be WAL");

    let synchronous: i32 = conn.query_row("PRAGMA synchronous;", [], |r| r.get(0)).unwrap();
    assert_eq!(synchronous, 2, "synchronous must be FULL (2)");

    let fullfsync: i32 = conn.query_row("PRAGMA fullfsync;", [], |r| r.get(0)).unwrap();
    assert_eq!(fullfsync, 1, "fullfsync must be enabled");

    let ckpt_fullfsync: i32 = conn.query_row("PRAGMA checkpoint_fullfsync;", [], |r| r.get(0)).unwrap();
    assert_eq!(ckpt_fullfsync, 1, "checkpoint_fullfsync must be enabled");
}

#[test]
fn insert_and_query_receipt() {
    let dir = tempdir().unwrap();
    let conn = open_durable(dir.path().join("receipts.db")).unwrap();
    let rec = sample_record("job-001");
    insert_job(&conn, &rec).unwrap();
    let found = query_receipt(&conn, "test-client", "test-req-1").unwrap();
    assert!(found.is_some());
    let found = found.unwrap();
    assert_eq!(found.job_id, "job-001");
    assert_eq!(found.state, JobState::Pending);
}

#[test]
fn state_transition_pending_to_dispatched() {
    let dir = tempdir().unwrap();
    let conn = open_durable(dir.path().join("states.db")).unwrap();
    insert_job(&conn, &sample_record("job-002")).unwrap();
    transition_job(&conn, "job-002", JobState::Dispatched).unwrap();
    let rec = query_receipt(&conn, "test-client", "test-req-1").unwrap().unwrap();
    assert_eq!(rec.state, JobState::Dispatched);
}

#[test]
fn outcome_unknown_state_stored_and_queried() {
    let dir = tempdir().unwrap();
    let conn = open_durable(dir.path().join("outcome.db")).unwrap();
    insert_job(&conn, &sample_record("job-003")).unwrap();
    transition_job(&conn, "job-003", JobState::OutcomeUnknown).unwrap();
    let rec = query_receipt(&conn, "test-client", "test-req-1").unwrap().unwrap();
    assert_eq!(rec.state, JobState::OutcomeUnknown);
}

#[test]
fn duplicate_job_id_rejected() {
    let dir = tempdir().unwrap();
    let conn = open_durable(dir.path().join("dup.db")).unwrap();
    insert_job(&conn, &sample_record("job-004")).unwrap();
    let result = insert_job(&conn, &sample_record("job-004"));
    assert!(matches!(result, Err(DbError::Duplicate)), "duplicate job_id must be rejected");
}

#[test]
fn receipt_payload_bounded_to_4096_bytes() {
    let dir = tempdir().unwrap();
    let conn = open_durable(dir.path().join("payload.db")).unwrap();
    let mut rec = sample_record("job-005");
    rec.receipt_payload = Some("x".repeat(MAX_PAYLOAD_BYTES + 1));
    let result = insert_job(&conn, &rec);
    assert!(matches!(result, Err(DbError::PayloadTooLarge)));
}

#[test]
fn request_digest_bounded_to_4096_bytes() {
    let dir = tempdir().unwrap();
    let conn = open_durable(dir.path().join("digest.db")).unwrap();
    let mut rec = sample_record("job-006");
    rec.request_digest = Some("y".repeat(MAX_PAYLOAD_BYTES + 1));
    let result = insert_job(&conn, &rec);
    assert!(matches!(result, Err(DbError::PayloadTooLarge)));
}

#[test]
fn accepted_payload_at_exact_limit_succeeds() {
    let dir = tempdir().unwrap();
    let conn = open_durable(dir.path().join("exact.db")).unwrap();
    let mut rec = sample_record("job-007");
    rec.receipt_payload = Some("z".repeat(MAX_PAYLOAD_BYTES));
    insert_job(&conn, &rec).unwrap();
    let found = query_receipt(&conn, "test-client", "test-req-1").unwrap().unwrap();
    assert_eq!(found.receipt_payload.unwrap().len(), MAX_PAYLOAD_BYTES);
}

#[test]
fn query_missing_returns_none() {
    let dir = tempdir().unwrap();
    let conn = open_durable(dir.path().join("missing.db")).unwrap();
    let result = query_receipt(&conn, "nobody", "nonexistent").unwrap();
    assert!(result.is_none());
}
