//! Native pure-Rust WhatsApp Web (Linked Device / QR & Pair Code) channel manager
//! with anti-spam guardrails and lossless Cloud API upgrade support.

use std::{
    sync::{Arc, LazyLock},
    time::{Duration, Instant},
};

use dashmap::DashMap;
use qrcode::{QrCode, render::svg};
use serde::Serialize;
use serde_json::{Value, json};
use sqlx::{PgPool, Row};
use tokio::sync::{Mutex, RwLock};
use whatsapp_rust::{
    download::MediaType,
    media::{self, AudioOptions, DocumentOptions, ImageOptions, VideoOptions},
    pair_code::PairCodeOptions,
    prelude::*,
    upload::UploadOptions,
    wacore::download::Downloadable,
    wacore_binary::JidExt,
};

use crate::{
    common::{ApiError, AppState},
    conversations::{insert_message, reload},
};

pub const PROVIDER_WEB: &str = "whatsapp_web";

static SESSIONS: LazyLock<DashMap<i64, Arc<WaWebSession>>> = LazyLock::new(DashMap::new);

fn env_usize(key: &str, default: usize) -> usize {
    std::env::var(key)
        .ok()
        .and_then(|s| s.trim().parse::<usize>().ok())
        .filter(|&v| v > 0)
        .unwrap_or(default)
}

fn env_u64(key: &str, default: u64) -> u64 {
    std::env::var(key)
        .ok()
        .and_then(|s| s.trim().parse::<u64>().ok())
        .unwrap_or(default)
}

pub fn max_per_minute() -> usize {
    env_usize("WA_WEB_MAX_MSG_PER_MIN", 15)
}

pub fn max_per_hour() -> usize {
    env_usize("WA_WEB_MAX_MSG_PER_HOUR", 120)
}

pub fn max_new_contacts_per_hour() -> usize {
    env_usize("WA_WEB_MAX_NEW_CONTACTS_PER_HOUR", 5)
}

pub fn min_delay_ms() -> u64 {
    env_u64("WA_WEB_MIN_DELAY_MS", 1200)
}

pub fn anti_spam_policy_json() -> Value {
    json!({
        "broadcast_blocked": true,
        "max_outbound_per_minute": max_per_minute(),
        "max_outbound_per_hour": max_per_hour(),
        "max_new_contacts_per_hour": max_new_contacts_per_hour(),
        "min_delay_ms": min_delay_ms(),
    })
}

pub fn normalize_wa_digits(raw: &str) -> String {
    raw.chars().filter(|c| c.is_ascii_digit()).collect()
}

pub fn is_pending_phone(phone: &str) -> bool {
    phone.starts_with("qr-pending-")
}

pub fn render_qr_svg(code: &str) -> Option<String> {
    let qr = QrCode::new(code.as_bytes()).ok()?;
    Some(
        qr.render::<svg::Color>()
            .min_dimensions(240, 240)
            .dark_color(svg::Color("#0F172A"))
            .light_color(svg::Color("#FFFFFF"))
            .build(),
    )
}

pub(crate) async fn is_wa_web_inbox(db: &PgPool, inbox_id: i64) -> Result<bool, ApiError> {
    Ok(sqlx::query_scalar(
        "SELECT EXISTS(
            SELECT 1 FROM inboxes i
            JOIN channel_whatsapp w ON w.id = i.channel_id AND w.account_id = i.account_id
            WHERE i.id::bigint = $1 AND i.channel_type = 'Channel::Whatsapp' AND w.provider = $2
        )",
    )
    .bind(inbox_id)
    .bind(PROVIDER_WEB)
    .fetch_one(db)
    .await?)
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct SessionSnapshot {
    pub state: String,
    pub qr_code: Option<String>,
    pub qr_svg: Option<String>,
    pub qr_expires_at: Option<i64>,
    pub pair_code: Option<String>,
    pub phone_number: Option<String>,
    pub push_name: Option<String>,
    pub last_error: Option<String>,
}

struct WaWebSession {
    channel_id: i64,
    inbox_id: i64,
    account_id: i64,
    snapshot: RwLock<SessionSnapshot>,
    handle: Mutex<Option<BotHandle>>,
    client: RwLock<Option<Arc<Client>>>,
    send_gate: Mutex<Option<Instant>>,
}

