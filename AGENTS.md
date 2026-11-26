# AGENTS.md

Guidance for AI agents working in this repository.

## What this is

Orbit unifies **Pulsar** (CS Helpdesk — Rust rewrite of Chatwoot) and **Saturn** (Project & Backlog — Rust rewrite of Plane) into **one Rust workspace and single compiled binary** (`orbit`, `axum` + `sqlx`) on one port (`:3000`) with dual PostgreSQL databases (`orbit_pulsar` with `pgvector`, and `orbit_saturn`).

Both constituent products remain visible in UI and attribution (`Orbit = Pulsar CS Desk + Saturn Backlog`).

| Path | Role |
| --- | --- |
| `crates/orbit/` | Unified binary entrypoint (`main.rs`), in-process CS→Backlog bridge (`bridge.rs`), 1x SSO auth bridge (`auth_bridge.rs`) |
| `crates/pulsar/` | Library crate extracted from Pulsar (Chatwoot-compatible CS desk APIs, ActionCable `/cable`, live chat `/widget`, MFA/SAML) |
| `crates/saturn/` | Library crate extracted from Saturn (Plane-compatible workspaces, work items, intake, assets, admin, public spaces, live docs) |
| `web/pulsar/` | Pulsar React Router SPA mounted at `/app/` (plus Orbit bug modal & settings integrations) |
| `web/saturn/` | Prebuilt Saturn React Router SPAs (`web` at `/`, `admin` at `/god-mode`, `space` at `/spaces`) with floating CS switcher |
| `docker/`, `docker-compose.yaml` | Split `docker/{axum,nginx,postgres}` production stack (non-root `circleit` uid 1001, Nginx WebSocket proxy, dual-DB pgvector init) |
| `tools/` | Verification scripts (`smoke.sh`, `e2e-screenshots.sh`, `capture-screenshots.mjs`) |
| `scripts/` | Git hook checks (`check-branch.sh`, `check-commit-msg.sh`), `new-branch.sh`, `build-web.sh` |
| `docs/` | Architecture docs, Git/PR rules, and Retina E2E screenshots (`docs/screenshots/`) |

Read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) before making structural changes, and keep changes inside `orbit/` strictly separate from upstream sibling repos.

## Non-negotiables

1. **Keep tenant isolation on both sides.**
   - Every Pulsar account route enforces `require_account` + `account_id` filtering (role 0 agents see only their assigned inboxes).
   - Every Saturn workspace/project route enforces `require_workspace` / `require_project` + `workspace_id` / `project_id` filtering (20 admin, 15 member, 5 guest, `deleted_at IS NULL`).
2. **Bind every SQL parameter.** Always use `sqlx::query(...).bind(...)`. Never interpolate request input into SQL.
3. **Argon2id password hashing + legacy compatibility.**
   - All newly created/reset/seeded passwords in both Pulsar (`auth::hash_password*`) and Saturn (`session::hash_password`) use **Argon2id** (`$argon2id$v=19$m=19456,t=2,p=1$...`).
   - Legacy `bcrypt` (Pulsar/Chatwoot) and Django `pbkdf2_sha256` (Saturn/Plane) hashes must remain verifiable and upgrade transparently to Argon2id on login.
4. **Preserve UI attribution.** Keep Pulsar (`#2781F6` `P` mark) and Saturn branding visible under the unified Orbit umbrella.
5. **No internal cross-crate secrets in frontends.** Frontends talk over same-origin HTTP/WebSocket only; cross-DB queries & live Saturn→Pulsar private-note events stay in `crates/orbit`.

## Commands

```bash
cargo test --workspace                                       # Unit & router overlap tests
scripts/build-web.sh                                         # Typecheck & build Pulsar SPA
cargo run --release -- seed admin@example.com 'Change-me-2026' Acme
cargo run --release                                          # http://localhost:3000 (/app/ & /)
./tools/smoke.sh                                             # Real HTTP API + SSO + Argon2id + attachment smoke test
./tools/e2e-screenshots.sh                                   # Headless Chromium E2E check + 5 screenshots
```

## Conventions

Branches are `OBT-<number>/<type>-<description>` cut from `origin/develop` (`scripts/new-branch.sh`).
Commits follow Conventional Commits in English without AI co-author trailers. Both are enforced by `.githooks/` and `.github/workflows/lint_pr.yml`. See [`docs/github/`](docs/github/).

Rust: `cargo fmt` (`max_width = 120`). Frontend: TypeScript strict check via `bun run typecheck` inside `web/pulsar/`.
