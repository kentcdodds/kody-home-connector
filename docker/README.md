# Home connector Docker / NAS deploy

Production image: `kentcdodds/kody-home-connector` (`latest` plus
`sha-<short>`). After **Publish Home Connector** succeeds, pull on the Synology
NAS (`192.168.1.234`) and restart with the start script next to
`/volume1/docker/`.

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
