//! Integration tests: boot the real tonic server on an ephemeral port and
//! call it with the generated client — the Rust mirror of the backend's
//! `test/integration` suite (real transport, no mocks).

use std::time::{SystemTime, UNIX_EPOCH};

use signing::config::Config;
use signing::grpc::signing::SigningServiceImpl;
use signing::pb::signing_service_client::SigningServiceClient;
use signing::pb::signing_service_server::SigningServiceServer;
use signing::pb::{ComputeSignatureRequest, VerifySignatureRequest};
use tokio_stream::wrappers::TcpListenerStream;
use tonic::transport::Channel;

const KEY_ID: &str = "svc-test";
const SECRET: &str = "test-secret-material-for-hmac-vector";
const METHOD: &str = "POST";
const PATH: &str = "/api/v1/track/secure";
const NONCE: &str = "7f9c24e5-1c4b-4c8a-9d3e-2f6a8b1c0d5e";
const BODY: &str = r#"{"events":[{"eventName":"button_click"}]}"#;

/// Spawns the server on 127.0.0.1:0 and returns a connected client.
async fn spawn_server() -> SigningServiceClient<Channel> {
    let config = Config::parse(&format!(r#"{{"{KEY_ID}":"{SECRET}"}}"#), None).unwrap();
    let service = SigningServiceImpl::new(&config);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    tokio::spawn(async move {
        tonic::transport::Server::builder()
            .add_service(SigningServiceServer::new(service))
            .serve_with_incoming(TcpListenerStream::new(listener))
            .await
            .unwrap();
    });

    SigningServiceClient::connect(format!("http://{addr}"))
        .await
        .expect("client connects to the spawned server")
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

fn compute_req(key_id: &str, timestamp: i64) -> ComputeSignatureRequest {
    ComputeSignatureRequest {
        method: METHOD.into(),
        path: PATH.into(),
        timestamp,
        nonce: NONCE.into(),
        body: BODY.as_bytes().to_vec(),
        key_id: key_id.into(),
    }
}

fn verify_req(key_id: &str, timestamp: i64, signature: &str) -> VerifySignatureRequest {
    VerifySignatureRequest {
        method: METHOD.into(),
        path: PATH.into(),
        timestamp,
        nonce: NONCE.into(),
        body: BODY.as_bytes().to_vec(),
        key_id: key_id.into(),
        signature: signature.into(),
    }
}

#[tokio::test]
async fn compute_then_verify_round_trips_a_valid_signature() {
    let mut client = spawn_server().await;
    let now = now_secs();

    let sig = client
        .compute_signature(compute_req(KEY_ID, now))
        .await
        .unwrap()
        .into_inner()
        .signature;
    assert_eq!(sig.len(), 64, "hex-encoded HMAC-SHA256");

    let resp = client
        .verify_signature(verify_req(KEY_ID, now, &sig))
        .await
        .unwrap()
        .into_inner();
    assert!(resp.valid);
    assert_eq!(resp.reason, "OK");
}

#[tokio::test]
async fn verify_rejects_a_bad_signature() {
    let mut client = spawn_server().await;
    let now = now_secs();

    let resp = client
        .verify_signature(verify_req(KEY_ID, now, &"0".repeat(64)))
        .await
        .unwrap()
        .into_inner();
    assert!(!resp.valid);
    assert_eq!(resp.reason, "SIGNATURE_INVALID");
}

#[tokio::test]
async fn verify_rejects_an_expired_timestamp() {
    let mut client = spawn_server().await;
    let stale = now_secs() - 301;

    let sig = client
        .compute_signature(compute_req(KEY_ID, stale))
        .await
        .unwrap()
        .into_inner()
        .signature;
    let resp = client
        .verify_signature(verify_req(KEY_ID, stale, &sig))
        .await
        .unwrap()
        .into_inner();
    assert!(!resp.valid);
    assert_eq!(resp.reason, "SIGNATURE_EXPIRED");
}

#[tokio::test]
async fn verify_reports_an_unknown_key() {
    let mut client = spawn_server().await;

    let resp = client
        .verify_signature(verify_req("nope", now_secs(), &"0".repeat(64)))
        .await
        .unwrap()
        .into_inner();
    assert!(!resp.valid);
    assert_eq!(resp.reason, "API_KEY_UNKNOWN");
}

#[tokio::test]
async fn compute_returns_not_found_for_an_unknown_key() {
    let mut client = spawn_server().await;

    let status = client
        .compute_signature(compute_req("nope", now_secs()))
        .await
        .unwrap_err();
    assert_eq!(status.code(), tonic::Code::NotFound);
    assert_eq!(status.message(), "API_KEY_UNKNOWN");
}
