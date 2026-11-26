#!/usr/bin/env bash
# Type-checks the test directories that `tsc -b` does not: each packages/*/test and services/*/test tsconfig.json that sets
# noEmit, with `tsc -p`, one directory at a time. Run by the `typecheck` task after `tsc -b`, so the packages' dist/ types the
# tests import are current. Every directory is checked; the run fails when any of them has a type error.
# @spec DEPLOY-TOOL-023
set -uo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

command -v tsc >/dev/null || { echo "typecheck: tsc not on PATH" >&2; exit 1; }

failed=()
for cfg in packages/*/test/tsconfig.json services/*/test/tsconfig.json; do
  grep -q '"noEmit": true' "$cfg" || continue
  tsc -p "$cfg" || failed+=("$(dirname "$cfg")")
done

if ((${#failed[@]})); then
  echo "typecheck: type errors in ${failed[*]}" >&2
  exit 1
fi
