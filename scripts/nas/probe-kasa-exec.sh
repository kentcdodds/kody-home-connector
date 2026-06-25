#!/bin/bash
# Run the KLAP probe inside the running kody-home-connector container.
# Same image and SQLite as production, but a fresh Node process.
#
# Usage:
#   ./probe-kasa-exec.sh [host]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=read-connector-env.sh
source "${SCRIPT_DIR}/read-connector-env.sh"

PROBE_SCRIPT="${SCRIPT_DIR}/probe-kasa-full.mjs"
CONTAINER="${CONTAINER:-kody-home-connector}"
HOST="${1:-192.168.1.61}"
START_SCRIPT="${START_SCRIPT:-${SCRIPT_DIR}/start-kody-home-connector.sh}"

if [[ ! -f "${PROBE_SCRIPT}" ]]; then
	echo "Missing ${PROBE_SCRIPT}" >&2
	exit 1
fi

if ! docker inspect "${CONTAINER}" >/dev/null 2>&1; then
	echo "Container ${CONTAINER} is not running." >&2
	exit 1
fi

load_connector_env "${START_SCRIPT}"

APP_COMMIT_SHA="$(
	docker inspect "${CONTAINER}" --format '{{range .Config.Env}}{{println .}}{{end}}' \
		| sed -n 's/^APP_COMMIT_SHA=//p' \
		| head -1
)"
APP_COMMIT_SHA="${APP_COMMIT_SHA:-unknown}"

echo "=== KLAP diagnostics via docker exec in ${CONTAINER} to ${HOST} ==="
echo "  Container APP_COMMIT_SHA: ${APP_COMMIT_SHA}"
echo ""

docker cp "${PROBE_SCRIPT}" "${CONTAINER}:/tmp/probe-kasa-full.mjs"

docker exec \
	-e "HOST=${HOST}" \
	-e "APP_COMMIT_SHA=${APP_COMMIT_SHA}" \
	-e "HOME_CONNECTOR_ID=${HOME_CONNECTOR_ID}" \
	-e "HOME_CONNECTOR_SHARED_SECRET=${HOME_CONNECTOR_SHARED_SECRET}" \
	-e "HOME_CONNECTOR_DATA_PATH=/data/home-connector" \
	"${CONTAINER}" \
	node --experimental-strip-types /tmp/probe-kasa-full.mjs
