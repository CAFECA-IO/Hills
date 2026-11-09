//! Streamable HTTP 傳輸（technical-design §18.1–18.2）：只綁 127.0.0.1，驗 Host、Origin 與 Bearer token。

use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use serde_json::Value;

use super::protocol::{McpBackend, Server};

pub struct Http<B> {
    pub server: Arc<Server<B>>,
    pub port: u16,
    /// 目前有效的 token（重新產生時即時更換）
    pub token: Arc<Mutex<String>>,
}

impl<B> Clone for Http<B> {
    fn clone(&self) -> Self {
        Self {
            server: self.server.clone(),
            port: self.port,
            token: self.token.clone(),
        }
    }
}

pub fn router<B: McpBackend>(http: Http<B>) -> Router {
    Router::new()
        .route(
            "/mcp",
            post(handle::<B>).get(not_allowed).delete(not_allowed),
        )
        .with_state(http)
}

async fn not_allowed() -> StatusCode {
    StatusCode::METHOD_NOT_ALLOWED
}

/// 固定時間比較，避免以回應時間猜 token。
fn same(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn host_ok(headers: &HeaderMap, port: u16) -> bool {
    let Some(host) = headers.get(header::HOST).and_then(|v| v.to_str().ok()) else {
        return false;
    };
    host == format!("127.0.0.1:{port}") || host == format!("localhost:{port}")
}

/// 沒有 Origin（非瀏覽器用戶端）可以；有的話必須是本機。
fn origin_ok(headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get(header::ORIGIN) else {
        return true;
    };
    let Ok(o) = origin.to_str() else {
        return false;
    };
    let rest = o
        .strip_prefix("http://127.0.0.1")
        .or_else(|| o.strip_prefix("http://localhost"));
    matches!(rest, Some(r) if r.is_empty() || (r.starts_with(':') && r[1..].chars().all(|c| c.is_ascii_digit())))
}

fn auth_ok(headers: &HeaderMap, token: &str) -> bool {
    let Some(v) = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
    else {
        return false;
    };
    let Some(given) = v.strip_prefix("Bearer ") else {
        return false;
    };
    !token.is_empty() && same(given.trim().as_bytes(), token.as_bytes())
}

async fn handle<B: McpBackend>(
    State(http): State<Http<B>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if !host_ok(&headers, http.port) || !origin_ok(&headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let token = http
        .token
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone();
    if !auth_ok(&headers, &token) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let Ok(msg) = serde_json::from_slice::<Value>(&body) else {
        let e = serde_json::json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": "parse error" } });
        return (StatusCode::BAD_REQUEST, axum::Json(e)).into_response();
    };
    if msg.is_array() {
        // 2025-06-18 不支援批次
        let e = serde_json::json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32600, "message": "batch not supported" } });
        return (StatusCode::BAD_REQUEST, axum::Json(e)).into_response();
    }
    match http.server.handle(msg).await {
        Some(r) => axum::Json(r).into_response(),
        None => StatusCode::ACCEPTED.into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::protocol::tests::Fake;
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    fn app() -> Router {
        router(Http {
            server: Arc::new(Server::new(Fake::default())),
            port: 47321,
            token: Arc::new(Mutex::new("secret".into())),
        })
    }

    fn req(host: &str, origin: Option<&str>, auth: Option<&str>, body: &str) -> Request<Body> {
        let mut b = Request::post("/mcp")
            .header(header::HOST, host)
            .header(header::CONTENT_TYPE, "application/json");
        if let Some(o) = origin {
            b = b.header(header::ORIGIN, o);
        }
        if let Some(a) = auth {
            b = b.header(header::AUTHORIZATION, a);
        }
        b.body(Body::from(body.to_owned())).unwrap()
    }

    const PING: &str = r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#;

    #[tokio::test]
    async fn checks_host_origin_and_token() {
        let ok = app()
            .oneshot(req("127.0.0.1:47321", None, Some("Bearer secret"), PING))
            .await
            .unwrap();
        assert_eq!(ok.status(), StatusCode::OK);
        let r = app()
            .oneshot(req("127.0.0.1:47321", None, Some("Bearer nope"), PING))
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::UNAUTHORIZED);
        let r = app()
            .oneshot(req("127.0.0.1:47321", None, None, PING))
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::UNAUTHORIZED);
        let r = app()
            .oneshot(req("evil.example:47321", None, Some("Bearer secret"), PING))
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::FORBIDDEN);
        let r = app()
            .oneshot(req(
                "localhost:47321",
                Some("https://evil.example"),
                Some("Bearer secret"),
                PING,
            ))
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::FORBIDDEN);
        let r = app()
            .oneshot(req(
                "localhost:47321",
                Some("http://localhost:6274"),
                Some("Bearer secret"),
                PING,
            ))
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::OK);
        let r = app()
            .oneshot(req(
                "localhost:47321",
                Some("http://localhost.evil.example"),
                Some("Bearer secret"),
                PING,
            ))
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn notification_is_accepted_and_get_is_405() {
        let r = app()
            .oneshot(req(
                "127.0.0.1:47321",
                None,
                Some("Bearer secret"),
                r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
            ))
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::ACCEPTED);
        let r = app()
            .oneshot(
                Request::get("/mcp")
                    .header(header::HOST, "127.0.0.1:47321")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::METHOD_NOT_ALLOWED);
    }
}
