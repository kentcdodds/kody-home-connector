# Home MCP server

This process is the LAN-side MCP server for devices that are only reachable on
the local network. Kody connects to it the same way it connects to any other
remote MCP server: outbound Streamable HTTP to `/mcp`, then OAuth.

Published URL:

```
https://kody-home.doddsfamily.us/mcp
```

The protocol is MCP `2026-07-28` (SDK v2 `createMcpHandler`, dual-era so current
Kody clients can still connect). Authorization is CIMD only:

- `/.well-known/oauth-authorization-server` advertises
  `client_id_metadata_document_supported: true` and no `registration_endpoint`
- `/authorize` fetches the client's HTTPS Client ID Metadata Document, enforces
  PKCE S256, and requires RFC 8707 `resource` to be this server's MCP URL.
  Public `/authorize` is gated by Cloudflare Access. The LAN origin is trusted,
  so there is no operator password.
- `/token` and `/revoke` issue and revoke hashed bearer tokens
- `/mcp` requires `Authorization: Bearer` and answers 401 with
  `WWW-Authenticate` `resource_metadata`

There is no reverse-dial Worker WebSocket, no DCR, and no leftover Worker
shared-secret handshake. Each Kody account adds the same public MCP URL at
`/account/mcp-servers`. After authorize, tools are
`kody.mcp["<server-name>"].tool_name(...)` (use `home` as the server name).

Core env vars:

- `HOME_MCP_PUBLIC_BASE_URL` - public origin, default
  `https://kody-home.doddsfamily.us`
- `HOME_CONNECTOR_ID` - local SQLite namespace for adopted devices, default
  `default`. Keep an existing id so device rows stay visible. This is not the
  Kody MCP server name.
- `HOME_CONNECTOR_DATA_KEY` / `HOME_CONNECTOR_SHARED_SECRET` - optional local
  SQLite encryption key. Not used for MCP or Kody auth. Required to save the
  Android companion token from `/phone/setup`.
- `PHONE_DEVICE_TOKEN` - optional env fallback for the Android companion token
  on `/phone/ws`. Prefer the encrypted token saved from `/phone/setup`. Never
  log the raw value.

Cloudflare (KCD account, zone `doddsfamily.us`) already publishes this origin:

- Tunnel: **Dodds Vault** (`2b106400-17fb-466a-8abb-374e82608620`), same
  remote-managed tunnel as jellyfin / mediarss / music / vault
- Ingress: `kody-home.doddsfamily.us` → `http://192.168.1.234:4040`
- DNS: proxied CNAME to `{tunnel-id}.cfargotunnel.com`
- Access **Bypass** on `/mcp`, `/token`, `/revoke`, `/.well-known`, `/health`,
  and `/phone/ws` so Kody's CIMD client and the Android companion can reach
  machine paths without a Zero Trust login
- Access **Allow** on the rest of the hostname (admin UI and `/authorize`) for
  `kentcdodds@gmail.com` and `me@kentcdodds.com`

A phone cannot complete Cloudflare Access login. `/phone/status` and
`/phone/setup` stay behind Access like other admin pages. Do not put phone
control behind Access on `/mcp`; `/mcp` stays machine Bypass.

The Remix admin UI stays on the same HTTP server. Opening `/authorize` during
CIMD requires Cloudflare Access on the public hostname. The LAN origin is
trusted.

`home_connector_get_metadata`, `/health`, and the admin dashboard report MCP
URL, listening state, and local tool count.

## Current adapters

The connector exposes these local-device families:

- Roku discovery and control over SSDP + ECP HTTP
- Lutron HomeWorks QSX discovery and control over mDNS + LEAP TLS
- Samsung TV / Frame discovery and control over mDNS, REST, and local WebSocket
  channels
- Venstar WiFi thermostat status and control over the local REST API
- TP-Link Kasa KLAP/SHIP 2.0 smart plug discovery and on/off control
- Android phone companion over WebSocket at `/phone/ws` (status, permissions,
  calendars, contacts summary, network, mDNS, packages, battery, Bluetooth,
  display, system toggles, accounts, Settings, Tesla/cast diagnosis)
- Island router diagnostics and guarded writes over SSH using one typed command
  catalog
- Access Networks Unleashed / RUCKUS Unleashed WiFi controller reads and typed
  high-risk writes over the local AJAX management interface
- JellyFish Lighting controller discovery, zones, patterns, and daily/calendar
  schedules over the controller's local WebSocket API

