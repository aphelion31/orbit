mod auth_bridge;
mod bridge;
mod theme;

use axum::{
    Json, Router,
    extract::State,
    http::StatusCode,
    middleware,
    response::{IntoResponse, Response},
    routing::{any, get},
};
use bridge::OrbitState;
use serde_json::json;
use std::sync::Arc;
use tower_http::{compression::CompressionLayer, trace::TraceLayer};

fn env(k: &str, d: &str) -> String {
    std::env::var(k)
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| d.to_string())
}

async fn health(State(st): State<OrbitState>) -> Response {
    let p_ok = sqlx::query_scalar::<_, i32>("SELECT 1")
        .fetch_one(&st.pulsar.db)
        .await
        .is_ok();
    let s_ok = sqlx::query_scalar::<_, i32>("SELECT 1")
        .fetch_one(&st.saturn.db)
        .await
        .is_ok();
    let status = if p_ok && s_ok {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };
    (
        status,
        Json(json!({
            "status": if p_ok && s_ok { "OK" } else { "UNAVAILABLE" },
            "pulsar": if p_ok { "ok" } else { "error" },
            "saturn": if s_ok { "ok" } else { "error" },
        })),
    )
        .into_response()
}

async fn favicon_ico() -> impl IntoResponse {
    (
        [
            (axum::http::header::CONTENT_TYPE, "image/x-icon"),
            (axum::http::header::CACHE_CONTROL, "public, max-age=86400"),
        ],
        include_bytes!("favicon.ico").as_slice(),
    )
}

