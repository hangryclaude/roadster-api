#!/usr/bin/env bash
# freetessie-proxy.sh — builds and runs Tesla's own signing sidecar (tesla-http-proxy,
# teslamotors/vehicle-command, Apache 2.0) on loopback, exactly as docs/FREETESSIE-BRIEF.md's
# "Decision: Tesla's own Go proxy sidecar, not native TS" calls for. freetessie's
# fleetClient.ts talks to this process over TLS at config.signingProxyUrl — nothing in
# this repo reimplements the Vehicle Command Protocol's signing, and this script doesn't
# either; it only builds and launches Tesla's own binary.
#
# Module path/flags verified against the real source and a real build (2026-10-27):
#   https://github.com/teslamotors/vehicle-command/tree/main/cmd/tesla-http-proxy
#   https://github.com/teslamotors/vehicle-command#readme ("Running the Proxy Server")
# `go install github.com/teslamotors/vehicle-command/cmd/tesla-http-proxy@latest` —
# the obvious one-liner — does NOT work: vehicle-command's own go.mod carries a
# `replace` directive (JuulLabs-OSS/cbgo -> tinygo-org/cbgo), and `go install pkg@version`
# categorically refuses any module whose go.mod has one, even a non-local one — confirmed
# by actually running it and hitting that exact refusal, not assumed. The working path,
# also confirmed by actually building it, is the one the README itself uses: clone the
# repo, then `go build` from inside it, where replace directives are honored normally.
# -key-file is the vehicle COMMAND-signing private key (TESLA_PUBLIC_KEY_PATH's pair,
# keys/private-key.pem — generate it with `npm run freetessie:setup -- keygen` first).
# -tls-key/-cert are this process's OWN loopback HTTPS listener cert, unrelated to that
# key and to the public "3p" key Tesla verifies over the internet.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KEYS_DIR="${REPO_ROOT}/keys"
PRIVATE_KEY="${KEYS_DIR}/private-key.pem"
PROXY_TLS_KEY="${KEYS_DIR}/proxy-key.pem"
PROXY_TLS_CERT="${KEYS_DIR}/proxy-cert.pem"
PORT="${SIGNING_PROXY_PORT:-4443}"
HOST="${SIGNING_PROXY_HOST:-127.0.0.1}"
SRC_DIR="${REPO_ROOT}/.freetessie-proxy-src"
PROXY_BIN="${REPO_ROOT}/keys/tesla-http-proxy"
REPO_URL="https://github.com/teslamotors/vehicle-command"

mkdir -p "$KEYS_DIR"

if [[ ! -f "$PRIVATE_KEY" ]]; then
  echo "freetessie-proxy: missing ${PRIVATE_KEY}" >&2
  echo "  run \`npm run freetessie:setup -- keygen\` first, then re-run this script." >&2
  exit 1
fi

if ! command -v go >/dev/null 2>&1; then
  echo "freetessie-proxy: 'go' is not installed — install it (e.g. 'brew install go') and re-run." >&2
  exit 1
fi

if [[ ! -x "$PROXY_BIN" ]]; then
  if [[ ! -d "$SRC_DIR" ]]; then
    echo "freetessie-proxy: cloning ${REPO_URL} into ${SRC_DIR} ..."
    git clone --depth 1 "$REPO_URL" "$SRC_DIR"
  fi
  echo "freetessie-proxy: building tesla-http-proxy (go build, inside the clone) ..."
  (cd "$SRC_DIR" && go build -o "$PROXY_BIN" ./cmd/tesla-http-proxy)
fi

if [[ ! -x "$PROXY_BIN" ]]; then
  echo "freetessie-proxy: build finished but ${PROXY_BIN} is still missing — check the build output above." >&2
  exit 1
fi

# This sidecar's own loopback TLS pair (separate from TESLA_PUBLIC_KEY_PATH, which is
# the key Tesla itself verifies over the internet) — the exact openssl invocation
# tesla-http-proxy's own README documents for a self-signed loopback cert.
if [[ ! -f "$PROXY_TLS_KEY" || ! -f "$PROXY_TLS_CERT" ]]; then
  echo "freetessie-proxy: generating a self-signed loopback TLS cert at ${KEYS_DIR} ..."
  openssl req -x509 -nodes -newkey ec \
    -pkeyopt ec_paramgen_curve:secp384r1 \
    -pkeyopt ec_param_enc:named_curve \
    -subj "/CN=${HOST}" \
    -keyout "$PROXY_TLS_KEY" -out "$PROXY_TLS_CERT" -sha256 -days 3650 \
    -addext "extendedKeyUsage = serverAuth" \
    -addext "keyUsage = digitalSignature, keyCertSign, keyAgreement"
  chmod 600 "$PROXY_TLS_KEY"
fi

# The sidecar never needs public exposure — freetessie's fleetClient.ts is its only
# caller, bound on loopback only (-host 127.0.0.1) so this doesn't add new attack surface.
echo "freetessie-proxy: listening on https://${HOST}:${PORT}"
echo "freetessie-proxy: Node's fetch won't trust this self-signed cert on its own — set, for"
echo "  the freetessie process (not this one):"
echo "    export NODE_EXTRA_CA_CERTS=\"${PROXY_TLS_CERT}\""
echo "  before starting it with TESLA_SIGNING_PROXY_URL=https://${HOST}:${PORT}."

exec "$PROXY_BIN" \
  -tls-key "$PROXY_TLS_KEY" \
  -cert "$PROXY_TLS_CERT" \
  -key-file "$PRIVATE_KEY" \
  -host "$HOST" \
  -port "$PORT"