All surfaces are registered as MCP tools on this process and served at `/mcp`.

## Bond bridge health and workflow fanout

The Bond adapter owns bridge-level request pacing, cooldown, and reliability
logs for all Bond MCP tools. Network failures put the whole bridge into a shared
circuit-breaker cooldown; consecutive bridge failures extend that cooldown up to
15 minutes so scheduled jobs and shade workflow retries do not keep probing an
unreachable bridge every time a workflow fans out across devices.

Workflow packages that may call more than one Bond device on the same bridge
should call `bond_get_bridge_health` once before fanout and again before
retrying after any Bond failure. If `shouldFanOut` or `shouldRetryNow` is false,
the workflow should skip all per-device calls for that bridge and schedule one
bridge-level retry at `nextRecommendedAttemptAt` (or after `retryAfterMs`). This
avoids turning one bridge outage into one error per shade/device.

`bond_get_reliability_status` includes the same `health` object plus recent
request logs for diagnostics. Use it when investigating reliability history; use
`bond_get_bridge_health` for lightweight workflow guards.

The production "Bond bridge ZPGI01117 uptime monitor" is a Kody scheduled job,
not source in this repository. After adding this server in Kody as `home`,
update that job to call `kody.mcp["home"].bond_get_bridge_health({ bridgeId })`
before `kody.mcp["home"].bond_get_bridge_version({ bridgeId })`. When health
says the bridge is cooling down, the monitor should record a skipped/backoff
sample and avoid the version fetch until `nextRecommendedAttemptAt`.

## JellyFish Lighting integration

The JellyFish adapter lives under `src/adapters/jellyfish/` and talks to local
controllers through their WebSocket JSON API from the connector host. This is
the right boundary for workflows that need controller access because Cursor
Cloud machines typically cannot reach the user's LAN controller directly.

The MCP surface includes:

- `jellyfish_scan_controllers`
- `jellyfish_list_controllers`
- `jellyfish_list_zones`
- `jellyfish_list_patterns`
- `jellyfish_get_pattern`
- `jellyfish_run_pattern`
- `jellyfish_get_daily_schedule`
- `jellyfish_set_daily_schedule`
- `jellyfish_get_calendar_schedule`
- `jellyfish_set_calendar_schedule`

Schedule write tools replace the full controller schedule list. Callers should
read the schedule first, remove or edit only the intended events, and then write
the complete desired list back. The connector validates schedule action types,
time/sunrise/sunset bounds, daily day codes (`M`, `T`, `W`, `TH`, `F`, `SA`,
`S`), calendar `YYYYMMDD` strings, and zone names against the controller's known
zones before sending a write.

Calendar schedule days include a year, but public JellyFish docs describe those
entries as annual. Do not treat the calendar schedule as a verified one-off
restoration mechanism without checking live controller behavior.

## Lutron integration

The Lutron adapter lives under `src/adapters/lutron/` and supports a generic,
runtime-discovered subset of HomeWorks QSX capabilities that have been validated
against a live processor and represented in sanitized mock fixtures:

- discover processors on the local network via `_lutron._tcp`
- persist discovered processor identity locally
- associate credentials with a discovered processor
- authenticate over LEAP on `8081`
- traverse the live area tree from `/area/rootarea`
- read associated zones, control stations, keypad buttons, LED state, and
  virtual buttons when present
- treat keypad buttons as scene-like controls when `virtualbutton` is empty
- press keypad buttons
- set direct zone levels for dimmed/switched loads

The adapter intentionally does not promise:

- dealer/programming changes to the Lutron system
- `8902` support for runtime control
- static scene catalogs independent of live keypad/button discovery

### Discovery and transport notes

- Discovery defaults to `mdns://_lutron._tcp.local`.
- Bonjour advertises processor metadata, but runtime LEAP control/auth uses
  `8081`.
- The more privileged QSX endpoint on `8902` is intentionally ignored in this
  integration because it requires client certificates.

## Samsung TV integration

The Samsung TV adapter lives under `src/adapters/samsung-tv/` and intentionally
supports a conservative subset of capabilities that have been validated against
a real Frame TV:

- discover TVs on the local network
- adopt a discovered TV into managed state
- pair a TV and persist the returned auth token
- fetch device metadata
- send remote keys
- probe a curated known-app registry by app ID
- launch apps by explicit app ID
- best-effort power off and power on
- get and set Art Mode

The adapter does not promise:

- full installed-app enumeration
- named app launch for apps without a known app ID
- guaranteed full power off/on semantics across Frame firmware variants

