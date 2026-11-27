#!/usr/bin/env bash
# Runs the given command (a test run) with a throwaway data directory and a throwaway config directory holding copies of the
# shipped config/*.example.* files, with .env, secrets.yaml and the settings store's master key pointed inside it, and removes
# both when the command ends. No test writes under the checkout's data/ (log files included) or reads the owner's config.yaml,
# .env, secrets.yaml or master key.
# @spec DEPLOY-TOOL-022
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
data=""
conf=""
# Armed before the first directory exists, so a failed second mktemp still removes the first.
trap 'rm -rf ${data:+"$data"} ${conf:+"$conf"}' EXIT
data="$(mktemp -d "${TMPDIR:-/tmp}/cohost-test-data.XXXXXX")"
conf="$(mktemp -d "${TMPDIR:-/tmp}/cohost-test-config.XXXXXX")"

cp "$root"/config/*.example.* "$conf"/
export COHOST_DATA_DIR="$data"
export CONFIG_DIR="$conf"
export COHOST_ENV_FILE="$conf/.env"
export COHOST_SECRETS_FILE="$conf/secrets/secrets.yaml"
export COHOST_KEY_FILE="$conf/master.key"

"$@"
