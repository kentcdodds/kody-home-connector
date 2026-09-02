# Kody Home Connector

Local-network home automation MCP server for Kody.

The process still runs on Node 24 on the LAN (or behind a Cloudflare tunnel). It
no longer dials Kody over a reverse WebSocket. Kody connects to it the same way
it connects to Linear: outbound Streamable HTTP MCP plus OAuth.

Published MCP URL:

```
https://kody-home.doddsfamily.us/mcp
```

OAuth is CIMD-only (Client ID Metadata Documents). There is no Dynamic Client
Registration. Production Kody presents
`https://<kody-origin>/oauth/client-metadata.json` as `client_id` and callbacks
at `/account/mcp-servers/oauth/callback`.

See [`docs/home-connector.md`](./docs/home-connector.md) for architecture and
adapter details.

## Development

```bash
npm install
npm run dev
```

## Configuration

Public origin (defaults to the live hostname):

```bash
HOME_MCP_PUBLIC_BASE_URL=https://kody-home.doddsfamily.us
```

`/authorize` does not use an operator password. On the public hostname,
Cloudflare Access is the human gate. The LAN origin is trusted.

Optional local persistence:

```bash
HOME_CONNECTOR_ID=default
HOME_CONNECTOR_DATA_KEY=...
# HOME_CONNECTOR_SHARED_SECRET is still accepted as the SQLite data key
```

Keep an existing `HOME_CONNECTOR_ID` so adopted-device rows stay visible. That
id is only a local SQLite namespace. The Kody MCP server name is chosen when you
add the server in Kody (`home` is the usual name).

Android companion (optional): save the shared device token on `/phone/setup`. It
is encrypted in local SQLite with `HOME_CONNECTOR_DATA_KEY`.
`PHONE_DEVICE_TOKEN` remains an optional env fallback if no stored token is
present.

```bash
PHONE_DEVICE_TOKEN=...
```

The phone app dials `wss://kody-home.doddsfamily.us/phone/ws` (LAN:
`ws://192.168.1.234:4040/phone/ws`) with that token. Cloudflare Access Bypass
must include `/phone/ws` on the same list as `/mcp`. `/phone/status` and
`/phone/setup` stay behind Access. A phone cannot complete Access login.

Do not set `KODY_USERNAME`, `WORKER_BASE_URL`, `HOME_CONNECTOR_TARGETS`, or a
Worker shared secret for auth. Those Worker reverse-dial settings are gone.

## Add this server in Kody

1. Deploy this process on the NAS at `192.168.1.234:4040`. Cloudflare already
   routes `https://kody-home.doddsfamily.us` through the **Dodds Vault** tunnel.
   MCP/OAuth machine paths (`/mcp`, `/token`, `/revoke`, `/.well-known`,
   `/health`, `/phone/ws`) bypass Access. The admin UI and `/authorize` require
   Cloudflare Access. The LAN origin is trusted and has no extra login.
2. In Kody, open `/account/mcp-servers` and add
   `https://kody-home.doddsfamily.us/mcp` with name `home`.
3. Open the authorization URL, pass Cloudflare Access, and approve Kody.
4. Tools appear as `kody.mcp["home"].tool_name(...)`.

After Kody ships the remote-connector removal PR, run package codemod
`0005-remote-connector-to-mcp-server` on your packages to rewrite `kody.remote`
/ `remote:<name>:<tool>` to `kody.mcp` / `mcp:<name>:<tool>`.

Useful checks:

```bash
npm run validate
```
