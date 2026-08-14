//! Bootstrap ONLY: load config, init tracing, wire the tonic server, serve.
//! Everything else lives in the layers — see src/lib.rs and
//! docs/project-structure.md → "Rust service anatomy".

use signing::config::Config;
use signing::grpc::signing::SigningServiceImpl;
use signing::pb::signing_service_server::SigningServiceServer;
use tonic_health::server::health_reporter;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // JSON logs to stdout — the platform's log convention.
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    // Fail fast on invalid env (mirrors the backend's Joi validation).
    let config = Config::from_env()?;
    let addr = format!("0.0.0.0:{}", config.grpc_port).parse()?;
    let signing = SigningServiceImpl::new(&config);

    // Standard grpc.health.v1 so k8s/compose can probe.
    let (health, health_service) = health_reporter();
    health
        .set_serving::<SigningServiceServer<SigningServiceImpl>>()
        .await;

    tracing::info!(%addr, "signing service listening");

    tonic::transport::Server::builder()
        .add_service(health_service)
        .add_service(SigningServiceServer::new(signing))
        .serve_with_shutdown(addr, shutdown_signal())
        .await?;

    tracing::info!("signing service stopped");
    Ok(())
}

/// Resolves on SIGTERM (k8s/compose stop) or Ctrl-C for graceful shutdown.
async fn shutdown_signal() {
    let ctrl_c = tokio::signal::ctrl_c();
    #[cfg(unix)]
    {
        let mut sigterm = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install SIGTERM handler");
        tokio::select! {
            _ = ctrl_c => {},
            _ = sigterm.recv() => {},
        }
    }
    #[cfg(not(unix))]
    ctrl_c.await.expect("failed to install Ctrl-C handler");
    tracing::info!("shutdown signal received");
}
