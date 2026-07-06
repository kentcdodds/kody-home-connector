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

Set `KODY_USERNAME` for deployed connectors so the Worker WebSocket uses Kody's
username-scoped ingress path. `HOME_CONNECTOR_ID` must match the connector name
saved in Kody (`/account/remote-connectors`):

```bash
KODY_USERNAME=your-kody-username
HOME_CONNECTOR_ID=home
WORKER_BASE_URL=https://heykody.dev
HOME_CONNECTOR_SHARED_SECRET=...
```

`HOME_CONNECTOR_ID` still defaults to `default`, and `WORKER_BASE_URL` still
defaults to `http://localhost:3742` for local development. After Kody's
kind-less connector migration, the WebSocket URL is
`wss://…/@you/connectors/<name>` with no separate kind segment.

Useful checks:

```bash
npm run validate
```
