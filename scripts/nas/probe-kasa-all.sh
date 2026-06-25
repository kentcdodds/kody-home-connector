#!/bin/bash
# Probe all configured Kasa plug hosts. Override with KASA_PROBE_HOSTS (space-separated).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEFAULT_HOSTS="192.168.1.61 192.168.0.186 192.168.0.187 192.168.1.145"
read -r -a HOSTS <<< "${KASA_PROBE_HOSTS:-${DEFAULT_HOSTS}}"

status=0
for host in "${HOSTS[@]}"; do
	echo ""
	if ! "${SCRIPT_DIR}/probe-kasa-full.sh" "${host}"; then
		status=1
	fi
done
exit "${status}"
