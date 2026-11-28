#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec python3 - "$ROOT" "$@" <<'PY'
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(sys.argv[1])
ARGS = sys.argv[2:]

use_remote = "--remote" in ARGS
check_only = "--check" in ARGS
no_verify = "--no-verify" in ARGS

def get_flag(name: str) -> str | None:
    if name in ARGS:
        idx = ARGS.index(name)
        if idx + 1 >= len(ARGS):
            raise SystemExit(f"Missing value for {name}")
        return ARGS[idx + 1]
    return None

pulsar_override = get_flag("--pulsar-dir")
saturn_override = get_flag("--saturn-dir")
only_repo = get_flag("--only")
pulsar_ref = get_flag("--pulsar-ref")
saturn_ref = get_flag("--saturn-ref")
if only_repo and only_repo not in ("pulsar", "saturn"):
    raise SystemExit(f"Invalid --only value: {only_repo} (expected 'pulsar' or 'saturn')")
selected_names = (only_repo,) if only_repo else ("pulsar", "saturn")

LOCK_PATH = ROOT / "upstream.lock"
lock = json.loads(LOCK_PATH.read_text())

PROTECTED_ORBIT_ONLY = {
    "crates/pulsar/src/lib.rs",
    "crates/pulsar/src/channels/whatsapp_web.rs",
    "crates/pulsar/src/channels/whatsapp_web_store.rs",
    "crates/pulsar/migrations/0009_whatsapp_web_store.sql",
    "crates/saturn/src/lib.rs",
    "web/pulsar/app/components/next/conversation/OrbitBugModal.tsx",
    "web/pulsar/app/components/next/inbox/WhatsAppChannelSettings.tsx",
    "web/pulsar/app/components/next/OrbitThemeCard.tsx",
    "web/pulsar/app/lib/orbitTheme.ts",
    "web/pulsar/app/routes/settings/integrations/orbit.tsx",
    "web/pulsar/public/brand-assets/logo.svg",
    "web/pulsar/public/brand-assets/logo_dark.svg",
    "web/pulsar/public/brand-assets/logo_thumbnail.svg",
    "web/pulsar/public/favicon.ico",
    "web/pulsar/public/favicon-32x32.png",
    "web/pulsar/public/apple-touch-icon.png",
}

def git(repo: Path, *args: str, text: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", "-C", str(repo), *args],
        check=True,
        capture_output=True,
        text=text,
    )

def git_bytes(repo: Path, rev: str, path: str) -> bytes:
    return subprocess.run(
        ["git", "-C", str(repo), "show", f"{rev}:{path}"],
        check=True,
        capture_output=True,
    ).stdout

def is_binary(data: bytes) -> bool:
    return b"\x00" in data

def map_pulsar(rel: str) -> str | None:
    if rel == "src/main.rs":
        return None
    if rel.startswith("src/"):
        return "crates/pulsar/" + rel
    if rel.startswith("migrations/"):
        return "crates/pulsar/" + rel
    if rel in ("features.json", "installation_defaults.json", "Cargo.toml"):
        return "crates/pulsar/" + rel
    if rel.startswith("web/app/"):
        return "web/pulsar/app/" + rel[len("web/app/"):]
    if rel.startswith("web/public/i18n/"):
        return "web/pulsar/public/i18n/" + rel[len("web/public/i18n/"):]
    if rel in (
        "web/package.json",
        "web/bun.lock",
        "web/vite.config.ts",
        "web/react-router.config.ts",
        "web/tsconfig.json",
    ):
        return "web/pulsar/" + Path(rel).name
    return None

def map_saturn(rel: str) -> str | None:
    if rel == "src/main.rs":
        return None
    if rel.startswith(("src/", "migrations/", "assets/", "tests/")):
        return "crates/saturn/" + rel
    if rel == "Cargo.toml":
        return "crates/saturn/Cargo.toml"
    for app in ("web", "admin", "space"):
        prefix = f"web/apps/{app}/build/client/"
        if rel.startswith(prefix):
            return f"web/saturn/{app}/build/client/" + rel[len(prefix):]
    return None

