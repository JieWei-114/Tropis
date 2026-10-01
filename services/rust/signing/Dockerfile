# services/rust/signing — stateless HMAC signing gRPC service (Rust).
# The crate is a member of the Cargo workspace at the repo root, so the build
# copies the workspace manifests too. Build context MUST be the repo root
# (build.rs compiles ../../../proto/signing/v1):
#   docker build -f services/rust/signing/Dockerfile .

# ── Build stage ──────────────────────────────────────────────────────
FROM rust:1.97-slim-bookworm AS build

# tonic-prost-build shells out to protoc.
RUN apt-get update && apt-get install -y --no-install-recommends protobuf-compiler \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependency layer cache: build a dummy main against the real manifests
# (workspace root + member) first so `cargo build` only recompiles our
# crate on source changes.
COPY Cargo.toml Cargo.lock rustfmt.toml ./
COPY services/rust/signing/Cargo.toml services/rust/signing/
RUN mkdir services/rust/signing/src && echo 'fn main() {}' > services/rust/signing/src/main.rs \
    && cargo build --release -p signing \
    && rm -rf services/rust/signing/src target/release/deps/signing* target/release/signing

# Real sources: the shared proto contract + this service.
COPY proto proto
COPY services/rust/signing/build.rs services/rust/signing/
COPY services/rust/signing/src services/rust/signing/src
RUN cargo build --release -p signing

# ── Runtime stage ────────────────────────────────────────────────────
FROM debian:bookworm-slim
RUN useradd --system --uid 10001 signing
COPY --from=build /app/target/release/signing /usr/local/bin/signing
USER signing
ENV GRPC_PORT=50052
EXPOSE 50052
ENTRYPOINT ["/usr/local/bin/signing"]
