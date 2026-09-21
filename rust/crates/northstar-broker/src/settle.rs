//! Cancel-and-settle authority: validates cancelAndSettle requests,
//! books job transitions, and reports per-run outcomes.
//! Reply `data` stays opaque to the broker envelope layer.

use std::collections::HashSet;
use rusqlite::{params, Connection};

use crate::db::{transition_job, DbError, JobState, ReceiptRecord};

pub const MAX_CANCEL_RUN_IDS: usize = 64;
pub const MIN_SETTLEMENT_WINDOW_MS: u64 = 1;
pub const MAX_SETTLEMENT_WINDOW_MS: u64 = 10_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunOutcome {
    Settled,
    TimedOut,
    Unknown,
}

#[derive(Debug)]
pub enum SettleError {
    EmptyRunIds,
    TooManyRunIds,
    DuplicateRunIds,
    WindowOutOfBounds,
    Db(DbError),
}

impl std::fmt::Display for SettleError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SettleError::EmptyRunIds => write!(f, "runIds must not be empty"),
            SettleError::TooManyRunIds => {
                write!(f, "runIds count exceeds maximum of {MAX_CANCEL_RUN_IDS}")
            }
            SettleError::DuplicateRunIds => write!(f, "runIds must not contain duplicates"),
            SettleError::WindowOutOfBounds => write!(
                f,
                "settlementWindowMs must be between {MIN_SETTLEMENT_WINDOW_MS} and {MAX_SETTLEMENT_WINDOW_MS} ms"
            ),
            SettleError::Db(e) => write!(f, "database error: {e}"),
        }
    }
}

impl std::error::Error for SettleError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            SettleError::Db(e) => Some(e),
            _ => None,
        }
    }
}

impl From<DbError> for SettleError {
    fn from(e: DbError) -> Self {
        SettleError::Db(e)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SettleRequest {
    pub run_ids: Vec<String>,
    pub settlement_window_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SettleReport {
    pub settled: Vec<String>,
    pub timed_out: Vec<String>,
    pub unknown: Vec<String>,
}

/// Validate request bounds.
pub fn settle_validate(req: &SettleRequest) -> Result<(), SettleError> {
    if req.run_ids.is_empty() {
        return Err(SettleError::EmptyRunIds);
    }
    if req.run_ids.len() > MAX_CANCEL_RUN_IDS {
        return Err(SettleError::TooManyRunIds);
    }
    let mut seen = HashSet::with_capacity(req.run_ids.len());
    for id in &req.run_ids {
        if !seen.insert(id) {
            return Err(SettleError::DuplicateRunIds);
        }
    }
    if req.settlement_window_ms < MIN_SETTLEMENT_WINDOW_MS
        || req.settlement_window_ms > MAX_SETTLEMENT_WINDOW_MS
    {
        return Err(SettleError::WindowOutOfBounds);
    }
    Ok(())
}

/// Look up receipt by job_id directly. Read-only.
pub fn find_by_job_id(conn: &Connection, job_id: &str) -> Result<Option<ReceiptRecord>, DbError> {
    let mut stmt = conn.prepare(
        "SELECT job_id, client_id, request_id, state, submitted_at, receipt_payload, request_digest
         FROM job_receipts WHERE job_id = ?1 LIMIT 1",
    )?;
    let mut rows = stmt.query(params![job_id])?;
    if let Some(row) = rows.next()? {
        let state_str: String = row.get(3)?;
        let state =
            JobState::from_str(&state_str).ok_or_else(|| DbError::InvalidState(state_str))?;
        Ok(Some(ReceiptRecord {
            job_id: row.get(0)?,
            client_id: row.get(1)?,
            request_id: row.get(2)?,
            state,
            submitted_at: row.get(4)?,
            receipt_payload: row.get(5)?,
            request_digest: row.get(6)?,
        }))
    } else {
        Ok(None)
    }
}

/// Validate and book outcomes.
/// For each run_id:
/// - find_by_job_id
/// - None -> unknown (no rows invented)
/// - Some(rec) if rec.client_id != client_id -> unknown (cross-client runs never touched)
/// - Completed -> settled (idempotent)
/// - Pending | Dispatched -> transition_job(completed) -> settled
/// - OutcomeUnknown -> unknown
pub fn settle_books(
    conn: &Connection,
    client_id: &str,
    req: &SettleRequest,
) -> Result<SettleReport, SettleError> {
    settle_validate(req)?;

    let mut settled = Vec::new();
    let timed_out = Vec::new();
    let mut unknown = Vec::new();

    for run_id in &req.run_ids {
        match find_by_job_id(conn, run_id)? {
            None => {
                unknown.push(run_id.clone());
            }
            Some(rec) => {
                if rec.client_id != client_id {
                    unknown.push(run_id.clone());
                } else {
                    match rec.state {
                        JobState::Completed => {
                            settled.push(run_id.clone());
                        }
                        JobState::Pending | JobState::Dispatched => {
                            transition_job(conn, run_id, JobState::Completed)?;
                            settled.push(run_id.clone());
                        }
                        JobState::OutcomeUnknown => {
                            unknown.push(run_id.clone());
                        }
                    }
                }
            }
        }
    }

    Ok(SettleReport {
        settled,
        timed_out,
        unknown,
    })
}

/// Verifies existence and client ownership of a dispatched job without modifying state.
/// TimedOut means process survived settlement window — job stays Dispatched.
pub fn mark_timed_out(conn: &Connection, client_id: &str, job_id: &str) -> Result<bool, DbError> {
    match find_by_job_id(conn, job_id)? {
        Some(rec) if rec.client_id == client_id && rec.state == JobState::Dispatched => Ok(true),
        _ => Ok(false),
    }
}
