#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PORT="${PORT:-38421}"
BASE="http://127.0.0.1:${PORT}"
P_DB="${P_DB:-orbit_pulsar_smoke_$$}"
S_DB="${S_DB:-orbit_saturn_smoke_$$}"
PG_BASE="${PG_BASE:-postgres://localhost}"
P_URL="${PG_BASE}/${P_DB}"
S_URL="${PG_BASE}/${S_DB}"
EMAIL="admin@orbit.local"
PASS="OrbitPass123!"
ORG="OrbitCo"
ORBIT_BIN="${ORBIT_BIN:-}"

JAR="$(mktemp)"
P_HDR="$(mktemp)"
LOG="$(mktemp)"
SERVER_PID=""

cleanup() {
  if [[ -n "$SERVER_PID" ]]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -f "$JAR" "$P_HDR" "$LOG"
  dropdb --if-exists "$P_DB" >/dev/null 2>&1 || true
  dropdb --if-exists "$S_DB" >/dev/null 2>&1 || true
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  echo "--- orbit log ---" >&2
  cat "$LOG" >&2 || true
  exit 1
}

echo "==> Creating temporary databases $P_DB & $S_DB"
createdb "$P_DB"
createdb "$S_DB"

export PULSAR_DATABASE_URL="$P_URL"
export SATURN_DATABASE_URL="$S_URL"
export FRONTEND_URL="$BASE"
export WEB_URL="$BASE"
export BIND="127.0.0.1:${PORT}"
export SECRET_KEY="orbit-smoke-secret-key"
export SECRET_KEY_BASE="orbit-smoke-secret-key-base"
export PULSAR_WEB_DIR="$ROOT/web/pulsar/build/client"
export SATURN_WEB_DIR="$ROOT/web/saturn"
export PULSAR_STORAGE_DIR="$ROOT/storage/pulsar_smoke"
export SATURN_STORAGE_DIR="$ROOT/storage/saturn_smoke"

if [[ -z "$ORBIT_BIN" ]]; then
  echo "==> Building orbit binary"
  cargo build -p orbit
  ORBIT_BIN="$ROOT/target/debug/orbit"
fi

echo "==> Seeding Orbit ($EMAIL / $ORG)"
"$ORBIT_BIN" seed "$EMAIL" "$PASS" "$ORG"

P_HASH="$(psql "$P_URL" -Atc "SELECT encrypted_password FROM users WHERE lower(email) = '$EMAIL' LIMIT 1")"
S_HASH="$(psql "$S_URL" -Atc "SELECT password FROM users WHERE lower(email) = '$EMAIL' LIMIT 1")"
[[ "$P_HASH" == \$argon2id\$* ]] || fail "Pulsar seeded password not Argon2id: $P_HASH"
[[ "$S_HASH" == argon2\$argon2id\$* || "$S_HASH" == \$argon2id\$* ]] || fail "Saturn seeded password not Argon2id: $S_HASH"
echo "✔ Both Pulsar & Saturn seeded passwords use Argon2id"

echo "==> Starting orbit on $BASE"
"$ORBIT_BIN" >"$LOG" 2>&1 &
SERVER_PID=$!

for _ in $(seq 1 60); do
  if curl -sf "$BASE/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done

HEALTH="$(curl -sf "$BASE/health")" || fail "/health unreachable"
python3 - <<'PY' "$HEALTH"
import sys, json
h = json.loads(sys.argv[1])
assert h.get("status") == "OK", h
assert h.get("pulsar") == "ok" and h.get("saturn") == "ok", h
print("✔ /health OK:", h)
PY

curl -sf "$BASE/app/" | grep -qi "<!doctype html" || fail "GET /app/ missing HTML"
curl -sf "$BASE/" | grep -qi "Saturn" || fail "GET / missing Saturn HTML"
curl -sf "$BASE/assets/entry.client-DGbjlsLU.js" | grep -q "Pulsar CS Desk" || fail "GET entry.client missing Pulsar CS Desk switcher"
curl -sf "$BASE/sdk.js" >/dev/null || fail "GET /sdk.js failed"
echo "✔ SPAs (/app/, /) and /sdk.js OK"

