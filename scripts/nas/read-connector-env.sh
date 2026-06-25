#!/bin/bash
# Shared helpers for NAS-side Kasa probe scripts. Source from other scripts:
#   source "${SCRIPT_DIR}/read-connector-env.sh"
#   load_connector_env "${SCRIPT_DIR}/start-kody-home-connector.sh"

load_connector_env() {
	local start_script="${1:-}"

	if [[ -z "${HOME_CONNECTOR_ID:-}" && -f "${start_script}" ]]; then
		HOME_CONNECTOR_ID="$(
			sed -n 's/^HOME_CONNECTOR_ID="\(.*\)"$/\1/p' "${start_script}" | head -1
		)"
		export HOME_CONNECTOR_ID
	fi

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

	if [[ -z "${DATA_PATH:-}" && -f "${start_script}" ]]; then
		DATA_PATH="$(
			sed -n 's/^HOST_DATA_PATH="\(.*\)"$/\1/p' "${start_script}" | head -1
		)"
		export DATA_PATH
	fi

	if [[ -z "${DATA_PATH:-}" ]]; then
		DATA_PATH="/volume1/docker/kody-home-connector"
		export DATA_PATH
	fi

	if [[ -z "${KASA_KLAP_USE_SUBPROCESS:-}" && -f "${start_script}" ]]; then
		KASA_KLAP_USE_SUBPROCESS="$(
			sed -n 's/^[[:space:]]*-e "KASA_KLAP_USE_SUBPROCESS=\([^"]*\)".*/\1/p' "${start_script}" | head -1
		)"
		export KASA_KLAP_USE_SUBPROCESS
	fi

	if [[ -z "${HOME_CONNECTOR_DB_PATH:-}" && -f "${start_script}" ]]; then
		HOME_CONNECTOR_DB_PATH="$(
			sed -n 's/^[[:space:]]*-e "HOME_CONNECTOR_DB_PATH=\([^"]*\)".*/\1/p' "${start_script}" | head -1
		)"
		export HOME_CONNECTOR_DB_PATH
	fi

	return 0
}
