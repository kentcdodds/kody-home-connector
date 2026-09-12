# NAS diagnostic scripts

Copy these files to the Synology NAS docker folder (for example
`/volume1/docker/`) alongside `start-kody-home-connector.sh`. They help debug
KLAP connectivity from the same host-network Docker path production uses.

Scripts:

- `probe-kasa-full.sh [host]` — one-off container with mounted probe script
- `probe-kasa-exec.sh [host]` — probe inside the running connector container
- `probe-kasa-all.sh` — runs `probe-kasa-full.sh` for each plug host

Optional env file for credential comparison tests:

- `/volume1/docker/kasa-test.env` with `KASA_USERNAME` and `KASA_PASSWORD`

The probe reads `HOME_CONNECTOR_SHARED_SECRET` from the environment or from
`start-kody-home-connector.sh` in the same directory.

Audiobook archive mount (required for AAXC→M4B import): merge the RW volume from
`docker/README.md` into `start-kody-home-connector.sh`:

```bash
# Synology host path for Kent's NAS pull
-v /volume1/media/audio/audiobooks:/media/audiobooks
-e AUDIOBOOK_LIBRARY_PATH=/media/audiobooks
```

Mac equivalent host path: `/Volumes/media/audio/audiobooks`. Do not mark the
home-connector mount `:ro`.

Override plug hosts for `probe-kasa-all.sh`:

```bash
KASA_PROBE_HOSTS="192.168.1.61 192.168.0.186" ./probe-kasa-all.sh
```
