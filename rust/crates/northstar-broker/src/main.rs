use std::env;
use std::fs;
use std::io::{self, Read, Write};
use std::os::unix::fs::FileTypeExt;
use std::os::unix::fs::MetadataExt;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};

use northstar_broker::auth::{issue_session, verify_token, BrokerAuth};
use northstar_broker::db::{
    bind_dispatched_job, delete_job_by_request, insert_job, open_durable, owns_all_jobs,
    query_receipt, recover_incomplete_jobs, transition_job, transition_job_by_request, JobState,
    ReceiptRecord,
};
use northstar_broker::endpoint::unix::get_peer_identity;
use northstar_broker::executor::{ExecutorError, ExecutorUpstream};
use northstar_broker::frame::{decode_frame, encode_frame, BROKER_MAX_FRAME_BYTES};
use northstar_broker::grants::intersect_capabilities;
use northstar_broker::protocol::{
    BrokerCapability, BrokerErrorMessage, BrokerMessage, BrokerQueryResponse, BrokerResponse,
    BrokerWelcome, JobSubmissionReceipt, RpcMethod, RuntimeRpcRequest,
};

#[derive(Debug)]
struct CliArgs {
    project_id: String,
    socket_path: PathBuf,
    db_path: PathBuf,
    executor_socket: Option<PathBuf>,
    executor_token_file: Option<PathBuf>,
}

fn validate_project_id(id: &str) -> bool {
    if id.is_empty() || id.len() > 96 {
        return false;
    }
    id.chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
}

fn parse_args() -> Result<CliArgs, String> {
    let mut args = env::args().skip(1);
    let mut project_id = None;
    let mut socket_path = None;
    let mut db_path = None;
    let mut executor_socket = None;
    let mut executor_token_file = None;

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--project-id" => {
                let val = args.next().ok_or("Missing value for --project-id")?;
                if !validate_project_id(&val) {
                    return Err(format!("Invalid --project-id: {val}"));
                }
                project_id = Some(val);
            }
            "--socket" => {
                let val = args.next().ok_or("Missing value for --socket")?;
                socket_path = Some(PathBuf::from(val));
            }
            "--db" => {
                let val = args.next().ok_or("Missing value for --db")?;
                db_path = Some(PathBuf::from(val));
            }
            "--executor-socket" => {
                let val = args.next().ok_or("Missing value for --executor-socket")?;
                executor_socket = Some(PathBuf::from(val));
            }
            "--executor-token-file" => {
                let val = args
                    .next()
                    .ok_or("Missing value for --executor-token-file")?;
                executor_token_file = Some(PathBuf::from(val));
            }
            other => {
                return Err(format!("Unknown argument: {other}"));
            }
        }
    }

    let project_id = project_id.ok_or("Missing required argument: --project-id")?;
    let socket_path = socket_path.ok_or("Missing required argument: --socket")?;
    let db_path = db_path.unwrap_or_else(|| {
        let parent = socket_path.parent().unwrap_or_else(|| Path::new("."));
        parent.join("broker-state.db")
    });

    Ok(CliArgs {
        project_id,
        socket_path,
        db_path,
        executor_socket,
        executor_token_file,
    })
}

fn remove_stale_socket(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(meta) => {
            if meta.file_type().is_symlink() {
                return Err(io::Error::new(
                    io::ErrorKind::AlreadyExists,
                    "Socket path is a symlink: refusing to delete",
                ));
            }
            let my_uid = unsafe { libc::geteuid() };
            if meta.uid() != my_uid {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "Socket file is not owned by current user",
                ));
            }
            if !meta.file_type().is_socket() {
                return Err(io::Error::new(
                    io::ErrorKind::AlreadyExists,
                    "Path exists and is not a socket",
                ));
            }
            fs::remove_file(path)?;
            Ok(())
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

