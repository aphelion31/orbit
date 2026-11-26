# Multi-stage production build for Orbit (CS Desk + Project & Backlog in one binary)

FROM oven/bun:1.4.4-slim AS web-builder
WORKDIR /app/web/pulsar
COPY web/pulsar/package.json web/pulsar/bun.lock ./
RUN bun install --frozen-lockfile
COPY web/pulsar .
RUN bun run typecheck && bun run build

FROM rust:1-bookworm AS rust-builder
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY crates crates
RUN cargo build --release --bin orbit

FROM debian:bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --create-home orbit

WORKDIR /srv/orbit
COPY --from=rust-builder /app/target/release/orbit /usr/local/bin/orbit
COPY --from=web-builder /app/web/pulsar/build/client /srv/orbit/web/pulsar/build/client
COPY web/saturn /srv/orbit/web/saturn
RUN mkdir -p /data/storage/pulsar /data/storage/saturn \
    && chown -R orbit:orbit /srv/orbit /data/storage

USER orbit
ENV BIND=0.0.0.0:3000 \
    PULSAR_WEB_DIR=/srv/orbit/web/pulsar/build/client \
    SATURN_WEB_DIR=/srv/orbit/web/saturn \
    PULSAR_STORAGE_DIR=/data/storage/pulsar \
    SATURN_STORAGE_DIR=/data/storage/saturn \
    RUST_LOG=info,tower_http=warn

EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -sf http://127.0.0.1:3000/ready >/dev/null || exit 1

ENTRYPOINT ["/usr/local/bin/orbit"]
