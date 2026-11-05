//! hills-storage：SwarmStorage 原理的分片儲存節點（technical-design §15.6）
//!
//! 目前只提供健康檢查；功能依 docs/backlog/m0-m1.md 的對應 Issue 開發。

use axum::{Json, Router, routing::get};
use serde_json::{Value, json};

const SERVICE: &str = "hills-storage";

fn app() -> Router {
    Router::new().route("/v1/health", get(health))
}

async fn health() -> Json<Value> {
    Json(json!({ "service": SERVICE, "status": "ok", "version": env!("CARGO_PKG_VERSION") }))
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();
    let addr = std::env::var("HILLS_LISTEN").unwrap_or_else(|_| "0.0.0.0:8080".into());
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    tracing::info!(%addr, "{SERVICE} listening");
    axum::serve(listener, app())
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request};
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    #[tokio::test]
    async fn health_reports_ok() {
        let res = app()
            .oneshot(Request::get("/v1/health").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert!(res.status().is_success());
        let body = res.into_body().collect().await.unwrap().to_bytes();
        let v: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(v["service"], SERVICE);
        assert_eq!(v["status"], "ok");
    }
}
