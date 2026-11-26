use axum::{
    Json, Router,
    extract::{FromRef, Path, Query, State},
    http::StatusCode,
    routing::{get, post},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use std::collections::HashMap;
use uuid::Uuid;

#[derive(Clone)]
pub struct OrbitState {
    pub pulsar: pulsar::common::AppState,
    pub saturn: saturn::common::AppState,
}

impl FromRef<OrbitState> for PgPool {
    fn from_ref(s: &OrbitState) -> PgPool {
        s.pulsar.db.clone()
    }
}

pub fn routes() -> Router<OrbitState> {
    Router::new()
        .route("/config", get(get_config).put(put_config))
        .route("/meta", get(get_meta))
        .route("/issues", post(create_issue))
        .route("/linked_issues", get(linked_issues))
        .route("/unlink_issue", post(unlink_issue))
}

#[derive(Clone, Debug)]
struct ResolvedConfig {
    configured: bool,
    workspace_id: Uuid,
    workspace_slug: String,
    project_id: Uuid,
    project_identifier: String,
    target_mode: String,
    state_id: Option<Uuid>,
    priority: String,
    label_ids: Vec<Uuid>,
    sync_status_notes: bool,
}

impl ResolvedConfig {
    fn to_json(&self) -> Value {
        json!({
            "workspace_id": self.workspace_id,
            "workspace_slug": self.workspace_slug,
            "project_id": self.project_id,
            "project_identifier": self.project_identifier,
            "target_mode": self.target_mode,
            "state_id": self.state_id,
            "priority": self.priority,
            "label_ids": self.label_ids,
            "sync_status_notes": self.sync_status_notes,
        })
    }
}

fn valid_priority(p: &str) -> bool {
    matches!(p, "none" | "low" | "medium" | "high" | "urgent")
}

fn valid_mode(m: &str) -> bool {
    matches!(m, "work_item" | "intake")
}

fn parse_uuid_val(v: Option<&Value>) -> Option<Uuid> {
    v.and_then(|x| x.as_str())
        .filter(|s| !s.trim().is_empty())
        .and_then(|s| Uuid::parse_str(s.trim()).ok())
}

fn parse_uuid_array(v: Option<&Value>) -> Vec<Uuid> {
    v.and_then(|x| x.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().and_then(|s| Uuid::parse_str(s).ok()))
                .collect()
        })
        .unwrap_or_default()
}

fn html_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(ch),
        }
    }
    out
}

