use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, HeaderValue, header},
    response::{IntoResponse, Response},
    routing::post,
};
use serde_json::json;
use uuid::Uuid;

use crate::bridge::OrbitState;

pub fn routes() -> Router<OrbitState> {
    Router::new()
        .route("/sync_saturn", post(sync_saturn))
        .route("/exchange_saturn", post(exchange_saturn))
        .route("/sign_out", post(sign_out))
}

async fn ensure_saturn_user(
    st: &OrbitState,
    email: &str,
    name: &str,
) -> Result<Uuid, pulsar::common::ApiError> {
    let norm = email.trim().to_lowercase();
    if norm.is_empty() {
        return Err(pulsar::common::ApiError::bad("User email is required for SSO"));
    }
    if let Some(id) = sqlx::query_scalar::<_, Uuid>(
        "SELECT id FROM users WHERE lower(email) = $1 AND is_active LIMIT 1",
    )
    .bind(&norm)
    .fetch_optional(&st.saturn.db)
    .await?
    {
        return Ok(id);
    }

    let mut parts = name.trim().splitn(2, ' ');
    let first_name = parts.next().filter(|s| !s.is_empty()).unwrap_or("Orbit");
    let last_name = parts.next().unwrap_or("");
    let random_pw = format!("{}Aa1!", Uuid::new_v4().simple());

    let uid = saturn::auth::create_user(&st.saturn.db, &norm, &random_pw, first_name, last_name)
        .await
        .map_err(|_| pulsar::common::ApiError::bad("Could not provision Saturn user"))?;

    let ws_id: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM workspaces WHERE deleted_at IS NULL ORDER BY created_at LIMIT 1",
    )
    .fetch_optional(&st.saturn.db)
    .await?;

    if let Some(wid) = ws_id {
        sqlx::query(
            "INSERT INTO workspace_members (workspace_id, member_id, role, created_by_id, updated_by_id, is_active)
             SELECT $1, $2, 15, $2, $2, true
             WHERE NOT EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND member_id = $2 AND deleted_at IS NULL)",
        )
        .bind(wid)
        .bind(uid)
        .execute(&st.saturn.db)
        .await?;

        sqlx::query(
            "INSERT INTO project_members (workspace_id, project_id, member_id, role, created_by_id, updated_by_id, is_active)
             SELECT $1, p.id, $2, 15, $2, $2, true
             FROM projects p
             WHERE p.workspace_id = $1 AND p.deleted_at IS NULL AND p.archived_at IS NULL
               AND NOT EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.member_id = $2 AND pm.deleted_at IS NULL)",
        )
        .bind(wid)
        .bind(uid)
        .execute(&st.saturn.db)
        .await?;
    }

    sqlx::query(
        "UPDATE profiles SET is_onboarded = true, is_tour_completed = true, last_workspace_id = COALESCE($2, last_workspace_id)
         WHERE user_id = $1",
    )
    .bind(uid)
    .bind(ws_id)
    .execute(&st.saturn.db)
    .await?;

    Ok(uid)
}

/// Issue a Saturn `session-id` cookie for an authenticated Pulsar user (1x login Pulsar -> Saturn).
async fn sync_saturn(
    State(st): State<OrbitState>,
    user: pulsar::common::CurrentUser,
) -> Result<Response, pulsar::common::ApiError> {
    let saturn_uid = ensure_saturn_user(&st, &user.email, &user.name).await?;
    let key = saturn::session::create(
        &st.saturn,
        saturn_uid,
        false,
        json!({ "source": "orbit_sso" }),
    )
    .await
    .map_err(|_| pulsar::common::ApiError::bad("Could not create Saturn session"))?;

    let cookie = saturn::session::set_cookie(
        &st.saturn,
        saturn::session::COOKIE,
        Some(&key),
        saturn::session::AGE_SECS,
    );
    let mut headers = HeaderMap::new();
    if let Ok(val) = HeaderValue::from_str(&cookie) {
        headers.insert(header::SET_COOKIE, val);
    }
    Ok((
        headers,
        Json(json!({ "synced": true, "saturn_user_id": saturn_uid })),
    )
        .into_response())
}

/// Exchange an existing Saturn `session-id` cookie for Pulsar devise_token_auth headers (1x login Saturn -> Pulsar).
async fn exchange_saturn(
    State(st): State<OrbitState>,
    headers: HeaderMap,
) -> Result<Response, pulsar::common::ApiError> {
    let key = saturn::session::cookie(&headers, saturn::session::COOKIE)
        .ok_or_else(pulsar::common::ApiError::unauthorized)?;
    let saturn_uid = saturn::session::load(&st.saturn, &key)
        .await
        .map_err(|_| pulsar::common::ApiError::unauthorized())?
        .ok_or_else(pulsar::common::ApiError::unauthorized)?;

    let row: Option<(String, String, String, String)> = sqlx::query_as(
        "SELECT email, COALESCE(display_name, ''), COALESCE(first_name, ''), COALESCE(last_name, '')
         FROM users WHERE id = $1 AND is_active",
    )
    .bind(saturn_uid)
    .fetch_optional(&st.saturn.db)
    .await?;
    let (email, display_name, first_name, last_name) =
        row.ok_or_else(pulsar::common::ApiError::unauthorized)?;

    let full_name = if !display_name.trim().is_empty() {
        display_name
    } else {
        format!("{first_name} {last_name}").trim().to_string()
    };

    let (pid, uid, tokens) =
        pulsar::auth::provision_sso_user(&st.pulsar.db, &email, &full_name).await?;
    let (client, token, expiry) = pulsar::auth::issue_token(&st.pulsar.db, pid, tokens).await?;
    let data = pulsar::auth::user_json(&st.pulsar.db, pid).await?;
    Ok((
        pulsar::auth::auth_headers(&uid, &client, &token, expiry),
        Json(json!({ "data": data })),
    )
        .into_response())
}

/// Destroy Saturn session cookie when signing out from Pulsar.
async fn sign_out(State(st): State<OrbitState>, headers: HeaderMap) -> Response {
    if let Some(key) = saturn::session::cookie(&headers, saturn::session::COOKIE) {
        let _ = saturn::session::destroy(&st.saturn, &key).await;
    }
    let clear = saturn::session::set_cookie(&st.saturn, saturn::session::COOKIE, None, 0);
    let mut out_headers = HeaderMap::new();
    if let Ok(val) = HeaderValue::from_str(&clear) {
        out_headers.insert(header::SET_COOKIE, val);
    }
    (out_headers, Json(json!({ "signed_out": true }))).into_response()
}
