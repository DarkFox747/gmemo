#!/bin/sh
# Builds dist-demo/gmemo-demo.zip (C8, demo-kit §7). Run: pnpm package:demo
#
# Contents: the working tree as git sees it (tracked + untracked files that are
# not gitignored), so new uncommitted docs/openspec files are included and
# everything in .gitignore (node_modules, dist, .env, .claude, ...) is not. An
# explicit exclusion list is applied on top as defence in depth.
#
# Gate: the zip is unzipped into a temp dir and checked for forbidden paths
# and grepped with the local .sanitize-patterns file (gitignored, extended
# regexes). The gate fails closed: a missing or empty patterns file aborts the
# script unless ALLOW_NO_PATTERNS=1 is set. Any hit fails the script. Only file
# paths are printed, never the matched text.
#
# POSIX sh; works in Git Bash. Needs git, tar, unzip and zip (or bsdtar).

set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

OUT_DIR="dist-demo"
ZIP_NAME="gmemo-demo.zip"
TOP="gmemo-demo"
PATTERNS=".sanitize-patterns"

# Paths never shipped (extended regex over repo-relative paths).
EXCLUDE='(^|/)node_modules/|^\.git/|(^|/)\.claude/|(^|/)\.claude\.json$|(^|/)\.mcp\.json$|(^|/)CLAUDE\.md$|^entrevistas/|(^|/)prompt\.md$|(^|/)PROMPT-demo-entrega4\.md$|(^|/)\.sanitize-patterns$|(^|/)dist/|^dist-demo/|\.tfvars$|\.tfvars\.json$|\.tfstate|(^|/)\.terraform/|(^|/)\.env$|(^|/)\.env\.|\.pem$|\.key$|\.p12$|\.pfx$|(^|/)id_rsa|(^|/)id_ed25519|(^|/)\.codex/|(^|/)\.cursor/|(^|/)\.windsurf/|(^|/)\.aider'
# ...except the documented examples.
KEEP='(^|/)\.env(\.[^/]*)?\.example$|\.tfvars\.example$'

fail() {
  echo "[package-demo] ERROR: $1" >&2
  exit 1
}

command -v git >/dev/null 2>&1 || fail "git is required"
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || fail "not a git working tree"
command -v unzip >/dev/null 2>&1 || fail "unzip is required for the verification step"

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT INT TERM

# 1) File list.
git -c core.quotepath=off ls-files --cached --others --exclude-standard \
  | grep -E -v "$EXCLUDE" > "$WORK/candidates" || true
git -c core.quotepath=off ls-files --cached --others --exclude-standard \
  | grep -E "$KEEP" >> "$WORK/candidates" || true
sort -u "$WORK/candidates" | while IFS= read -r f; do
  # Tracked files deleted from the working tree are skipped.
  if [ -f "$f" ]; then printf '%s\n' "$f"; fi
done > "$WORK/files"

COUNT=$(wc -l < "$WORK/files" | tr -d ' ')
[ "$COUNT" -gt 0 ] || fail "no files to package"
grep -q '^openspec/' "$WORK/files" || fail "openspec/ is missing from the package"
grep -q '^docs/demo/INSTRUCTIVO\.md$' "$WORK/files" || fail "docs/demo/INSTRUCTIVO.md is missing"

# 2) Stage under a top-level folder and zip it.
mkdir -p "$WORK/stage/$TOP"
tar -cf - -T "$WORK/files" | (cd "$WORK/stage/$TOP" && tar -xf -)

mkdir -p "$OUT_DIR"
rm -f "$OUT_DIR/$ZIP_NAME"
ZIP_PATH="$ROOT/$OUT_DIR/$ZIP_NAME"
if command -v zip >/dev/null 2>&1; then
  (cd "$WORK/stage" && zip -q -r -X "$ZIP_PATH" "$TOP")
elif command -v bsdtar >/dev/null 2>&1; then
  (cd "$WORK/stage" && bsdtar -a -cf "$ZIP_PATH" "$TOP")
elif [ -x "${SYSTEMROOT:-/c/Windows}/System32/tar.exe" ]; then
  # Windows ships bsdtar as tar.exe; -a picks the zip format from the extension.
  (cd "$WORK/stage" && "${SYSTEMROOT:-/c/Windows}/System32/tar.exe" -a -cf "$ZIP_PATH" "$TOP")
else
  fail "zip or bsdtar is required to create the archive"
fi
[ -s "$ZIP_PATH" ] || fail "the zip was not created"

# 3) Verification over the unzipped copy.
mkdir -p "$WORK/check"
unzip -q "$ZIP_PATH" -d "$WORK/check"

find "$WORK/check" \( -name node_modules -o -name .git -o -name .claude -o -name .claude.json \
  -o -name .mcp.json -o -name CLAUDE.md -o -name entrevistas -o -name prompt.md \
  -o -name PROMPT-demo-entrega4.md -o -name .sanitize-patterns -o -name .terraform \
  -o -name '*.pem' -o -name '*.key' -o -name '*.p12' -o -name '*.pfx' -o -name 'id_rsa*'   -o -name 'id_ed25519*' -o -name .codex -o -name .cursor -o -name .windsurf -o -name '.aider*'   -o -name dist -o -name '*.tfvars' -o -name '*.tfvars.json' -o -name '*.tfstate*' -o -name .env \
  -o \( -name '.env.*' ! -name '*.example' \) \) > "$WORK/forbidden"
if [ -s "$WORK/forbidden" ]; then
  sed "s|^$WORK/check/||" "$WORK/forbidden" >&2
  fail "forbidden paths found in the package"
fi

# Fail closed: without patterns the gate would silently check nothing.
: > "$WORK/patterns"
if [ -f "$PATTERNS" ]; then
  # Blank or comment lines would match everything: drop them.
  grep -v -E '^[[:space:]]*(#|$)' "$PATTERNS" > "$WORK/patterns" || true
fi
if [ -s "$WORK/patterns" ]; then
  if grep -r -I -l -i -E -f "$WORK/patterns" "$WORK/check" > "$WORK/hits"; then
    sed "s|^$WORK/check/||" "$WORK/hits" >&2
    fail "sanitization patterns matched the files above"
  fi
  echo "[package-demo] sanitization grep: clean ($(wc -l < "$WORK/patterns" | tr -d ' ') patterns)"
elif [ "${ALLOW_NO_PATTERNS:-}" = "1" ]; then
  echo "[package-demo] WARNING: $PATTERNS is missing or empty; ALLOW_NO_PATTERNS=1 set, so the sanitization grep is SKIPPED (forbidden-path check only)" >&2
else
  fail "$PATTERNS is missing or empty; refusing to package without the sanitization gate (set ALLOW_NO_PATTERNS=1 to override)"
fi

SIZE=$(wc -c < "$ZIP_PATH" | tr -d ' ')
echo "[package-demo] OK: $OUT_DIR/$ZIP_NAME ($COUNT files, $SIZE bytes)"