# Sign into Pulsar
curl -sf -D "$P_HDR" -o /dev/null -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}" "$BASE/auth/sign_in" || fail "Pulsar sign_in"
hdr() { grep -i "^$1:" "$P_HDR" | cut -d' ' -f2 | tr -d '\r'; }
AUTH=(-H "access-token: $(hdr access-token)" -H "client: $(hdr client)" -H "uid: $(hdr uid)" -H 'content-type: application/json')
PA="$BASE/api/v1/accounts/1"
OA="$BASE/api/v1/orbit/accounts/1"

# Sign into Saturn
SATURN_LOC=$(curl -s -o /dev/null -w '%{redirect_url}' -c "$JAR" -d "email=$EMAIL&password=$PASS" "$BASE/auth/sign-in/")
[[ "$SATURN_LOC" != *error_code* ]] || fail "Saturn sign-in failed: $SATURN_LOC"
echo "✔ Signed into Pulsar & Saturn"

# Check Orbit integration entry in Pulsar apps list
curl -sf "${AUTH[@]}" "$PA/integrations/apps" | python3 -c '
import sys, json
apps = json.load(sys.stdin)["payload"]
assert any(a["id"] == "orbit" for a in apps), [a["id"] for a in apps]
print("✔ Orbit appears in Pulsar integrations list")'

# Inspect Orbit meta + config
META=$(curl -sf "${AUTH[@]}" "$OA/meta")
CFG=$(curl -sf "${AUTH[@]}" "$OA/config")
eval "$(python3 -c '
import sys, json
meta = json.loads(sys.argv[1])
cfg = json.loads(sys.argv[2])
assert cfg["configured"] is True, cfg
c = cfg["config"]
ws_slug = c["workspace_slug"]
ws_id = c["workspace_id"]
proj_id = c["project_id"]
proj_ident = c["project_identifier"]
states = [s for s in meta["states"] if s["project_id"] == proj_id]
todo = next(s["id"] for s in states if s["name"] == "Todo")
done = next(s["id"] for s in states if s["name"] == "Done")
print(f"WS_SLUG={ws_slug}")
print(f"WS_ID={ws_id}")
print(f"PROJ_ID={proj_id}")
print(f"PROJ_IDENT={proj_ident}")
print(f"TODO_STATE={todo}")
print(f"DONE_STATE={done}")
' "$META" "$CFG")"
echo "✔ Meta & seeded default config OK (ws=$WS_SLUG proj=$PROJ_IDENT)"

# Update default destination state explicitly to Todo
curl -sf "${AUTH[@]}" -X PUT "$OA/config" -d "{
  \"workspace_id\": \"$WS_ID\",
  \"project_id\": \"$PROJ_ID\",
  \"target_mode\": \"work_item\",
  \"state_id\": \"$TODO_STATE\",
  \"priority\": \"high\",
  \"label_ids\": [],
  \"sync_status_notes\": true
}" | python3 -c "
import sys, json
d = json.load(sys.stdin)
assert d['configured'] is True
assert d['config']['state_id'] == '$TODO_STATE', d
print('✔ Updated default Orbit destination to Todo')"