async fn default_backlog_state(
    db: &PgPool,
    workspace_id: Uuid,
    project_id: Uuid,
) -> Result<Option<(Uuid, String, String, String)>, pulsar::common::ApiError> {
    let row: Option<(Uuid, String, String, String)> = sqlx::query_as(
        "SELECT id, name, color, \"group\"
         FROM states
         WHERE project_id = $1 AND workspace_id = $2 AND deleted_at IS NULL AND NOT is_triage
         ORDER BY (\"group\" = 'backlog') DESC, (lower(name) LIKE '%backlog%') DESC, \"default\" DESC, sequence
         LIMIT 1",
    )
    .bind(project_id)
    .bind(workspace_id)
    .fetch_optional(db)
    .await?;
    Ok(row)
}

async fn resolve_account_config(
    st: &OrbitState,
    account_id: i64,
) -> Result<Option<ResolvedConfig>, pulsar::common::ApiError> {
    let hook = pulsar::integrations::load_hook(&st.pulsar.db, account_id, "orbit").await?;
    let settings = hook.as_ref().map(|h| &h.3);

    let saved_ws = settings.and_then(|s| parse_uuid_val(s.get("workspace_id")));
    let saved_proj = settings.and_then(|s| parse_uuid_val(s.get("project_id")));

    let mut configured = false;
    let ws_row: Option<(Uuid, String)> = if let Some(ws_id) = saved_ws {
        sqlx::query_as(
            "SELECT id, slug FROM workspaces WHERE id = $1 AND deleted_at IS NULL LIMIT 1",
        )
        .bind(ws_id)
        .fetch_optional(&st.saturn.db)
        .await?
    } else {
        None
    };

    let (workspace_id, workspace_slug, proj_row) = match ws_row {
        Some((wid, wslug)) => {
            let pr: Option<(Uuid, String)> = if let Some(pid) = saved_proj {
                sqlx::query_as(
                    "SELECT id, identifier FROM projects WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL AND archived_at IS NULL LIMIT 1",
                )
                .bind(pid)
                .bind(wid)
                .fetch_optional(&st.saturn.db)
                .await?
            } else {
                None
            };
            if pr.is_some() {
                configured = hook.is_some();
                (wid, wslug, pr)
            } else {
                let fallback_p: Option<(Uuid, String)> = sqlx::query_as(
                    "SELECT id, identifier FROM projects WHERE workspace_id = $1 AND deleted_at IS NULL AND archived_at IS NULL ORDER BY created_at LIMIT 1",
                )
                .bind(wid)
                .fetch_optional(&st.saturn.db)
                .await?;
                (wid, wslug, fallback_p)
            }
        }
        None => {
            let Some((wid, wslug)): Option<(Uuid, String)> = sqlx::query_as(
                "SELECT id, slug FROM workspaces WHERE deleted_at IS NULL ORDER BY created_at LIMIT 1",
            )
            .fetch_optional(&st.saturn.db)
            .await?
            else {
                return Ok(None);
            };
            let pr: Option<(Uuid, String)> = sqlx::query_as(
                "SELECT id, identifier FROM projects WHERE workspace_id = $1 AND deleted_at IS NULL AND archived_at IS NULL ORDER BY created_at LIMIT 1",
            )
            .bind(wid)
            .fetch_optional(&st.saturn.db)
            .await?;
            (wid, wslug, pr)
        }
    };

    let Some((project_id, project_identifier)) = proj_row else {
        return Ok(None);
    };

    let target_mode = settings
        .and_then(|s| s.get("target_mode").and_then(|v| v.as_str()))
        .filter(|m| valid_mode(m))
        .unwrap_or("work_item")
        .to_string();

    let saved_state = settings.and_then(|s| parse_uuid_val(s.get("state_id")));
    let state_id = if let Some(sid) = saved_state {
        let valid: Option<Uuid> = sqlx::query_scalar(
            "SELECT id FROM states WHERE id = $1 AND project_id = $2 AND workspace_id = $3 AND deleted_at IS NULL AND NOT is_triage",
        )
        .bind(sid)
        .bind(project_id)
        .bind(workspace_id)
        .fetch_optional(&st.saturn.db)
        .await?;
        match valid {
            Some(id) => Some(id),
            None => default_backlog_state(&st.saturn.db, workspace_id, project_id)
                .await?
                .map(|r| r.0),
        }
    } else {
        default_backlog_state(&st.saturn.db, workspace_id, project_id)
            .await?
            .map(|r| r.0)
    };

    let priority = settings
        .and_then(|s| s.get("priority").and_then(|v| v.as_str()))
        .filter(|p| valid_priority(p))
        .unwrap_or("medium")
        .to_string();

    let raw_labels = parse_uuid_array(settings.and_then(|s| s.get("label_ids")));
    let label_ids: Vec<Uuid> = if raw_labels.is_empty() {
        vec![]
    } else {
        sqlx::query_scalar(
            "SELECT id FROM labels WHERE workspace_id = $1 AND project_id = $2 AND deleted_at IS NULL AND id = ANY($3)",
        )
        .bind(workspace_id)
        .bind(project_id)
        .bind(&raw_labels)
        .fetch_all(&st.saturn.db)
        .await?
    };

    let sync_status_notes = settings
        .and_then(|s| s.get("sync_status_notes").and_then(|v| v.as_bool()))
        .unwrap_or(true);

    Ok(Some(ResolvedConfig {
        configured,
        workspace_id,
        workspace_slug,
        project_id,
        project_identifier,
        target_mode,
        state_id,
        priority,
        label_ids,
        sync_status_notes,
    }))
}

async fn get_config(
    State(st): State<OrbitState>,
    user: pulsar::common::CurrentUser,
    Path(account_id): Path<i64>,
) -> pulsar::common::ApiResult {
    pulsar::common::require_account(&st.pulsar.db, &user, account_id).await?;
    let resolved = resolve_account_config(&st, account_id).await?;
    Ok(Json(match resolved {
        Some(cfg) => json!({
            "configured": cfg.configured,
            "config": cfg.to_json(),
        }),
        None => json!({
            "configured": false,
            "config": null,
        }),
    }))
}

async fn put_config(
    State(st): State<OrbitState>,
    user: pulsar::common::CurrentUser,
    Path(account_id): Path<i64>,
    Json(body): Json<Value>,
) -> pulsar::common::ApiResult {
    pulsar::common::require_account(&st.pulsar.db, &user, account_id).await?;

    let workspace_id = parse_uuid_val(body.get("workspace_id"))
        .ok_or_else(|| pulsar::common::ApiError::bad("workspace_id is required"))?;
    let project_id = parse_uuid_val(body.get("project_id"))
        .ok_or_else(|| pulsar::common::ApiError::bad("project_id is required"))?;

    let workspace_slug: String = sqlx::query_scalar(
        "SELECT slug FROM workspaces WHERE id = $1 AND deleted_at IS NULL",
    )
    .bind(workspace_id)
    .fetch_optional(&st.saturn.db)
    .await?
    .ok_or_else(|| pulsar::common::ApiError::bad("Invalid workspace_id"))?;

    let project_identifier: String = sqlx::query_scalar(
        "SELECT identifier FROM projects WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL AND archived_at IS NULL",
    )
    .bind(project_id)
    .bind(workspace_id)
    .fetch_optional(&st.saturn.db)
    .await?
    .ok_or_else(|| pulsar::common::ApiError::bad("Invalid project_id"))?;

    let target_mode = body
        .get("target_mode")
        .and_then(|v| v.as_str())
        .unwrap_or("work_item");
    if !valid_mode(target_mode) {
        return Err(pulsar::common::ApiError::bad(
            "target_mode must be 'work_item' or 'intake'",
        ));
    }

    let state_id = match parse_uuid_val(body.get("state_id")) {
        Some(sid) => {
            let exists: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM states WHERE id = $1 AND project_id = $2 AND workspace_id = $3 AND deleted_at IS NULL AND NOT is_triage)",
            )
            .bind(sid)
            .bind(project_id)
            .bind(workspace_id)
            .fetch_one(&st.saturn.db)
            .await?;
            if !exists {
                return Err(pulsar::common::ApiError::bad("Invalid state_id for selected project"));
            }
            Some(sid)
        }
        None => default_backlog_state(&st.saturn.db, workspace_id, project_id)
            .await?
            .map(|r| r.0),
    };

    let priority = body
        .get("priority")
        .and_then(|v| v.as_str())
        .unwrap_or("medium");
    if !valid_priority(priority) {
        return Err(pulsar::common::ApiError::bad("Invalid priority"));
    }

    let raw_labels = parse_uuid_array(body.get("label_ids"));
    let label_ids: Vec<Uuid> = if raw_labels.is_empty() {
        vec![]
    } else {
        sqlx::query_scalar(
            "SELECT id FROM labels WHERE workspace_id = $1 AND project_id = $2 AND deleted_at IS NULL AND id = ANY($3)",
        )
        .bind(workspace_id)
        .bind(project_id)
        .bind(&raw_labels)
        .fetch_all(&st.saturn.db)
        .await?
    };

    let sync_status_notes = body
        .get("sync_status_notes")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);

    let cfg = ResolvedConfig {
        configured: true,
        workspace_id,
        workspace_slug,
        project_id,
        project_identifier,
        target_mode: target_mode.to_string(),
        state_id,
        priority: priority.to_string(),
        label_ids,
        sync_status_notes,
    };
    let settings = cfg.to_json();
    pulsar::integrations::upsert_hook(
        &st.pulsar.db,
        account_id,
        "orbit",
        "in-process",
        Some(&workspace_id.to_string()),
        settings.clone(),
    )
    .await?;

    Ok(Json(json!({
        "configured": true,
        "config": settings,
    })))
}