def reapply_saturn_web_patches() -> None:
    loader_js = (
        ";/* Orbit Pulsar CS Desk + Theme Bridge */"
        "(function(){if(window.__orbitThemeLoaded)return;window.__orbitThemeLoaded=1;"
        "function l(){if(document.getElementById('orbit-theme-bridge-js'))return;"
        "var s=document.createElement('script');s.id='orbit-theme-bridge-js';"
        "s.src='/api/v1/orbit/theme.js';s.defer=true;document.head.appendChild(s);}"
        "if(document.readyState==='complete'){setTimeout(l,150);}else{"
        "window.addEventListener('load',function(){setTimeout(l,150);});}})();"
    )
    old_switcher_re = re.compile(r";\(function\(\)\{function m\(\)\{[\s\S]*?orbit-cs-switcher[\s\S]*?\}\)\(\);\s*$")
    for app in ("web", "admin", "space"):
        for p in sorted(glob.glob(str(ROOT / f"web/saturn/{app}/build/client/assets/entry.client-*.js"))):
            txt = Path(p).read_text()
            txt = old_switcher_re.sub("", txt)
            if "orbit-theme-bridge-js" not in txt:
                Path(p).write_text(txt.rstrip() + loader_js)
                print(f"✔ re-applied Orbit Pulsar CS Desk + Theme bridge in {Path(p).relative_to(ROOT)}")

    hydrate_re = re.compile(
        r"([A-Za-z0-9_$]+)=n\(function\(\)\{let\{resolvedTheme:[^}]+\}=[^;]+;"
        r"return typeof window>`u`\|\|[^?]+\?\(0,([A-Za-z0-9_$]+)\.jsx\)\(`div`,\{\}\):"
        r"\(0,\2\.jsx\)\(`div`,\{className:`relative flex h-screen w-full items-center justify-center bg-canvas`,"
        r"children:\(0,\2\.jsx\)\([^,]+,\{\}\)\}\)\}\)"
    )
    for p in sorted(glob.glob(str(ROOT / "web/saturn/web/build/client/assets/root-*.js"))):
        txt = Path(p).read_text()
        new_txt, count = hydrate_re.subn(r"\1=n(function(){return(0,\2.jsx)(`div`,{})})", txt)
        if count > 0:
            Path(p).write_text(new_txt)
            print(f"✔ re-applied HydrateFallback fix in {Path(p).relative_to(ROOT)}")

def verify_orbit_guards() -> None:
    guards = [
        ("web/pulsar/app/routes/inbox.tsx", "Masukin Backlog (Orbit)"),
        ("web/pulsar/app/components/next/conversation/OrbitBugModal.tsx", "OrbitBugModal"),
        ("web/pulsar/app/components/next/conversation/ConversationSidebar.tsx", "Orbit Backlog"),
        ("web/pulsar/app/lib/orbitTheme.ts", "applyOrbitTheme"),
        ("crates/orbit/src/main.rs", "/api/v1/orbit"),
        ("crates/orbit/src/theme.rs", "ORBIT_THEME"),
        ("crates/saturn/src/webhook_out.rs", "pub fn subscribe_internal"),
    ]
    for rel, needle in guards:
        fp = ROOT / rel
        if not fp.exists() or needle not in fp.read_text():
            raise SystemExit(f"✖ Orbit safety guard failed: '{needle}' missing in {rel}")
    for app in ("web", "admin", "space"):
        entries = sorted(glob.glob(str(ROOT / f"web/saturn/{app}/build/client/assets/entry.client-*.js")))
        if not any("orbit-theme-bridge-js" in Path(p).read_text() and "Pulsar CS Desk" in Path(p).read_text() for p in entries):
            raise SystemExit(f"✖ Orbit safety guard failed: Orbit bridge missing in Saturn {app} entry.client")
    print("✔ All Orbit feature safety guards intact")