impl WaWebSession {
    fn new(channel_id: i64, inbox_id: i64, account_id: i64) -> Self {
        Self {
            channel_id,
            inbox_id,
            account_id,
            snapshot: RwLock::new(SessionSnapshot {
                state: "connecting".into(),
                ..Default::default()
            }),
            handle: Mutex::new(None),
            client: RwLock::new(None),
            send_gate: Mutex::new(None),
        }
    }
}

pub async fn snapshot_for(channel_id: i64) -> SessionSnapshot {
    if let Some(sess) = SESSIONS.get(&channel_id) {
        sess.snapshot.read().await.clone()
    } else {
        SessionSnapshot {
            state: "disconnected".into(),
            ..Default::default()
        }
    }
}

pub fn status_summary(channel_id: i64) -> Option<Value> {
    let sess = SESSIONS.get(&channel_id)?;
    let snap = sess.snapshot.try_read().ok()?;
    Some(json!({
        "state": snap.state,
        "connected": snap.state == "connected",
        "push_name": snap.push_name,
    }))
}

pub async fn disconnect_session(
    db: &PgPool,
    channel_id: i64,
    logout_remote: bool,
    delete_store_data: bool,
) {
    if let Some((_, sess)) = SESSIONS.remove(&channel_id) {
        if logout_remote {
            let client_opt = sess.client.write().await.take();
            if let Some(client) = client_opt {
                let _ = tokio::time::timeout(Duration::from_secs(4), client.logout()).await;
            }
        } else {
            let _ = sess.client.write().await.take();
        }
        if let Some(handle) = sess.handle.lock().await.take() {
            let abort_copy = format!("wa_web ch={channel_id}");
            if tokio::time::timeout(Duration::from_secs(4), handle.shutdown())
                .await
                .is_err()
            {
                tracing::warn!("{abort_copy}: shutdown timed out");
            }
        }
    }
    if delete_store_data {
        if let Err(e) = super::whatsapp_web_store::PgWaStore::purge(db, channel_id).await {
            tracing::warn!(error = %e, channel_id, "failed to purge WA QR Postgres store");
        }
    }
}

