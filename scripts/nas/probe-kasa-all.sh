#!/bin/bash
# Probe all configured Kasa plug hosts. Override with KASA_PROBE_HOSTS (space-separated).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEFAULT_HOSTS="192.168.1.61 192.168.0.186 192.168.0.187 192.168.1.145"
read -r -a HOSTS <<< "${KASA_PROBE_HOSTS:-${DEFAULT_HOSTS}}"

for host in "${HOSTS[@]}"; do
	echo ""
	"${SCRIPT_DIR}/probe-kasa-full.sh" "${host}"
done
