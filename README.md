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
username-scoped ingress path:

```bash
KODY_USERNAME=your-kody-username
HOME_CONNECTOR_ID=default
WORKER_BASE_URL=https://heykody.dev
HOME_CONNECTOR_SHARED_SECRET=...
```

`HOME_CONNECTOR_ID` still defaults to `default`, and `WORKER_BASE_URL` still
defaults to `http://localhost:3742` for local development.

Useful checks:

```bash
npm run validate
```