async fn get_meta(
    State(st): State<OrbitState>,
    user: pulsar::common::CurrentUser,
    Path(account_id): Path<i64>,
    Query(q): Query<HashMap<String, String>>,
) -> pulsar::common::ApiResult {
    pulsar::common::require_account(&st.pulsar.db, &user, account_id).await?;

    let ws_filter = q
        .get("workspace_id")
        .and_then(|s| Uuid::parse_str(s.trim()).ok());
    let proj_filter = q
        .get("project_id")
        .and_then(|s| Uuid::parse_str(s.trim()).ok());

    let workspaces: Vec<(Uuid, String, String)> = sqlx::query_as(
        "SELECT id, name, slug FROM workspaces WHERE deleted_at IS NULL ORDER BY created_at, name",
    )
    .fetch_all(&st.saturn.db)
    .await?;

    let projects: Vec<(Uuid, String, String, Uuid)> = sqlx::query_as(
        "SELECT id, name, identifier, workspace_id
         FROM projects
         WHERE deleted_at IS NULL AND archived_at IS NULL
           AND ($1::uuid IS NULL OR workspace_id = $1)
         ORDER BY created_at, name",
    )
    .bind(ws_filter)
    .fetch_all(&st.saturn.db)
    .await?;

    let states: Vec<(Uuid, String, String, String, bool, bool, Uuid)> = sqlx::query_as(
        "SELECT id, name, color, \"group\", \"default\", is_triage, project_id
         FROM states
         WHERE deleted_at IS NULL AND NOT is_triage
           AND ($1::uuid IS NULL OR workspace_id = $1)
           AND ($2::uuid IS NULL OR project_id = $2)
         ORDER BY sequence, name",
    )
    .bind(ws_filter)
    .bind(proj_filter)
    .fetch_all(&st.saturn.db)
    .await?;

    let labels: Vec<(Uuid, String, String, Uuid)> = sqlx::query_as(
        "SELECT id, name, color, project_id
         FROM labels
         WHERE deleted_at IS NULL
           AND ($1::uuid IS NULL OR workspace_id = $1)
           AND ($2::uuid IS NULL OR project_id = $2)
         ORDER BY sort_order, name",
    )
    .bind(ws_filter)
    .bind(proj_filter)
    .fetch_all(&st.saturn.db)
    .await?;

    Ok(Json(json!({
        "workspaces": workspaces.into_iter().map(|(id, name, slug)| json!({
            "id": id, "name": name, "slug": slug,
        })).collect::<Vec<_>>(),
        "projects": projects.into_iter().map(|(id, name, identifier, workspace_id)| json!({
            "id": id, "name": name, "identifier": identifier, "workspace_id": workspace_id,
        })).collect::<Vec<_>>(),
        "states": states.into_iter().map(|(id, name, color, group, is_default, is_triage, project_id)| json!({
            "id": id, "name": name, "color": color, "group": group, "default": is_default, "is_triage": is_triage, "project_id": project_id,
        })).collect::<Vec<_>>(),
        "labels": labels.into_iter().map(|(id, name, color, project_id)| json!({
            "id": id, "name": name, "color": color, "project_id": project_id,
        })).collect::<Vec<_>>(),
    })))
}

async fn resolve_saturn_actor(
    db: &PgPool,
    email: &str,
    workspace_id: Uuid,
) -> Result<Uuid, pulsar::common::ApiError> {
    if !email.trim().is_empty() {
        let by_email: Option<Uuid> = sqlx::query_scalar(
            "SELECT id FROM users WHERE lower(email) = lower($1) AND is_active LIMIT 1",
        )
        .bind(email.trim())
        .fetch_optional(db)
        .await?;
        if let Some(id) = by_email {
            return Ok(id);
        }
    }
    let member: Option<Uuid> = sqlx::query_scalar(
        "SELECT member_id FROM workspace_members
         WHERE workspace_id = $1 AND deleted_at IS NULL AND is_active
         ORDER BY role DESC, created_at LIMIT 1",
    )
    .bind(workspace_id)
    .fetch_optional(db)
    .await?;
    if let Some(id) = member {
        return Ok(id);
    }
    let owner: Option<Uuid> =
        sqlx::query_scalar("SELECT owner_id FROM workspaces WHERE id = $1 AND deleted_at IS NULL")
            .bind(workspace_id)
            .fetch_optional(db)
            .await?;
    owner.ok_or_else(|| pulsar::common::ApiError::bad("No active Saturn user found for workspace"))
}

async fn ensure_default_intake(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    workspace_id: Uuid,
    project_id: Uuid,
    user_id: Uuid,
) -> Result<Uuid, sqlx::Error> {
    if let Some(id) = sqlx::query_scalar::<_, Uuid>(
        "SELECT id FROM intakes WHERE project_id = $1 AND deleted_at IS NULL ORDER BY created_at LIMIT 1",
    )
    .bind(project_id)
    .fetch_optional(&mut **tx)
    .await?
    {
        return Ok(id);
    }
    sqlx::query_scalar(
        "INSERT INTO intakes (id, name, description, is_default, view_props, logo_props, project_id, workspace_id,
             created_by_id, updated_by_id, created_at, updated_at)
         VALUES (gen_random_uuid(), 'Intake', '', true, '{}'::jsonb, '{}'::jsonb, $1, $2, $3, $3, now(), now())
         RETURNING id",
    )
    .bind(project_id)
    .bind(workspace_id)
    .bind(user_id)
    .fetch_one(&mut **tx)
    .await
}

