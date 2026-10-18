#!/bin/bash
# Template / merge source for the NAS start script at /volume1/docker/.
# Copy secrets and existing -e flags from the live start-kody-home-connector.sh.
# The important new piece is the RW audiobook share at /media/audiobooks.
# Keep HOST_DATA_PATH mounted: OAuth refresh tokens live in that SQLite file
# and must survive image recreate or Kody has to reauth.
set -euo pipefail

IMAGE="${IMAGE:-kentcdodds/kody-home-connector:latest}"
CONTAINER_NAME="${CONTAINER_NAME:-kody-home-connector}"
HOST_DATA_PATH="${HOST_DATA_PATH:-/volume1/docker/kody-home-connector}"
# Synology NAS host path for Kent's pull. Mac: /Volumes/media/audio/audiobooks
HOST_AUDIOBOOK_LIBRARY_PATH="${HOST_AUDIOBOOK_LIBRARY_PATH:-/volume1/media/audio/audiobooks}"
AUDIOBOOK_LIBRARY_PATH="${AUDIOBOOK_LIBRARY_PATH:-/media/audiobooks}"

if [[ -z "${HOME_CONNECTOR_SHARED_SECRET:-}" && -z "${HOME_CONNECTOR_DATA_KEY:-}" ]]; then
	echo "Set HOME_CONNECTOR_SHARED_SECRET or HOME_CONNECTOR_DATA_KEY from the live NAS start script." >&2
	exit 1
fi

docker pull "${IMAGE}"
docker stop "${CONTAINER_NAME}" >/dev/null 2>&1 || true
docker rm "${CONTAINER_NAME}" >/dev/null 2>&1 || true

# Araknis / Unleashed / Island / court / discovery knobs that used to live as
# docker -e flags are now runtime config in SQLite under HOST_DATA_PATH.
# Prefer MCP tools (araknis_set_config, access_networks_unleashed_set_config,
# …) so changing them does not require editing this script or recreating the
# container. Env vars still work as a fallback seed (precedence: stored >
# env > default) but you should not need to add new -e lines for those
# settings. Username/password are NEVER env vars — use /araknis-switch/setup
# (or araknis_set_credentials), same pattern as Island PIN / Kasa.
#
# Bootstrap-only env that must stay here: HOME_CONNECTOR_ID, data key/secret,
# HOME_CONNECTOR_DATA_PATH, volume mounts (HOST_DATA_PATH, audiobook library),
# and optionally HOME_MCP_PUBLIC_BASE_URL / PORT.
docker run -d --name "${CONTAINER_NAME}" --network host --restart unless-stopped \
	-e "HOME_CONNECTOR_ID=${HOME_CONNECTOR_ID:-default}" \
	-e "HOME_CONNECTOR_SHARED_SECRET=${HOME_CONNECTOR_SHARED_SECRET:-}" \
	-e "HOME_CONNECTOR_DATA_KEY=${HOME_CONNECTOR_DATA_KEY:-}" \
	-e "HOME_CONNECTOR_DATA_PATH=/data/home-connector" \
	-e "AUDIOBOOK_LIBRARY_PATH=${AUDIOBOOK_LIBRARY_PATH}" \
	-v "${HOST_DATA_PATH}:/data/home-connector" \
	-v "${HOST_AUDIOBOOK_LIBRARY_PATH}:${AUDIOBOOK_LIBRARY_PATH}" \
	"${IMAGE}"
