# Pull Request Template

## Description

Summary of the change and the issue it fixes, with any context or dependencies.
Fixes # (issue)

## Type of change

- [ ] Bug fix (non-breaking change which fixes an issue)
- [ ] New feature or bridge enhancement (non-breaking change which adds functionality)
- [ ] Breaking change (fix or feature that would cause existing functionality not to work as expected)
- [ ] This change requires a documentation update

## How has this been tested?

Commands run and what they showed (`cargo test --workspace`, `./tools/smoke.sh`, `./tools/e2e-screenshots.sh`, `scripts/build-web.sh`).

## Checklist

- [ ] Branch is `OBT-<number>/<type>-<description>`, cut from `develop`
- [ ] PR title follows Conventional Commits (`feat: ...`, `fix: ...`)
- [ ] No AI co-author lines in commits (AI use may be disclosed here instead)
- [ ] Tenant isolation checked on both Pulsar (`account_id`) and Saturn (`workspace_id` / `project_id`) handlers
- [ ] Password hashing / auth changes preserve Argon2id and legacy verification compatibility
- [ ] I have performed a self-review of my code
- [ ] I have updated the documentation where needed
- [ ] New and existing tests pass locally
