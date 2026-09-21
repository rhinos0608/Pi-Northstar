use serde_json;
use crate::protocol::BrokerMessage;

pub const BROKER_MAX_FRAME_BYTES: usize = 256 * 1024;
pub const BROKER_PROTOCOL_VERSION: u32 = 2;

#[derive(Debug)]
pub enum FrameError {
    TooLarge,
    InvalidFrame,
    Utf8Error,
}

impl std::fmt::Display for FrameError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FrameError::TooLarge => write!(f, "frame_too_large"),
            FrameError::InvalidFrame => write!(f, "invalid_frame"),
            FrameError::Utf8Error => write!(f, "invalid_utf8"),
        }
    }
}
impl std::error::Error for FrameError {}

/// Encode a BrokerMessage into a length-prefixed frame (4-byte big-endian length + JSON body).
pub fn encode_frame(message: &BrokerMessage) -> Result<Vec<u8>, FrameError> {
    let body = serde_json::to_vec(message).map_err(|_| FrameError::InvalidFrame)?;
    if body.len() > BROKER_MAX_FRAME_BYTES {
        return Err(FrameError::TooLarge);
    }
    let len = body.len() as u32;
    let mut frame = Vec::with_capacity(4 + body.len());
    frame.extend_from_slice(&len.to_be_bytes());
    frame.extend_from_slice(&body);
    Ok(frame)
}

/// Validate that a decoded message has version == 2 and exact literal kind per variant.
fn validate_message(message: &BrokerMessage) -> Result<(), FrameError> {
    let (version, kind, expected_kind) = match message {
        BrokerMessage::Hello(h) => (h.version, h.kind.as_str(), "hello"),
        BrokerMessage::Welcome(w) => (w.version, w.kind.as_str(), "welcome"),
        BrokerMessage::Request(r) => (r.version, r.kind.as_str(), "request"),
        BrokerMessage::Query(q) => (q.version, q.kind.as_str(), "query"),
        BrokerMessage::Response(r) => (r.version, r.kind.as_str(), "response"),
        BrokerMessage::QueryResponse(qr) => (qr.version, qr.kind.as_str(), "queryResponse"),
        BrokerMessage::Error(e) => (e.version, e.kind.as_str(), "error"),
    };

    if version == BROKER_PROTOCOL_VERSION && kind == expected_kind {
        Ok(())
    } else {
        Err(FrameError::InvalidFrame)
    }
}

/// Decode a length-prefixed frame into a BrokerMessage.
pub fn decode_frame(frame: &[u8]) -> Result<BrokerMessage, FrameError> {
    if frame.len() < 4 {
        return Err(FrameError::InvalidFrame);
    }
    let size = u32::from_be_bytes(frame[..4].try_into().unwrap()) as usize;
    if size > BROKER_MAX_FRAME_BYTES {
        return Err(FrameError::TooLarge);
    }
    if frame.len() != size + 4 {
        return Err(FrameError::InvalidFrame);
    }
    let body = std::str::from_utf8(&frame[4..]).map_err(|_| FrameError::Utf8Error)?;
    let msg: BrokerMessage = serde_json::from_str(body).map_err(|_| FrameError::InvalidFrame)?;
    validate_message(&msg)?;
    Ok(msg)
}