pub async fn start_session(
    st: AppState,
    channel_id: i64,
    inbox_id: i64,
    account_id: i64,
    pair_phone: Option<String>,
) -> anyhow::Result<()> {
    disconnect_session(&st.db, channel_id, false, false).await;

    let sess = Arc::new(WaWebSession::new(channel_id, inbox_id, account_id));
    SESSIONS.insert(channel_id, sess.clone());

    if std::env::var("WA_WEB_DISABLE_CONNECT").as_deref() == Ok("1") {
        let mut snap = sess.snapshot.write().await;
        snap.state = "qr_ready".into();
        snap.last_error = None;
        return Ok(());
    }

    tokio::spawn(async move {
        let store = Arc::new(super::whatsapp_web_store::PgWaStore::new(
            st.db.clone(),
            channel_id,
        ));

        let s_qr = sess.clone();
        let s_pair = sess.clone();
        let s_conn = sess.clone();
        let st_conn = st.clone();
        let s_out = sess.clone();
        let db_out = st.db.clone();
        let s_msg = sess.clone();
        let st_msg = st.clone();

        let mut builder = Bot::builder()
            .with_backend_arc(store)
            .on_qr_code(move |code, timeout| {
                let s = s_qr.clone();
                async move {
                    let svg_xml = render_qr_svg(&code);
                    let exp = chrono::Utc::now().timestamp() + timeout.as_secs() as i64;
                    let mut snap = s.snapshot.write().await;
                    snap.state = "qr_ready".into();
                    snap.qr_code = Some(code);
                    snap.qr_svg = svg_xml;
                    snap.qr_expires_at = Some(exp);
                    snap.last_error = None;
                }
            })
            .on_pair_code(move |code, timeout| {
                let s = s_pair.clone();
                async move {
                    let exp = chrono::Utc::now().timestamp() + timeout.as_secs() as i64;
                    let mut snap = s.snapshot.write().await;
                    snap.pair_code = Some(code);
                    snap.qr_expires_at = Some(exp);
                }
            })
            .on_connected(move |client| {
                let s = s_conn.clone();
                let st_c = st_conn.clone();
                async move {
                    let digits = client
                        .pn()
                        .map(|j| normalize_wa_digits(&j.user))
                        .unwrap_or_default();
                    let push_name = client.push_name();
                    let phone_plus = if digits.is_empty() {
                        None
                    } else {
                        Some(format!("+{digits}"))
                    };

                    if let Some(ref phone) = phone_plus {
                        let dup: bool = sqlx::query_scalar(
                            "SELECT EXISTS(SELECT 1 FROM channel_whatsapp WHERE phone_number = $1 AND id::bigint <> $2)",
                        )
                        .bind(phone)
                        .bind(s.channel_id)
                        .fetch_one(&st_c.db)
                        .await
                        .unwrap_or(false);
                        if dup {
                            let mut snap = s.snapshot.write().await;
                            snap.state = "error".into();
                            snap.last_error = Some(format!(
                                "Phone number {phone} is already connected to another WhatsApp inbox"
                            ));
                            client.disconnect().await;
                            return;
                        }

                        let meta = json!({
                            "connected": true,
                            "push_name": push_name,
                            "linked_at": chrono::Utc::now().to_rfc3339(),
                        });
                        if let Err(e) = sqlx::query(
                            "UPDATE channel_whatsapp
                             SET phone_number = $1,
                                 provider_config = COALESCE(provider_config, '{}'::jsonb) || $2,
                                 updated_at = now()
                             WHERE id::bigint = $3",
                        )
                        .bind(phone)
                        .bind(&meta)
                        .bind(s.channel_id)
                        .execute(&st_c.db)
                        .await
                        {
                            tracing::warn!(error = %e, "failed to persist connected WA QR phone");
                        }
                        st_c.hub.invalidate_cache(s.account_id, "inbox");
                    }

                    *s.client.write().await = Some(client);
                    let mut snap = s.snapshot.write().await;
                    snap.state = "connected".into();
                    snap.qr_code = None;
                    snap.qr_svg = None;
                    snap.qr_expires_at = None;
                    snap.pair_code = None;
                    snap.phone_number = phone_plus;
                    snap.push_name = if push_name.trim().is_empty() {
                        None
                    } else {
                        Some(push_name)
                    };
                    snap.last_error = None;
                }
            })
            .on_logged_out(move |_info| {
                let s = s_out.clone();
                let db = db_out.clone();
                async move {
                    *s.client.write().await = None;
                    {
                        let mut snap = s.snapshot.write().await;
                        snap.state = "logged_out".into();
                        snap.qr_code = None;
                        snap.qr_svg = None;
                        snap.pair_code = None;
                    }
                    let _ = sqlx::query(
                        "UPDATE channel_whatsapp
                         SET provider_config = COALESCE(provider_config, '{}'::jsonb) || '{\"connected\":false}'::jsonb,
                             updated_at = now()
                         WHERE id::bigint = $1",
                    )
                    .bind(s.channel_id)
                    .execute(&db)
                    .await;
                    let _ = super::whatsapp_web_store::PgWaStore::purge(&db, s.channel_id).await;
                }
            })
            .on_message(move |ctx| {
                let s = s_msg.clone();
                let st_m = st_msg.clone();
                async move {
                    if let Err(e) = handle_inbound_message(&st_m, &s, ctx).await {
                        tracing::warn!(error = %e, channel_id = s.channel_id, "WA QR inbound error");
                    }
                }
            });

        if let Some(raw_phone) = pair_phone {
            let digits = normalize_wa_digits(&raw_phone);
            if digits.len() >= 8 {
                builder = builder.with_pair_code(PairCodeOptions {
                    phone_number: digits,
                    ..Default::default()
                });
            }
        }

        match builder.build().await {
            Ok(bot) => {
                let handle = bot.spawn();
                *sess.client.write().await = Some(handle.client());
                *sess.handle.lock().await = Some(handle);
                // Guard if session was removed while building
                if !SESSIONS.contains_key(&channel_id) {
                    if let Some(h) = sess.handle.lock().await.take() {
                        h.shutdown().await;
                    }
                }
            }
            Err(e) => {
                let mut snap = sess.snapshot.write().await;
                snap.state = "error".into();
                snap.last_error = Some(format!("WhatsApp QR client failed to start: {e}"));
            }
        }
    });

    Ok(())
}