Power support is intentionally split:

- power off uses the Samsung local remote channel with `KEY_POWEROFF`
- power on uses Wake-on-LAN and the TV's stored MAC address

This works well enough to expose as a connector capability, but it should be
treated as best-effort because Samsung Frame firmware can blur the line between
Art Mode and true standby.

## Venstar thermostat integration

The Venstar adapter lives under `src/adapters/venstar/` and supports LAN-only
REST calls to `/query/info`, `/query/sensors`, `/query/runtimes`, `/control`,
and `/settings` for thermostats that have the local API enabled. Managed
thermostats are stored in the connector's local SQLite database and are added
through the home connector UI or Venstar MCP tools rather than env/file
configuration.

Discovery is subnet-scan-only. The connector probes `/query/info` across
`VENSTAR_SCAN_CIDRS` when that env var is set; otherwise it derives private
`/24` networks from local IPv4 interfaces. This avoids the SSDP multicast
fragility that showed up on NAS and Docker bridge deployments while keeping the
user flow aligned with the other managed device integrations.

## TP-Link Kasa smart plug integration

The Kasa adapter lives under `src/adapters/kasa/` and targets modern TP-Link
Kasa plugs that advertise `Server: SHIP 2.0` and use the KLAP protocol over HTTP
port 80. It is intended for EP25-style plugs that no longer respond to the
legacy TCP/9999 XOR transport.

Discovery combines:

- KLAP/Kasa UDP discovery probes on ports `9999` and `20002`
- HTTP subnet probes across `KASA_SCAN_CIDRS`, or private `/24` ranges derived
  from local IPv4 interfaces when the env var is unset
- credential-aware KLAP `system.get_sysinfo` reads so aliases, model, MAC,
  device id, and relay state can be persisted

KLAP authentication and requests are implemented in TypeScript. The client uses
the TP-Link account credential hash (`md5(md5(username) + md5(password))`), the
two-step `/app/handshake1` and `/app/handshake2` flow with `TP_SESSIONID`, and
AES-CBC request framing derived from the local seed, remote seed, and auth hash.
It also checks the python-kasa fallback credential candidates and blank
credentials during handshake matching.

Credential setup options:

- local admin UI: open `/kasa/setup`, enter the TP-Link/Kasa app email and
  password, and submit **Save credentials**
- MCP: call `kasa_set_credentials`
- environment fallback: set `KASA_USERNAME` and `KASA_PASSWORD`

Credentials saved through `/kasa/setup` and `kasa_set_credentials` use the same
adapter code path and are persisted locally in SQLite, encrypted with
`HOME_CONNECTOR_SHARED_SECRET`. The setup page shows whether credentials are
configured and the saved username/email, but never renders the saved password
back to the browser.

The local UI flow is:

1. `/kasa/setup` - store or replace TP-Link/Kasa account credentials.
2. `/kasa/status` - scan plugs, review known/adopted plugs, credential
   readiness, and discovery diagnostics.
3. Use MCP adoption/control tools once the desired plug is known.

The MCP surface is:

- `kasa_scan_plugs`
- `kasa_list_plugs`
- `kasa_adopt_plug`
- `kasa_forget_plug`
- `kasa_set_credentials`
- `kasa_get_plug_status`
- `kasa_turn_plug_on`
- `kasa_turn_plug_off`

Control tools require an adopted plug and resolve targets only by stable
`plugId` or exact unique alias; arbitrary IP control is intentionally not
accepted. `kasa_turn_plug_off` is marked destructive because it may power down
connected equipment.

Configuration:

- `KASA_SCAN_CIDRS` overrides derived private `/24` scan ranges. Entries must be
  `a.b.c.0/24` or `a.b.c.d/32`.
- `KASA_REQUEST_TIMEOUT_MS` defaults to `8000` and must be at least `1000`.
- `KASA_USERNAME` and `KASA_PASSWORD` provide optional env fallback credentials.
- `KASA_KLAP_USE_SUBPROCESS` defaults to enabled. Set to `false` or `0` to run
  KLAP in-process instead of a short-lived worker subprocess.
- `KASA_KLAP_USE_RAW_SOCKET` defaults to disabled. Set to `true` or `1` only
  when debugging transport issues; production Synology deployments should rely
  on the default `node:http` path with raw-socket fallback for handshake1 cookie
  loss.

