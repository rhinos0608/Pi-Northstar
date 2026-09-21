use std::io::{Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use northstar_broker::executor::{ExecutorError, ExecutorUpstream};
use tempfile::tempdir;

fn bin_path() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_northstar-broker"))
}

struct BrokerChild {
    child: Child,
    _temp: tempfile::TempDir,
}

impl Drop for BrokerChild {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn read_exact_frame(stream: &mut UnixStream) -> Vec<u8> {
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let mut len_buf = [0u8; 4];
    stream
        .read_exact(&mut len_buf)
        .expect("failed to read frame len");
    let len = u32::from_be_bytes(len_buf) as usize;
    let mut body = vec![0u8; len];
    stream
        .read_exact(&mut body)
        .expect("failed to read frame body");

    let mut frame = Vec::with_capacity(4 + len);
    frame.extend_from_slice(&len_buf);
    frame.extend_from_slice(&body);
    frame
}

fn send_raw_frame(stream: &mut UnixStream, json_bytes: &[u8]) {
    let len = json_bytes.len() as u32;
    stream.write_all(&len.to_be_bytes()).unwrap();
    stream.write_all(json_bytes).unwrap();
    stream.flush().unwrap();
}

#[test]
fn test_executor_connect_nonexistent_socket() {
    let temp = tempdir().unwrap();
    let non_existent = temp.path().join("does-not-exist.sock");
    let upstream = ExecutorUpstream::new(&non_existent);

    let res = upstream.execute(b"{}", Duration::from_secs(1));
    assert!(
        matches!(res, Err(ExecutorError::BeforeDispatch(_))),
        "connecting to nonexistent socket must return BeforeDispatch error"
    );
}

#[test]
fn test_executor_same_uid_attestation_passes_and_roundtrips() {
    let temp = tempdir().unwrap();
    let sock_path = temp.path().join("stub_upstream.sock");
    let listener = UnixListener::bind(&sock_path).unwrap();

    let stop = Arc::new(AtomicBool::new(false));
    let stop_clone = Arc::clone(&stop);

    let handle = thread::spawn(move || {
        listener.set_nonblocking(true).unwrap();
        let mut client_stream = None;
        for _ in 0..100 {
            if stop_clone.load(Ordering::SeqCst) {
                return;
            }
            if let Ok((s, _)) = listener.accept() {
                client_stream = Some(s);
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }

        if let Some(mut stream) = client_stream {
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();

            for _ in 0..2 {
                let mut len_buf = [0u8; 4];
                if stream.read_exact(&mut len_buf).is_err() {
                    break;
                }
                let len = u32::from_be_bytes(len_buf) as usize;
                let mut body = vec![0u8; len];
                if stream.read_exact(&mut body).is_err() {
                    break;
                }
                let reply = b"{\"success\":true}";
                let reply_len = reply.len() as u32;
                let _ = stream.write_all(&reply_len.to_be_bytes());
                let _ = stream.write_all(reply);
                let _ = stream.flush();
            }
        }
    });

    let upstream = ExecutorUpstream::new(&sock_path);
    let first = upstream
        .execute(b"{\"hello\":1}", Duration::from_secs(2))
        .unwrap();
    let second = upstream
        .execute(b"{\"hello\":2}", Duration::from_secs(2))
        .unwrap();
    assert_eq!(first, b"{\"success\":true}");
    assert_eq!(second, b"{\"success\":true}");

    stop.store(true, Ordering::SeqCst);
    let _ = handle.join();
}

#[test]
fn test_executor_stub_reads_then_drops_yields_after_dispatch() {
    let temp = tempdir().unwrap();
    let sock_path = temp.path().join("stub_drop.sock");
    let listener = UnixListener::bind(&sock_path).unwrap();

    let handle = thread::spawn(move || {
        if let Ok((mut stream, _)) = listener.accept() {
            let mut len_buf = [0u8; 4];
            if stream.read_exact(&mut len_buf).is_ok() {
                let len = u32::from_be_bytes(len_buf) as usize;
                let mut body = vec![0u8; len];
                let _ = stream.read_exact(&mut body);
            }
            // Drop stream immediately without sending reply
            drop(stream);
        }
    });

    let upstream = ExecutorUpstream::new(&sock_path);
    let res = upstream.execute(b"{\"test\":true}", Duration::from_millis(500));
    assert!(
        matches!(res, Err(ExecutorError::AfterDispatch(_))),
        "reading dropped stream after write must yield AfterDispatch error"
    );

    let _ = handle.join();
}

#[test]
fn test_executor_stub_dead_listener_yields_before_dispatch() {
    let temp = tempdir().unwrap();
    let sock_path = temp.path().join("dead.sock");
    // NOTE: do NOT bind+drop a listener here. On macOS the socket teardown
    // after drop races a subsequent connect (connect can transiently succeed
    // against the dying socket, yielding AfterDispatch instead of
    // BeforeDispatch). A regular file models the same observable state —
    // path present, nobody listening — with zero kernel timing dependence.
    std::fs::write(&sock_path, b"not a socket").unwrap();

    let upstream = ExecutorUpstream::new(&sock_path);
    let res = upstream.execute(b"{}", Duration::from_secs(1));
    match res {
        Err(ExecutorError::BeforeDispatch(_)) => (),
        other => panic!("expected BeforeDispatch, got: {:?}", other),
    }
}

#[test]
fn test_broker_forwarding_lifecycle_with_executor_socket() {
    let temp = tempdir().unwrap();
    let broker_sock = temp.path().join("broker.sock");
    let db_path = temp.path().join("broker.db");
    let executor_sock = temp.path().join("executor.sock");

    // Spawn stub executor upstream listener
    let exec_listener = UnixListener::bind(&executor_sock).unwrap();
    let stop = Arc::new(AtomicBool::new(false));
    let stop_clone = Arc::clone(&stop);

    let exec_handle = thread::spawn(move || {
        exec_listener.set_nonblocking(true).unwrap();
        while !stop_clone.load(Ordering::SeqCst) {
            match exec_listener.accept() {
                Ok((mut stream, _)) => {
                    stream.set_nonblocking(false).unwrap();
                    stream
                        .set_read_timeout(Some(Duration::from_secs(3)))
                        .unwrap();
                    let mut len_buf = [0u8; 4];
                    if stream.read_exact(&mut len_buf).is_ok() {
                        let len = u32::from_be_bytes(len_buf) as usize;
                        let mut body = vec![0u8; len];
                        if stream.read_exact(&mut body).is_ok() {
                            let req_val: serde_json::Value =
                                serde_json::from_slice(&body).expect("parse req from broker");
                            let req_id = req_val["requestId"].as_str().unwrap_or("unknown");
                            let method = req_val["method"].as_str().unwrap_or("unknown");

                            let reply_val = serde_json::json!({
                                "version": 1,
                                "requestId": req_id,
                                "method": method,
                                "success": true,
                                "data": {
                                    "executed": true,
                                    "runId": "runtime_123"
                                }
                            });
                            let reply_bytes = serde_json::to_vec(&reply_val).unwrap();
                            let reply_len = reply_bytes.len() as u32;
                            let _ = stream.write_all(&reply_len.to_be_bytes());
                            let _ = stream.write_all(&reply_bytes);
                            let _ = stream.flush();
                        }
                    }
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(10));
                }
                Err(_) => break,
            }
        }
    });

    let project_id = "test-project";
    let bin = bin_path();
    let child = Command::new(&bin)
        .arg("--project-id")
        .arg(project_id)
        .arg("--socket")
        .arg(&broker_sock)
        .arg("--db")
        .arg(&db_path)
        .arg("--executor-socket")
        .arg(&executor_sock)
        .spawn()
        .expect("spawn broker with executor socket");

    let mut broker = BrokerChild { child, _temp: temp };

    let mut stream = None;
    for _ in 0..50 {
        if let Ok(s) = UnixStream::connect(&broker_sock) {
            stream = Some(s);
            break;
        }
        thread::sleep(Duration::from_millis(20));
    }
    let mut stream = stream.expect("connected to broker");

    // 1. Handshake
    let hello = serde_json::json!({
        "version": 2,
        "kind": "hello",
        "clientId": "client-1",
        "projectId": project_id,
        "requestedCapabilities": ["runtime:negotiate", "runtime:start", "runtime:status", "runtime:result", "runtime:cancel"]
    });
    send_raw_frame(&mut stream, &serde_json::to_vec(&hello).unwrap());
    let welcome_frame = read_exact_frame(&mut stream);
    let welcome: serde_json::Value = serde_json::from_slice(&welcome_frame[4..]).unwrap();
    assert_eq!(welcome["kind"], "welcome");
    let token = welcome["token"].as_str().unwrap().to_string();
    let epoch = welcome["epoch"].as_str().unwrap().to_string();
    let session_id = welcome["sessionId"].as_str().unwrap().to_string();

    // 2. Send Start request -> forwarded to executor -> returns reply
    let start_req = serde_json::json!({
        "version": 2,
        "kind": "request",
        "token": token,
        "epoch": epoch,
        "sessionId": session_id,
        "sequence": 1,
        "projectId": project_id,
        "request": {
            "version": 1,
            "requestId": "start-req-1",
            "method": "start",
            "params": {
                "modelId": "test/model",
                "prompt": "test prompt"
            }
        }
    });
    send_raw_frame(&mut stream, &serde_json::to_vec(&start_req).unwrap());
    let resp_frame = read_exact_frame(&mut stream);
    let resp: serde_json::Value = serde_json::from_slice(&resp_frame[4..]).unwrap();
    assert_eq!(resp["version"], 2);
    assert_eq!(resp["kind"], "response");
    assert_eq!(resp["sequence"], 1);
    assert_eq!(resp["reply"]["requestId"], "start-req-1");
    assert_eq!(resp["reply"]["method"], "start");
    assert_eq!(resp["reply"]["success"], true);
    assert_eq!(resp["reply"]["data"]["executed"], true);

    // 3. Receipt exists and is bound to the runtime-issued run id.
    let receipt_query = serde_json::json!({
        "version": 2,
        "kind": "query",
        "token": token,
        "epoch": epoch,
        "sessionId": session_id,
        "sequence": 2,
        "projectId": project_id,
        "query": { "method": "submissionReceipt", "requestId": "start-req-1" }
    });
    send_raw_frame(&mut stream, &serde_json::to_vec(&receipt_query).unwrap());
    let receipt_frame = read_exact_frame(&mut stream);
    let receipt: serde_json::Value = serde_json::from_slice(&receipt_frame[4..]).unwrap();
    assert_eq!(receipt["kind"], "queryResponse");
    assert_eq!(receipt["receipt"]["jobId"], "runtime_123");

    // 4. Send duplicate start request -> duplicate_mutation
    let dup_req = serde_json::json!({
        "version": 2,
        "kind": "request",
        "token": token,
        "epoch": epoch,
        "sessionId": session_id,
        "sequence": 3,
        "projectId": project_id,
        "request": {
            "version": 1,
            "requestId": "start-req-1",
            "method": "start",
            "params": {}
        }
    });
    send_raw_frame(&mut stream, &serde_json::to_vec(&dup_req).unwrap());
    let err_frame = read_exact_frame(&mut stream);
    let err: serde_json::Value = serde_json::from_slice(&err_frame[4..]).unwrap();
    assert_eq!(err["kind"], "error");
    assert_eq!(err["code"], "duplicate_mutation");

    // Clean up
    drop(stream);
    let _ = broker.child.kill();
    let _ = broker.child.wait();

    stop.store(true, Ordering::SeqCst);
    let _ = exec_handle.join();
}