fn capability_for_method(method: &RpcMethod) -> BrokerCapability {
    match method {
        RpcMethod::Negotiate => BrokerCapability::RuntimeNegotiate,
        RpcMethod::Start => BrokerCapability::RuntimeStart,
        RpcMethod::Status => BrokerCapability::RuntimeStatus,
        RpcMethod::Result => BrokerCapability::RuntimeResult,
        RpcMethod::CancelAndSettle => BrokerCapability::RuntimeCancel,
    }
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

fn request_digest(request: &RuntimeRpcRequest) -> Result<String, serde_json::Error> {
    let bytes = serde_json::to_vec(request)?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn provisional_job_id(client_id: &str, request_id: &str) -> String {
    let material = format!("{client_id}:{request_id}");
    let digest = format!("{:x}", Sha256::digest(material.as_bytes()));
    format!("runtime_pending_{}", &digest[..32])
}

fn is_provisional_job_id(job_id: &str) -> bool {
    let Some(suffix) = job_id.strip_prefix("runtime_pending_") else {
        return false;
    };
    suffix.len() == 32 && suffix.chars().all(|c| c.is_ascii_hexdigit())
}

fn valid_runtime_job_id(job_id: &str) -> bool {
    let Some(suffix) = job_id.strip_prefix("runtime_") else {
        return false;
    };
    !suffix.is_empty()
        && suffix.len() <= 64
        && suffix
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn terminal_runtime_state(state: &str) -> bool {
    matches!(state, "completed" | "failed" | "cancelled")
}

fn terminal_result_error(code: &str) -> bool {
    matches!(
        code,
        "provider_error"
            | "output_token_limit_exceeded"
            | "result_byte_limit_exceeded"
            | "output_contract_breach"
            | "contract_breach"
    )
}

fn mark_jobs_outcome_unknown(db_conn: &rusqlite::Connection, run_ids: &[String]) {
    for run_id in run_ids {
        let _ = transition_job(db_conn, run_id, JobState::OutcomeUnknown);
    }
}

fn send_error(stream: &mut UnixStream, code: &str) {
    let msg = BrokerMessage::Error(BrokerErrorMessage {
        version: 2,
        kind: "error".to_string(),
        code: code.to_string(),
    });
    if let Ok(frame) = encode_frame(&msg) {
        let _ = stream.write_all(&frame);
    }
}

fn send_msg(stream: &mut UnixStream, msg: &BrokerMessage) -> io::Result<()> {
    let frame =
        encode_frame(msg).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string()))?;
    stream.write_all(&frame)
}

fn read_one_frame(
    stream: &mut UnixStream,
    buf: &mut Vec<u8>,
) -> Result<Option<BrokerMessage>, String> {
    loop {
        if buf.len() >= 4 {
            let size = u32::from_be_bytes(buf[..4].try_into().unwrap()) as usize;
            if size > BROKER_MAX_FRAME_BYTES {
                return Err("frame_too_large".to_string());
            }
            if buf.len() >= 4 + size {
                let frame = buf.drain(..4 + size).collect::<Vec<u8>>();
                match decode_frame(&frame) {
                    Ok(msg) => return Ok(Some(msg)),
                    Err(_) => return Err("invalid_frame".to_string()),
                }
            }
        }

        let mut temp = [0u8; 4096];
        match stream.read(&mut temp) {
            Ok(0) => {
                if buf.is_empty() {
                    return Ok(None);
                } else {
                    return Err("invalid_frame".to_string());
                }
            }
            Ok(n) => {
                buf.extend_from_slice(&temp[..n]);
                if buf.len() > BROKER_MAX_FRAME_BYTES + 4 {
                    return Err("frame_too_large".to_string());
                }
            }
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e.to_string()),
        }
    }
}

