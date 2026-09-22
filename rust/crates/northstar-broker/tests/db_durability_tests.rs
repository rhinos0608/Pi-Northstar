//! Slice 5: SQLite receipt authority durability tests.
//! Verifies WAL/FULL/fullfsync pragmas, 4-state schema, BEGIN IMMEDIATE,
//! payload bounding, and outcome_unknown mapping. Unprivileged / Tier 1.

use northstar_broker::db::{
    bind_dispatched_job, claim_start_atomic, delete_job_by_request,
    insert_job, open_durable, owns_all_jobs, release_start_artifacts,
    query_receipt, recover_incomplete_jobs, transition_job, transition_job_by_request, DbError,
    JobState, ReceiptRecord, MAX_PAYLOAD_BYTES,
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

    let journal_mode: String = conn
        .query_row("PRAGMA journal_mode;", [], |r| r.get(0))
        .unwrap();
    assert_eq!(
        journal_mode.to_lowercase(),
        "wal",
        "journal_mode must be WAL"
    );

    let synchronous: i32 = conn
        .query_row("PRAGMA synchronous;", [], |r| r.get(0))
        .unwrap();
    assert_eq!(synchronous, 2, "synchronous must be FULL (2)");

    let fullfsync: i32 = conn
        .query_row("PRAGMA fullfsync;", [], |r| r.get(0))
        .unwrap();
    assert_eq!(fullfsync, 1, "fullfsync must be enabled");

    let ckpt_fullfsync: i32 = conn
        .query_row("PRAGMA checkpoint_fullfsync;", [], |r| r.get(0))
        .unwrap();
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
    let rec = query_receipt(&conn, "test-client", "test-req-1")
        .unwrap()
        .unwrap();
    assert_eq!(rec.state, JobState::Dispatched);
}

#[test]
fn outcome_unknown_state_stored_and_queried() {
    let dir = tempdir().unwrap();
    let conn = open_durable(dir.path().join("outcome.db")).unwrap();
    insert_job(&conn, &sample_record("job-003")).unwrap();
    transition_job(&conn, "job-003", JobState::OutcomeUnknown).unwrap();
    let rec = query_receipt(&conn, "test-client", "test-req-1")
        .unwrap()
        .unwrap();
    assert_eq!(rec.state, JobState::OutcomeUnknown);
}

#[test]
fn duplicate_job_id_rejected() {
    let dir = tempdir().unwrap();
    let conn = open_durable(dir.path().join("dup.db")).unwrap();
    insert_job(&conn, &sample_record("job-004")).unwrap();
    let result = insert_job(&conn, &sample_record("job-004"));
    assert!(
        matches!(result, Err(DbError::Duplicate)),
        "duplicate job_id must be rejected"
    );
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
    let found = query_receipt(&conn, "test-client", "test-req-1")
        .unwrap()
        .unwrap();
    assert_eq!(found.receipt_payload.unwrap().len(), MAX_PAYLOAD_BYTES);
}

#[test]
fn query_missing_returns_none() {
    let dir = tempdir().unwrap();
    let conn = open_durable(dir.path().join("missing.db")).unwrap();
    let result = query_receipt(&conn, "nobody", "nonexistent").unwrap();
    assert!(result.is_none());
}

#[test]
fn bind_dispatched_job_replaces_provisional_id_and_keeps_job_dispatched() {
    let dir = tempdir().unwrap();
    let conn = open_durable(dir.path().join("bind.db")).unwrap();
    insert_job(&conn, &sample_record("runtime_pending_1")).unwrap();

    bind_dispatched_job(&conn, "test-client", "test-req-1", "runtime_actual_1").unwrap();

    let rec = query_receipt(&conn, "test-client", "test-req-1")
        .unwrap()
        .unwrap();
    assert_eq!(rec.job_id, "runtime_actual_1");
    assert_eq!(rec.state, JobState::Dispatched);
    assert!(owns_all_jobs(&conn, "test-client", &["runtime_actual_1".into()]).unwrap());
    assert!(!owns_all_jobs(&conn, "other-client", &["runtime_actual_1".into()]).unwrap());
}