async fn create_issue(
    State(st): State<OrbitState>,
    user: pulsar::common::CurrentUser,
    Path(account_id): Path<i64>,
    Json(body): Json<Value>,
) -> pulsar::common::ApiResult<(StatusCode, Json<Value>)> {
    pulsar::common::require_account(&st.pulsar.db, &user, account_id).await?;

    let conv_disp_id = body["conversation_id"]
        .as_i64()
        .or_else(|| body["conversation_id"].as_str().and_then(|s| s.parse().ok()))
        .ok_or_else(|| pulsar::common::ApiError::bad("conversation_id is required"))?;

    let message_id = body["message_id"]
        .as_i64()
        .or_else(|| body["message_id"].as_str().and_then(|s| s.parse().ok()));
    let include_attachments = body
        .get("include_attachments")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);

    let title = body["title"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty() && s.chars().count() <= 255)
        .ok_or_else(|| {
            pulsar::common::ApiError::bad("title is required (max 255 characters)")
        })?;

    let conv_row: Option<(i64, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT c.id::bigint, ct.name, ct.email
         FROM conversations c
         LEFT JOIN contacts ct ON ct.id = c.contact_id
         WHERE c.account_id = $1 AND c.display_id = $2",
    )
    .bind(account_id)
    .bind(conv_disp_id)
    .fetch_optional(&st.pulsar.db)
    .await?;
    let (conv_id, contact_name, contact_email) =
        conv_row.ok_or_else(pulsar::common::ApiError::not_found)?;

    let msg_content: Option<String> = if let Some(mid) = message_id {
        sqlx::query_scalar(
            "SELECT content FROM messages WHERE id = $1 AND conversation_id = $2 AND account_id = $3",
        )
        .bind(mid)
        .bind(conv_id)
        .bind(account_id as i32)
        .fetch_optional(&st.pulsar.db)
        .await?
        .flatten()
    } else {
        None
    };

    let defaults = resolve_account_config(&st, account_id).await?;

    let workspace_id = parse_uuid_val(body.get("workspace_id"))
        .or_else(|| defaults.as_ref().map(|c| c.workspace_id))
        .ok_or_else(|| pulsar::common::ApiError::bad("No Saturn workspace configured or found"))?;
    let workspace_slug: String = sqlx::query_scalar(
        "SELECT slug FROM workspaces WHERE id = $1 AND deleted_at IS NULL",
    )
    .bind(workspace_id)
    .fetch_optional(&st.saturn.db)
    .await?
    .ok_or_else(|| pulsar::common::ApiError::bad("Invalid Saturn workspace_id"))?;

    let project_id = parse_uuid_val(body.get("project_id"))
        .or_else(|| {
            defaults
                .as_ref()
                .filter(|c| c.workspace_id == workspace_id)
                .map(|c| c.project_id)
        });
    let (project_id, project_identifier): (Uuid, String) = if let Some(pid) = project_id {
        sqlx::query_as(
            "SELECT id, identifier FROM projects WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL AND archived_at IS NULL",
        )
        .bind(pid)
        .bind(workspace_id)
        .fetch_optional(&st.saturn.db)
        .await?
        .ok_or_else(|| pulsar::common::ApiError::bad("Invalid Saturn project_id"))?
    } else {
        sqlx::query_as(
            "SELECT id, identifier FROM projects WHERE workspace_id = $1 AND deleted_at IS NULL AND archived_at IS NULL ORDER BY created_at LIMIT 1",
        )
        .bind(workspace_id)
        .fetch_optional(&st.saturn.db)
        .await?
        .ok_or_else(|| pulsar::common::ApiError::bad("No active Saturn project in workspace"))?
    };

    let target_mode = body
        .get("target_mode")
        .and_then(|v| v.as_str())
        .or_else(|| defaults.as_ref().map(|c| c.target_mode.as_str()))
        .unwrap_or("work_item")
        .to_string();
    if !valid_mode(&target_mode) {
        return Err(pulsar::common::ApiError::bad(
            "target_mode must be 'work_item' or 'intake'",
        ));
    }

    let priority = body
        .get("priority")
        .and_then(|v| v.as_str())
        .or_else(|| defaults.as_ref().map(|c| c.priority.as_str()))
        .unwrap_or("medium")
        .to_string();
    if !valid_priority(&priority) {
        return Err(pulsar::common::ApiError::bad("Invalid priority"));
    }

    let explicit_state_id = parse_uuid_val(body.get("state_id"));
    let requested_labels = if body.get("label_ids").is_some() {
        parse_uuid_array(body.get("label_ids"))
    } else {
        defaults
            .as_ref()
            .filter(|c| c.project_id == project_id)
            .map(|c| c.label_ids.clone())
            .unwrap_or_default()
    };

    let actor_id = resolve_saturn_actor(&st.saturn.db, &user.email, workspace_id).await?;
    let conv_url = format!(
        "{}/app/accounts/{}/conversations/{}",
        st.pulsar.frontend_url.trim_end_matches('/'),
        account_id,
        conv_disp_id
    );

    let desc_body = body
        .get("description")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or(msg_content)
        .unwrap_or_default();

    let client_label = match (
        contact_name.as_deref().filter(|s| !s.is_empty()),
        contact_email.as_deref().filter(|s| !s.is_empty()),
    ) {
        (Some(n), Some(e)) => format!("{n} ({e})"),
        (Some(n), None) => n.to_string(),
        (None, Some(e)) => e.to_string(),
        (None, None) => "Unknown contact".to_string(),
    };
    let reported_by = if user.name.trim().is_empty() {
        user.email.as_str()
    } else {
        user.name.as_str()
    };

    let mut raw_html = String::new();
    if !desc_body.is_empty() {
        raw_html.push_str("<p>");
        raw_html.push_str(&html_escape(&desc_body).replace('\n', "<br/>"));
        raw_html.push_str("</p>");
    }

    // Carry over Pulsar message attachments to Saturn storage when requested.
    struct CopiedAsset {
        id: Uuid,
        name: String,
        content_type: String,
        saturn_key: String,
        size: usize,
        url: String,
    }
    let mut copied_assets: Vec<CopiedAsset> = Vec::new();
    if include_attachments && let Some(mid) = message_id {
        let rows: Vec<(String, String, String)> = sqlx::query_as(
            "SELECT b.key, b.filename, COALESCE(NULLIF(b.content_type, ''), 'application/octet-stream')
             FROM attachments at
             JOIN active_storage_attachments asa
               ON asa.record_type = 'Attachment' AND asa.record_id = at.id AND asa.name = 'file'
             JOIN active_storage_blobs b ON b.id = asa.blob_id
             WHERE at.message_id = $1 AND at.account_id = $2
             ORDER BY at.id",
        )
        .bind(mid)
        .bind(account_id as i32)
        .fetch_all(&st.pulsar.db)
        .await?;

        for (blob_key, filename, content_type) in rows {
            if !pulsar::storage::valid_key(&blob_key) {
                continue;
            }
            let src_path = pulsar::storage::blob_path(&blob_key);
            let Ok(bytes) = tokio::fs::read(&src_path).await else {
                tracing::warn!(key = %blob_key, "orbit attachment source blob missing on disk");
                continue;
            };
            if bytes.len() as i64 > st.saturn.cfg.file_size_limit {
                tracing::warn!(filename = %filename, size = bytes.len(), "orbit attachment exceeds Saturn file_size_limit");
                continue;
            }
            let asset_id = Uuid::new_v4();
            let clean_name = saturn::assets::sanitize_filename(&filename);
            let saturn_key = format!("{workspace_id}/{}-{clean_name}", asset_id.simple());
            let dst_path = st.saturn.cfg.storage_dir.join(&saturn_key);
            if let Some(parent) = dst_path.parent() {
                if let Err(e) = tokio::fs::create_dir_all(parent).await {
                    tracing::warn!(error = %e, "could not create Saturn attachment directory");
                    continue;
                }
            }
            if let Err(e) = tokio::fs::write(&dst_path, &bytes).await {
                tracing::warn!(error = %e, "could not write Saturn attachment file");
                continue;
            }
            let url = format!("/api/assets/v2/workspaces/{workspace_slug}/{asset_id}/");
            raw_html.push_str(&format!(
                "<p><strong>Attachment:</strong> <a href=\"{}\">{}</a></p>",
                html_escape(&url),
                html_escape(&clean_name),
            ));
            copied_assets.push(CopiedAsset {
                id: asset_id,
                name: clean_name,
                content_type,
                saturn_key,
                size: bytes.len(),
                url,
            });
        }
    }

    raw_html.push_str(&format!(
        "<p><strong>Client:</strong> {}<br/><strong>Reported by CS:</strong> {}<br/><strong>Conversation:</strong> <a href=\"{}\">#{}</a></p>",
        html_escape(&client_label),
        html_escape(reported_by),
        html_escape(&conv_url),
        conv_disp_id,
    ));
    let html = saturn::common::sanitize_html(&raw_html)
        .map_err(|_| pulsar::common::ApiError::bad("Invalid description content"))?;
    let stripped = saturn::common::strip_tags(&html);

    let mut tx = st.saturn.db.begin().await?;

    // Match saturn's advisory lock key (SHA-256 of project_id) so sequence_id never races.
    let digest = Sha256::digest(project_id.to_string().as_bytes());
    let lock = i64::from_be_bytes(digest[..8].try_into().expect("SHA-256 length"));
    sqlx::query("SELECT pg_advisory_xact_lock($1)")
        .bind(lock)
        .execute(&mut *tx)
        .await?;

    let (state_id, state_name, state_color, state_group): (Uuid, String, String, String) =
        if target_mode == "intake" {
            let existing: Option<(Uuid, String, String, String)> = sqlx::query_as(
                "SELECT id, name, color, \"group\" FROM states
                 WHERE project_id = $1 AND workspace_id = $2 AND is_triage AND deleted_at IS NULL LIMIT 1",
            )
            .bind(project_id)
            .bind(workspace_id)
            .fetch_optional(&mut *tx)
            .await?;
            match existing {
                Some(s) => s,
                None => {
                    let tid: Uuid = sqlx::query_scalar(
                        "INSERT INTO states (name, color, \"group\", \"default\", is_triage, sequence, slug, project_id, workspace_id, created_by_id, updated_by_id)
                         VALUES ('Triage', '#4E5355', 'triage', false, true, 65000, 'triage', $1, $2, $3, $3)
                         RETURNING id",
                    )
                    .bind(project_id)
                    .bind(workspace_id)
                    .bind(actor_id)
                    .fetch_one(&mut *tx)
                    .await?;
                    (tid, "Triage".into(), "#4E5355".into(), "triage".into())
                }
            }
        } else if let Some(sid) = explicit_state_id {
            sqlx::query_as(
                "SELECT id, name, color, \"group\" FROM states
                 WHERE id = $1 AND project_id = $2 AND workspace_id = $3 AND deleted_at IS NULL AND NOT is_triage",
            )
            .bind(sid)
            .bind(project_id)
            .bind(workspace_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| pulsar::common::ApiError::bad("Invalid state_id for selected project"))?
        } else if let Some(cfg_sid) = defaults
            .as_ref()
            .filter(|c| c.project_id == project_id)
            .and_then(|c| c.state_id)
        {
            if let Some(row) = sqlx::query_as::<_, (Uuid, String, String, String)>(
                "SELECT id, name, color, \"group\" FROM states
                 WHERE id = $1 AND project_id = $2 AND workspace_id = $3 AND deleted_at IS NULL AND NOT is_triage",
            )
            .bind(cfg_sid)
            .bind(project_id)
            .bind(workspace_id)
            .fetch_optional(&mut *tx)
            .await?
            {
                row
            } else {
                sqlx::query_as(
                    "SELECT id, name, color, \"group\" FROM states
                     WHERE project_id = $1 AND workspace_id = $2 AND deleted_at IS NULL AND NOT is_triage
                     ORDER BY (\"group\" = 'backlog') DESC, (lower(name) LIKE '%backlog%') DESC, \"default\" DESC, sequence
                     LIMIT 1",
                )
                .bind(project_id)
                .bind(workspace_id)
                .fetch_optional(&mut *tx)
                .await?
                .ok_or_else(|| pulsar::common::ApiError::bad("Project has no active states"))?
            }
        } else {
            sqlx::query_as(
                "SELECT id, name, color, \"group\" FROM states
                 WHERE project_id = $1 AND workspace_id = $2 AND deleted_at IS NULL AND NOT is_triage
                 ORDER BY (\"group\" = 'backlog') DESC, (lower(name) LIKE '%backlog%') DESC, \"default\" DESC, sequence
                 LIMIT 1",
            )
            .bind(project_id)
            .bind(workspace_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| pulsar::common::ApiError::bad("Project has no active states"))?
        };

    let completed_at: Option<chrono::DateTime<chrono::Utc>> =
        if matches!(state_group.as_str(), "completed" | "cancelled") {
            Some(chrono::Utc::now())
        } else {
            None
        };

    let sequence: i64 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(sequence), 0) + 1 FROM issue_sequences WHERE project_id = $1 AND workspace_id = $2 AND deleted_at IS NULL",
    )
    .bind(project_id)
    .bind(workspace_id)
    .fetch_one(&mut *tx)
    .await?;
    let seq_i32 = i32::try_from(sequence)
        .map_err(|_| pulsar::common::ApiError::bad("Issue sequence exhausted"))?;

    let issue_id: Uuid = sqlx::query_scalar(
        "INSERT INTO issues (name, project_id, workspace_id, state_id, sequence_id, created_by_id, updated_by_id,
            sort_order, completed_at, priority, description_html, description_stripped, description_json, is_draft)
         VALUES ($1, $2, $3, $4, $5, $6, $6,
            COALESCE((SELECT MAX(sort_order) + 10000 FROM issues WHERE project_id = $2 AND workspace_id = $3 AND state_id = $4 AND deleted_at IS NULL), 65535),
            $7, $8, $9, $10, '{}'::jsonb, false)
         RETURNING id",
    )
    .bind(title)
    .bind(project_id)
    .bind(workspace_id)
    .bind(state_id)
    .bind(seq_i32)
    .bind(actor_id)
    .bind(completed_at)
    .bind(&priority)
    .bind(&html)
    .bind(&stripped)
    .fetch_one(&mut *tx)
    .await?;

    sqlx::query(
        "INSERT INTO issue_sequences (issue_id, project_id, workspace_id, sequence, created_by_id, updated_by_id)
         VALUES ($1, $2, $3, $4, $5, $5)",
    )
    .bind(issue_id)
    .bind(project_id)
    .bind(workspace_id)
    .bind(sequence)
    .bind(actor_id)
    .execute(&mut *tx)
    .await?;

    if target_mode == "intake" {
        let intake_id = ensure_default_intake(&mut tx, workspace_id, project_id, actor_id).await?;
        sqlx::query(
            "INSERT INTO intake_issues (status, source, intake_id, issue_id, project_id, workspace_id, created_by_id, updated_by_id)
             VALUES (-2, 'IN_APP', $1, $2, $3, $4, $5, $5)",
        )
        .bind(intake_id)
        .bind(issue_id)
        .bind(project_id)
        .bind(workspace_id)
        .bind(actor_id)
        .execute(&mut *tx)
        .await?;
    }

    for lid in &requested_labels {
        sqlx::query(
            "INSERT INTO issue_labels (issue_id, project_id, workspace_id, label_id, created_by_id, updated_by_id)
             SELECT $1, $2, $3, $4, $5, $5
             WHERE EXISTS (SELECT 1 FROM labels WHERE id = $4 AND project_id = $2 AND workspace_id = $3 AND deleted_at IS NULL)",
        )
        .bind(issue_id)
        .bind(project_id)
        .bind(workspace_id)
        .bind(lid)
        .bind(actor_id)
        .execute(&mut *tx)
        .await?;
    }

    saturn::activity::record(
        &mut *tx,
        saturn::activity::ActivityEvent::new(
            issue_id,
            project_id,
            workspace_id,
            actor_id,
            "created",
            "created the issue",
        ),
    )
    .await?;

    for a in &copied_assets {
        sqlx::query(
            "INSERT INTO file_assets
               (id, attributes, asset, size, workspace_id, created_by_id, updated_by_id,
                entity_type, entity_identifier, project_id, issue_id, is_uploaded)
             VALUES ($1, $2, $3, $4, $5, $6, $6, 'ISSUE_ATTACHMENT', $7, $8, $9, true)",
        )
        .bind(a.id)
        .bind(json!({
            "name": a.name,
            "type": a.content_type,
            "size": a.size,
        }))
        .bind(&a.saturn_key)
        .bind(a.size as f64)
        .bind(workspace_id)
        .bind(actor_id)
        .bind(issue_id.to_string())
        .bind(project_id)
        .bind(issue_id)
        .execute(&mut *tx)
        .await?;

        let mut att_ev = saturn::activity::ActivityEvent::new(
            issue_id,
            project_id,
            workspace_id,
            actor_id,
            "created",
            "created an attachment",
        );
        att_ev.field = Some("attachment");
        att_ev.new_value = Some(&a.name);
        att_ev.new_identifier = Some(a.id);
        saturn::activity::record(&mut *tx, att_ev).await?;
    }

    let link_meta = json!({
        "source": "orbit_pulsar",
        "account_id": account_id,
        "conversation_display_id": conv_disp_id,
        "message_id": message_id,
    });
    let link_id: Uuid = sqlx::query_scalar(
        "INSERT INTO issue_links (workspace_id, project_id, issue_id, url, title, metadata, created_by_id, updated_by_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
         RETURNING id",
    )
    .bind(workspace_id)
    .bind(project_id)
    .bind(issue_id)
    .bind(&conv_url)
    .bind(format!("CS Conversation #{conv_disp_id}"))
    .bind(&link_meta)
    .bind(actor_id)
    .fetch_one(&mut *tx)
    .await?;

    tx.commit().await?;

    saturn::webhook_out::emit(
        &st.saturn,
        workspace_id,
        "issue",
        "created",
        json!({ "id": issue_id }),
        actor_id,
    );

    let identifier = format!("{project_identifier}-{seq_i32}");
    let issue_url = if target_mode == "intake" {
        format!("/{workspace_slug}/projects/{project_id}/intake")
    } else {
        format!("/{workspace_slug}/projects/{project_id}/issues/{issue_id}")
    };

    if let Ok(conv) = pulsar::conversations::reload(&st.pulsar.db, conv_id).await {
        let dest = if target_mode == "intake" {
            "Intake".to_string()
        } else {
            state_name.clone()
        };
        let _ = pulsar::conversations::insert_message(
            &st.pulsar,
            &conv,
            Some(("User", user.id)),
            &format!("Reported bug {identifier} to Saturn ({dest}): {title}"),
            2,
            false,
            0,
            json!({}),
            None,
        )
        .await;
    }

    let attachments_json: Vec<Value> = copied_assets
        .iter()
        .map(|a| {
            json!({
                "id": a.id,
                "name": a.name,
                "content_type": a.content_type,
                "size": a.size,
                "url": a.url,
            })
        })
        .collect();

    Ok((
        StatusCode::CREATED,
        Json(json!({
            "id": issue_id,
            "link_id": link_id,
            "identifier": identifier,
            "name": title,
            "priority": priority,
            "target_mode": target_mode,
            "workspace_id": workspace_id,
            "workspace_slug": workspace_slug,
            "project_id": project_id,
            "state": {
                "id": state_id,
                "name": state_name,
                "color": state_color,
                "group": state_group,
            },
            "url": issue_url,
            "attachments_copied": attachments_json,
        })),
    ))
}