fn handle_connection(
    mut stream: UnixStream,
    project_id: &str,
    auth: &BrokerAuth,
    db_conn: &rusqlite::Connection,
    executor: Option<&ExecutorUpstream>,
) {
    let raw_fd = std::os::unix::io::AsRawFd::as_raw_fd(&stream);
    let my_euid = unsafe { libc::geteuid() };

    match get_peer_identity(raw_fd) {
        Ok(peer) => {
            if peer.uid != my_euid {
                send_error(&mut stream, "unauthorized");
                return;
            }
        }
        Err(_) => {
            send_error(&mut stream, "unauthorized");
            return;
        }
    }

    let mut buf = Vec::new();
    let mut welcome: Option<BrokerWelcome> = None;
    let mut last_sequence: Option<i64> = None;

    loop {
        let msg = match read_one_frame(&mut stream, &mut buf) {
            Ok(Some(m)) => m,
            Ok(None) => return,
            Err(err_code) => {
                let code = match err_code.as_str() {
                    "frame_too_large" => "frame_too_large",
                    "unsupported_version" => "unsupported_version",
                    _ => "invalid_frame",
                };
                send_error(&mut stream, code);
                return;
            }
        };

        if welcome.is_none() {
            let hello = match msg {
                BrokerMessage::Hello(h) => h,
                _ => {
                    send_error(&mut stream, "unsupported_version");
                    return;
                }
            };

            if hello.project_id != project_id {
                send_error(&mut stream, "project_denied");
                return;
            }

            let granted = intersect_capabilities(&hello.requested_capabilities);
            let session = issue_session(auth, &hello.client_id, project_id, granted);

            let welcome_msg = BrokerWelcome {
                version: 2,
                kind: "welcome".to_string(),
                epoch: session.epoch.clone(),
                client_id: hello.client_id.clone(),
                session_id: session.session_id.clone(),
                token: session.token.clone(),
                // Wire timestamps are JavaScript epoch milliseconds. Token claims
                // remain second-based internally for verification.
                expires_at: session.expires_at.saturating_mul(1_000),
                capabilities: session.capabilities.clone(),
                project_id: project_id.to_string(),
            };

            if send_msg(&mut stream, &BrokerMessage::Welcome(welcome_msg.clone())).is_err() {
                return;
            }
            welcome = Some(welcome_msg);
            continue;
        }

        let current_welcome = welcome.as_ref().unwrap();

        match msg {
            BrokerMessage::Query(q) => {
                if q.project_id != project_id {
                    send_error(&mut stream, "project_denied");
                    return;
                }
                if q.epoch != auth.epoch {
                    send_error(&mut stream, "epoch_mismatch");
                    return;
                }

                let next_seq = last_sequence.map_or(1, |s| s + 1);
                if q.sequence != next_seq {
                    send_error(&mut stream, "sequence_replay");
                    return;
                }
                last_sequence = Some(q.sequence);

                if let Err(err) = verify_token(
                    auth,
                    &q.token,
                    &auth.epoch,
                    &current_welcome.client_id,
                    &current_welcome.session_id,
                    project_id,
                    &BrokerCapability::RuntimeStatus,
                ) {
                    let code = match err {
                        northstar_broker::auth::VerifyError::ExpiredToken => "expired_token",
                        northstar_broker::auth::VerifyError::EpochMismatch => "epoch_mismatch",
                        northstar_broker::auth::VerifyError::ProjectDenied => "project_denied",
                        northstar_broker::auth::VerifyError::ScopeDenied => "scope_denied",
                        _ => "unauthorized",
                    };
                    send_error(&mut stream, code);
                    return;
                }

                let maybe_rec =
                    match query_receipt(db_conn, &current_welcome.client_id, &q.query.request_id) {
                        Ok(r) => r,
                        Err(_) => {
                            send_error(&mut stream, "invalid_frame");
                            return;
                        }
                    };

                // A definitive failed start is journaled as completed for durable
                // mutation accounting, but it never created a runtime job. Do not
                // expose its provisional id as a job submission receipt.
                let receipt = maybe_rec.and_then(|r| {
                    if r.state == JobState::Completed && is_provisional_job_id(&r.job_id) {
                        return None;
                    }
                    Some(JobSubmissionReceipt {
                        job_id: r.job_id,
                        client_id: r.client_id,
                        request_id: r.request_id,
                        submitted_at: r.submitted_at as u64,
                        state: Some(r.state.as_str().to_string()),
                    })
                });

                let resp = BrokerMessage::QueryResponse(BrokerQueryResponse {
                    version: 2,
                    kind: "queryResponse".to_string(),
                    sequence: q.sequence,
                    receipt,
                });

                if send_msg(&mut stream, &resp).is_err() {
                    return;
                }
            }

            BrokerMessage::Request(req) => {
                if req.project_id != project_id {
                    send_error(&mut stream, "project_denied");
                    return;
                }
                if req.epoch != auth.epoch {
                    send_error(&mut stream, "epoch_mismatch");
                    return;
                }

                let next_seq = last_sequence.map_or(1, |s| s + 1);
                if req.sequence != next_seq {
                    send_error(&mut stream, "sequence_replay");
                    return;
                }
                last_sequence = Some(req.sequence);

                let required_cap = capability_for_method(&req.request.method);
                if let Err(err) = verify_token(
                    auth,
                    &req.token,
                    &auth.epoch,
                    &current_welcome.client_id,
                    &current_welcome.session_id,
                    project_id,
                    &required_cap,
                ) {
                    let code = match err {
                        northstar_broker::auth::VerifyError::ExpiredToken => "expired_token",
                        northstar_broker::auth::VerifyError::EpochMismatch => "epoch_mismatch",
                        northstar_broker::auth::VerifyError::ProjectDenied => "project_denied",
                        northstar_broker::auth::VerifyError::ScopeDenied => "scope_denied",
                        _ => "unauthorized",
                    };
                    send_error(&mut stream, code);
                    return;
                }

                match req.request.method {
                    RpcMethod::CancelAndSettle => {
                        handle_cancel_and_settle(
                            &mut stream,
                            &req.request,
                            req.sequence,
                            &current_welcome.client_id,
                            db_conn,
                            executor,
                        );
                    }
                    RpcMethod::Start => {
                        match db_conn.execute(
                            "INSERT INTO mutation_claims (client_id, request_id) VALUES (?1, ?2)",
                            rusqlite::params![&current_welcome.client_id, &req.request.request_id],
                        ) {
                            Ok(_) => {}
                            Err(rusqlite::Error::SqliteFailure(e, _))
                                if e.code == rusqlite::ErrorCode::ConstraintViolation =>
                            {
                                send_error(&mut stream, "duplicate_mutation");
                                return;
                            }
                            Err(_) => {
                                send_error(&mut stream, "invalid_frame");
                                return;
                            }
                        }

                        let digest = match request_digest(&req.request) {
                            Ok(value) => value,
                            Err(_) => {
                                send_error(&mut stream, "invalid_frame");
                                return;
                            }
                        };
                        let pending_job_id =
                            provisional_job_id(&current_welcome.client_id, &req.request.request_id);
                        let pending_receipt = ReceiptRecord {
                            job_id: pending_job_id,
                            client_id: current_welcome.client_id.clone(),
                            request_id: req.request.request_id.clone(),
                            state: JobState::Pending,
                            submitted_at: now_millis(),
                            receipt_payload: None,
                            request_digest: Some(digest),
                        };
                        if insert_job(db_conn, &pending_receipt).is_err() {
                            send_error(&mut stream, "invalid_frame");
                            return;
                        }

                        if let Some(upstream) = executor {
                            let req_bytes = match serde_json::to_vec(&req.request) {
                                Ok(b) => b,
                                Err(_) => {
                                    let _ = delete_job_by_request(
                                        db_conn,
                                        &current_welcome.client_id,
                                        &req.request.request_id,
                                    );
                                    send_error(&mut stream, "invalid_frame");
                                    return;
                                }
                            };
                            if let Err(err) = upstream.prepare() {
                                let _ = delete_job_by_request(
                                    db_conn,
                                    &current_welcome.client_id,
                                    &req.request.request_id,
                                );
                                let reply_val = serde_json::json!({
                                    "version": 1,
                                    "requestId": req.request.request_id,
                                    "method": "start",
                                    "success": false,
                                    "error": {
                                        "code": "runtime_unavailable",
                                        "message": format!("Upstream executor unavailable before dispatch: {err}")
                                    }
                                });
                                let _ = send_msg(
                                    &mut stream,
                                    &BrokerMessage::Response(BrokerResponse {
                                        version: 2,
                                        kind: "response".to_string(),
                                        sequence: req.sequence,
                                        reply: reply_val,
                                    }),
                                );
                                continue;
                            }
                            if transition_job_by_request(
                                db_conn,
                                &current_welcome.client_id,
                                &req.request.request_id,
                                JobState::Dispatched,
                            )
                            .is_err()
                            {
                                send_error(&mut stream, "invalid_frame");
                                return;
                            }
                            match upstream.execute_prepared(&req_bytes, Duration::from_secs(60)) {
                                Ok(reply_bytes) => {
                                    match serde_json::from_slice::<serde_json::Value>(&reply_bytes)
                                    {
                                        Ok(reply_val) => {
                                            if let Some(obj) = reply_val.as_object() {
                                                let echo_req_id =
                                                    obj.get("requestId").and_then(|v| v.as_str())
                                                        == Some(&req.request.request_id);
                                                let echo_method =
                                                    obj.get("method").and_then(|v| v.as_str())
                                                        == Some("start");
                                                let success =
                                                    obj.get("success").and_then(|v| v.as_bool());
                                                if !echo_req_id || !echo_method || success.is_none()
                                                {
                                                    let _ = transition_job_by_request(
                                                        db_conn,
                                                        &current_welcome.client_id,
                                                        &req.request.request_id,
                                                        JobState::OutcomeUnknown,
                                                    );
                                                    send_error(&mut stream, "invalid_frame");
                                                    return;
                                                }
                                                if success == Some(true) {
                                                    let run_id = obj
                                                        .get("data")
                                                        .and_then(|v| v.as_object())
                                                        .and_then(|v| v.get("runId"))
                                                        .and_then(|v| v.as_str());
                                                    let Some(run_id) = run_id
                                                        .filter(|id| valid_runtime_job_id(id))
                                                    else {
                                                        let _ = transition_job_by_request(
                                                            db_conn,
                                                            &current_welcome.client_id,
                                                            &req.request.request_id,
                                                            JobState::OutcomeUnknown,
                                                        );
                                                        send_error(&mut stream, "invalid_frame");
                                                        return;
                                                    };
                                                    if bind_dispatched_job(
                                                        db_conn,
                                                        &current_welcome.client_id,
                                                        &req.request.request_id,
                                                        run_id,
                                                    )
                                                    .is_err()
                                                    {
                                                        let _ = transition_job_by_request(
                                                            db_conn,
                                                            &current_welcome.client_id,
                                                            &req.request.request_id,
                                                            JobState::OutcomeUnknown,
                                                        );
                                                        send_error(&mut stream, "invalid_frame");
                                                        return;
                                                    }
                                                } else if transition_job_by_request(
                                                    db_conn,
                                                    &current_welcome.client_id,
                                                    &req.request.request_id,
                                                    JobState::Completed,
                                                )
                                                .is_err()
                                                {
                                                    send_error(&mut stream, "invalid_frame");
                                                    return;
                                                }

                                                let resp =
                                                    BrokerMessage::Response(BrokerResponse {
                                                        version: 2,
                                                        kind: "response".to_string(),
                                                        sequence: req.sequence,
                                                        reply: reply_val,
                                                    });
                                                if send_msg(&mut stream, &resp).is_err() {
                                                    return;
                                                }
                                            } else {
                                                let _ = transition_job_by_request(
                                                    db_conn,
                                                    &current_welcome.client_id,
                                                    &req.request.request_id,
                                                    JobState::OutcomeUnknown,
                                                );
                                                send_error(&mut stream, "invalid_frame");
                                                return;
                                            }
                                        }
                                        Err(_) => {
                                            let _ = transition_job_by_request(
                                                db_conn,
                                                &current_welcome.client_id,
                                                &req.request.request_id,
                                                JobState::OutcomeUnknown,
                                            );
                                            send_error(&mut stream, "invalid_frame");
                                            return;
                                        }
                                    }
                                }
                                Err(ExecutorError::BeforeDispatch(err_msg)) => {
                                    // The durable journal was already marked dispatched immediately
                                    // before the write. A write/flush failure may be partial, so the
                                    // external outcome is ambiguous even though the executor labels
                                    // transport setup failures as BeforeDispatch.
                                    let _ = transition_job_by_request(
                                        db_conn,
                                        &current_welcome.client_id,
                                        &req.request.request_id,
                                        JobState::OutcomeUnknown,
                                    );
                                    let reply_val = serde_json::json!({
                                        "version": 1,
                                        "requestId": req.request.request_id,
                                        "method": "start",
                                        "success": false,
                                        "error": {
                                            "code": "timeout",
                                            "message": format!("Upstream executor dispatch outcome is unknown: {err_msg}")
                                        }
                                    });
                                    let resp = BrokerMessage::Response(BrokerResponse {
                                        version: 2,
                                        kind: "response".to_string(),
                                        sequence: req.sequence,
                                        reply: reply_val,
                                    });
                                    if send_msg(&mut stream, &resp).is_err() {
                                        return;
                                    }
                                }
                                Err(ExecutorError::AfterDispatch(err_msg)) => {
                                    // Attempt OutcomeUnknown transition; on failure keep the same
                                    // outcome_unknown-conservative error reply below — never success.
                                    let _ = transition_job_by_request(
                                        db_conn,
                                        &current_welcome.client_id,
                                        &req.request.request_id,
                                        JobState::OutcomeUnknown,
                                    );
                                    let reply_val = serde_json::json!({
                                        "version": 1,
                                        "requestId": req.request.request_id,
                                        "method": "start",
                                        "success": false,
                                        "error": {
                                            "code": "timeout",
                                            "message": format!("Upstream executor communication lost after dispatch: {err_msg}")
                                        }
                                    });
                                    let resp = BrokerMessage::Response(BrokerResponse {
                                        version: 2,
                                        kind: "response".to_string(),
                                        sequence: req.sequence,
                                        reply: reply_val,
                                    });
                                    if send_msg(&mut stream, &resp).is_err() {
                                        return;
                                    }
                                }
                            }
                        } else {
                            // No executor exists, so dispatch is provably absent.
                            let _ = delete_job_by_request(
                                db_conn,
                                &current_welcome.client_id,
                                &req.request.request_id,
                            );
                            let reply_val = serde_json::json!({
                                "version": 1,
                                "requestId": req.request.request_id,
                                "method": "start",
                                "success": false,
                                "error": {
                                    "code": "runtime_unavailable",
                                    "message": "Broker host did not supply a native executor"
                                }
                            });
                            let resp = BrokerMessage::Response(BrokerResponse {
                                version: 2,
                                kind: "response".to_string(),
                                sequence: req.sequence,
                                reply: reply_val,
                            });
                            if send_msg(&mut stream, &resp).is_err() {
                                return;
                            }
                        }
                    }
                    RpcMethod::Negotiate | RpcMethod::Status | RpcMethod::Result => {
                        let method_str = match req.request.method {
                            RpcMethod::Negotiate => "negotiate",
                            RpcMethod::Status => "status",
                            RpcMethod::Result => "result",
                            _ => unreachable!(),
                        };
                        let owned_run_id = if matches!(
                            req.request.method,
                            RpcMethod::Status | RpcMethod::Result
                        ) {
                            let Some(run_id) = req
                                .request
                                .params
                                .get("runId")
                                .and_then(|v| v.as_str())
                                .filter(|id| valid_runtime_job_id(id))
                            else {
                                send_error(&mut stream, "invalid_frame");
                                return;
                            };
                            match owns_all_jobs(
                                db_conn,
                                &current_welcome.client_id,
                                &[run_id.to_string()],
                            ) {
                                Ok(true) => Some(run_id.to_string()),
                                Ok(false) => {
                                    send_error(&mut stream, "scope_denied");
                                    return;
                                }
                                Err(_) => {
                                    send_error(&mut stream, "invalid_frame");
                                    return;
                                }
                            }
                        } else {
                            None
                        };

                        if let Some(upstream) = executor {
                            let req_bytes = match serde_json::to_vec(&req.request) {
                                Ok(b) => b,
                                Err(_) => {
                                    send_error(&mut stream, "invalid_frame");
                                    return;
                                }
                            };
                            match upstream.execute(&req_bytes, Duration::from_secs(60)) {
                                Ok(reply_bytes) => {
                                    match serde_json::from_slice::<serde_json::Value>(&reply_bytes)
                                    {
                                        Ok(reply_val) => {
                                            if let Some(obj) = reply_val.as_object() {
                                                let echo_req_id =
                                                    obj.get("requestId").and_then(|v| v.as_str())
                                                        == Some(&req.request.request_id);
                                                let echo_method =
                                                    obj.get("method").and_then(|v| v.as_str())
                                                        == Some(method_str);
                                                let has_success = obj
                                                    .get("success")
                                                    .and_then(|v| v.as_bool())
                                                    .is_some();
                                                if echo_req_id && echo_method && has_success {
                                                    let success = obj
                                                        .get("success")
                                                        .and_then(|v| v.as_bool())
                                                        .unwrap_or(false);
                                                    if let Some(run_id) = owned_run_id.as_deref() {
                                                        let should_settle = match req.request.method {
                                                            RpcMethod::Status if success => obj
                                                                .get("data")
                                                                .and_then(|v| v.as_object())
                                                                .is_some_and(|data| {
                                                                    data.get("runId")
                                                                        .and_then(|v| v.as_str())
                                                                        == Some(run_id)
                                                                        && data
                                                                            .get("state")
                                                                            .and_then(|v| v.as_str())
                                                                            .is_some_and(terminal_runtime_state)
                                                                }),
                                                            RpcMethod::Result if success => true,
                                                            RpcMethod::Result => obj
                                                                .get("error")
                                                                .and_then(|v| v.as_object())
                                                                .and_then(|error| error.get("code"))
                                                                .and_then(|v| v.as_str())
                                                                .is_some_and(terminal_result_error),
                                                            _ => false,
                                                        };
                                                        if should_settle {
                                                            let _ = transition_job(
                                                                db_conn,
                                                                run_id,
                                                                JobState::Completed,
                                                            );
                                                        }
                                                    }
                                                    let resp =
                                                        BrokerMessage::Response(BrokerResponse {
                                                            version: 2,
                                                            kind: "response".to_string(),
                                                            sequence: req.sequence,
                                                            reply: reply_val,
                                                        });
                                                    if send_msg(&mut stream, &resp).is_err() {
                                                        return;
                                                    }
                                                } else {
                                                    send_error(&mut stream, "invalid_frame");
                                                    return;
                                                }
                                            } else {
                                                send_error(&mut stream, "invalid_frame");
                                                return;
                                            }
                                        }
                                        Err(_) => {
                                            send_error(&mut stream, "invalid_frame");
                                            return;
                                        }
                                    }
                                }
                                Err(ExecutorError::BeforeDispatch(err_msg)) => {
                                    let reply_val = serde_json::json!({
                                        "version": 1,
                                        "requestId": req.request.request_id,
                                        "method": method_str,
                                        "success": false,
                                        "error": {
                                            "code": "runtime_unavailable",
                                            "message": format!("Upstream executor dispatch failed: {err_msg}")
                                        }
                                    });
                                    let resp = BrokerMessage::Response(BrokerResponse {
                                        version: 2,
                                        kind: "response".to_string(),
                                        sequence: req.sequence,
                                        reply: reply_val,
                                    });
                                    if send_msg(&mut stream, &resp).is_err() {
                                        return;
                                    }
                                }
                                Err(ExecutorError::AfterDispatch(err_msg)) => {
                                    let reply_val = serde_json::json!({
                                        "version": 1,
                                        "requestId": req.request.request_id,
                                        "method": method_str,
                                        "success": false,
                                        "error": {
                                            "code": "timeout",
                                            "message": format!("Upstream executor communication lost after dispatch: {err_msg}")
                                        }
                                    });
                                    let resp = BrokerMessage::Response(BrokerResponse {
                                        version: 2,
                                        kind: "response".to_string(),
                                        sequence: req.sequence,
                                        reply: reply_val,
                                    });
                                    if send_msg(&mut stream, &resp).is_err() {
                                        return;
                                    }
                                }
                            }
                        } else {
                            // Executor socket absent: return well-formed runtime_unavailable reply
                            let reply_val = serde_json::json!({
                                "version": 1,
                                "requestId": req.request.request_id,
                                "method": method_str,
                                "success": false,
                                "error": {
                                    "code": "runtime_unavailable",
                                    "message": "Broker host did not supply a native executor"
                                }
                            });
                            let resp = BrokerMessage::Response(BrokerResponse {
                                version: 2,
                                kind: "response".to_string(),
                                sequence: req.sequence,
                                reply: reply_val,
                            });
                            if send_msg(&mut stream, &resp).is_err() {
                                return;
                            }
                        }
                    }
                }
            }

            _ => {
                send_error(&mut stream, "invalid_frame");
                return;
            }
        }
    }
}