NAS troubleshooting scripts live under `scripts/nas/`. Copy them to the NAS
docker folder next to the start script and run `probe-kasa-full.sh` or
`probe-kasa-exec.sh` against a plug IP when KLAP fails from the connector but
works from another host.

## Android phone companion

The phone adapter lives under `src/adapters/phone/` and is a **device client**,
not a second MCP server. Kent's Android app (built separately in
`@kentcdodds/phone`) dials this connector over WebSocket. Kody still talks to
this process at `https://kody-home.doddsfamily.us/mcp` as `kody.mcp["home"]`.
Phone tools become `kody.mcp["home"].phone_*`.

This is not the old reverse-dial Worker. That Worker reverse-dial was how the
connector used to reach Kody. It is gone. The phone opens a WebSocket to the
connector; Kody keeps using Streamable HTTP `/mcp` plus CIMD OAuth.

WebSocket URLs:

- Production: `wss://kody-home.doddsfamily.us/phone/ws`
- LAN: `ws://192.168.1.234:4040/phone/ws`

The upgrade is attached on the raw Node `http.Server` in `server/index.ts`
because Remix's `createRequestListener` cannot handle WebSocket upgrades. Remix
is not mounted on `/phone/ws`. `/phone/status` and `/phone/setup` are ordinary
admin pages.

Auth accepts the device token from, in order: query `token`, header
`X-Phone-Token`, or `Authorization: Bearer`. The connector compares it with
timing-safe equality against the stored token from `/phone/setup`, falling back
to `PHONE_DEVICE_TOKEN` if no stored token is present. If neither is set,
upgrades are rejected with 503 and MCP tools return a
`phone_token_not_configured` structured error. The raw token is never logged or
rendered in the admin UI. Saving or clearing the stored token disconnects any
current companion socket.

The JSON protocol is one object per text frame at `protocolVersion` 1: phone
`hello` / server `hello_ack`, server `call` / phone `result`, and optional
`ping`/`pong`. Default RPC timeout is 25s (`phone_mdns_scan` uses 60s). v1 keeps
one primary connected phone. The same `deviceId` reconnect replaces the old
socket; a different `deviceId` keeps the newest accepted socket. A delayed
`hello` from an older socket does not steal primary from a newer socket.

The MCP surface is:

- `phone_status`
- `phone_permissions`
- `phone_calendars`
- `phone_contacts_summary` (counts only; no contact payloads in v1)
- `phone_network`
- `phone_mdns_scan` (default `_googlecast._tcp`)
- `phone_packages`
- `phone_open_app_settings`
- `phone_battery`
- `phone_bluetooth` (adapter + bonded names; read-only)
- `phone_display`
- `phone_system` (airplane, Wi-Fi on, location mode, private DNS; read-only)
- `phone_accounts` (type + name only)
- `phone_open_special_settings` (`app` | `battery` | `notifications`)
- `phone_diagnose_tesla` (permissions for `com.teslamotors.tesla` plus
  calendars, contacts summary, and network)
- `phone_diagnose_cast` (network, mDNS `_googlecast._tcp`, and permissions for
  Google Home, YouTube, and GMS)

These tools can read calendar metadata and contact counts, and
`phone_open_app_settings` can open Android Settings on the connected phone. When
no phone is connected, RPC tools return `isError` with structured
`phone_offline` rather than throwing.

Cloudflare Access Bypass for `kody-home.doddsfamily.us` must include `/phone/ws`.
The MCP machine app is already at the five-destination limit (`/mcp`, `/token`,
`/revoke`, `/.well-known`, `/health`), so `/phone/ws` is a separate Access app
named **Kody Home Phone WebSocket** with an Everyone Bypass policy. Apply that
in Cloudflare; this repo does not change Access. A phone cannot complete Access
login. `/phone/status` and `/phone/setup` stay behind Access.

## Island router diagnostics integration

The Island router adapter lives under `src/adapters/island-router/` and
intentionally limits itself to typed allowlisted SSH commands from the connector
host to the local router. The default posture is read-only diagnostics.
Write-risk catalog entries are available only when SSH host verification is
configured and the caller supplies a strict reason plus exact confirmation
phrase. It is designed for situations where Kody only has network reachability
to the router from the NAS or other machine running the home connector.

The adapter exposes a small Access-Networks-Unleashed-style surface:

- `router_get_status` for connectivity/configuration readiness plus a compact
  status snapshot from `show version`, `show clock`, `show interface summary`,
  and `show ip neighbors`