async fn linked_issues(
    State(st): State<OrbitState>,
    user: pulsar::common::CurrentUser,
    Path(account_id): Path<i64>,
    Query(q): Query<HashMap<String, String>>,
) -> pulsar::common::ApiResult {
    pulsar::common::require_account(&st.pulsar.db, &user, account_id).await?;
    let conv_disp_id = q
        .get("conversation_id")
        .and_then(|s| s.parse::<i64>().ok())
        .ok_or_else(|| pulsar::common::ApiError::bad("conversation_id is required"))?;
    let suffix = format!("%/app/accounts/{account_id}/conversations/{conv_disp_id}");

    type Row = (
        Uuid,
        Uuid,
        String,
        String,
        String,
        String,
        Uuid,
        Option<Uuid>,
        Option<String>,
        Option<String>,
        Option<String>,
        bool,
    );
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT l.id, i.id, p.identifier || '-' || i.sequence_id AS identifier,
                i.name, i.priority, w.slug, i.project_id,
                s.id, s.name, s.color, s.\"group\",
                EXISTS(SELECT 1 FROM intake_issues ii WHERE ii.issue_id = i.id AND ii.deleted_at IS NULL) AS is_intake
         FROM issue_links l
         JOIN issues i ON i.id = l.issue_id AND i.deleted_at IS NULL
         JOIN projects p ON p.id = i.project_id AND p.deleted_at IS NULL
         JOIN workspaces w ON w.id = i.workspace_id AND w.deleted_at IS NULL
         LEFT JOIN states s ON s.id = i.state_id AND s.deleted_at IS NULL
         WHERE l.deleted_at IS NULL
           AND (
             (l.metadata->>'source' = 'orbit_pulsar'
              AND (l.metadata->>'account_id')::bigint = $1
              AND (l.metadata->>'conversation_display_id')::bigint = $2)
             OR l.url LIKE $3
           )
         ORDER BY l.created_at DESC",
    )
    .bind(account_id)
    .bind(conv_disp_id)
    .bind(&suffix)
    .fetch_all(&st.saturn.db)
    .await?;

    let items: Vec<Value> = rows
        .into_iter()
        .map(
            |(
                link_id,
                id,
                identifier,
                name,
                priority,
                workspace_slug,
                project_id,
                state_id,
                state_name,
                state_color,
                state_group,
                is_intake,
            )| {
                let url = if is_intake {
                    format!("/{workspace_slug}/projects/{project_id}/intake")
                } else {
                    format!("/{workspace_slug}/projects/{project_id}/issues/{id}")
                };
                json!({
                    "link_id": link_id,
                    "id": id,
                    "identifier": identifier,
                    "name": name,
                    "priority": priority,
                    "workspace_slug": workspace_slug,
                    "project_id": project_id,
                    "is_intake": is_intake,
                    "url": url,
                    "state": state_id.map(|sid| json!({
                        "id": sid,
                        "name": state_name,
                        "color": state_color,
                        "group": state_group,
                    })),
                })
            },
        )
        .collect();

    Ok(Json(Value::Array(items)))
}