fn handle_cancel_and_settle(
    stream: &mut UnixStream,
    req: &RuntimeRpcRequest,
    sequence: i64,
    client_id: &str,
    db_conn: &rusqlite::Connection,
    executor: Option<&ExecutorUpstream>,
) {
    let params_obj = match req.params.as_object() {
        Some(o) => o,
        None => {
            send_error(stream, "invalid_frame");
            return;
        }
    };

    let run_ids_arr = match params_obj.get("runIds").and_then(|v| v.as_array()) {
        Some(a) if !a.is_empty() && a.len() <= 64 => a,
        _ => {
            send_error(stream, "invalid_frame");
            return;
        }
    };
    let mut run_ids = Vec::with_capacity(run_ids_arr.len());
    for item in run_ids_arr {
        let Some(run_id) = item.as_str().filter(|id| valid_runtime_job_id(id)) else {
            send_error(stream, "invalid_frame");
            return;
        };
        if run_ids.iter().any(|existing| existing == run_id) {
            send_error(stream, "invalid_frame");
            return;
        }
        run_ids.push(run_id.to_string());
    }

    let settlement_window_ms = match params_obj
        .get("settlementWindowMs")
        .and_then(|v| v.as_u64())
    {
        Some(w) if (1..=10_000).contains(&w) => w,
        _ => {
            send_error(stream, "invalid_frame");
            return;
        }
    };

    match owns_all_jobs(db_conn, client_id, &run_ids) {
        Ok(true) => {}
        Ok(false) => {
            send_error(stream, "scope_denied");
            return;
        }
        Err(_) => {
            send_error(stream, "invalid_frame");
            return;
        }
    }

    match db_conn.execute(
        "INSERT INTO mutation_claims (client_id, request_id) VALUES (?1, ?2)",
        rusqlite::params![client_id, &req.request_id],
    ) {
        Ok(_) => {}
        Err(rusqlite::Error::SqliteFailure(e, _))
            if e.code == rusqlite::ErrorCode::ConstraintViolation =>
        {
            send_error(stream, "duplicate_mutation");
            return;
        }
        Err(_) => {
            send_error(stream, "invalid_frame");
            return;
        }
    }

    let Some(upstream) = executor else {
        let reply = serde_json::json!({
            "version": 1,
            "requestId": req.request_id,
            "method": "cancelAndSettle",
            "success": false,
            "error": {
                "code": "runtime_unavailable",
                "message": "Native executor not composed"
            }
        });
        let _ = send_msg(
            stream,
            &BrokerMessage::Response(BrokerResponse {
                version: 2,
                kind: "response".to_string(),
                sequence,
                reply,
            }),
        );
        return;
    };

    let req_bytes = match serde_json::to_vec(req) {
        Ok(bytes) => bytes,
        Err(_) => {
            send_error(stream, "invalid_frame");
            return;
        }
    };
    let timeout = Duration::from_millis(settlement_window_ms.saturating_add(5_000));
    let reply_val = match upstream.execute(&req_bytes, timeout) {
        Ok(bytes) => match serde_json::from_slice::<serde_json::Value>(&bytes) {
            Ok(value) => value,
            Err(_) => {
                mark_jobs_outcome_unknown(db_conn, &run_ids);
                send_error(stream, "invalid_frame");
                return;
            }
        },
        Err(ExecutorError::BeforeDispatch(message)) => serde_json::json!({
            "version": 1,
            "requestId": req.request_id,
            "method": "cancelAndSettle",
            "success": false,
            "error": {
                "code": "runtime_unavailable",
                "message": format!("Upstream executor dispatch failed: {message}")
            }
        }),
        Err(ExecutorError::AfterDispatch(message)) => {
            mark_jobs_outcome_unknown(db_conn, &run_ids);
            serde_json::json!({
                "version": 1,
                "requestId": req.request_id,
                "method": "cancelAndSettle",
                "success": false,
                "error": {
                    "code": "timeout",
                    "message": format!("Upstream executor communication lost after dispatch: {message}")
                }
            })
        }
    };

    let valid = reply_val.as_object().is_some_and(|obj| {
        obj.get("requestId").and_then(|v| v.as_str()) == Some(&req.request_id)
            && obj.get("method").and_then(|v| v.as_str()) == Some("cancelAndSettle")
            && obj.get("success").and_then(|v| v.as_bool()).is_some()
    });
    if !valid {
        mark_jobs_outcome_unknown(db_conn, &run_ids);
        send_error(stream, "invalid_frame");
        return;
    }

    if reply_val
        .as_object()
        .and_then(|obj| obj.get("success"))
        .and_then(|v| v.as_bool())
        == Some(true)
    {
        if let Some(settlements) = reply_val
            .as_object()
            .and_then(|obj| obj.get("data"))
            .and_then(|v| v.as_object())
            .and_then(|data| data.get("settlements"))
            .and_then(|v| v.as_array())
        {
            for settlement in settlements {
                let Some(item) = settlement.as_object() else {
                    continue;
                };
                let Some(run_id) = item.get("runId").and_then(|v| v.as_str()) else {
                    continue;
                };
                let Some(state) = item.get("state").and_then(|v| v.as_str()) else {
                    continue;
                };
                if run_ids.iter().any(|owned| owned == run_id) && terminal_runtime_state(state) {
                    let _ = transition_job(db_conn, run_id, JobState::Completed);
                }
            }
        }
    }

    let _ = send_msg(
        stream,
        &BrokerMessage::Response(BrokerResponse {
            version: 2,
            kind: "response".to_string(),
            sequence,
            reply: reply_val,
        }),
    );
}

