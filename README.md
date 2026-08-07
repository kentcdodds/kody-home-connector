# Kody Home Connector

Local-network home automation connector for Kody.

The connector runs as a Node 24 process on the local network and opens an
outbound WebSocket to the Kody Worker. It exposes local device integrations as
MCP tools over the remote connector protocol from `@kody-bot/connector-kit`.

See [`docs/home-connector.md`](./docs/home-connector.md) for architecture and
adapter details.

## Development

```bash
npm install
npm run dev
```

## Configuration

### Single-account (legacy)

Set `KODY_USERNAME` for deployed connectors so the Worker WebSocket uses Kody's
username-scoped ingress path. `HOME_CONNECTOR_ID` must match the connector name
saved in Kody (`/account/remote-connectors`):

```bash
KODY_USERNAME=your-kody-username
HOME_CONNECTOR_ID=home
WORKER_BASE_URL=https://heykody.app
HOME_CONNECTOR_SHARED_SECRET=...
```

`HOME_CONNECTOR_ID` still defaults to `default`, and `WORKER_BASE_URL` still
defaults to `http://localhost:3742` for local development. After Kody's
kind-less connector migration, the WebSocket URL is
`wss://…/@you/connectors/<name>` with no separate kind segment.

### Multi-account Worker sessions

One LAN process can dial any number of independent Kody accounts. All sessions
share the same local adapters, tool registry, and SQLite device state.

Configure targets with `HOME_CONNECTOR_TARGETS` (JSON array) or
`HOME_CONNECTOR_TARGETS_FILE` (path to a JSON file). Do not set both.

Each Kody account still needs its own `/account/remote-connectors` row and
shared secret. This only multi-dials from one process.

```bash
WORKER_BASE_URL=https://heykody.dev
HOME_CONNECTOR_TARGETS='[
  {
    "kodyUsername": "alice",
    "sharedSecret": "...",
    "connectorId": "home"
  },
  {
    "kodyUsername": "bob",
    "sharedSecret": "...",
    "connectorId": "home"
  }
]'
```

Per-target fields:

- `kodyUsername` (required for production Worker URLs)
- `sharedSecret` (Worker auth secret for that account)
- `connectorId` / `homeConnectorId` (optional; defaults to `default`)
- `workerBaseUrl` (optional; inherits process `WORKER_BASE_URL`)

When multi-target config is omitted, the legacy single-target env vars above
still open exactly one session.

Useful checks:

```bash
npm run validate
```
