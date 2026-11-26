use axum::{
    Json, Router,
    body::to_bytes,
    extract::{FromRequestParts, Request, State},
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::Row;

use crate::bridge::OrbitState;

const CONFIG_NAME: &str = "ORBIT_THEME";
const BRIDGE_JS: &str = include_str!("orbit_theme_bridge.js");
pub const DEFAULT_PRIMARY_HEX: &str = "#2781F6";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct OrbitTheme {
    pub preset: String,
    pub mode: String,
    pub primary: String,
    pub surface: String,
    pub radius: String,
}

impl Default for OrbitTheme {
    fn default() -> Self {
        Self {
            preset: "orbit-blue".to_string(),
            mode: "auto".to_string(),
            primary: DEFAULT_PRIMARY_HEX.to_string(),
            surface: String::new(),
            radius: "md".to_string(),
        }
    }
}

pub fn routes() -> Router<OrbitState> {
    Router::new()
        .route("/theme", get(get_theme).put(put_theme))
        .route("/theme.js", get(get_theme_js))
}

pub fn normalize_hex(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    let hex = trimmed.strip_prefix('#').unwrap_or(trimmed);
    if hex.len() != 6 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    Some(format!("#{}", hex.to_ascii_uppercase()))
}

fn valid_mode(m: &str) -> bool {
    matches!(m, "auto" | "light" | "dark")
}

fn valid_radius(r: &str) -> bool {
    matches!(r, "sm" | "md" | "lg")
}

fn sanitize_preset(raw: Option<&str>, primary: &str) -> String {
    if let Some(p) = raw.map(str::trim).filter(|s| !s.is_empty()) {
        let clean: String = p
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
            .take(32)
            .collect();
        if !clean.is_empty() {
            return clean;
        }
    }
    if primary == DEFAULT_PRIMARY_HEX {
        "orbit-blue".to_string()
    } else {
        "custom".to_string()
    }
}

pub fn parse_and_validate_theme(body: &Value) -> Result<OrbitTheme, pulsar::common::ApiError> {
    let obj = body
        .as_object()
        .ok_or_else(|| pulsar::common::ApiError::bad("Theme payload must be a JSON object"))?;

    let primary = match obj.get("primary").and_then(|v| v.as_str()) {
        Some(raw) if !raw.trim().is_empty() => normalize_hex(raw)
            .ok_or_else(|| pulsar::common::ApiError::bad("primary must be a #RRGGBB hex color"))?,
        _ => DEFAULT_PRIMARY_HEX.to_string(),
    };

    let surface = match obj.get("surface").and_then(|v| v.as_str()) {
        Some(raw) if !raw.trim().is_empty() => normalize_hex(raw)
            .ok_or_else(|| pulsar::common::ApiError::bad("surface must be a #RRGGBB hex color"))?,
        _ => String::new(),
    };

    let mode = obj
        .get("mode")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("auto");
    if !valid_mode(mode) {
        return Err(pulsar::common::ApiError::bad(
            "mode must be one of 'auto', 'light', or 'dark'",
        ));
    }

    let radius = obj
        .get("radius")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("md");
    if !valid_radius(radius) {
        return Err(pulsar::common::ApiError::bad(
            "radius must be one of 'sm', 'md', or 'lg'",
        ));
    }

    let preset = sanitize_preset(obj.get("preset").and_then(|v| v.as_str()), &primary);

    Ok(OrbitTheme {
        preset,
        mode: mode.to_string(),
        primary,
        surface,
        radius: radius.to_string(),
    })
}

async fn load_stored_theme(db: &sqlx::PgPool) -> Result<OrbitTheme, pulsar::common::ApiError> {
    let row = sqlx::query(
        "SELECT serialized_value FROM installation_configs WHERE name = $1 ORDER BY created_at DESC LIMIT 1",
    )
    .bind(CONFIG_NAME)
    .fetch_optional(db)
    .await?;

    let Some(row) = row else {
        return Ok(OrbitTheme::default());
    };

    let serialized: Value = row.try_get("serialized_value")?;
    let val = serialized.get("value").unwrap_or(&serialized);
    Ok(parse_and_validate_theme(val).unwrap_or_default())
}

async fn save_stored_theme(
    db: &sqlx::PgPool,
    theme: &OrbitTheme,
) -> Result<(), pulsar::common::ApiError> {
    let payload = json!({ "value": theme });
    sqlx::query(
        "INSERT INTO installation_configs (name, serialized_value, locked, created_at, updated_at)
         VALUES ($1, $2, false, now(), now())
         ON CONFLICT (name) DO UPDATE SET serialized_value = EXCLUDED.serialized_value, locked = false, updated_at = now()",
    )
    .bind(CONFIG_NAME)
    .bind(payload)
    .execute(db)
    .await?;
    Ok(())
}

async fn get_theme(State(st): State<OrbitState>) -> pulsar::common::ApiResult {
    let theme = load_stored_theme(&st.pulsar.db).await?;
    Ok(Json(json!(theme)))
}

async fn put_theme(
    State(st): State<OrbitState>,
    req: Request,
) -> Result<Response, pulsar::common::ApiError> {
    let (mut parts, body) = req.into_parts();

    let pulsar_authed =
        <pulsar::common::CurrentUser as FromRequestParts<sqlx::PgPool>>::from_request_parts(
            &mut parts,
            &st.pulsar.db,
        )
        .await
        .is_ok();

    let saturn_authed = if pulsar_authed {
        false
    } else if let Some(key) = saturn::session::cookie(&parts.headers, saturn::session::COOKIE) {
        saturn::session::load(&st.saturn, &key)
            .await
            .ok()
            .flatten()
            .is_some()
    } else {
        false
    };

    if !pulsar_authed && !saturn_authed {
        return Err(pulsar::common::ApiError::unauthorized());
    }

    let bytes = to_bytes(body, 16 * 1024)
        .await
        .map_err(|_| pulsar::common::ApiError::bad("Invalid theme request body"))?;
    let json_body: Value = serde_json::from_slice(&bytes)
        .map_err(|_| pulsar::common::ApiError::bad("Theme payload must be valid JSON"))?;
    let theme = parse_and_validate_theme(&json_body)?;
    save_stored_theme(&st.pulsar.db, &theme).await?;

    Ok(Json(theme).into_response())
}

async fn get_theme_js() -> Response {
    let mut res = (StatusCode::OK, BRIDGE_JS).into_response();
    let headers = res.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/javascript; charset=utf-8"),
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-cache"),
    );
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_theme_is_orbit_blue() {
        let def = OrbitTheme::default();
        assert_eq!(def.primary, "#2781F6");
        assert_eq!(def.preset, "orbit-blue");
        assert_eq!(def.mode, "auto");
        assert_eq!(def.surface, "");
        assert_eq!(def.radius, "md");
    }

    #[test]
    fn normalize_hex_validates_strict_six_digit_colors() {
        assert_eq!(normalize_hex("#2781f6").as_deref(), Some("#2781F6"));
        assert_eq!(normalize_hex("7c3aed").as_deref(), Some("#7C3AED"));
        assert_eq!(normalize_hex("#fff"), None);
        assert_eq!(normalize_hex("not-a-color"), None);
    }

    #[test]
    fn parse_theme_accepts_custom_and_rejects_invalid() {
        let ok = parse_and_validate_theme(&json!({
            "preset": "cosmic-violet",
            "mode": "dark",
            "primary": "7c3aed",
            "surface": "#1e1b4b",
            "radius": "lg"
        }))
        .expect("valid theme");
        assert_eq!(ok.primary, "#7C3AED");
        assert_eq!(ok.surface, "#1E1B4B");
        assert_eq!(ok.mode, "dark");
        assert_eq!(ok.radius, "lg");
        assert_eq!(ok.preset, "cosmic-violet");

        assert!(parse_and_validate_theme(&json!({ "primary": "#XYZ123" })).is_err());
        assert!(parse_and_validate_theme(&json!({ "surface": "bad" })).is_err());
        assert!(parse_and_validate_theme(&json!({ "mode": "sepia" })).is_err());
        assert!(parse_and_validate_theme(&json!({ "radius": "huge" })).is_err());
    }
}
