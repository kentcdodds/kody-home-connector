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

Useful checks:

```bash
npm run validate
```
