fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Compile the shared contract from the repo-root proto module.
    // grpc.health.v1 is provided pre-compiled by tonic-health.
    // The client is generated too — used by tests/grpc_test.rs to call the
    // real server over a socket.
    tonic_prost_build::configure()
        .build_client(true)
        .compile_protos(
            &["../../../proto/signing/v1/signing.proto"],
            &["../../../proto"],
        )?;
    Ok(())
}
