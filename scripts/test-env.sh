#!/usr/bin/env bash
# Runs the given command (a test run) with a throwaway data directory and a throwaway config directory holding copies of the
# shipped config/*.example.* files, with .env and the settings store's master key pointed inside it, and removes
# both when the command ends. No test writes under the checkout's data/ (log files included) or opens the owner's settings
# store, .env or master key.
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
export COHOST_KEY_FILE="$conf/master.key"
# The store refuses its default key path while this is set (settings-store STORE-KEY-001), so a test that opens it with
# COHOST_KEY_FILE unset fails instead of reading or creating the owner's ~/.config/cohost/master.key.
export COHOST_TEST_ENV=1

"$@"