pub async fn restore_all(st: AppState) {
    if std::env::var("WA_WEB_DISABLE_CONNECT").as_deref() == Ok("1") {
        return;
    }
    let rows: Vec<(i64, i64, i64, String)> = match sqlx::query_as(
        "SELECT w.id::bigint, i.id::bigint, i.account_id::bigint, w.phone_number
         FROM channel_whatsapp w
         JOIN inboxes i ON i.channel_id = w.id AND i.account_id = w.account_id
         WHERE i.channel_type = 'Channel::Whatsapp'
           AND w.provider = $1
           AND w.phone_number NOT LIKE 'qr-pending-%'",
    )
    .bind(PROVIDER_WEB)
    .fetch_all(&st.db)
    .await
    {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!(error = %e, "WA QR startup restore query failed");
            return;
        }
    };

    for (channel_id, inbox_id, account_id, _phone) in rows {
        if let Err(e) = start_session(st.clone(), channel_id, inbox_id, account_id, None).await {
            tracing::warn!(error = %e, channel_id, "failed to restore WA QR session");
        }
    }
}

fn resolve_sender_digits(ctx: &MessageContext) -> String {
    let sender = &ctx.info.source.sender;
    if sender.to_string().ends_with("@lid") {
        if let Some(alt) = ctx.info.source.sender_alt.as_ref() {
            let d = normalize_wa_digits(&alt.user);
            if !d.is_empty() {
                return d;
            }
        }
    }
    let primary = normalize_wa_digits(&sender.user);
    if !primary.is_empty() && !sender.to_string().ends_with("@lid") {
        return primary;
    }
    normalize_wa_digits(&ctx.info.source.chat.user)
}

