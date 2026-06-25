#!/bin/bash
# Run the KLAP probe inside the running kody-home-connector container.
# Same image and SQLite as production, but a fresh Node process.
#
# Usage:
#   ./probe-kasa-exec.sh [host]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

PROBE_SCRIPT="${SCRIPT_DIR}/probe-kasa-full.mjs"
CONTAINER="${CONTAINER:-kody-home-connector}"
HOST="${1:-192.168.1.61}"

if [[ ! -f "${PROBE_SCRIPT}" ]]; then
	echo "Missing ${PROBE_SCRIPT}" >&2
	exit 1
fi

if [[ "$(docker inspect --format '{{.State.Running}}' "${CONTAINER}" 2>/dev/null || echo false)" != "true" ]]; then
	echo "Container ${CONTAINER} is not running." >&2
	exit 1
fi

read_container_env() {
	docker inspect "${CONTAINER}" --format '{{range .Config.Env}}{{println .}}{{end}}'
}

HOME_CONNECTOR_ID="$(
	read_container_env | sed -n 's/^HOME_CONNECTOR_ID=//p' | head -1
)"
HOME_CONNECTOR_SHARED_SECRET="$(
	read_container_env | sed -n 's/^HOME_CONNECTOR_SHARED_SECRET=//p' | head -1
)"
HOME_CONNECTOR_DATA_PATH="$(
	read_container_env | sed -n 's/^HOME_CONNECTOR_DATA_PATH=//p' | head -1
)"

if [[ -z "${HOME_CONNECTOR_ID}" || -z "${HOME_CONNECTOR_SHARED_SECRET}" || -z "${HOME_CONNECTOR_DATA_PATH}" ]]; then
	echo "Container ${CONTAINER} is missing HOME_CONNECTOR_ID, HOME_CONNECTOR_SHARED_SECRET, or HOME_CONNECTOR_DATA_PATH." >&2
	exit 1
fi

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
	-e "HOME_CONNECTOR_DATA_PATH=${HOME_CONNECTOR_DATA_PATH}" \
	"${CONTAINER}" \
	node --experimental-strip-types /tmp/probe-kasa-full.mjs
