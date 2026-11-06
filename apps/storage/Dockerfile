# hills-storage（technical-design §15.6–15.7、D39）。在 repo 根目錄建置：
#   docker build -f apps/storage/Dockerfile -t hills-storage .
FROM rust:1-bookworm AS build
WORKDIR /src
COPY . .
RUN cargo build --release --locked -p hills-storage \
    && cp target/release/hills-storage /hills-storage

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --home /data hills \
    && mkdir -p /data /storage-codes && chown hills /data /storage-codes
COPY --from=build /hills-storage /usr/local/bin/hills-storage
USER hills
ENV HILLS_DATA_DIR=/data \
    HILLS_STORAGE_CODES_DIR=/storage-codes \
    HILLS_LISTEN=0.0.0.0:8080
VOLUME ["/data"]
EXPOSE 8080/tcp
HEALTHCHECK --interval=30s --timeout=5s CMD curl -fsS http://127.0.0.1:8080/v1/health || exit 1
ENTRYPOINT ["hills-storage"]