async fn handle_inbound_message(
    st: &AppState,
    sess: &WaWebSession,
    ctx: MessageContext,
) -> anyhow::Result<()> {
    if ctx.info.source.is_from_me
        || ctx.info.source.is_group
        || ctx.info.source.chat.is_newsletter()
        || ctx.info.source.chat.is_status_broadcast()
    {
        return Ok(());
    }

    let from = resolve_sender_digits(&ctx);
    if from.is_empty() {
        return Ok(());
    }

    let msg_id = ctx.info.id.clone();
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM messages WHERE inbox_id = $1 AND source_id = $2)",
    )
    .bind(sess.inbox_id as i32)
    .bind(&msg_id)
    .fetch_one(&st.db)
    .await?;
    if exists {
        return Ok(());
    }

    let locked: bool = sqlx::query_scalar(
        "SELECT COALESCE(lock_to_single_conversation, false) FROM inboxes WHERE id = $1",
    )
    .bind(sess.inbox_id)
    .fetch_optional(&st.db)
    .await?
    .unwrap_or(false);

    let name = if ctx.info.push_name.trim().is_empty() {
        from.clone()
    } else {
        ctx.info.push_name.trim().to_string()
    };

    let row = sqlx::query(
        "SELECT id::bigint AS id, contact_id::bigint AS contact_id
         FROM contact_inboxes WHERE inbox_id = $1 AND source_id = $2",
    )
    .bind(sess.inbox_id as i32)
    .bind(&from)
    .fetch_optional(&st.db)
    .await?;

    let (ci, contact) = if let Some(r) = row {
        (r.try_get::<i64, _>("id")?, r.try_get::<i64, _>("contact_id")?)
    } else {
        let c: i64 = sqlx::query_scalar(
            "INSERT INTO contacts (name, phone_number, account_id, created_at, updated_at, last_activity_at)
             VALUES ($1, $2, $3, now(), now(), now()) RETURNING id::bigint",
        )
        .bind(&name)
        .bind(format!("+{from}"))
        .bind(sess.account_id as i32)
        .fetch_one(&st.db)
        .await?;
        let ci: i64 = sqlx::query_scalar(
            "INSERT INTO contact_inboxes (contact_id, inbox_id, source_id, created_at, updated_at, pubsub_token)
             VALUES ($1, $2, $3, now(), now(), $4) RETURNING id::bigint",
        )
        .bind(c)
        .bind(sess.inbox_id as i32)
        .bind(&from)
        .bind(uuid::Uuid::new_v4().to_string())
        .fetch_one(&st.db)
        .await?;
        (ci, c)
    };

    let conv_id: Option<i64> = sqlx::query_scalar(
        "SELECT id::bigint FROM conversations
         WHERE contact_inbox_id = $1 AND account_id = $2 AND ($3 OR status <> 1)
         ORDER BY id DESC LIMIT 1",
    )
    .bind(ci)
    .bind(sess.account_id as i32)
    .bind(locked)
    .fetch_optional(&st.db)
    .await?;
    let conv_id = match conv_id {
        Some(id) => id,
        None => sqlx::query_scalar(
            "INSERT INTO conversations
             (account_id, inbox_id, status, contact_id, contact_inbox_id, additional_attributes, custom_attributes, last_activity_at, created_at, updated_at)
             VALUES ($1, $2, 0, $3, $4, '{}', '{}', now(), now(), now())
             RETURNING id::bigint",
        )
        .bind(sess.account_id as i32)
        .bind(sess.inbox_id as i32)
        .bind(contact)
        .bind(ci)
        .fetch_one(&st.db)
        .await?,
    };

    let conv = reload(&st.db, conv_id)
        .await
        .map_err(|e| anyhow::anyhow!("reload conv failed: {}", e.1))?;

    let base = ctx.message.get_base_message();
    let mut content = ctx.message.text_content().unwrap_or_default().to_string();
    if content.is_empty() {
        if let Some(img) = base.image_message.as_option() {
            content = img.caption.clone().unwrap_or_default();
        } else if let Some(vid) = base.video_message.as_option() {
            content = vid.caption.clone().unwrap_or_default();
        } else if let Some(doc) = base.document_message.as_option() {
            content = doc.caption.clone().unwrap_or_default();
        }
    }

    let created = insert_message(
        st,
        &conv,
        Some(("Contact", contact)),
        &content,
        0,
        false,
        0,
        json!({ "__pulsar_source_id": msg_id }),
        None,
    )
    .await
    .map_err(|e| anyhow::anyhow!("insert_message failed: {}", e.1))?;

    if let Some(mid) = created["id"].as_i64() {
        if let Err(e) = ingest_media_attachment(st, sess.account_id, mid, &ctx).await {
            tracing::warn!(error = %e, "WA QR inbound media download failed");
        }
    }

    Ok(())
}

async fn ingest_media_attachment(
    st: &AppState,
    account_id: i64,
    message_id: i64,
    ctx: &MessageContext,
) -> anyhow::Result<()> {
    let base = ctx.message.get_base_message();
    let (bytes, filename, mime, file_type): (Vec<u8>, String, String, Option<i32>) =
        if let Some(img) = base.image_message.as_option() {
            (
                ctx.client.download(img as &dyn Downloadable).await?,
                "image.jpg".into(),
                img.mimetype.clone().unwrap_or_else(|| "image/jpeg".into()),
                Some(0),
            )
        } else if let Some(vid) = base.video_message.as_option() {
            (
                ctx.client.download(vid as &dyn Downloadable).await?,
                "video.mp4".into(),
                vid.mimetype.clone().unwrap_or_else(|| "video/mp4".into()),
                Some(2),
            )
        } else if let Some(aud) = base.audio_message.as_option() {
            (
                ctx.client.download(aud as &dyn Downloadable).await?,
                "audio.ogg".into(),
                aud.mimetype
                    .clone()
                    .unwrap_or_else(|| "audio/ogg; codecs=opus".into()),
                Some(1),
            )
        } else if let Some(doc) = base.document_message.as_option() {
            (
                ctx.client.download(doc as &dyn Downloadable).await?,
                doc.file_name
                    .clone()
                    .unwrap_or_else(|| "document".into()),
                doc.mimetype
                    .clone()
                    .unwrap_or_else(|| "application/octet-stream".into()),
                None,
            )
        } else if let Some(stk) = base.sticker_message.as_option() {
            (
                ctx.client.download(stk as &dyn Downloadable).await?,
                "sticker.webp".into(),
                stk.mimetype.clone().unwrap_or_else(|| "image/webp".into()),
                Some(0),
            )
        } else {
            return Ok(());
        };

    if bytes.len() > crate::storage::MAX_BYTES {
        anyhow::bail!("media too large");
    }

    crate::storage::attach_to_message(
        &st.db,
        account_id,
        message_id,
        &filename,
        &mime,
        &bytes,
        file_type,
    )
    .await
    .map_err(|e| anyhow::anyhow!("attach_to_message failed: {}", e.1))?;
    Ok(())
}

