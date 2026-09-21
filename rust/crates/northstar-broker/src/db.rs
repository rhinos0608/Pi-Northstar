//! Durable SQLite receipt authority.
//! WAL + synchronous=FULL + macOS fullfsync. Fail-closed on any write error.

use rusqlite::{params, Connection, OpenFlags};
use std::path::Path;

pub const DB_SCHEMA_VERSION: u32 = 1;
pub const MAX_PAYLOAD_BYTES: usize = 4096;

/// Job state in the receipt journal.
#[derive(Debug, Clone, PartialEq)]
pub enum JobState {
    Pending,
    Dispatched,
    Completed,
    OutcomeUnknown,
}

impl JobState {
    pub fn as_str(&self) -> &'static str {
        match self {
            JobState::Pending => "pending",
            JobState::Dispatched => "dispatched",
            JobState::Completed => "completed",
            JobState::OutcomeUnknown => "outcome_unknown",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "pending" => Some(JobState::Pending),
            "dispatched" => Some(JobState::Dispatched),
            "completed" => Some(JobState::Completed),
            "outcome_unknown" => Some(JobState::OutcomeUnknown),
            _ => None,
        }
    }
}

/// A receipt record in the journal.
#[derive(Debug, Clone)]
pub struct ReceiptRecord {
    pub job_id: String,
    pub client_id: String,
    pub request_id: String,
    pub state: JobState,
    pub submitted_at: i64,
    /// Optional bounded payload (≤ MAX_PAYLOAD_BYTES). Never auto-retried.
    pub receipt_payload: Option<String>,
    /// Optional bounded request digest (≤ MAX_PAYLOAD_BYTES).
    pub request_digest: Option<String>,
}

#[derive(Debug)]
pub enum DbError {
    Sql(rusqlite::Error),
    PayloadTooLarge,
    InvalidState(String),
    Duplicate,
    SchemaMismatch { expected: u32, found: u32 },
}

impl std::fmt::Display for DbError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DbError::Sql(e) => write!(f, "sqlite error: {e}"),
            DbError::PayloadTooLarge => write!(f, "payload exceeds {MAX_PAYLOAD_BYTES} byte limit"),
            DbError::InvalidState(s) => write!(f, "invalid job state: {s}"),
            DbError::Duplicate => write!(f, "duplicate job_id"),
            DbError::SchemaMismatch { expected, found } => write!(
                f,
                "schema version mismatch: expected {expected}, found {found}"
            ),
        }
    }
}
impl std::error::Error for DbError {}
impl From<rusqlite::Error> for DbError {
    fn from(e: rusqlite::Error) -> Self {
        DbError::Sql(e)
    }
}

/// Open a durable SQLite connection with WAL + FULL sync + macOS fullfsync.
pub fn open_durable<P: AsRef<Path>>(path: P) -> Result<Connection, DbError> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_CREATE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = FULL;
         PRAGMA fullfsync = 1;
         PRAGMA checkpoint_fullfsync = 1;",
    )?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_version (
            version INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS job_receipts (
            job_id          TEXT PRIMARY KEY NOT NULL,
            client_id       TEXT NOT NULL,
            request_id      TEXT NOT NULL,
            state           TEXT NOT NULL CHECK(state IN ('pending','dispatched','completed','outcome_unknown')),
            submitted_at    INTEGER NOT NULL,
            receipt_payload TEXT,
            request_digest  TEXT
         );
         CREATE INDEX IF NOT EXISTS idx_receipts_client_request
             ON job_receipts(client_id, request_id);",
    )?;
    // Populate schema_version on create, read+validate on open.
    // Empty table -> QueryReturnedNoRows -> initialize version 1.
    // Any other SQLite or u32 decoding error propagates, never treated as empty.
    let found: Option<u32> =
        match conn.query_row("SELECT version FROM schema_version LIMIT 1", [], |row| {
            row.get(0)
        }) {
            Ok(v) => Some(v),
            Err(rusqlite::Error::QueryReturnedNoRows) => None,
            Err(e) => return Err(DbError::Sql(e)),
        };
    match found {
        None => {
            conn.execute(
                "INSERT INTO schema_version (version) VALUES (?1)",
                rusqlite::params![DB_SCHEMA_VERSION],
            )?;
        }
        Some(v) if v == DB_SCHEMA_VERSION => {}
        Some(v) => {
            return Err(DbError::SchemaMismatch {
                expected: DB_SCHEMA_VERSION,
                found: v,
            });
        }
    }
    Ok(conn)
}

fn check_payload(s: &Option<String>) -> Result<(), DbError> {
    if let Some(p) = s {
        if p.len() > MAX_PAYLOAD_BYTES {
            return Err(DbError::PayloadTooLarge);
        }
    }
    Ok(())
}

