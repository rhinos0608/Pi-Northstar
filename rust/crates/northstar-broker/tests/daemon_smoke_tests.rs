use std::fs;
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::time::Duration;

use tempfile::tempdir;

fn fixture_dir() -> PathBuf {
    let manifest = env!("CARGO_MANIFEST_DIR");
    Path::new(manifest).join("../../../test/fixtures/rpc-golden")
}

fn bin_path() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_northstar-broker"))
}

struct BrokerChild {
    child: Child,
    _temp: tempfile::TempDir,
    socket_path: PathBuf,
}

impl Drop for BrokerChild {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn spawn_broker(project_id: &str) -> (BrokerChild, UnixStream) {
    let temp = tempdir().unwrap();
    let socket_path = temp.path().join("test-broker.sock");
    let db_path = temp.path().join("test-broker.db");

    let bin = bin_path();
    let child = Command::new(&bin)
        .arg("--project-id")
        .arg(project_id)
        .arg("--socket")
        .arg(&socket_path)
        .arg("--db")
        .arg(&db_path)
        .spawn()
        .expect("failed to spawn northstar-broker");

    // Poll until socket is bound and ready to accept
    let mut stream = None;
    for _ in 0..50 {
        if let Ok(s) = UnixStream::connect(&socket_path) {
            stream = Some(s);
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }

    let stream = stream.expect("failed to connect to broker socket");
    (
        BrokerChild {
            child,
            _temp: temp,
            socket_path,
        },
        stream,
    )
}

fn read_exact_frame(stream: &mut UnixStream) -> Vec<u8> {
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let mut len_buf = [0u8; 4];
    stream.read_exact(&mut len_buf).expect("failed to read frame len");
    let len = u32::from_be_bytes(len_buf) as usize;
    let mut body = vec![0u8; len];
    stream.read_exact(&mut body).expect("failed to read frame body");

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
fn test_daemon_smoke_lifecycle() {
    let project_id = "golden-project";
    let (mut broker, mut stream) = spawn_broker(project_id);

    // 1. Send golden broker-v2-hello.json -> expect welcome
    let hello_path = fixture_dir().join("broker-v2-hello.json");
    let hello_bytes = fs::read(&hello_path).expect("broker-v2-hello.json fixture");
    send_raw_frame(&mut stream, &hello_bytes);

    let welcome_frame = read_exact_frame(&mut stream);
    let welcome_val: serde_json::Value =
        serde_json::from_slice(&welcome_frame[4..]).expect("welcome json parse");
    assert_eq!(welcome_val["version"], 2);
    assert_eq!(welcome_val["kind"], "welcome");
    assert_eq!(welcome_val["projectId"], project_id);
    assert_eq!(welcome_val["clientId"], "golden-client");
    let token = welcome_val["token"].as_str().expect("token str").to_string();
    let epoch = welcome_val["epoch"].as_str().expect("epoch str").to_string();
    let session_id = welcome_val["sessionId"].as_str().expect("sessionId str").to_string();

    // 2. Query unknown receipt -> queryResponse without receipt
    let query_msg = serde_json::json!({
        "version": 2,
        "kind": "query",
        "token": token,
        "epoch": epoch,
        "sessionId": session_id,
        "sequence": 1,
        "projectId": project_id,
        "query": {
            "method": "submissionReceipt",
            "requestId": "unknown-req-999"
        }
    });
    let query_bytes = serde_json::to_vec(&query_msg).unwrap();
    send_raw_frame(&mut stream, &query_bytes);

    let query_resp_frame = read_exact_frame(&mut stream);
    let query_resp_val: serde_json::Value =
        serde_json::from_slice(&query_resp_frame[4..]).expect("queryResponse json parse");
    assert_eq!(query_resp_val["version"], 2);
    assert_eq!(query_resp_val["kind"], "queryResponse");
    assert_eq!(query_resp_val["sequence"], 1);
    assert!(query_resp_val.get("receipt").is_none());

    // 3. cancel with duplicate runIds -> error frame (invalid_frame)
    let cancel_dup = serde_json::json!({
        "version": 2,
        "kind": "request",
        "token": token,
        "epoch": epoch,
        "sessionId": session_id,
        "sequence": 2,
        "projectId": project_id,
        "request": {
            "version": 1,
            "requestId": "cancel-dup-req",
            "method": "cancelAndSettle",
            "params": {
                "runIds": ["runtime_dup1", "runtime_dup1"],
                "settlementWindowMs": 1000
            }
        }
    });
    send_raw_frame(&mut stream, &serde_json::to_vec(&cancel_dup).unwrap());
    let err_frame = read_exact_frame(&mut stream);
    let err_val: serde_json::Value = serde_json::from_slice(&err_frame[4..]).unwrap();
    assert_eq!(err_val["kind"], "error");
    assert_eq!(err_val["code"], "invalid_frame");

    // Close old stream because error closes connection
    drop(stream);

    // 4. Reconnect and handshake fresh session for unknown run cancellation
    let mut stream2 = UnixStream::connect(&broker.socket_path).unwrap();
    send_raw_frame(&mut stream2, &hello_bytes);
    let w2_frame = read_exact_frame(&mut stream2);
    let w2_val: serde_json::Value = serde_json::from_slice(&w2_frame[4..]).unwrap();
    let token2 = w2_val["token"].as_str().unwrap();
    let epoch2 = w2_val["epoch"].as_str().unwrap();
    let session2 = w2_val["sessionId"].as_str().unwrap();

    // 5. cancel unknown run -> response success with empty settled
    let cancel_unknown = serde_json::json!({
        "version": 2,
        "kind": "request",
        "token": token2,
        "epoch": epoch2,
        "sessionId": session2,
        "sequence": 1,
        "projectId": project_id,
        "request": {
            "version": 1,
            "requestId": "cancel-unknown-req",
            "method": "cancelAndSettle",
            "params": {
                "runIds": ["runtime_unknown_0001"],
                "settlementWindowMs": 1000
            }
        }
    });
    send_raw_frame(&mut stream2, &serde_json::to_vec(&cancel_unknown).unwrap());
    let resp_frame = read_exact_frame(&mut stream2);
    let resp_val: serde_json::Value = serde_json::from_slice(&resp_frame[4..]).unwrap();
    assert_eq!(resp_val["version"], 2);
    assert_eq!(resp_val["kind"], "response");
    assert_eq!(resp_val["sequence"], 1);
    assert_eq!(resp_val["reply"]["success"], true);
    assert_eq!(resp_val["reply"]["method"], "cancelAndSettle");
    assert_eq!(resp_val["reply"]["data"]["settledRunIds"], serde_json::json!([]));
    assert_eq!(resp_val["reply"]["data"]["timedOutRunIds"], serde_json::json!([]));

    drop(stream2);

    // 6. send v1 hello (version:1) on new connection -> expect error/close
    let mut stream3 = UnixStream::connect(&broker.socket_path).unwrap();
    let v1_hello = serde_json::json!({
        "version": 1,
        "kind": "hello",
        "clientId": "golden-client",
        "projectId": project_id,
        "requestedCapabilities": []
    });
    send_raw_frame(&mut stream3, &serde_json::to_vec(&v1_hello).unwrap());
    let err_frame2 = read_exact_frame(&mut stream3);
    let err_val2: serde_json::Value = serde_json::from_slice(&err_frame2[4..]).unwrap();
    assert_eq!(err_val2["kind"], "error");
    // decode_frame rejects version != 2 with FrameError::InvalidFrame -> sends invalid_frame or unsupported_version
    assert!(err_val2["code"] == "invalid_frame" || err_val2["code"] == "unsupported_version");

    // Verify stream3 closes / EOF
    let mut eof_buf = [0u8; 1];
    let n = stream3.read(&mut eof_buf).unwrap_or(0);
    assert_eq!(n, 0, "stream should be closed after error");
    drop(stream3);

    // 7. SIGTERM the child -> exits 0
    let pid = broker.child.id() as libc::pid_t;
    unsafe {
        libc::kill(pid, libc::SIGTERM);
    }
    let status = broker.child.wait().expect("child exit");
    assert!(status.success(), "broker did not exit 0 on SIGTERM");
}