# Create contact, conversation, and client bug message in Pulsar
INBOX=$(curl -sf "${AUTH[@]}" "$PA/inboxes" | python3 -c 'import sys,json;print(json.load(sys.stdin)["payload"][0]["id"])')
CONTACT=$(curl -sf "${AUTH[@]}" -X POST "$PA/contacts" -d '{"name":"Budi Client","email":"budi@client.test"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["payload"]["contact"]["id"])')
CONV=$(curl -sf "${AUTH[@]}" -X POST "$PA/conversations" -d "{\"inbox_id\":$INBOX,\"contact_id\":$CONTACT}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
MSG_RESP=$(curl -sf "${AUTH[@]}" -X POST "$PA/conversations/$CONV/messages" -d '{"content":"Tombol checkout error 500 waktu klik bayar","message_type":"incoming"}')
MSG_ID=$(python3 -c 'import sys,json;print(json.loads(sys.argv[1])["id"])' "$MSG_RESP")
echo "✔ Created CS conversation #$CONV with client bug message #$MSG_ID"

# Push bug #1 using default configured state (Todo)
ISSUE1_JSON=$(curl -sf "${AUTH[@]}" -X POST "$OA/issues" -d "{
  \"conversation_id\": $CONV,
  \"message_id\": $MSG_ID,
  \"title\": \"Tombol checkout error 500\",
  \"priority\": \"urgent\"
}")
eval "$(python3 -c '
import sys, json
d = json.loads(sys.argv[1])
todo = sys.argv[2]
assert d["state"]["id"] == todo, d
assert d["target_mode"] == "work_item", d
print("ISSUE1_ID=" + d["id"])
print("ISSUE1_IDENT=" + d["identifier"])
' "$ISSUE1_JSON" "$TODO_STATE")"
echo "✔ Created Saturn issue $ISSUE1_IDENT in Todo state"

# Push bug #2 via Intake mode
ISSUE2_JSON=$(curl -sf "${AUTH[@]}" -X POST "$OA/issues" -d "{
  \"conversation_id\": $CONV,
  \"message_id\": $MSG_ID,
  \"title\": \"Triage: checkout error screenshot follow-up\",
  \"target_mode\": \"intake\",
  \"priority\": \"medium\"
}")
LINK2_ID=$(python3 -c '
import sys, json
d = json.loads(sys.argv[1])
assert d["target_mode"] == "intake", d
print(d["link_id"])
' "$ISSUE2_JSON")
echo "✔ Created Saturn Intake issue (link_id=$LINK2_ID)"

# Verify linked_issues endpoint returns both
curl -sf "${AUTH[@]}" "$OA/linked_issues?conversation_id=$CONV" | python3 -c '
import sys, json
items = json.load(sys.stdin)
assert len(items) == 2, items
assert any(not x["is_intake"] and x["state"]["name"] == "Todo" for x in items), items
assert any(x["is_intake"] for x in items), items
print("✔ linked_issues returns both Todo and Intake items")'

# Move issue #1 to Done inside Saturn & verify private status note appears in Pulsar chat
PATCH_CODE=$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' -X PATCH \
  -H 'content-type: application/json' \
  -d "{\"state_id\":\"$DONE_STATE\"}" \
  "$BASE/api/workspaces/$WS_SLUG/projects/$PROJ_ID/issues/$ISSUE1_ID/")
[[ "$PATCH_CODE" == 2* ]] || fail "Saturn PATCH issue state returned $PATCH_CODE"

SYNCED=0
for _ in $(seq 1 25); do
  if curl -sf "${AUTH[@]}" "$PA/conversations/$CONV/messages" | python3 -c "
import sys, json
msgs = json.load(sys.stdin)['payload']
ok = any(m.get('private') is True and '$ISSUE1_IDENT' in (m.get('content') or '') and 'Done' in (m.get('content') or '') for m in msgs)
sys.exit(0 if ok else 1)" 2>/dev/null; then
    SYNCED=1
    break
  fi
  sleep 0.2
done
[[ "$SYNCED" == 1 ]] || fail "Private status sync note from Saturn -> Pulsar did not arrive"
echo "✔ Live status sync posted private note in Pulsar chat ($ISSUE1_IDENT -> Done)"

# Unlink issue #2 and verify count drops to 1
curl -sf "${AUTH[@]}" -X POST "$OA/unlink_issue" -d "{\"conversation_id\":$CONV,\"link_id\":\"$LINK2_ID\"}" >/dev/null
curl -sf "${AUTH[@]}" "$OA/linked_issues?conversation_id=$CONV" | python3 -c '
import sys, json
items = json.load(sys.stdin)
assert len(items) == 1, items
print("✔ Unlink issue OK")'

# Unified 1x Login SSO: Pulsar -> Saturn (new cookie jar)
SSO_JAR="$(mktemp)"
SSO_AUTH_RES=$(curl -sf -c "$SSO_JAR" "${AUTH[@]}" -X POST "$BASE/api/v1/orbit/auth/sync_saturn")
python3 -c '
import sys, json
d = json.loads(sys.argv[1])
assert d.get("synced") is True and d.get("saturn_user_id"), d
' "$SSO_AUTH_RES"
curl -sf -b "$SSO_JAR" "$BASE/api/users/me/" >/dev/null || fail "Saturn /api/users/me/ with synced SSO cookie failed"
echo "✔ 1x SSO Pulsar -> Saturn OK"

# Unified 1x Login SSO: Saturn cookie -> Pulsar headers
EX_HDR="$(mktemp)"
curl -sf -D "$EX_HDR" -b "$SSO_JAR" -X POST "$BASE/api/v1/orbit/auth/exchange_saturn" -o /dev/null || fail "exchange_saturn failed"
EX_TOK=$(grep -i "^access-token:" "$EX_HDR" | cut -d' ' -f2 | tr -d '\r')
EX_CLI=$(grep -i "^client:" "$EX_HDR" | cut -d' ' -f2 | tr -d '\r')
EX_UID=$(grep -i "^uid:" "$EX_HDR" | cut -d' ' -f2 | tr -d '\r')
curl -sf -H "access-token: $EX_TOK" -H "client: $EX_CLI" -H "uid: $EX_UID" "$BASE/api/v1/profile" >/dev/null || fail "Pulsar profile with exchanged SSO token failed"
echo "✔ 1x SSO Saturn -> Pulsar OK"

# Attachment carry-over: upload PNG to Pulsar chat, push bug, download from Saturn
PNG_TMP="$(mktemp /tmp/orbit_bug_XXXXXX.png)"
python3 -c '
import sys, zlib, struct
def chunk(tag, data):
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xffffffff)
ihdr = struct.pack(">IIBBBBB", 2, 2, 8, 2, 0, 0, 0)
idat = zlib.compress(b"\x00\xff\x00\x00\xff\x00\x00\x00\xff\x00\x00\xff\x00\x00")
png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")
open(sys.argv[1], "wb").write(png)
' "$PNG_TMP"

ATT_MSG_JSON=$(curl -sf \
  -H "access-token: $(hdr access-token)" -H "client: $(hdr client)" -H "uid: $(hdr uid)" \
  -F "content=Screenshot error checkout terlampir" \
  -F "attachments[]=@${PNG_TMP};type=image/png;filename=bug.png" \
  "$PA/conversations/$CONV/messages")
ATT_MSG_ID=$(python3 -c 'import sys,json;print(json.loads(sys.argv[1])["id"])' "$ATT_MSG_JSON")

ISSUE3_JSON=$(curl -sf "${AUTH[@]}" -X POST "$OA/issues" -d "{
  \"conversation_id\": $CONV,
  \"message_id\": $ATT_MSG_ID,
  \"title\": \"Bug with screenshot attachment\",
  \"include_attachments\": true
}")
eval "$(python3 -c '
import sys, json
d = json.loads(sys.argv[1])
atts = d.get("attachments_copied") or []
assert len(atts) == 1, d
print("ISSUE3_ID=" + d["id"])
print("ASSET3_ID=" + atts[0]["id"])
' "$ISSUE3_JSON")"

curl -sf -b "$SSO_JAR" "$BASE/api/assets/v2/workspaces/$WS_SLUG/projects/$PROJ_ID/issues/$ISSUE3_ID/attachments/" | python3 -c "
import sys, json
rows = json.load(sys.stdin)
assert any(r.get('id') == '$ASSET3_ID' for r in rows), rows
print('✔ Saturn attachment list contains carried-over asset')"

DL_BYTES=$(curl -sf -b "$SSO_JAR" "$BASE/api/assets/v2/workspaces/$WS_SLUG/$ASSET3_ID/" | python3 -c 'import sys; b=sys.stdin.buffer.read(); assert b.startswith(b"\x89PNG"), b[:16]; print(len(b))')
echo "✔ Carried-over PNG downloaded from Saturn ($DL_BYTES bytes)"

# Unified Orbit Theme API (default Orbit Blue #2781F6, Pulsar update, Saturn cookie update, auth guard)
DEF_THEME=$(curl -sf "$BASE/api/v1/orbit/theme")
python3 -c '
import sys, json
t = json.loads(sys.argv[1])
assert t["primary"] == "#2781F6" and t["preset"] == "orbit-blue", t
print("✔ Default Orbit theme is Orbit Blue (#2781F6):", t)' "$DEF_THEME"

THEME_JS=$(curl -sf "$BASE/api/v1/orbit/theme.js")
grep -q "orbit-theme-override" <<<"$THEME_JS" || fail "GET /api/v1/orbit/theme.js missing override engine"
grep -q "Pulsar CS Desk" <<<"$THEME_JS" || fail "GET /api/v1/orbit/theme.js missing Pulsar CS Desk switcher"
echo "✔ GET /api/v1/orbit/theme.js OK"

UNAUTH_THEME_CODE=$(curl -s -o /dev/null -w '%{http_code}' -X PUT -H 'content-type: application/json' \
  -d '{"preset":"cosmic-violet","mode":"light","primary":"#7C3AED","surface":"","radius":"md"}' \
  "$BASE/api/v1/orbit/theme")
[[ "$UNAUTH_THEME_CODE" == "401" ]] || fail "Expected 401 for unauthenticated PUT /api/v1/orbit/theme, got $UNAUTH_THEME_CODE"
echo "✔ Unauthenticated PUT /api/v1/orbit/theme rejected with 401"

SAVED_THEME=$(curl -sf "${AUTH[@]}" -X PUT -d '{"preset":"cosmic-violet","mode":"light","primary":"#7C3AED","surface":"#EEF2FF","radius":"lg"}' "$BASE/api/v1/orbit/theme")
GET_THEME_AFTER=$(curl -sf "$BASE/api/v1/orbit/theme")
python3 -c '
import sys, json
s, g = json.loads(sys.argv[1]), json.loads(sys.argv[2])
for d in (s, g):
    assert d == {"preset": "cosmic-violet", "mode": "light", "primary": "#7C3AED", "surface": "#EEF2FF", "radius": "lg"}, d
print("✔ Pulsar PUT /api/v1/orbit/theme persisted and synced")' "$SAVED_THEME" "$GET_THEME_AFTER"

RESET_THEME=$(curl -sf -b "$JAR" -X PUT -H 'content-type: application/json' \
  -d '{"preset":"orbit-blue","mode":"auto","primary":"#2781F6","surface":"","radius":"md"}' \
  "$BASE/api/v1/orbit/theme")
python3 -c '
import sys, json
r = json.loads(sys.argv[1])
assert r == {"preset": "orbit-blue", "mode": "auto", "primary": "#2781F6", "surface": "", "radius": "md"}, r
print("✔ Saturn cookie PUT /api/v1/orbit/theme reset to Orbit Blue (#2781F6)")' "$RESET_THEME"

# Unified sign out destroys Saturn cookie session
curl -sf -b "$SSO_JAR" -c "$SSO_JAR" -X POST "$BASE/api/v1/orbit/auth/sign_out" >/dev/null
OUT_CODE=$(curl -s -b "$SSO_JAR" -o /dev/null -w '%{http_code}' "$BASE/api/users/me/")
[[ "$OUT_CODE" == "401" || "$OUT_CODE" == "403" ]] || fail "Expected 401/403 after unified sign_out, got $OUT_CODE"
echo "✔ Unified sign_out invalidated Saturn session ($OUT_CODE)"

rm -f "$SSO_JAR" "$EX_HDR" "$PNG_TMP"
rm -rf "$ROOT/storage/pulsar_smoke" "$ROOT/storage/saturn_smoke"
echo "ORBIT SMOKE OK"