- `router_run_command` for one command id/template from the typed command
  catalog. It never accepts arbitrary CLI text. Each entry defines exact CLI
  rendering, read/write access, risk level, required params and validators, CLI
  context (`exec`, `configure terminal`, or `interface <iface>`), optional
  no/remove variants, persistence metadata, blast-radius guidance, and a docs
  URL when available.

The catalog includes documented read commands such as `show clock`,
`show version`, `show running-config`, `show startup-config`,
`show interface summary`, `show interface`, `show ip interface`,
`show ip neighbors`, `show ip dhcp-reservations`, `show log`, `show syslog`,
`show stats`, and `ping`. It also includes guarded write entries such as
`clear dhcp-client`, `clear log`, `write memory`, `ip dhcp-reserve`,
`no ip dhcp-reserve`, selected interface-context commands, `syslog server`, and
`ip port-forward`. Extremely destructive operations such as `clear everything`,
`clear network`, rollback/update flows, SSH key regeneration, password changes,
and backup/restore remain omitted.

The adapter intentionally does not expose guessed aliases such as `show-ip-arp`,
`show-ip-sessions`, or `show-log-recent`, nor unsupported public commands such
as `show ip nat`, `show ip counters`, `show ip top`, or `show ip dns stats`.
Higher-level router workflows are expected to live in packages that wrap the
generic command substrate with typed helpers.

The adapter explicitly does not expose:

- arbitrary shell or CLI command execution over MCP
- arbitrary mutating router commands beyond the explicit command catalog
- password-based auth flows through MCP

## Island Router HTTP API proxy integration

The Island Router HTTP API proxy adapter lives under
`src/adapters/island-router-api/` alongside the SSH diagnostics adapter. It lets
Kody drive `my.islandrouter.com` through this MCP server when the connector host
is inside the user's LAN and can resolve `my.islandrouter.com` through the
router's intercepting DNS. It will not work from a host outside that LAN path.

The adapter stores the user's Island PIN locally in SQLite, encrypted with
`HOME_CONNECTOR_SHARED_SECRET`. The PIN is supplied through
`island_router_api_set_pin`; it is not read from env. Access, refresh, and
session JWTs are cached in memory only. Each session starts with the Island
`POST /api/startup` challenge, computes the HOTP value from the returned base32
secret and offset, then posts the saved PIN plus OTP. Subsequent proxied calls
use the access token and retry once after `POST /api/refresh` on `401`.

Configuration:

- `ISLAND_ROUTER_API_BASE_URL` defaults to `https://my.islandrouter.com`
- `ISLAND_ROUTER_API_REQUEST_TIMEOUT_MS` defaults to `8000` with a minimum of
  `1000`
- `ISLAND_ROUTER_API_ALLOW_INSECURE_TLS=true` allows self-signed LAN TLS for
  this adapter only

The MCP surface is intentionally generic:

- `island_router_api_get_status`
- `island_router_api_set_pin`
- `island_router_api_clear_pin`
- `island_router_api_request`

`island_router_api_request` accepts `GET`, `POST`, `PUT`, and `DELETE` for paths
under `/api/`. Non-GET calls require `acknowledgeHighRisk: true`, an operator
reason of at least 20 characters, and the exact confirmation phrase.
Higher-level typed utilities are expected to live in packages that wrap this
generic proxy.

Write-risk catalog entries are intentionally hard to use because mistakes can
have severe consequences. Agents must be highly certain before using them. The
MCP surface requires:

- SSH host verification via `known_hosts` or a pinned host fingerprint
- typed command ids plus structured params instead of free-form CLI
- an operator reason and an exact confirmation phrase for write-risk entries
- destructive tool annotations and warning-heavy descriptions

Commands that change running configuration do not silently run `write memory`.
When a catalog result reports `persistence.requiresWriteMemory=true`, callers
must review the output and run the separate `write memory` catalog command
explicitly if the change should persist across reboot.

SSH transport is conservative:

- public-key authentication only
- private key path comes from local connector env/runtime config
- host verification can use either a mounted `known_hosts` file or an expected
  host fingerprint
- the Docker image includes the OpenSSH client utilities needed for `ssh`,
  `ssh-keyscan`, and fingerprint verification

## Access Networks Unleashed WiFi integration

The Access Networks Unleashed adapter lives under
`src/adapters/access-networks-unleashed/` and targets controllers reachable from
the local connector host through the Unleashed AJAX management interface. The
connector manages controllers locally through its SQLite database:

- `access_networks_unleashed_scan_controllers` probes local private `/24`
  networks derived from the connector host's IPv4 interfaces, unless
  `ACCESS_NETWORKS_UNLEASHED_SCAN_CIDRS` overrides the scan list
- `access_networks_unleashed_adopt_controller` marks one discovered controller
  as the active controller for reads and writes
- `access_networks_unleashed_set_credentials` stores controller credentials
  locally, encrypted with `HOME_CONNECTOR_SHARED_SECRET`
- `ACCESS_NETWORKS_UNLEASHED_ALLOW_INSECURE_TLS=true` allows connections when
  the controller uses a self-signed LAN certificate
- `ACCESS_NETWORKS_UNLEASHED_REQUEST_TIMEOUT_MS` can raise the default 8s
  request timeout for slower controllers or networks

Beyond controller lifecycle (scan/list/adopt/remove/credentials/authenticate),
the adapter exposes a single generic capability:

- `access_networks_unleashed_request` posts an authenticated XML payload to the
  adopted controller's `POST {host}/admin/_cmdstat.jsp` endpoint. It accepts
  `action` (`getstat` | `setconf` | `docmd`), `comp` (Unleashed component name
  such as `system`, `stamgr`, `apStat`, `eventd`), `xmlBody` (inner XML appended
  inside the `<ajax-request>` envelope), an optional `updater` string (defaults
  to `<comp>.<timestamp>.<rand>`), and an optional `allowInsecureTls` override.
  Responses are returned as both raw XML and a best-effort parsed object.

The capability is deliberately warning-heavy because `setconf` and `docmd`
actions can disconnect clients, take SSIDs offline, reboot access points, or
otherwise disrupt local connectivity. Each call requires:

- `acknowledgeHighRisk: true`
- an operator reason of at least 20 characters
- the exact confirmation phrase rejected for any other value

Higher-level Unleashed flows (list APs, list clients, edit WLANs, block clients,
restart APs, etc.) are intended to live in saved Kody packages that wrap
`home_access_networks_unleashed_request` through `kody:runtime`. The home
connector itself does not expose any typed Unleashed CLI or per-operation
capabilities.

## Local persistence

The local process persists device-family-specific state on disk.

The connector stores a local SQLite database containing:

- discovered Samsung TV metadata
- whether each TV has been adopted
- the latest pairing token for each TV
- last token verification / auth error details
- discovered Lutron processor metadata
- Lutron credentials associated with each discovered processor
- last Lutron authentication success/error details
- discovered Access Networks Unleashed controller metadata
- which Access Networks Unleashed controller is adopted
- Access Networks Unleashed credentials encrypted locally with
  `HOME_CONNECTOR_SHARED_SECRET`
- last Access Networks Unleashed authentication success/error details
- discovered Kasa smart plug metadata
- which Kasa smart plugs are adopted
- Kasa TP-Link account credentials encrypted locally with
  `HOME_CONNECTOR_SHARED_SECRET`
- last Kasa authentication success/error details
- Android companion device token encrypted locally with
  `HOME_CONNECTOR_DATA_KEY`
- discovered JellyFish controller metadata and latest connection status
- discovered Bond bridges and tokens
- discovered Sonos players
- managed Venstar thermostats

By default the database is stored at
`~/.kody/home-connector/home-connector.sqlite`. Operators can override the base
directory with `HOME_CONNECTOR_DATA_PATH` or the full file path with
`HOME_CONNECTOR_DB_PATH`.

This persistence is intentionally local to the connector host so that pairing
survives process restarts without pushing device-local secrets into Kody.

## Discovery and mocks

Samsung discovery defaults to `mdns://_samsungmsf._tcp.local`.

Lutron discovery defaults to `mdns://_lutron._tcp.local`.

The connector uses one shared pure-JavaScript mDNS discovery path for both
Samsung and Lutron, so discovery behavior is consistent across macOS, Linux, and
containers. Live discovery requires the process or container to have multicast
visibility on the local network.

In local development with `MOCKS=true`, the connector uses mock Samsung TV and
Lutron handlers in the same style as the Roku mocks:

- mock discovery endpoint
- mock device metadata
- mock app status and app launch
- mock pairing/token issuance
- mock remote-key behavior
- mock power state transitions
- mock Art Mode state transitions
- mock Lutron processor discovery
- mock Lutron credential validation
- mock Lutron area/zone/button inventory
- mock Lutron button press and zone-level state transitions

That lets the adapter, MCP surface, and admin routes run in local development
and tests without needing physical local-network devices.
