#!/usr/bin/env bash
# Runs the given command (a test run) with a throwaway data directory and a throwaway config directory holding copies of the
# shipped config/*.example.* files, with .env and secrets.yaml pointed inside it, and removes both when the command ends. No
# test writes under the checkout's data/ (log files included) or reads the owner's config.yaml, .env or secrets.yaml.
# @spec DEPLOY-TOOL-022
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
data="$(mktemp -d "${TMPDIR:-/tmp}/cohost-test-data.XXXXXX")"
conf="$(mktemp -d "${TMPDIR:-/tmp}/cohost-test-config.XXXXXX")"
trap 'rm -rf "$data" "$conf"' EXIT

cp "$root"/config/*.example.* "$conf"/
export COHOST_DATA_DIR="$data"
export CONFIG_DIR="$conf"
export COHOST_ENV_FILE="$conf/.env"
export COHOST_SECRETS_FILE="$conf/secrets/secrets.yaml"

"$@"
