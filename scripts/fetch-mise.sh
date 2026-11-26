#!/usr/bin/env bash
# Fetch, verify and install one mise release binary (deployment design, "Verifying mise").
#   scripts/fetch-mise.sh <version> <destination>
# Run by scripts/install.sh (destination ~/.local/bin/mise) and by the Dockerfile's toolchain stage
# (/usr/local/bin/mise). It downloads only the release tarball and the clearsigned SHASUMS256.asc,
# verifies the signature with the committed release key in a throwaway keyring, requires the
# signature to be from the pinned primary key, checks the tarball against the one signed line naming it,
# and only then unpacks it. Every step's status is checked explicitly; a failure names the step,
# exits non-zero and installs nothing.
#
# Two optional arguments, <key file> <fingerprint>, replace the committed key and the pinned fingerprint;
# they exist for the test that exercises this procedure with a key of its own. The installer and the
# Dockerfile never pass them.
# @spec DEPLOY-TOOL-020
set -uo pipefail

here=$(cd "$(dirname "$0")" && pwd)
version=${1:-}
dest=${2:-}
key=${3:-$here/mise-release-key.asc}
fingerprint=${4:-24853EC9F655CE80B48E6C3A8B81C9D17413A06D}
base=https://github.com/jdx/mise/releases/download

fail() {
  echo "fetch-mise: $1; mise v$version was not installed" >&2
  exit 1
}

[[ -n "$version" && -n "$dest" ]] || { echo "usage: $0 <version> <destination>" >&2; exit 2; }
tarball="mise-v${version}-linux-x64.tar.gz"

tmp=$(mktemp -d) || fail "creating a temporary directory failed"
trap 'rm -rf "$tmp"' EXIT
mkdir -m 700 "$tmp/gnupg" "$tmp/dl" "$tmp/x" || fail "creating the temporary directories failed"

curl -fsSL -o "$tmp/dl/$tarball" "$base/v$version/$tarball" || fail "downloading $tarball failed"
curl -fsSL -o "$tmp/dl/SHASUMS256.asc" "$base/v$version/SHASUMS256.asc" || fail "downloading SHASUMS256.asc failed"

gpg --batch --quiet --homedir "$tmp/gnupg" --import "$key" 2>"$tmp/gpg.err" \
  || { cat "$tmp/gpg.err" >&2; fail "importing the release key $key failed"; }

status=$(gpg --batch --homedir "$tmp/gnupg" --status-fd 1 --output "$tmp/sums" --decrypt "$tmp/dl/SHASUMS256.asc" 2>"$tmp/gpg.err")
rc=$?
[[ $rc -eq 0 ]] || { cat "$tmp/gpg.err" >&2; fail "gpg could not verify SHASUMS256.asc (exit $rc)"; }
signer=$(printf '%s\n' "$status" | awk '$1 == "[GNUPG:]" && $2 == "VALIDSIG" { print $NF }')
[[ "$signer" == "$fingerprint" ]] \
  || fail "SHASUMS256.asc is not signed by the mise release key $fingerprint (VALIDSIG: ${signer:-none})"

count=$(grep -c -- " ./$tarball\$" "$tmp/sums")
[[ "$count" == 1 ]] || fail "the signed checksums name $tarball $count times, not once"
grep -- " ./$tarball\$" "$tmp/sums" | (cd "$tmp/dl" && sha256sum -c --quiet -) \
  || fail "the sha256 of $tarball does not match the signed checksum"

tar -xzf "$tmp/dl/$tarball" -C "$tmp/x" || fail "unpacking $tarball failed"
[[ -f "$tmp/x/mise/bin/mise" ]] || fail "$tarball holds no mise/bin/mise"
mkdir -p "$(dirname "$dest")" || fail "creating $(dirname "$dest") failed"
install -m 0755 "$tmp/x/mise/bin/mise" "$dest" || fail "installing the binary to $dest failed"
echo "fetch-mise: installed mise v$version to $dest (signature and checksum verified)"
