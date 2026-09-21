//! Gate B Slice 7: cancel and settle authority tests.
//! Verifies request validation bounds, outcome booking, cross-client isolation,
//! idempotency, and outcome_unknown / unknown job non-invention.

use northstar_broker::db::{insert_job, open_durable, query_receipt, JobState, ReceiptRecord};
use northstar_broker::settle::{
    find_by_job_id, mark_timed_out, settle_books, settle_validate, SettleError, SettleRequest,
    MAX_CANCEL_RUN_IDS, MAX_SETTLEMENT_WINDOW_MS, MIN_SETTLEMENT_WINDOW_MS,
};
use tempfile::tempdir;

fn sample_job(job_id: &str, client_id: &str, req_id: &str, state: JobState) -> ReceiptRecord {
    ReceiptRecord {
        job_id: job_id.to_string(),
        client_id: client_id.to_string(),
        request_id: req_id.to_string(),
        state,
        submitted_at: 1_700_000_000,
        receipt_payload: None,
        request_digest: None,
    }
}

#[test]
fn validation_rejects_empty_run_ids() {
    let req = SettleRequest {
        run_ids: vec![],
        settlement_window_ms: 1000,
    };
    let res = settle_validate(&req);
    assert!(matches!(res, Err(SettleError::EmptyRunIds)));
}

#[test]
fn validation_rejects_duplicate_run_ids() {
    let req = SettleRequest {
        run_ids: vec!["run-1".to_string(), "run-2".to_string(), "run-1".to_string()],
        settlement_window_ms: 1000,
    };
    let res = settle_validate(&req);
    assert!(matches!(res, Err(SettleError::DuplicateRunIds)));
}

#[test]
fn validation_rejects_too_many_run_ids() {
    let run_ids: Vec<String> = (0..=MAX_CANCEL_RUN_IDS)
        .map(|i| format!("run-{i}"))
        .collect();
    let req = SettleRequest {
        run_ids,
        settlement_window_ms: 1000,
    };
    let res = settle_validate(&req);
    assert!(matches!(res, Err(SettleError::TooManyRunIds)));
}

#[test]
fn validation_rejects_window_zero() {
    let req = SettleRequest {
        run_ids: vec!["run-1".to_string()],
        settlement_window_ms: 0,
    };
    let res = settle_validate(&req);
    assert!(matches!(res, Err(SettleError::WindowOutOfBounds)));
}

#[test]
fn validation_rejects_window_above_max() {
    let req = SettleRequest {
        run_ids: vec!["run-1".to_string()],
        settlement_window_ms: MAX_SETTLEMENT_WINDOW_MS + 1,
    };
    let res = settle_validate(&req);
    assert!(matches!(res, Err(SettleError::WindowOutOfBounds)));
}

#[test]
fn validation_accepts_boundary_windows() {
    let req_min = SettleRequest {
        run_ids: vec!["run-1".to_string()],
        settlement_window_ms: MIN_SETTLEMENT_WINDOW_MS,
    };
    assert!(settle_validate(&req_min).is_ok());

    let req_max = SettleRequest {
        run_ids: vec!["run-1".to_string()],
        settlement_window_ms: MAX_SETTLEMENT_WINDOW_MS,
    };
    assert!(settle_validate(&req_max).is_ok());

    let exact_64_ids: Vec<String> = (0..MAX_CANCEL_RUN_IDS)
        .map(|i| format!("run-{i}"))
        .collect();
    let req_64 = SettleRequest {
        run_ids: exact_64_ids,
        settlement_window_ms: 5000,
    };
    assert!(settle_validate(&req_64).is_ok());
}

#[test]
fn settle_books_settles_pending_and_dispatched_jobs() {
    let dir = tempdir().unwrap();
    let conn = open_durable(dir.path().join("settle.db")).unwrap();

    insert_job(
        &conn,
        &sample_job("job-pend", "client-a", "req-1", JobState::Pending),
    )
    .unwrap();
    insert_job(
        &conn,
        &sample_job("job-disp", "client-a", "req-2", JobState::Dispatched),
    )
    .unwrap();

    let req = SettleRequest {
        run_ids: vec!["job-pend".to_string(), "job-disp".to_string()],
        settlement_window_ms: 500,
    };

    let report = settle_books(&conn, "client-a", &req).unwrap();
    assert_eq!(report.settled, vec!["job-pend", "job-disp"]);
    assert!(report.timed_out.is_empty());
    assert!(report.unknown.is_empty());

    let rec1 = find_by_job_id(&conn, "job-pend").unwrap().unwrap();
    assert_eq!(rec1.state, JobState::Completed);
    let rec2 = find_by_job_id(&conn, "job-disp").unwrap().unwrap();
    assert_eq!(rec2.state, JobState::Completed);
}