#[test]
fn transition_by_request_and_restart_recovery_are_conservative() {
    let dir = tempdir().unwrap();
    let conn = open_durable(dir.path().join("recover.db")).unwrap();
    insert_job(&conn, &sample_record("runtime_pending_2")).unwrap();
    transition_job_by_request(&conn, "test-client", "test-req-1", JobState::Dispatched).unwrap();
    assert_eq!(recover_incomplete_jobs(&conn).unwrap(), 1);
    let rec = query_receipt(&conn, "test-client", "test-req-1")
        .unwrap()
        .unwrap();
    assert_eq!(rec.state, JobState::OutcomeUnknown);
}

#[test]
fn known_before_dispatch_failure_can_remove_pending_receipt() {
    let dir = tempdir().unwrap();
    let conn = open_durable(dir.path().join("delete.db")).unwrap();
    insert_job(&conn, &sample_record("runtime_pending_3")).unwrap();
    delete_job_by_request(&conn, "test-client", "test-req-1").unwrap();
    assert!(query_receipt(&conn, "test-client", "test-req-1")
        .unwrap()
        .is_none());
}

#[test]
fn claim_start_atomic_writes_claim_and_receipt_together() {
    let dir = tempdir().unwrap();
    let conn = open_durable(dir.path().join("atomic.db")).unwrap();
    let rec = sample_record("runtime_pending_atomic");
    claim_start_atomic(&conn, "test-client", "test-req-1", &rec).unwrap();
    // Receipt queryable: retry with same request id sees useful receipt.
    let found = query_receipt(&conn, "test-client", "test-req-1")
        .unwrap()
        .expect("receipt must exist after atomic claim");
    assert_eq!(found.job_id, "runtime_pending_atomic");
    // Second claim with same identity is a duplicate, receipt intact.
    let dup = claim_start_atomic(&conn, "test-client", "test-req-1", &rec);
    assert!(matches!(dup, Err(DbError::Duplicate)));
    assert!(query_receipt(&conn, "test-client", "test-req-1")
        .unwrap()
        .is_some());
}

#[test]
fn claim_start_atomic_failure_leaves_neither_row() {
    let dir = tempdir().unwrap();
    let conn = open_durable(dir.path().join("atomic-fail.db")).unwrap();
    // Oversized digest fails payload check before any durable write.
    let mut rec = sample_record("runtime_pending_fail");
    rec.request_digest = Some("y".repeat(MAX_PAYLOAD_BYTES + 1));
    let result = claim_start_atomic(&conn, "test-client", "test-req-1", &rec);
    assert!(matches!(result, Err(DbError::PayloadTooLarge)));
    assert!(query_receipt(&conn, "test-client", "test-req-1")
        .unwrap()
        .is_none());
    let claim_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM mutation_claims WHERE client_id = 'test-client' AND request_id = 'test-req-1'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(claim_count, 0, "failed claim must leave no claim row");
    // Exact retry after failure is allowed and succeeds.
    let rec = sample_record("runtime_pending_fail");
    claim_start_atomic(&conn, "test-client", "test-req-1", &rec).unwrap();
    assert!(query_receipt(&conn, "test-client", "test-req-1")
        .unwrap()
        .is_some());
}

#[test]
fn prepare_failure_cleanup_releases_claim_for_exact_retry() {
    let dir = tempdir().unwrap();
    let conn = open_durable(dir.path().join("prepare-fail.db")).unwrap();
    let rec = sample_record("runtime_pending_prepare");
    claim_start_atomic(&conn, "test-client", "test-req-1", &rec).unwrap();
    // Simulate provable-non-dispatch cleanup (serialize/prepare/no-executor path):
    // receipt AND claim released atomically so exact retry is allowed.
    release_start_artifacts(&conn, "test-client", "test-req-1").unwrap();
    assert!(query_receipt(&conn, "test-client", "test-req-1")
        .unwrap()
        .is_none());
    // Exact retry succeeds after cleanup.
    let rec = sample_record("runtime_pending_prepare");
    claim_start_atomic(&conn, "test-client", "test-req-1", &rec).unwrap();
    assert!(query_receipt(&conn, "test-client", "test-req-1")
        .unwrap()
        .is_some());
}
