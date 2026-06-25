#!/bin/bash
# Shared helpers for NAS-side Kasa probe scripts. Source from other scripts:
#   source "${SCRIPT_DIR}/read-connector-env.sh"
#   load_connector_env "${SCRIPT_DIR}/start-kody-home-connector.sh"

load_connector_env() {
	local start_script="${1:-}"

	if [[ -z "${HOME_CONNECTOR_ID:-}" ]]; then
		HOME_CONNECTOR_ID="default"
		export HOME_CONNECTOR_ID
	fi

	if [[ -z "${HOME_CONNECTOR_SHARED_SECRET:-}" && -f "${start_script}" ]]; then
		HOME_CONNECTOR_SHARED_SECRET="$(
			sed -n 's/^HOME_CONNECTOR_SHARED_SECRET="\(.*\)"$/\1/p' "${start_script}" | head -1
		)"
		export HOME_CONNECTOR_SHARED_SECRET
	fi

	if [[ -z "${HOME_CONNECTOR_SHARED_SECRET:-}" ]]; then
		echo "Set HOME_CONNECTOR_SHARED_SECRET or place start-kody-home-connector.sh alongside the probe scripts." >&2
		return 1
	fi

	if [[ -z "${DATA_PATH:-}" ]]; then
		DATA_PATH="/volume1/docker/kody-home-connector"
		export DATA_PATH
	fi

	return 0
}