tmpdir = Path(tempfile.mkdtemp(prefix="orbit-sync-"))
try:
    repos: dict[str, Path] = {}
    if "pulsar" in selected_names:
        if pulsar_override:
            repos["pulsar"] = Path(pulsar_override).resolve()
        elif use_remote:
            dst = tmpdir / "pulsar"
            subprocess.run(["git", "clone", "--branch", lock["pulsar"]["branch"], lock["pulsar"]["repo"], str(dst)], check=True)
            repos["pulsar"] = dst
        else:
            repos["pulsar"] = (ROOT.parent / "pulsar").resolve()

    if "saturn" in selected_names:
        if saturn_override:
            repos["saturn"] = Path(saturn_override).resolve()
        elif use_remote:
            dst = tmpdir / "saturn"
            subprocess.run(["git", "clone", "--branch", lock["saturn"]["branch"], lock["saturn"]["repo"], str(dst)], check=True)
            repos["saturn"] = dst
        else:
            repos["saturn"] = (ROOT.parent / "saturn").resolve()

    mappers = {"pulsar": map_pulsar, "saturn": map_saturn}
    conflicts: list[str] = []
    warnings: list[str] = []
    any_changes = False
    saturn_web_touched = False

    pending_updates: dict[str, tuple[str, str]] = {}

    for name in selected_names:
        repo = repos[name]
        if not (repo / ".git").exists():
            raise SystemExit(f"✖ Upstream repo not found at {repo} (pass --remote to clone)")
        base_sha = lock[name]["sha"]
        ref_override = pulsar_ref if name == "pulsar" else saturn_ref
        is_custom = (name == "pulsar" and pulsar_override) or (name == "saturn" and saturn_override)
        target_ref = ref_override or ("HEAD" if is_custom else lock[name]["branch"])
        new_sha = git(repo, "rev-parse", target_ref).stdout.strip()
        if base_sha == new_sha:
            print(f"✔ {name}: already up-to-date ({new_sha[:7]})")
            continue

        count = git(repo, "rev-list", "--count", f"{base_sha}..{new_sha}").stdout.strip()
        diff_lines = git(repo, "diff", "--name-status", "--no-renames", base_sha, new_sha).stdout.splitlines()
        mapped_ops: list[tuple[str, str, str]] = []
        for line in diff_lines:
            parts = line.split("\t", 1)
            if len(parts) != 2:
                continue
            status, rel = parts[0], parts[1]
            if rel == "src/main.rs":
                warnings.append(f"{name}: src/main.rs changed upstream — verify new `mod` items in crates/{name}/src/lib.rs")
            if rel.startswith("migrations/"):
                warnings.append(f"{name}: {rel} changed upstream — verify it is wired in crates/{name}/src/lib.rs")
            dst_rel = mappers[name](rel)
            if dst_rel:
                mapped_ops.append((status, rel, dst_rel))

        print(f"• {name}: {base_sha[:7]} -> {new_sha[:7]} ({count} commit(s), {len(mapped_ops)} mapped file(s))")
        if check_only:
            for st, rel, dst_rel in mapped_ops:
                print(f"  [{st}] {rel} -> {dst_rel}")
            any_changes = any_changes or (base_sha != new_sha)
            continue

        for status, rel, dst_rel in mapped_ops:
            dst = ROOT / dst_rel
            if dst_rel.startswith("web/saturn/"):
                saturn_web_touched = True
            if status == "D":
                if dst_rel in PROTECTED_ORBIT_ONLY:
                    warnings.append(f"Skipped upstream deletion of Orbit-owned file {dst_rel}")
                elif dst.exists():
                    dst.unlink()
                    any_changes = True
                continue
            new_bytes = git_bytes(repo, new_sha, rel)
            if status == "A" or not dst.exists():
                dst.parent.mkdir(parents=True, exist_ok=True)
                dst.write_bytes(new_bytes)
                any_changes = True
                continue

            base_bytes = git_bytes(repo, base_sha, rel)
            cur_bytes = dst.read_bytes()
            if cur_bytes == new_bytes:
                continue
            if dst_rel.startswith("web/saturn/") or is_binary(base_bytes) or is_binary(new_bytes) or is_binary(cur_bytes):
                dst.parent.mkdir(parents=True, exist_ok=True)
                dst.write_bytes(new_bytes)
                any_changes = True
                continue
            if cur_bytes == base_bytes:
                dst.write_bytes(new_bytes)
                any_changes = True
                continue

            # 3-way merge preserving Orbit overlays alongside upstream additions
            base_tmp = tmpdir / "base.tmp"
            new_tmp = tmpdir / "new.tmp"
            base_tmp.write_bytes(base_bytes)
            new_tmp.write_bytes(new_bytes)
            res = subprocess.run(
                [
                    "git",
                    "merge-file",
                    "-L",
                    "orbit",
                    "-L",
                    f"{name}-base",
                    "-L",
                    f"{name}-new",
                    str(dst),
                    str(base_tmp),
                    str(new_tmp),
                ],
                capture_output=True,
                text=True,
            )
            any_changes = True
            if res.returncode > 0:
                conflicts.append(dst_rel)
            elif res.returncode < 0:
                raise SystemExit(f"✖ git merge-file error on {dst_rel}: {res.stderr}")

        tag_proc = subprocess.run(
            ["git", "-C", str(repo), "describe", "--tags", "--exact-match", new_sha],
            capture_output=True,
            text=True,
        )
        new_tag = tag_proc.stdout.strip() if tag_proc.returncode == 0 else lock[name].get("tag", "")
        pending_updates[name] = (new_sha, new_tag)

    if check_only:
        sys.exit(0)

    if saturn_web_touched:
        reapply_saturn_web_patches()

    if conflicts:
        print("\n✖ 3-way merge conflicts require manual resolution before updating upstream.lock:")
        for c in conflicts:
            print(f"  - {c}")
        sys.exit(1)

    verify_orbit_guards()

    if pending_updates:
        for name, (sha, tag) in pending_updates.items():
            lock[name]["sha"] = sha
            if tag:
                lock[name]["tag"] = tag
        LOCK_PATH.write_text(json.dumps(lock, indent=2) + "\n")
        print(f"✔ Updated {LOCK_PATH.name}")

    for w in warnings:
        print(f"⚠ {w}")

    if any_changes and not no_verify:
        print("==> Verifying synced Orbit workspace (build-web, cargo test, smoke.sh)...")
        subprocess.run([str(ROOT / "scripts/build-web.sh")], cwd=str(ROOT), check=True)
        subprocess.run(["cargo", "test", "--workspace"], cwd=str(ROOT), check=True)
        subprocess.run([str(ROOT / "tools/smoke.sh")], cwd=str(ROOT), check=True)
        print("✔ Upstream sync verified with zero regressions")
finally:
    shutil.rmtree(tmpdir, ignore_errors=True)
PY
