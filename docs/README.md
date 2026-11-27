# Orbit Documentation

Central index for Orbit's architecture, development workflow, visual assets, and automated media/chart generators.

## Architecture & Operations

| Document | Covers |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | High-level system routing, invariants, and crate boundaries |
| [01.OVERVIEW.md](architectures/01.OVERVIEW.md) | Unified Pulsar + Saturn stack, in-process bus, request routing |
| [02.STRUCTURE-PROJECT.md](architectures/02.STRUCTURE-PROJECT.md) | Workspace crates, SPA bundles, env vars, scripts, test tools |
| [03.BRIDGE-COMPAT.md](architectures/03.BRIDGE-COMPAT.md) | Orbit bridge endpoints, 1x SSO, attachments, Argon2id + legacy auth |
| [04.DEPLOY.md](architectures/04.DEPLOY.md) | Docker Compose packaging, bare-metal `--release` run, seeding, backups |

## Git & Release Workflow

| Document | Covers |
| --- | --- |
| [01.GIT-COMMIT.md](github/01.GIT-COMMIT.md) | Conventional Commit rules and `.githooks/commit-msg` |
| [02.GIT-BRANCH.md](github/02.GIT-BRANCH.md) | `develop`, `master`, `OBT-NNN/<type>-*` branches, release and hotfix |
| [03.GIT-PR-FLOW.md](github/03.GIT-PR-FLOW.md) | PR flow (`OBT-NNN` -> `develop` -> `release/X.Y.Z` -> `master`), CI & versioning |

## Media, Brand & Charts

- **Brand marks**: [`docs/brand/orbit-mark.svg`](brand/orbit-mark.svg) (light) & [`docs/brand/orbit-mark-dark.svg`](brand/orbit-mark-dark.svg) (dark)
- **Screenshots**: [`docs/screenshots/`](screenshots/) regenerated headlessly via [`tools/e2e-screenshots.sh`](../tools/e2e-screenshots.sh)
- **Demo video & preview**: [`tools/record-demo.sh`](../tools/record-demo.sh) + [`tools/record-demo.mjs`](../tools/record-demo.mjs)
- **Weekly GitHub stars chart**: [`docs/images/star-history.svg`](images/star-history.svg) updated automatically by `github-actions[bot]` via [`.github/workflows/update-star-history.yml`](../.github/workflows/update-star-history.yml)
