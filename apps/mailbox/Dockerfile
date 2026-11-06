# hills-mailbox（technical-design §10、§16.9）。在 repo 根目錄建置：
#   docker build -f apps/mailbox/Dockerfile -t hills-mailbox .
FROM rust:1-bookworm AS build
WORKDIR /src
COPY . .
RUN cargo build --release --locked -p hills-mailbox \
    && cp target/release/hills-mailbox /hills-mailbox

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --home /data hills \
    && mkdir -p /data && chown hills /data
COPY --from=build /hills-mailbox /usr/local/bin/hills-mailbox
USER hills
ENV HILLS_DATA_DIR=/data \
    HILLS_UDP_PORT=7843 \
    HILLS_LISTEN=0.0.0.0:8080
VOLUME ["/data"]
EXPOSE 7843/udp 8080/tcp
HEALTHCHECK --interval=30s --timeout=5s CMD curl -fsS http://127.0.0.1:8080/v1/health || exit 1
ENTRYPOINT ["hills-mailbox"]
