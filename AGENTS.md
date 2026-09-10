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