async fn unlink_issue(
    State(st): State<OrbitState>,
    user: pulsar::common::CurrentUser,
    Path(account_id): Path<i64>,
    Json(body): Json<Value>,
) -> pulsar::common::ApiResult {
    pulsar::common::require_account(&st.pulsar.db, &user, account_id).await?;
    let conv_disp_id = body["conversation_id"]
        .as_i64()
        .or_else(|| body["conversation_id"].as_str().and_then(|s| s.parse().ok()))
        .ok_or_else(|| pulsar::common::ApiError::bad("conversation_id is required"))?;
    let link_id = parse_uuid_val(body.get("link_id"))
        .ok_or_else(|| pulsar::common::ApiError::bad("link_id is required"))?;
    let suffix = format!("%/app/accounts/{account_id}/conversations/{conv_disp_id}");

    let res = sqlx::query(
        "UPDATE issue_links SET deleted_at = now(), updated_at = now()
         WHERE id = $1 AND deleted_at IS NULL
           AND (
             (metadata->>'source' = 'orbit_pulsar'
              AND (metadata->>'account_id')::bigint = $2
              AND (metadata->>'conversation_display_id')::bigint = $3)
             OR url LIKE $4
           )",
    )
    .bind(link_id)
    .bind(account_id)
    .bind(conv_disp_id)
    .bind(&suffix)
    .execute(&st.saturn.db)
    .await?;

    if res.rows_affected() == 0 {
        return Err(pulsar::common::ApiError::not_found());
    }

    if let Ok(conv_id) = sqlx::query_scalar::<_, i64>(
        "SELECT id::bigint FROM conversations WHERE account_id = $1 AND display_id = $2",
    )
    .bind(account_id)
    .bind(conv_disp_id)
    .fetch_one(&st.pulsar.db)
    .await
    {
        if let Ok(conv) = pulsar::conversations::reload(&st.pulsar.db, conv_id).await {
            let _ = pulsar::conversations::insert_message(
                &st.pulsar,
                &conv,
                Some(("User", user.id)),
                "Unlinked Saturn issue from conversation",
                2,
                false,
                0,
                json!({}),
                None,
            )
            .await;
        }
    }

    Ok(Json(json!({ "success": true })))
}

