#!/bin/bash
# Run on the Synology NAS to capture KLAP behavior from inside the connector
# image with --network host (same path as production).
#
# Usage:
#   ./probe-kasa-full.sh [host]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=read-connector-env.sh
source "${SCRIPT_DIR}/read-connector-env.sh"

PROBE_SCRIPT="${SCRIPT_DIR}/probe-kasa-full.mjs"
IMAGE="${IMAGE:-kentcdodds/kody-home-connector:latest}"
HOST="${1:-192.168.1.61}"
ENV_FILE="${ENV_FILE:-/volume1/docker/kasa-test.env}"
START_SCRIPT="${START_SCRIPT:-${SCRIPT_DIR}/start-kody-home-connector.sh}"

if [[ ! -f "${PROBE_SCRIPT}" ]]; then
	echo "Missing ${PROBE_SCRIPT}" >&2
	exit 1
fi

load_connector_env "${START_SCRIPT}"

ENV_ARGS=()
if [[ -f "${ENV_FILE}" ]]; then
	ENV_ARGS=(--env-file "${ENV_FILE}")
	echo "Using credentials from ${ENV_FILE}"
else
	echo "No ${ENV_FILE} — env credential tests will be skipped."
fi

echo "=== KLAP diagnostics via ${IMAGE} to ${HOST} (network host) ==="

DOCKER_ENV=(
	-e "HOST=${HOST}"
	-e "HOME_CONNECTOR_ID=${HOME_CONNECTOR_ID}"
	-e "HOME_CONNECTOR_SHARED_SECRET=${HOME_CONNECTOR_SHARED_SECRET}"
	-e "HOME_CONNECTOR_DATA_PATH=/data/home-connector"
)
if [[ -n "${KASA_KLAP_USE_SUBPROCESS:-}" ]]; then
	DOCKER_ENV+=(-e "KASA_KLAP_USE_SUBPROCESS=${KASA_KLAP_USE_SUBPROCESS}")
fi
if [[ -n "${HOME_CONNECTOR_DB_PATH:-}" ]]; then
	DOCKER_ENV+=(-e "HOME_CONNECTOR_DB_PATH=${HOME_CONNECTOR_DB_PATH}")
fi

docker run --rm --network host \
	"${ENV_ARGS[@]}" \
	"${DOCKER_ENV[@]}" \
	-v "${DATA_PATH}:/data/home-connector:ro" \
	-v "${PROBE_SCRIPT}:/probe.mjs:ro" \
	"${IMAGE}" \
	node --experimental-strip-types /probe.mjs