/// Insert a new job receipt in Pending state using BEGIN IMMEDIATE.
pub fn insert_job(conn: &Connection, rec: &ReceiptRecord) -> Result<(), DbError> {
    check_payload(&rec.receipt_payload)?;
    check_payload(&rec.request_digest)?;
    conn.execute_batch("BEGIN IMMEDIATE;")?;
    let result = conn.execute(
        "INSERT INTO job_receipts
            (job_id, client_id, request_id, state, submitted_at, receipt_payload, request_digest)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            rec.job_id,
            rec.client_id,
            rec.request_id,
            rec.state.as_str(),
            rec.submitted_at,
            rec.receipt_payload,
            rec.request_digest,
        ],
    );
    match result {
        Ok(_) => {
            conn.execute_batch("COMMIT;")?;
            Ok(())
        }
        Err(rusqlite::Error::SqliteFailure(ref e, _))
            if e.code == rusqlite::ErrorCode::ConstraintViolation =>
        {
            conn.execute_batch("ROLLBACK;")?;
            Err(DbError::Duplicate)
        }
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK;");
            Err(DbError::Sql(e))
        }
    }
}

/// Transition job state using BEGIN IMMEDIATE. Interrupted writes map to outcome_unknown.
pub fn transition_job(conn: &Connection, job_id: &str, new_state: JobState) -> Result<(), DbError> {
    conn.execute_batch("BEGIN IMMEDIATE;")?;
    let rows = conn.execute(
        "UPDATE job_receipts SET state = ?1 WHERE job_id = ?2",
        params![new_state.as_str(), job_id],
    );
    match rows {
        Ok(0) => {
            conn.execute_batch("ROLLBACK;")?;
            Ok(())
        } // not found; no-op
        Ok(_) => {
            conn.execute_batch("COMMIT;")?;
            Ok(())
        }
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK;");
            Err(DbError::Sql(e))
        }
    }
}

/// Query a receipt by client + request_id. Read-only; no epoch rotation.
pub fn query_receipt(
    conn: &Connection,
    client_id: &str,
    request_id: &str,
) -> Result<Option<ReceiptRecord>, DbError> {
    let mut stmt = conn.prepare(
        "SELECT job_id, client_id, request_id, state, submitted_at, receipt_payload, request_digest
         FROM job_receipts WHERE client_id = ?1 AND request_id = ?2 LIMIT 1",
    )?;
    let mut rows = stmt.query(params![client_id, request_id])?;
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

/** Transition a receipt selected by its stable client/request identity. */
pub fn transition_job_by_request(
    conn: &Connection,
    client_id: &str,
    request_id: &str,
    new_state: JobState,
) -> Result<(), DbError> {
    conn.execute_batch("BEGIN IMMEDIATE;")?;
    let rows = conn.execute(
        "UPDATE job_receipts SET state = ?1 WHERE client_id = ?2 AND request_id = ?3",
        params![new_state.as_str(), client_id, request_id],
    );
    match rows {
        Ok(_) => {
            conn.execute_batch("COMMIT;")?;
            Ok(())
        }
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK;");
            Err(DbError::Sql(e))
        }
    }
}

/** Replace a provisional receipt id with the runtime-issued id while keeping the job dispatched. */
pub fn bind_dispatched_job(
    conn: &Connection,
    client_id: &str,
    request_id: &str,
    job_id: &str,
) -> Result<(), DbError> {
    conn.execute_batch("BEGIN IMMEDIATE;")?;
    let rows = conn.execute(
        "UPDATE job_receipts SET job_id = ?1, state = ?2
         WHERE client_id = ?3 AND request_id = ?4",
        params![job_id, JobState::Dispatched.as_str(), client_id, request_id],
    );
    match rows {
        Ok(0) => {
            conn.execute_batch("ROLLBACK;")?;
            Err(DbError::InvalidState("missing pending receipt".into()))
        }
        Ok(_) => {
            conn.execute_batch("COMMIT;")?;
            Ok(())
        }
        Err(rusqlite::Error::SqliteFailure(ref e, _))
            if e.code == rusqlite::ErrorCode::ConstraintViolation =>
        {
            let _ = conn.execute_batch("ROLLBACK;");
            Err(DbError::Duplicate)
        }
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK;");
            Err(DbError::Sql(e))
        }
    }
}

/** Remove a receipt only when dispatch is known not to have occurred. */
pub fn delete_job_by_request(
    conn: &Connection,
    client_id: &str,
    request_id: &str,
) -> Result<(), DbError> {
    conn.execute(
        "DELETE FROM job_receipts WHERE client_id = ?1 AND request_id = ?2",
        params![client_id, request_id],
    )?;
    Ok(())
}

/** Mark unfinished receipts unknown after broker/executor restart. Never retries them. */
pub fn recover_incomplete_jobs(conn: &Connection) -> Result<usize, DbError> {
    let changed = conn.execute(
        "UPDATE job_receipts SET state = ?1 WHERE state IN ('pending','dispatched')",
        params![JobState::OutcomeUnknown.as_str()],
    )?;
    Ok(changed)
}

/** Cancellation targets are authorized only when every runtime id belongs to this client. */
pub fn owns_all_jobs(
    conn: &Connection,
    client_id: &str,
    job_ids: &[String],
) -> Result<bool, DbError> {
    for job_id in job_ids {
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM job_receipts WHERE client_id = ?1 AND job_id = ?2",
            params![client_id, job_id],
            |row| row.get(0),
        )?;
        if count != 1 {
            return Ok(false);
        }
    }
    Ok(true)
}