#[test]
fn settle_books_unknown_run_id_not_invented() {
    let dir = tempdir().unwrap();
    let conn = open_durable(dir.path().join("unknown.db")).unwrap();

    let req = SettleRequest {
        run_ids: vec!["nonexistent-job".to_string()],
        settlement_window_ms: 100,
    };

    let report = settle_books(&conn, "client-a", &req).unwrap();
    assert!(report.settled.is_empty());
    assert!(report.timed_out.is_empty());
    assert_eq!(report.unknown, vec!["nonexistent-job"]);

    // Verify no row created in DB
    let found = find_by_job_id(&conn, "nonexistent-job").unwrap();
    assert!(found.is_none());

    let receipt = query_receipt(&conn, "client-a", "nonexistent-job").unwrap();
    assert!(receipt.is_none());
}

#[test]
fn settle_books_cross_client_job_reported_unknown_and_untouched() {
    let dir = tempdir().unwrap();
    let conn = open_durable(dir.path().join("cross_client.db")).unwrap();

    insert_job(
        &conn,
        &sample_job("job-other", "client-b", "req-b", JobState::Dispatched),
    )
    .unwrap();

    let req = SettleRequest {
        run_ids: vec!["job-other".to_string()],
        settlement_window_ms: 250,
    };

    let report = settle_books(&conn, "client-a", &req).unwrap();
    assert!(report.settled.is_empty());
    assert!(report.timed_out.is_empty());
    assert_eq!(report.unknown, vec!["job-other"]);

    // Verify job untouched in DB and still Dispatched under client-b
    let rec = find_by_job_id(&conn, "job-other").unwrap().unwrap();
    assert_eq!(rec.client_id, "client-b");
    assert_eq!(rec.state, JobState::Dispatched);
}

#[test]
fn settle_books_completed_job_re_settle_is_idempotent() {
    let dir = tempdir().unwrap();
    let conn = open_durable(dir.path().join("idempotent.db")).unwrap();

    insert_job(
        &conn,
        &sample_job("job-done", "client-a", "req-d", JobState::Completed),
    )
    .unwrap();

    let req = SettleRequest {
        run_ids: vec!["job-done".to_string()],
        settlement_window_ms: 1000,
    };

    let report = settle_books(&conn, "client-a", &req).unwrap();
    assert_eq!(report.settled, vec!["job-done"]);
    assert!(report.timed_out.is_empty());
    assert!(report.unknown.is_empty());

    let rec = find_by_job_id(&conn, "job-done").unwrap().unwrap();
    assert_eq!(rec.state, JobState::Completed);
}

#[test]
fn settle_books_outcome_unknown_job_reported_unknown() {
    let dir = tempdir().unwrap();
    let conn = open_durable(dir.path().join("outcome_unknown.db")).unwrap();

    insert_job(
        &conn,
        &sample_job("job-unk", "client-a", "req-u", JobState::OutcomeUnknown),
    )
    .unwrap();

    let req = SettleRequest {
        run_ids: vec!["job-unk".to_string()],
        settlement_window_ms: 1000,
    };

    let report = settle_books(&conn, "client-a", &req).unwrap();
    assert!(report.settled.is_empty());
    assert_eq!(report.unknown, vec!["job-unk"]);
}

#[test]
fn mark_timed_out_verifies_dispatched_and_client_ownership() {
    let dir = tempdir().unwrap();
    let conn = open_durable(dir.path().join("timed_out.db")).unwrap();

    insert_job(
        &conn,
        &sample_job("job-disp", "client-a", "req-1", JobState::Dispatched),
    )
    .unwrap();
    insert_job(
        &conn,
        &sample_job("job-pend", "client-a", "req-2", JobState::Pending),
    )
    .unwrap();

    assert!(mark_timed_out(&conn, "client-a", "job-disp").unwrap());
    assert!(!mark_timed_out(&conn, "client-a", "job-pend").unwrap());
    assert!(!mark_timed_out(&conn, "client-b", "job-disp").unwrap());
    assert!(!mark_timed_out(&conn, "client-a", "nonexistent").unwrap());

    // State stays dispatched
    let rec = find_by_job_id(&conn, "job-disp").unwrap().unwrap();
    assert_eq!(rec.state, JobState::Dispatched);
}
