# Home connector Docker / NAS deploy

Production image: `kentcdodds/kody-home-connector` (`latest` plus
`sha-<short>`). After **Publish Home Connector** succeeds on `main`, pull
`latest` on the Synology NAS (`192.168.1.234`) and restart with the start script
next to `/volume1/docker/`. Keep the existing host data volume
(`HOST_DATA_PATH`, default `/volume1/docker/kody-home-connector`) mounted at
`/data/home-connector`. OAuth authorization codes, refresh tokens, and hashed
access tokens live in that SQLite file. Image recreate (`docker rm` +
`docker run`) does **not** invalidate Kody's tokens when this mount is
unchanged. Omitting the volume, or using a `HOME_CONNECTOR_DB_PATH` inside the
container filesystem, wipes the OAuth store and forces interactive reauth.
Tokens are opaque hashes, not JWTs, so there is no signing key to carry across
deploys.

## One-time: enable NAS container updates (docker.sock)

Agents can pull allowlisted **main** images and recreate containers
(`home-connector` → `kentcdodds/kody-home-connector:latest`, `mediarss` →
`kentcdodds/mediarss:main`) via `nas_update_container`. The connector talks to
the Docker Engine API over a unix socket (no Docker CLI, no SSH). **docker.sock
is root-equivalent** — the code only issues allowlisted Engine calls, and writes
default **off** until you enable them.

Do this once on the NAS (Container Manager UI or SSH). The running container
cannot mount the socket into itself.

1. Merge the template `docker/start-kody-home-connector.sh` into
   `/volume1/docker/start-kody-home-connector.sh` (keep your secrets). Confirm
   these lines exist:

   ```bash
   -v /var/run/docker.sock:/var/run/docker.sock \
   -e "NAS_DOCKER_SOCKET_PATH=/var/run/docker.sock" \
   ```

2. Recreate the connector from the host (pulls `latest` and remounts):

   ```bash
   cd /volume1/docker
   ./start-kody-home-connector.sh
   ```

3. Confirm the socket is visible:

   ```bash
   docker exec kody-home-connector ls -l /var/run/docker.sock
   ```

4. In MCP, enable writes when you are ready (still requires
   `acknowledgeHighRisk` + exact confirmation on each update):

   ```js
   kody.mcp['home'].nas_container_updates_set_config({ enabled: true })
   ```

5. Optional: if MediaRSS’s container name is not `mediarss`, set it once:

   ```js
   kody.mcp['home'].nas_container_updates_set_config({
   	mediarssContainerName: 'your-actual-name',
   })
   ```

After step 2, agents can `nas_check_container_update` / `nas_update_container`
(and self-update the connector). Keep the data volume mount unchanged across
recreates.

Integration settings that used to be docker `-e` flags (Araknis base URL / TLS /
SSH, Unleashed scan CIDRs, Island host, court pins, discovery URLs, …) now live
in that same SQLite file as **runtime config**. Prefer MCP `*_set_config` tools
over editing the start script. Env vars still seed values when no stored row
exists (`stored > env > default`). Bootstrap-only env (`HOME_CONNECTOR_ID`, data
key/secret, data path, volume mounts, listen port, public MCP base URL, SSH key
file paths) stays in the start script.

To smoke a PR without moving prod `latest` (currently `sha-f7134d6`), run
**Publish Home Connector** → **Run workflow** on that branch, then:

```bash
IMAGE=kentcdodds/kody-home-connector:sha-<short> ./start-kody-home-connector.sh
```

## Audiobook library mount (RW)

Personal Audible→M4B import writes flat `Title.m4b` files into the same
audiobook share mediarss already publishes. Use one in-container path:

| Role                           | Path                              |
| ------------------------------ | --------------------------------- |
| In-container (home + mediarss) | `/media/audiobooks`               |
| Synology NAS host (Kent pull)  | `/volume1/media/audio/audiobooks` |
| Mac host                       | `/Volumes/media/audio/audiobooks` |

The share **must be read-write** on this container. mediarss can stay read-only
if that is how it is deployed today.

`AUDIOBOOK_LIBRARY_PATH` defaults to `/media/audiobooks`. Override only if the
mount point changes.

Add this volume to the existing NAS `start-kody-home-connector.sh` (or use the
template in this directory):

```bash
HOST_AUDIOBOOK_LIBRARY_PATH="/volume1/media/audio/audiobooks"
# Mac: HOST_AUDIOBOOK_LIBRARY_PATH="/Volumes/media/audio/audiobooks"

docker run ... \
  -e "AUDIOBOOK_LIBRARY_PATH=/media/audiobooks" \
  -v "${HOST_AUDIOBOOK_LIBRARY_PATH}:/media/audiobooks" \
  ...
```

Do not add `:ro` on the home-connector mount.

The image includes `ffmpeg` (AAXC `audible_key`/`audible_iv`, AAX
`activation_bytes`). Confirm after pull:

```bash
docker exec kody-home-connector ffmpeg -version
docker exec kody-home-connector ls -ld /media/audiobooks
```