pub fn build_router(state: OrbitState) -> Router {
    let orbit_api = Router::new()
        .nest("/api/v1/orbit/accounts/{account_id}", bridge::routes())
        .nest("/api/v1/orbit/auth", auth_bridge::routes())
        .nest("/api/v1/orbit", theme::routes())
        .with_state(state.clone());

    Router::new()
        .route("/health", get(health))
        .route("/ready", get(health))
        .route("/favicon.ico", get(favicon_ico))
        .route("/robots.txt", get(saturn::web::robots_txt))
        .with_state(state.clone())
        .merge(orbit_api)
        .merge(pulsar::router(state.pulsar))
        .merge(saturn::api_router(state.saturn.clone()))
        .route("/api/{*rest}", any(saturn::web::api_not_found))
        .route("/auth/{*rest}", any(saturn::web::not_implemented))
        .merge(saturn::spa_router(state.saturn))
        .layer(middleware::from_fn(saturn::web::security_headers))
        .layer(saturn::cors_layer())
        .layer(middleware::from_fn(saturn::web::peer_header))
        .layer(CompressionLayer::new())
        .layer(
            TraceLayer::new_for_http().make_span_with(|request: &axum::http::Request<_>| {
                tracing::info_span!("http", method = %request.method(), path = %request.uri().path())
            }),
        )
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(env("RUST_LOG", "info,tower_http=warn"))
        .init();

    let pulsar_url = env("PULSAR_DATABASE_URL", "postgres://localhost/orbit_pulsar");
    let saturn_url = env("SATURN_DATABASE_URL", "postgres://localhost/orbit_saturn");
    let max_conns: u32 = env("DB_POOL", "10").parse()?;

    let pulsar_db = sqlx::postgres::PgPoolOptions::new()
        .max_connections(max_conns)
        .connect(&pulsar_url)
        .await?;
    let saturn_db = sqlx::postgres::PgPoolOptions::new()
        .max_connections(max_conns)
        .connect(&saturn_url)
        .await?;

    pulsar::migrate(&pulsar_db).await?;
    saturn::migrate(&saturn_db).await?;

    let frontend_url = std::env::var("FRONTEND_URL")
        .or_else(|_| std::env::var("WEB_URL"))
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "http://localhost:3000".into());

    let pulsar_storage_dir = env("PULSAR_STORAGE_DIR", "storage/pulsar");
    std::fs::create_dir_all(&pulsar_storage_dir)?;
    // Pulsar's storage module reads STORAGE_DIR from env; set it if unset so files land in storage/pulsar.
    if std::env::var_os("STORAGE_DIR").is_none() {
        // Safety: invoked once on startup before worker tasks spawn.
        unsafe { std::env::set_var("STORAGE_DIR", &pulsar_storage_dir) };
    }

    let secret_key = std::env::var("SECRET_KEY")
        .or_else(|_| std::env::var("SECRET_KEY_BASE"))
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| {
            tracing::warn!("SECRET_KEY / SECRET_KEY_BASE not set, using insecure dev key");
            "orbit-insecure-dev-key".into()
        });
    if std::env::var_os("SECRET_KEY_BASE").is_none() {
        // Safety: invoked once on startup before worker tasks spawn.
        unsafe { std::env::set_var("SECRET_KEY_BASE", &secret_key) };
    }

    let saturn_storage_dir = env("SATURN_STORAGE_DIR", "storage/saturn");
    std::fs::create_dir_all(&saturn_storage_dir)?;

    let pulsar_state = pulsar::common::AppState {
        db: pulsar_db.clone(),
        hub: pulsar::cable::Hub::with_db(pulsar_db.clone()),
        public_dir: env("PULSAR_WEB_DIR", "web/pulsar/build/client").into(),
        frontend_url: frontend_url.clone(),
    };

    let saturn_cfg = saturn::common::Config {
        cookie_secure: frontend_url.starts_with("https://"),
        web_url: frontend_url.clone(),
        secret_key,
        web_dir: env("SATURN_WEB_DIR", "web/saturn").into(),
        storage_dir: saturn_storage_dir.into(),
        file_size_limit: env("FILE_SIZE_LIMIT", "5242880").parse()?,
    };
    let saturn_state = saturn::common::AppState {
        db: saturn_db.clone(),
        cfg: Arc::new(saturn_cfg),
    };

    let orbit_state = OrbitState {
        pulsar: pulsar_state.clone(),
        saturn: saturn_state.clone(),
    };

    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("migrate") => return Ok(()),
        Some("seed") => {
            let seed_args = &args[2..];
            pulsar::seed::run(&pulsar_db, seed_args).await?;
            saturn::users::seed(&saturn_state, seed_args).await?;
            bridge::seed_default_hook(&orbit_state).await?;
            return Ok(());
        }
        _ => {}
    }

    pulsar::spawn_background(pulsar_state);
    saturn::spawn_background(saturn_state.clone());
    bridge::spawn_status_sync(orbit_state.clone());

    let addr = env("BIND", "0.0.0.0:3000");
    tracing::info!("orbit listening on {addr} (CS Desk at /app/, Backlog at /)");
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    axum::serve(
        listener,
        build_router(orbit_state).into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await?;

    saturn::flush_shutdown(&saturn_state).await;
    pulsar_db.close().await;
    saturn_db.close().await;
    tracing::info!("orbit shutdown complete");
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut sig) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            sig.recv().await;
        } else {
            std::future::pending::<()>().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    tracing::info!("shutdown signal received");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn orbit_router_builds_without_overlapping_routes() {
        let pulsar_db = sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://localhost/orbit_pulsar")
            .expect("lazy pulsar pool");
        let saturn_db = sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://localhost/orbit_saturn")
            .expect("lazy saturn pool");
        let pulsar_state = pulsar::common::AppState {
            db: pulsar_db,
            hub: pulsar::cable::Hub::default(),
            public_dir: "web/pulsar/build/client".into(),
            frontend_url: "http://localhost:3000".into(),
        };
        let saturn_state = saturn::common::AppState {
            db: saturn_db,
            cfg: Arc::new(saturn::common::Config {
                cookie_secure: false,
                web_url: "http://localhost:3000".into(),
                secret_key: "test-key".into(),
                web_dir: "web/saturn".into(),
                storage_dir: "storage/saturn".into(),
                file_size_limit: 5_242_880,
            }),
        };
        let _router = build_router(OrbitState {
            pulsar: pulsar_state,
            saturn: saturn_state,
        });
    }
}
