pub mod activity;
pub mod api_log;
pub mod api_v1;
pub mod api_v1_assets;
pub mod api_v1_extra;
pub mod auth;
pub mod common;
pub mod instance;
pub mod jobs;
pub mod jobs_fk;
pub mod notify;
pub mod oauth;
pub mod outbound;
pub mod session;
pub mod side_effects;
pub mod web;
pub mod webhook_out;
pub mod workitems;

// API areas. Each module owns its routes (full paths, trailing slash, as Plane's apps call them).
pub mod analytics;
pub mod api_v1_items;
pub mod assets;
pub mod cycles;
pub mod external;
pub mod issues;
pub mod live_doc;
pub mod live_http;
pub mod modules;
pub mod notifications;
pub mod pages;
pub mod projects;
pub mod public;
pub mod recent_visits;
pub mod states;
pub mod user_dash;
pub mod users;
pub mod views;
pub mod workspace_seed;
pub mod workspaces;

use axum::{
    Router,
    http::{HeaderName, HeaderValue, Method, header},
    middleware,
};
use common::AppState;
use tower_http::cors::{Any, CorsLayer};

fn plane_cors_origins() -> Vec<String> {
    let explicit: Vec<String> = std::env::var("CORS_ALLOWED_ORIGINS")
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect();
    if !explicit.is_empty() {
        return explicit;
    }
    let mut origins = Vec::new();
    for var in [
        "WEB_URL",
        "APP_BASE_URL",
        "ADMIN_BASE_URL",
        "SPACE_BASE_URL",
        "LIVE_BASE_URL",
    ] {
        let Ok(raw) = std::env::var(var) else { continue };
        let trimmed = raw.trim();
        let Ok(url) = url::Url::parse(trimmed) else { continue };
        if let Some(host) = url.host_str() {
            let port = url.port().map(|p| format!(":{p}")).unwrap_or_default();
            let origin = format!("{}://{host}{port}", url.scheme()).to_ascii_lowercase();
            if !origins.contains(&origin) {
                origins.push(origin);
            }
        }
    }
    origins
}

pub fn cors_layer() -> CorsLayer {
    let origins = plane_cors_origins();
    let methods = [
        Method::GET,
        Method::POST,
        Method::PUT,
        Method::PATCH,
        Method::DELETE,
        Method::OPTIONS,
    ];
    let headers = [
        header::ACCEPT,
        header::ACCEPT_ENCODING,
        header::AUTHORIZATION,
        header::CONTENT_TYPE,
        header::ORIGIN,
        header::USER_AGENT,
        HeaderName::from_static("x-api-key"),
        HeaderName::from_static("x-csrftoken"),
        HeaderName::from_static("x-requested-with"),
    ];
    let base = CorsLayer::new().allow_methods(methods).allow_headers(headers);
    let parsed: Vec<HeaderValue> = origins.iter().filter_map(|o| HeaderValue::from_str(o).ok()).collect();
    if !parsed.is_empty() {
        base.allow_origin(parsed).allow_credentials(true)
    } else {
        base.allow_origin(Any)
    }
}

const MIGRATIONS: &[(&str, &str)] = &[
    ("0001_schema", include_str!("../migrations/0001_schema.sql")),
    ("0002_defaults", include_str!("../migrations/0002_defaults.sql")),
    ("0003_auth_tokens", include_str!("../migrations/0003_auth_tokens.sql")),
];

/// Saturn API routes (without global `/api/{*rest}`, `/auth/{*rest}`, or SPA fallback) so Orbit
/// can merge Pulsar and Saturn routes before applying fallback handlers.
pub fn api_router(state: AppState) -> Router {
    let v1 = Router::new()
        .merge(api_v1::routes())
        .merge(api_v1_assets::routes())
        .merge(api_v1_extra::routes())
        .merge(api_v1_items::routes())
        .layer(middleware::from_fn_with_state(state.clone(), api_log::log_api_requests));
    Router::new()
        .merge(v1)
        .merge(auth::routes())
        .merge(oauth::routes())
        .merge(instance::routes())
        .merge(users::routes())
        .merge(workspaces::routes())
        .merge(projects::routes())
        .merge(states::routes())
        .merge(issues::routes())
        .merge(cycles::routes())
        .merge(modules::routes())
        .merge(views::routes())
        .merge(pages::routes())
        .merge(notifications::routes())
        .merge(assets::routes())
        .merge(public::routes())
        .merge(analytics::routes())
        .merge(user_dash::routes())
        .merge(external::routes())
        .merge(live_http::routes())
        .layer(middleware::from_fn_with_state(state.clone(), web::origin_check))
        .with_state(state)
}

/// Saturn static SPAs (`/` web, `/god-mode` admin, `/spaces` space).
pub fn spa_router(state: AppState) -> Router {
    web::spa_routes(&state).with_state(state)
}

/// Apply migrations in order, once each. On an existing Plane database (tables already created by
/// Django) the schema migration is recorded as applied and only Saturn's additions run.
pub async fn migrate(db: &sqlx::PgPool) -> anyhow::Result<()> {
    sqlx::query("CREATE TABLE IF NOT EXISTS saturn_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())")
        .execute(db)
        .await?;
    let plane_db: (bool,) = sqlx::query_as("SELECT to_regclass('public.issues') IS NOT NULL")
        .fetch_one(db)
        .await?;
    if plane_db.0 {
        sqlx::query("INSERT INTO saturn_migrations (name) VALUES ('0001_schema') ON CONFLICT DO NOTHING")
            .execute(db)
            .await?;
    }
    for (name, sql) in MIGRATIONS {
        let done: (bool,) = sqlx::query_as("SELECT EXISTS (SELECT 1 FROM saturn_migrations WHERE name = $1)")
            .bind(name)
            .fetch_one(db)
            .await?;
        if done.0 {
            continue;
        }
        tracing::info!("applying migration {name}");
        let mut tx = db.begin().await?;
        sqlx::raw_sql(sql).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO saturn_migrations (name) VALUES ($1)")
            .bind(name)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
    }
    auth::ensure_instance(db).await?;
    instance::ensure_configurations(db).await
}

pub fn spawn_background(state: AppState) {
    jobs::spawn(state.clone());
    pages::spawn_room_sync(state);
}

pub async fn flush_shutdown(state: &AppState) {
    pages::flush_all_rooms(state).await;
}
