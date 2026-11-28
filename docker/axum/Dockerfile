# Multi-stage production build for Orbit Axum server (Pulsar CS Desk + Saturn Backlog)

FROM oven/bun:1.4.4-slim AS web-builder
WORKDIR /app/web/pulsar
COPY web/pulsar/package.json web/pulsar/bun.lock ./
RUN bun install --frozen-lockfile
COPY web/pulsar .
RUN bun run typecheck && bun run build

FROM rust:1-bookworm AS builder
RUN apt-get update && apt-get install -y --no-install-recommends \
    cmake make g++ pkg-config \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ARG CARGO_BUILD_JOBS
ENV CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS}
COPY Cargo.toml Cargo.lock ./
COPY crates crates
RUN cargo build --release --locked --bin orbit

FROM debian:bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1001 circleit \
    && useradd --uid 1001 --gid circleit --create-home circleit

WORKDIR /srv/orbit
COPY --from=builder /app/target/release/orbit /usr/local/bin/orbit
COPY --from=web-builder /app/web/pulsar/build/client /srv/orbit/web/pulsar/build/client
COPY web/saturn /srv/orbit/web/saturn
RUN install -d -o circleit -g circleit -m 750 /data/storage/pulsar /data/storage/saturn \
    && chown -R circleit:circleit /srv/orbit

USER circleit
ENV HOME=/home/circleit \
    BIND=0.0.0.0:3000 \
    PULSAR_WEB_DIR=/srv/orbit/web/pulsar/build/client \
    SATURN_WEB_DIR=/srv/orbit/web/saturn \
    PULSAR_STORAGE_DIR=/data/storage/pulsar \
    SATURN_STORAGE_DIR=/data/storage/saturn \
    RUST_LOG=info,tower_http=warn

EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -sf http://127.0.0.1:3000/ready >/dev/null || exit 1

ENTRYPOINT ["/usr/local/bin/orbit"]