/// Seed a default Orbit integration hook for the first Pulsar account pointing to the first
/// Saturn workspace + project + Backlog state (if not already configured).
pub async fn seed_default_hook(st: &OrbitState) -> anyhow::Result<()> {
    let account_id: Option<i64> =
        sqlx::query_scalar("SELECT id::bigint FROM accounts ORDER BY id LIMIT 1")
            .fetch_optional(&st.pulsar.db)
            .await?;
    let Some(account_id) = account_id else {
        return Ok(());
    };
    if pulsar::integrations::load_hook(&st.pulsar.db, account_id, "orbit")
        .await
        .map_err(|e| anyhow::anyhow!("{}", e.1))?
        .is_some()
    {
        return Ok(());
    }
    if let Some(cfg) = resolve_account_config(st, account_id)
        .await
        .map_err(|e| anyhow::anyhow!("{}", e.1))?
    {
        pulsar::integrations::upsert_hook(
            &st.pulsar.db,
            account_id,
            "orbit",
            "in-process",
            Some(&cfg.workspace_id.to_string()),
            cfg.to_json(),
        )
        .await
        .map_err(|e| anyhow::anyhow!("{}", e.1))?;
        tracing::info!(
            account_id,
            workspace = %cfg.workspace_slug,
            project = %cfg.project_identifier,
            "seeded default Orbit Backlog integration"
        );
    }
    Ok(())
}

