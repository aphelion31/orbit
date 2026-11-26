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

LOCK_PATH = ROOT / "upstream.lock"
lock = json.loads(LOCK_PATH.read_text())

PROTECTED_ORBIT_ONLY = {
    "crates/pulsar/src/lib.rs",
    "crates/saturn/src/lib.rs",
    "web/pulsar/app/components/next/conversation/OrbitBugModal.tsx",
    "web/pulsar/app/routes/settings/integrations/orbit.tsx",
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
    if rel in ("features.json", "Cargo.toml"):
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
    switcher_js = (
        ";(function(){function m(){if(!window.__reactRouterDataRouter||!document.body"
        "||!document.body.querySelector('aside,main,nav,form'))return;"
        "if(document.title&&!document.title.startsWith('Orbit'))"
        "document.title='Orbit \\u00b7 '+document.title;"
        "if(document.getElementById('orbit-cs-switcher'))return;"
        "var a=document.createElement('a');a.id='orbit-cs-switcher';a.href='/app/';"
        "a.title='Switch to Pulsar CS Desk (Orbit)';a.textContent='Pulsar CS Desk \\u2197';"
        "a.style.cssText='position:fixed;right:16px;bottom:16px;z-index:40;display:inline-flex;"
        "align-items:center;gap:7px;padding:8px 14px;border-radius:9999px;"
        "background:linear-gradient(135deg,#2781F6,#1d4ed8);color:#ffffff;"
        "font:600 12px/1 system-ui,-apple-system,sans-serif;text-decoration:none;"
        "border:1px solid rgba(255,255,255,0.2);box-shadow:0 8px 22px rgba(39,129,246,0.34);';"
        "document.body.appendChild(a);}function s(){new MutationObserver(m).observe("
        "document.body,{childList:true,subtree:true});setInterval(m,500);m();}"
        "if(document.readyState==='complete'){setTimeout(s,250);}else{"
        "window.addEventListener('load',function(){setTimeout(s,250);});}})();"
    )
    for p in sorted(glob.glob(str(ROOT / "web/saturn/web/build/client/assets/entry.client-*.js"))):
        txt = Path(p).read_text()
        if "orbit-cs-switcher" not in txt:
            Path(p).write_text(txt.rstrip() + switcher_js)
            print(f"✔ re-applied Orbit switcher pill in {Path(p).relative_to(ROOT)}")

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
        ("crates/orbit/src/main.rs", "/api/v1/orbit"),
        ("crates/saturn/src/webhook_out.rs", "pub fn subscribe_internal"),
    ]
    for rel, needle in guards:
        fp = ROOT / rel
        if not fp.exists() or needle not in fp.read_text():
            raise SystemExit(f"✖ Orbit safety guard failed: '{needle}' missing in {rel}")
    entries = sorted(glob.glob(str(ROOT / "web/saturn/web/build/client/assets/entry.client-*.js")))
    if not any("Pulsar CS Desk" in Path(p).read_text() for p in entries):
        raise SystemExit("✖ Orbit safety guard failed: Pulsar CS Desk switcher missing in Saturn entry.client")
    print("✔ All Orbit feature safety guards intact")

tmpdir = Path(tempfile.mkdtemp(prefix="orbit-sync-"))
try:
    repos: dict[str, Path] = {}
    if pulsar_override:
        repos["pulsar"] = Path(pulsar_override).resolve()
    elif use_remote:
        dst = tmpdir / "pulsar"
        subprocess.run(["git", "clone", "--branch", lock["pulsar"]["branch"], lock["pulsar"]["repo"], str(dst)], check=True)
        repos["pulsar"] = dst
    else:
        repos["pulsar"] = (ROOT.parent / "pulsar").resolve()

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

    for name in ("pulsar", "saturn"):
        repo = repos[name]
        if not (repo / ".git").exists():
            raise SystemExit(f"✖ Upstream repo not found at {repo} (pass --remote to clone)")
        base_sha = lock[name]["sha"]
        is_custom = (name == "pulsar" and pulsar_override) or (name == "saturn" and saturn_override)
        target_ref = "HEAD" if is_custom else lock[name]["branch"]
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
