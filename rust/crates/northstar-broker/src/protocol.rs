use serde::{Deserialize, Serialize};

pub const BROKER_PROTOCOL_VERSION: u32 = 2;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BrokerCapability {
    #[serde(rename = "runtime:negotiate")]
    RuntimeNegotiate,
    #[serde(rename = "runtime:start")]
    RuntimeStart,
    #[serde(rename = "runtime:status")]
    RuntimeStatus,
    #[serde(rename = "runtime:result")]
    RuntimeResult,
    #[serde(rename = "runtime:cancel")]
    RuntimeCancel,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BrokerHello {
    pub version: u32,
    pub kind: String, // must be "hello"
    #[serde(rename = "clientId")]
    pub client_id: String,
    #[serde(rename = "projectId")]
    pub project_id: String,
    #[serde(rename = "requestedCapabilities")]
    pub requested_capabilities: Vec<BrokerCapability>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BrokerWelcome {
    pub version: u32,
    pub kind: String, // must be "welcome"
    pub epoch: String,
    #[serde(rename = "clientId")]
    pub client_id: String,
    #[serde(rename = "sessionId")]
    pub session_id: String,
    pub token: String,
    #[serde(rename = "expiresAt")]
    pub expires_at: u64,
    pub capabilities: Vec<BrokerCapability>,
    #[serde(rename = "projectId")]
    pub project_id: String,
}

// Known RPC methods
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RpcMethod {
    Negotiate,
    Start,
    Status,
    Result,
    #[serde(rename = "cancelAndSettle")]
    CancelAndSettle,
}

// Inner RPC request (version 1 runtime protocol)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeRpcRequest {
    pub version: u32,
    #[serde(rename = "requestId")]
    pub request_id: String,
    pub method: RpcMethod,
    pub params: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BrokerRequest {
    pub version: u32,
    pub kind: String, // must be "request"
    pub token: String,
    pub epoch: String,
    #[serde(rename = "sessionId")]
    pub session_id: String,
    pub sequence: i64,
    #[serde(rename = "projectId")]
    pub project_id: String,
    pub request: RuntimeRpcRequest,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SubmissionReceiptQuery {
    pub method: String,
    #[serde(rename = "requestId")]
    pub request_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BrokerQuery {
    pub version: u32,
    pub kind: String, // must be "query"
    pub token: String,
    pub epoch: String,
    #[serde(rename = "sessionId")]
    pub session_id: String,
    pub sequence: i64,
    #[serde(rename = "projectId")]
    pub project_id: String,
    pub query: SubmissionReceiptQuery,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BrokerResponse {
    pub version: u32,
    pub kind: String, // must be "response"
    pub sequence: i64,
    pub reply: serde_json::Value, // opaque runtime reply
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct JobSubmissionReceipt {
    #[serde(rename = "jobId")]
    pub job_id: String,
    #[serde(rename = "clientId")]
    pub client_id: String,
    #[serde(rename = "requestId")]
    pub request_id: String,
    #[serde(rename = "submittedAt")]
    pub submitted_at: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BrokerQueryResponse {
    pub version: u32,
    pub kind: String, // must be "queryResponse"
    pub sequence: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub receipt: Option<JobSubmissionReceipt>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BrokerErrorMessage {
    pub version: u32,
    pub kind: String, // must be "error"
    pub code: String,
}

// Untagged enum: each variant has its own `kind` field.
// Order matters for untagged: more specific shapes first.
// Note: `version` (must be 2) and literal `kind` strings are validated post-decode
// in `crate::frame::decode_frame`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum BrokerMessage {
    Hello(BrokerHello),
    Welcome(BrokerWelcome),
    Request(BrokerRequest),
    Query(BrokerQuery),
    Response(BrokerResponse),
    QueryResponse(BrokerQueryResponse),
    Error(BrokerErrorMessage),
}