fn main() {
    let args = match parse_args() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("Error: {e}");
            std::process::exit(1);
        }
    };

    let conn = match open_durable(&args.db_path) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("Failed to open DB at {:?}: {e}", args.db_path);
            std::process::exit(1);
        }
    };

    if let Err(e) = recover_incomplete_jobs(&conn) {
        eprintln!("Failed to recover incomplete job receipts: {e}");
        std::process::exit(1);
    }

    if let Err(e) = conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS mutation_claims (
            client_id  TEXT NOT NULL,
            request_id TEXT NOT NULL,
            PRIMARY KEY (client_id, request_id)
        );",
    ) {
        eprintln!("Failed to initialize mutation_claims table: {e}");
        std::process::exit(1);
    }

    let auth = BrokerAuth::new();

    if let Err(e) = remove_stale_socket(&args.socket_path) {
        eprintln!("Failed removing stale socket {:?}: {e}", args.socket_path);
        std::process::exit(1);
    }

    let listener = match UnixListener::bind(&args.socket_path) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("Failed to bind socket {:?}: {e}", args.socket_path);
            std::process::exit(1);
        }
    };

    if let Err(e) = fs::set_permissions(&args.socket_path, fs::Permissions::from_mode(0o600)) {
        eprintln!(
            "Failed to set permissions 0600 on socket {:?}: {e}",
            args.socket_path
        );
        std::process::exit(1);
    }

    static TERM: AtomicBool = AtomicBool::new(false);
    extern "C" fn sig_handler(_: libc::c_int) {
        TERM.store(true, Ordering::SeqCst);
    }
    unsafe {
        libc::signal(libc::SIGTERM, sig_handler as libc::sighandler_t);
        libc::signal(libc::SIGINT, sig_handler as libc::sighandler_t);
    }

    if let Err(e) = listener.set_nonblocking(true) {
        eprintln!("Failed to set listener nonblocking: {e}");
        std::process::exit(1);
    }

    println!(
        "ready project={} socket={}",
        args.project_id,
        args.socket_path.display()
    );

    let conn = Arc::new(std::sync::Mutex::new(conn));
    let executor_upstream = match (args.executor_socket, args.executor_token_file) {
        (Some(sock), Some(tok)) => Some(ExecutorUpstream::with_token_file(sock, tok)),
        (Some(sock), None) => Some(ExecutorUpstream::new(sock)),
        _ => None,
    };

    while !TERM.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok((stream, _)) => {
                let _ = stream.set_nonblocking(false);
                let conn_guard = conn.lock().unwrap();
                handle_connection(
                    stream,
                    &args.project_id,
                    &auth,
                    &conn_guard,
                    executor_upstream.as_ref(),
                );
            }
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {
                continue;
            }
            Err(e) => {
                eprintln!("Accept error: {e}");
                break;
            }
        }
    }

    let _ = fs::remove_file(&args.socket_path);
    std::process::exit(0);
}
