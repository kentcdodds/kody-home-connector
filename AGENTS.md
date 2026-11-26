# kody-home-connector agent notes

Use Node 24 and npm for installs and scripts.

Useful checks:

- `npm test`
- `npm run lint`
- `npm run format:check`
- `npm run validate`

This repo contains the local-network `home` remote connector for Kody. Shared
remote connector protocol helpers come from `@kody-bot/connector-kit`.

Persistence uses `remix/data-table` over SQLite. Tables are declared in
`src/storage/schema.ts`; schema changes are SQL migrations under
`db/migrations/<timestamp>_<slug>/up.sql`, applied at startup and via
`HOME_CONNECTOR_DB_PATH=... npx remix db <status|migrate|rollback>`. See "Data
layer" in `docs/home-connector.md`.

Remix (`remix`, pinned to an exact version) ships its docs in the package. Start
at `node_modules/remix/INDEX.md`, which maps workflows to the installed guides
(`node_modules/remix/guides/`) and `remix/*` imports to their READMEs; prefer
those over hosted docs so APIs match the installed version.

Agent quick references (details in "Roku: play a video link / verify playback"
in `docs/home-connector.md`):

- `roku_play_youtube`: play a YouTube link on an adopted Roku and check that
  YouTube is active (Roku cannot confirm which video is playing).
- `roku_get_media_player`: active app plus playback state in one call.
- Roku ECP calls self-heal a stale stored address (one rediscovery, identity
  check, and retry); never hardcode Roku IPs.