/// Outbound delivery for `whatsapp_web` inboxes with strict anti-spam guardrails.
pub async fn send_outbound(
    st: &AppState,
    channel_id: i64,
    inbox_id: i64,
    conv_id: i64,
    message_id: i64,
    account_id: i64,
    row: &sqlx::postgres::PgRow,
) -> anyhow::Result<()> {
    let res: anyhow::Result<String> = async {
        let attrs: Option<Value> = row.try_get("additional_attributes")?;
        if attrs
            .as_ref()
            .and_then(|v| v.get("template_params"))
            .is_some_and(|v| v.is_object())
        {
            anyhow::bail!(
                "WhatsApp templates require Meta WhatsApp Cloud API. Switch this inbox to Meta Cloud API in Inbox Settings."
            );
        }

        // Anti-spam guardrail 1: restrict cold-start outbound messages (conversations with zero inbound customer reply)
        let has_inbound: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM messages WHERE conversation_id = $1 AND message_type = 0)",
        )
        .bind(conv_id)
        .fetch_one(&st.db)
        .await?;
        if !has_inbound {
            let cold_limit = max_new_contacts_per_hour();
            if crate::auth::check_window_rate_limit(
                &st.db,
                &format!("wa_web_cold:{inbox_id}"),
                3600,
                cold_limit,
            )
            .await
            .is_some()
            {
                anyhow::bail!(
                    "Anti-spam limit reached: max {cold_limit} cold conversations/hour on WhatsApp QR. Switch to Meta Cloud API for outbound campaigns."
                );
            }
        }

        // Anti-spam guardrail 2: per-inbox minute & hour outbound caps
        let min_limit = max_per_minute();
        if crate::auth::check_window_rate_limit(
            &st.db,
            &format!("wa_web_min:{inbox_id}"),
            60,
            min_limit,
        )
        .await
        .is_some()
        {
            anyhow::bail!(
                "Anti-spam rate limit: max {min_limit} messages/minute on WhatsApp QR."
            );
        }
        let hr_limit = max_per_hour();
        if crate::auth::check_window_rate_limit(
            &st.db,
            &format!("wa_web_hr:{inbox_id}"),
            3600,
            hr_limit,
        )
        .await
        .is_some()
        {
            anyhow::bail!(
                "Anti-spam rate limit: max {hr_limit} messages/hour on WhatsApp QR."
            );
        }

        let sess = SESSIONS.get(&channel_id).map(|r| r.value().clone()).ok_or_else(|| {
            anyhow::anyhow!(
                "WhatsApp QR device is not connected. Scan QR in Inbox Settings → Configuration."
            )
        })?;

        let client = {
            let guard = sess.client.read().await;
            guard.clone().ok_or_else(|| {
                anyhow::anyhow!(
                    "WhatsApp QR device is not connected. Scan QR in Inbox Settings → Configuration."
                )
            })?
        };

        // Anti-spam guardrail 3: human-like pacing between consecutive sends
        let min_gap = Duration::from_millis(min_delay_ms());
        if !min_gap.is_zero() {
            let mut gate = sess.send_gate.lock().await;
            if let Some(last) = *gate {
                let elapsed = last.elapsed();
                if elapsed < min_gap {
                    tokio::time::sleep(min_gap - elapsed).await;
                }
            }
            *gate = Some(Instant::now());
        }

        let to_raw: String = row.try_get("source_id")?;
        let to_digits = normalize_wa_digits(&to_raw);
        if to_digits.is_empty() {
            anyhow::bail!("Invalid recipient WhatsApp number");
        }
        let jid: Jid = format!("{to_digits}@s.whatsapp.net").parse()?;
        let content: Option<String> = row.try_get("content")?;
        let caption = content
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);

        let blobs: Vec<(String, String, String, Option<i32>)> = sqlx::query_as(
            "SELECT b.key, b.filename, COALESCE(NULLIF(b.content_type, ''), 'application/octet-stream'), at.file_type
             FROM attachments at
             JOIN active_storage_attachments asa
               ON asa.record_type = 'Attachment' AND asa.record_id = at.id AND asa.name = 'file'
             JOIN active_storage_blobs b ON b.id = asa.blob_id
             WHERE at.message_id = $1 AND at.account_id = $2
             ORDER BY at.id
             LIMIT 1",
        )
        .bind(message_id)
        .bind(account_id as i32)
        .fetch_all(&st.db)
        .await?;

        let wa_msg = if let Some((blob_key, filename, mime, file_type)) = blobs.into_iter().next()
        {
            if !crate::storage::valid_key(&blob_key) {
                anyhow::bail!("Invalid attachment storage key");
            }
            let bytes = tokio::fs::read(crate::storage::blob_path(&blob_key)).await?;
            match file_type {
                Some(0) => {
                    let up = client
                        .upload(bytes, MediaType::Image, UploadOptions::default())
                        .await?;
                    media::image_message(
                        up,
                        ImageOptions {
                            caption,
                            mimetype: Some(mime),
                            ..Default::default()
                        },
                    )
                }
                Some(1) => {
                    let up = client
                        .upload(bytes, MediaType::Audio, UploadOptions::default())
                        .await?;
                    media::audio_message(
                        up,
                        AudioOptions {
                            mimetype: Some(mime),
                            ..Default::default()
                        },
                    )
                }
                Some(2) => {
                    let up = client
                        .upload(bytes, MediaType::Video, UploadOptions::default())
                        .await?;
                    media::video_message(
                        up,
                        VideoOptions {
                            caption,
                            mimetype: Some(mime),
                            ..Default::default()
                        },
                    )
                }
                _ => {
                    let up = client
                        .upload(bytes, MediaType::Document, UploadOptions::default())
                        .await?;
                    media::document_message(
                        up,
                        DocumentOptions {
                            mimetype: Some(mime),
                            file_name: Some(filename),
                            caption,
                            ..Default::default()
                        },
                    )
                }
            }
        } else {
            let text = caption.unwrap_or_default();
            if text.is_empty() {
                anyhow::bail!("Message content cannot be empty");
            }
            wa::Message::text(text)
        };

        let sent = client.send_message(jid, wa_msg).await?;
        Ok(sent.message_id)
    }
    .await;

    match res {
        Ok(source) => {
            sqlx::query(
                "UPDATE messages SET source_id = $1, updated_at = now() WHERE id = $2 AND account_id = $3",
            )
            .bind(source)
            .bind(message_id)
            .bind(account_id)
            .execute(&st.db)
            .await?;
        }
        Err(e) => {
            sqlx::query(
                "UPDATE messages
                 SET status = 3,
                     content_attributes = COALESCE(content_attributes, '{}'::json)::jsonb || jsonb_build_object('external_error', $1::text),
                     updated_at = now()
                 WHERE id = $2 AND account_id = $3",
            )
            .bind(e.to_string())
            .bind(message_id)
            .bind(account_id)
            .execute(&st.db)
            .await?;
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn qr_svg_renders_valid_xml() {
        let svg = render_qr_svg("2@test-qr-payload-orbit").expect("qr svg");
        assert!(svg.contains("<svg"));
        assert!(svg.contains("</svg>"));
        assert!(svg.contains("#0F172A"));
    }

    #[test]
    fn normalizes_digits_and_pending_marker() {
        assert_eq!(normalize_wa_digits("+62 812-3456-7890"), "6281234567890");
        assert!(is_pending_phone("qr-pending-abc123"));
        assert!(!is_pending_phone("+6281234567890"));
    }

    #[test]
    fn anti_spam_policy_blocks_broadcasts() {
        let p = anti_spam_policy_json();
        assert_eq!(p["broadcast_blocked"], json!(true));
        assert!(p["max_outbound_per_minute"].as_u64().unwrap() >= 1);
        assert!(p["max_outbound_per_hour"].as_u64().unwrap() >= 1);
        assert!(p["max_new_contacts_per_hour"].as_u64().unwrap() >= 1);
    }
}