/// Listen to in-process Saturn issue updates and post a private note in linked Pulsar CS chats
/// whenever a linked bug's state changes.
pub fn spawn_status_sync(st: OrbitState) {
    let mut rx = saturn::webhook_out::subscribe_internal();
    tokio::spawn(async move {
        loop {
            let ev = match rx.recv().await {
                Ok(ev) => ev,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    tracing::warn!(lagged = n, "orbit status sync lagged internal events");
                    continue;
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            };
            if ev.event != "issue" || ev.action != "updated" {
                continue;
            }
            let state_changed = ev
                .changes
                .iter()
                .any(|(field, _, _)| field == "state" || field == "state_id");
            if !state_changed {
                continue;
            }
            let Some(issue_id) = ev
                .data
                .get("id")
                .and_then(|v| v.as_str())
                .and_then(|s| Uuid::parse_str(s).ok())
            else {
                continue;
            };
            let state_name = ev.data["state"]["name"]
                .as_str()
                .unwrap_or("Updated");
            let title = ev.data["name"].as_str().unwrap_or("Work item");

            let links: Vec<(Option<i64>, Option<i64>, String)> = match sqlx::query_as(
                "SELECT (l.metadata->>'account_id')::bigint,
                        (l.metadata->>'conversation_display_id')::bigint,
                        p.identifier || '-' || i.sequence_id
                 FROM issue_links l
                 JOIN issues i ON i.id = l.issue_id AND i.deleted_at IS NULL
                 JOIN projects p ON p.id = i.project_id AND p.deleted_at IS NULL
                 WHERE l.issue_id = $1
                   AND l.deleted_at IS NULL
                   AND l.metadata->>'source' = 'orbit_pulsar'",
            )
            .bind(issue_id)
            .fetch_all(&st.saturn.db)
            .await
            {
                Ok(rows) => rows,
                Err(e) => {
                    tracing::warn!(error = %e, "orbit status sync link lookup failed");
                    continue;
                }
            };

            for (acct_opt, conv_opt, identifier) in links {
                let (Some(account_id), Some(conv_disp_id)) = (acct_opt, conv_opt) else {
                    continue;
                };
                if let Ok(Some((_, _, _, settings, _))) =
                    pulsar::integrations::load_hook(&st.pulsar.db, account_id, "orbit").await
                {
                    if settings.get("sync_status_notes").and_then(|v| v.as_bool()) == Some(false) {
                        continue;
                    }
                }
                let Ok(Some(conv_id)) = sqlx::query_scalar::<_, i64>(
                    "SELECT id::bigint FROM conversations WHERE account_id = $1 AND display_id = $2",
                )
                .bind(account_id)
                .bind(conv_disp_id)
                .fetch_optional(&st.pulsar.db)
                .await
                else {
                    continue;
                };
                let Ok(conv) = pulsar::conversations::reload(&st.pulsar.db, conv_id).await else {
                    continue;
                };
                let note = format!(
                    "Orbit Backlog update: {identifier} \"{title}\" → {state_name}"
                );
                if let Err(e) = pulsar::conversations::insert_message(
                    &st.pulsar,
                    &conv,
                    None,
                    &note,
                    1,
                    true,
                    0,
                    json!({ "orbit_issue_id": issue_id }),
                    None,
                )
                .await
                {
                    tracing::warn!(error = %e.1, "orbit status sync failed to insert private note");
                }
            }
        }
    });
}
