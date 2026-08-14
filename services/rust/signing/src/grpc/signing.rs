//! tropis.signing.v1.SigningService tonic handler — thin transport shell.
//! Decodes requests into `domain::signature::SigningInput`, delegates, and
//! encodes the outcome. Error mapping lives in `error.rs`.

use tonic::{Request, Response, Status};

use crate::config::Config;
use crate::domain::signature::{now_secs, KeyStore, SigningInput};
use crate::pb::signing_service_server::SigningService;
use crate::pb::{
    ComputeSignatureRequest, ComputeSignatureResponse, VerifySignatureRequest,
    VerifySignatureResponse,
};

/// gRPC facade over the domain `KeyStore`.
#[derive(Debug, Default, Clone)]
pub struct SigningServiceImpl {
    store: KeyStore,
}

impl SigningServiceImpl {
    pub fn new(config: &Config) -> Self {
        Self {
            store: KeyStore::new(config.api_keys.clone()),
        }
    }
}

fn signing_input<'a>(
    method: &'a str,
    path: &'a str,
    timestamp: i64,
    nonce: &'a str,
    body: &'a [u8],
    key_id: &'a str,
) -> SigningInput<'a> {
    SigningInput {
        method,
        path,
        timestamp,
        nonce,
        body,
        key_id,
    }
}

#[tonic::async_trait]
impl SigningService for SigningServiceImpl {
    async fn compute_signature(
        &self,
        request: Request<ComputeSignatureRequest>,
    ) -> Result<Response<ComputeSignatureResponse>, Status> {
        let req = request.into_inner();
        let input = signing_input(
            &req.method,
            &req.path,
            req.timestamp,
            &req.nonce,
            &req.body,
            &req.key_id,
        );
        let signature = self.store.compute(&input)?;
        tracing::debug!(key_id = %req.key_id, method = %req.method, path = %req.path, "computed signature");
        Ok(Response::new(ComputeSignatureResponse { signature }))
    }

    async fn verify_signature(
        &self,
        request: Request<VerifySignatureRequest>,
    ) -> Result<Response<VerifySignatureResponse>, Status> {
        let req = request.into_inner();
        let input = signing_input(
            &req.method,
            &req.path,
            req.timestamp,
            &req.nonce,
            &req.body,
            &req.key_id,
        );
        let outcome = self.store.verify(&input, &req.signature, now_secs());
        Ok(Response::new(VerifySignatureResponse {
            valid: outcome.is_valid(),
            reason: outcome.reason().to_string(),
        }))
    }
}
