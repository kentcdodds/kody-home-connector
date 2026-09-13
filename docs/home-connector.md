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
  so there is no operator password. The consent page
  (`src/oauth/authorize-page.ts`) shows the requesting client, its metadata URL,
  and the return host, with **Approve** and **Deny** actions; Deny redirects
  back with `error=access_denied`. It shares design tokens with the admin UI via
  `src/ui/design-tokens.ts`.
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

The admin UI is server-rendered with `remix/html-template` and ships no browser
JavaScript: native forms submit without hydration, so there is no asset server,
client entry, or `remix/ui` component runtime to configure. Read-only pages are
`GET` routes (the router serves `HEAD` and answers other methods with `405`);
pages that also process form submissions dispatch on `request.method` inside a
single action. `createRequestListener` runs without `trustProxy` because the
container is reached directly on the LAN port; only enable it if the process is
moved exclusively behind a trusted TLS-terminating proxy.

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
- PJLink Class 1 projectors over TCP 4352 (scan/adopt, power, INPT, AVMT, LAMP)
- Court AV through PJLink (preferred) plus the cage Global Cache iTach IP2IR
  (HDMI switch, Optoma IR fallback, Chauvet Rotosphere), composed Roku/Sonos
  scene tools, and court Sony UHD Blu-ray control over LAN IRCC
- Personal Audible archive import: ffmpeg convert of an already-downloaded AAXC
  (voucher or key+iv) or AAX (activation_bytes) to a flat `Title.m4b` in the
  mounted audiobook library. No Audible API lives here.

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

## Court AV (PJLink + Global Cache iTach)

The sport-court cage stack is driven from this connector, not from Elan:

- Optoma ZK810TST at `192.168.0.128` (`00:50:41:B2:FD:09`), PJLink port 4352, no
  auth (`PJLINK 0`). `%1POWR 0` is the reliable lamp-off path.
- iTach IP2IR at `192.168.1.70:4998` (`GLOBAL_CACHE_HOST` / `GLOBAL_CACHE_PORT`)
- IR1 stick-on emitter → MROCIOA HDMI switch
- IR2 stick-on emitter → Optoma projector (fallback when PJLink is unreachable)
- IR3 hanging blaster → Chauvet Rotosphere (must be `IR_BLASTER`)
- Court Roku Ultra ECP at `192.168.1.98` + Sport Court Sonos HDMI/TV input
- Court Sony UHD Blu-ray over LAN IRCC (host often unset — player is frequently
  unplugged / network standby off)

Do not bypass the HDMI switch: Roku is on switch IN 1, the switch feeds an HDMI
audio extractor, and that extractor is the Sport Court Sonos path. Blu-ray is
switch IN 2 (Blu-ray → Blustream HEX150CS-TX → Cat6 → HDMI switch input 2 →
projector).

Court projector power (`court_projector_on`, `court_projector_standby`,
`court_start_roku`, `court_shutdown`) prefers PJLink on the adopted court
Optoma. If a power **command** returns PJLink unavailable-time (`ERR3`) — common
on Optoma while the lamp is already on or warming — the court tools query
`%1POWR` and continue when the observed state already matches the request
(`on`/`warming` for power-on, `standby`/`cooling` for standby) without sending
IR. IR fallback is used when PJLink is unreachable (typical after a **full**
projector off, when LAN/ping/4352/80 all go dark), or when power is still off
after unavailable-time. Court power fails fast into IR via
`COURT_PJLINK_TIMEOUT_MS` (default 1500ms). Hard-fail only when power is still
off/unreachable **and** IR fallback also fails. First power-on after a full off
is IR (or physical power) unless “network standby” is enabled on the unit. Do
not assume live PJLink during connector work while the Optoma is off. IR standby
was the unreliable path; use PJLink standby when the LAN is up.

Register the court Optoma once after deploy:

```
kody.mcp["home"].pjlink_adopt_projector({
  host: "192.168.0.128",
  macAddress: "00:50:41:B2:FD:09",
  name: "Court Optoma ZK810TST"
})
```

Or scan (`pjlink_scan_projectors`) and adopt the discovered `projectorId`.
`PJLINK_SCAN_EXTRA_HOSTS` defaults to `192.168.0.128` because that subnet may
not be on the NAS NIC. Optional `COURT_PJLINK_PROJECTOR_ID` pins the court
projector when more than one PJLink device is adopted. Court power tools use
`COURT_PJLINK_TIMEOUT_MS` (default 1500) so a dark LAN fails into IR quickly;
direct `pjlink_*` tools keep `PJLINK_REQUEST_TIMEOUT_MS` (default 5000).

Court Roku Ultra ECP `PowerOff` / `Power` leave `power-mode=PowerOn`. There is
no court Kasa plug. There is **no reliable Roku hard-off path**. Adopted Roku
devices (including Court Projector) are persisted in SQLite like Sonos/PJLink
and rehydrated on connector startup so `court_get_status.rokuDeviceId` survives
process restart. Discovery `isAdopted` from SSDP/JSON mocks is **not** connector
adoption; connector `adopted` / `isAdopted` stay in sync and remain false until
`roku_adopt_device`.

`@kentcdodds/court-projector` (`start-court` / `shutdown`) lives in that
package, not this repo. It should keep calling `court_start_roku` /
`court_shutdown` / `court_projector_*`; Patch can rewire the package after this
connector ships. No package change is required for the PJLink preference because
those court tools now own the transport choice.

### Court Sony UHD Blu-ray (LAN IRCC)

The cage Blu-ray is **offline-first**. It is often unplugged, and even when
plugged in it may have network standby off so IRCC ports never answer.

Pattern (same catalog-always-present idea as `phone_*`, but unplugged is not a
tool failure):

- `bluray_status` always exists and returns
  `{ connected: false, reason: string, ... }` when the player is unconfigured or
  unreachable. It never throws just because the unit is off.
- Transport/nav tools (`bluray_play`, d-pad, `bluray_press`, power, …) stay in
  the catalog and return that same disconnected status shape. Patch's
  `@kentcdodds/court-projector` mini-remote tab should call `bluray_status`
  first, disable buttons while `connected` is false, and call `bluray_press` /
  named tools when the player is on.

Config (all optional; empty is the normal state):

- `COURT_BLURAY_HOST` / `COURT_BLURAY_MAC`
- `COURT_BLURAY_AUTH_COOKIE` / `COURT_BLURAY_PSK` after on-screen pairing
- `COURT_BLURAY_TIMEOUT_MS` (default 1500)
- `COURT_BLURAY_SCAN_EXTRA_HOSTS` / `COURT_BLURAY_SCAN_CIDRS` (default empty)

A successful IRCC probe persists host/MAC (and later auth) in SQLite
(`sony_ircc_players`). Probe GETs `Ircc.xml:50001`, `actionList:50002`, and
`dmr.xml:52323`. Control is SOAP `X_SendIRCC` to `/upnp/control/IRCC` (or
`/sony/ircc`). Power-on sends Wake-on-LAN when a MAC is stored.

**192.168.0.115 / f8:4e:17:21:ed:b2 is the Sony camera (bisyamon), not the
Blu-ray.** Ircc/actionList/dmr fail there. The connector never defaults to
`.115`, never auto-picks it during scan, and `bluray_set_host` / status reject
it with `reasonCode: "blocked_sony_camera"`.

Live pairing needs the player powered with **network standby on**. After the
on-screen confirm, persist the auth cookie or PSK with `bluray_set_host`. Do not
send live IRCC POSTs from CI; unit tests use fixtures.

IRCC codes are the public Sony BD1 category table (sonyapilib `IrccCategory.BD1`
= 7258). UBP / BDP-CE players (including UBP-X700) ignore Bravia TV power codes:
`AAAAAQAAAAEAAAAvAw==` (TV PowerOff) returns HTTP 200 but does not turn the deck
off. Nav, eject, and home stay on BD1. Power uses the BD1 toggle
`AAAAAwAAHFoAAAAVAw==` (Power=21). `bluray_power_off` / `press("powerOff")`
sends that toggle **twice** with a 500ms gap (first press opens the confirm
dialog; BDP-CE laptop scripts needed the second). `bluray_power_on` is WOL plus
**one** toggle so `court_start_bluray` does not confirm power-off on a live
unit. `bluray_press({ command: "power" })` is a single toggle. TV/Bravia codes
remain available only via `getSonyIrccCode(name, "tv")`.

For a later mini remote in `@kentcdodds/court-projector`:

```
kody.mcp["home"].bluray_status()
kody.mcp["home"].court_start_bluray()
kody.mcp["home"].bluray_press({ command: "play" })
kody.mcp["home"].bluray_up()
```

Named IR commands live in `src/adapters/global-cache/codes.ts`. Reliability:

- HDMI inputs 1 and 2, projector ON / standby / HDMI: proven on the court
- HDMI inputs 3-5: sequential NEC guesses (`0x4C` / `0x03`-`0x05`)
- Rotosphere: Flipper IRC-6 conversions. Black Out, Manual, and Red were
  observed. Auto and most other buttons are **not reliable** and should be
  re-learned on the iTach pinhole next to the power jack.

MCP surface:

- `pjlink_scan_projectors` / `pjlink_list_projectors`
- `pjlink_adopt_projector` / `pjlink_forget_projector`
- `pjlink_get_power` / `pjlink_power_on` / `pjlink_power_off`
- `pjlink_get_input` / `pjlink_set_input`
- `pjlink_get_av_mute` / `pjlink_set_av_mute`
- `pjlink_get_lamp` / `pjlink_get_info`
- `globalcache_get_status`
- `globalcache_list_ir_commands`
- `globalcache_send_ir`
- `court_get_status`
- `sonos_select_tv_input` (Amp/HT HDMI/TV ARC via `x-sonos-htastream:…:spdif`)
- `sonos_select_audio_input` (analog line-in only; not the court Amp TV path)
- `court_start_roku` (PJLink projector ON + IR fallback, HDMI 1, Sport Court
  Sonos TV/HDMI via `sonos_select_tv_input`, Roku Home or app)
- `court_start_bluray` (same AV path on HDMI 2, then Blu-ray WOL/IRCC power-on;
  player offline returns `{ connected: false, reason }` instead of throwing)
- `bluray_status` / `bluray_scan` / `bluray_set_host` / `bluray_forget`
- `bluray_play` / `bluray_pause` / `bluray_stop` / `bluray_eject`
- `bluray_up` / `bluray_down` / `bluray_left` / `bluray_right` / `bluray_enter`
- `bluray_home` / `bluray_back` / `bluray_options`
- `bluray_press` / `bluray_power_on` / `bluray_power_off`
- `court_set_hdmi_input`
- `court_projector_on` / `court_projector_standby`
- `court_set_rotosphere`
- `court_shutdown`

`court_start_roku` resolves the Court Projector Roku by name (`/court/i`) or
`COURT_ROKU_DEVICE_ID`, and Sport Court Sonos by room name or
`COURT_SONOS_PLAYER_ID`. Adopt those devices first. Sport Court Amp
(`sonos-rincon-804af2a8db1f01400` @ `192.168.1.111`) must use HDMI/TV (ARC), not
analog line-in. `court_start_roku` calls the TV/SPDIF URI
(`x-sonos-htastream:RINCON_…:spdif`) via `sonos_select_tv_input`. That URI was
live-verified on the court Amp; `x-sonos-ht:spdif` / `x-sonos-ht:hdmi` 714.
ContentDirectory `AI:` only lists analog “Audio Component” — TV is not an
AudioIn object. If the Amp later 714s the htastream URI, the tool fails clearly
(no line-in fallback): set the room up as TV Speakers / HDMI ARC in the Sonos
app and retry.

### Deploy onto kody-home.doddsfamily.us

This connector is not deployed by merging the PR. **Publish Home Connector**
runs tests on every pull request. Image push happens on `main` (moves `latest`
plus `sha-<short>`) or via **workflow_dispatch** on a branch (`sha-<short>` only
— does not move prod `latest`). Prod today is `sha-f7134d6`. After merge to
`main`:

1. GitHub Actions workflow **Publish Home Connector** tests, then pushes
   `kentcdodds/kody-home-connector:latest` (and a `sha-` tag) to Docker Hub.
2. On the Synology NAS (`192.168.1.234`), Howie/Patch pull the new image and
   restart the container with the existing `start-kody-home-connector.sh` next
   to `/volume1/docker/` (see `scripts/nas/README.md` and `docker/README.md`).
   Mount `/volume1/media/audio/audiobooks` RW at `/media/audiobooks`. Cloudflare
   already tunnels `kody-home.doddsfamily.us` → `http://192.168.1.234:4040`.
3. Startup applies pending SQLite migrations automatically (`pjlink_projectors`,
   `sony_ircc_players`, …).
4. Adopt the court Optoma with `pjlink_adopt_projector` (no password).

There is no Kody workflow package in this repo. These tools are the connector
capabilities `@kentcdodds/court-projector` should call.

## Personal Audible archive (AAXC → M4B)

`@kody/audible` owns Audible auth, library/wishlist, and download. This
connector only converts and writes a personal archive of owned titles.

MCP tools (`kody.mcp["home"]`):

- `audiobook_library_path({ filename? })` — mount / writable / ffmpeg status
- `audiobook_library_filename({ title })` — `Title.m4b` matching the existing
  flat library (no `Author -` prefix)
- `audiobook_exists({ filename })` — exists check (rejects `..` / subdirs)
- `audiobook_import_aaxc` — AAXC bytes (`aaxcBase64`) or temp path (`aaxcPath`)
  plus voucher `key`/`iv`; optional `chapters` and `coverBase64`. Writes flat
  `Title.m4b`. `aaxcUrl` is the large-file variant (fetched with User-Agent
  `Audible Download Manager` so Audible CloudFront does not 403 browser UAs).

Patch handoff (`@kody/audible` downloads, then calls this after the image
publishes):

```
kody.mcp["home"].audiobook_library_filename({ title: "Blightfall" })
// => { filename: "Blightfall.m4b" }

kody.mcp["home"].audiobook_exists({ filename: "Blightfall.m4b" })

kody.mcp["home"].audiobook_import_aaxc({
  aaxcPath: "/tmp/owned.aaxc",   // or aaxcBase64, or aaxcUrl
  key: "<voucher hex>",
  iv: "<voucher hex>",
  title: "Blightfall",
  chapters: [{ title: "Opening", startMs: 0, lengthMs: 1500 }],
  coverBase64: "<optional jpeg/png>"
})
```

ffmpeg in the image uses `-audible_key`/`-audible_iv` for AAXC and
`-activation_bytes` for AAX, then `-c copy` to M4B.

Library mount (must be **RW** on this container; same in-container path as
mediarss):

| Role              | Path                                           |
| ----------------- | ---------------------------------------------- |
| In-container      | `/media/audiobooks` (`AUDIOBOOK_LIBRARY_PATH`) |
| Synology NAS host | `/volume1/media/audio/audiobooks`              |
| Mac host          | `/Volumes/media/audio/audiobooks`              |

See `docker/README.md` for the volume flags to merge into the NAS start script.
After **Publish Home Connector**, the NAS pull must remount that share RW or
`audiobook_import_aaxc` cannot write.

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

Cloudflare Access Bypass for `kody-home.doddsfamily.us` must include
`/phone/ws`. The MCP machine app is already at the five-destination limit
(`/mcp`, `/token`, `/revoke`, `/.well-known`, `/health`), so `/phone/ws` is a
separate Access app named **Kody Home Phone WebSocket** with an Everyone Bypass
policy. Apply that in Cloudflare; this repo does not change Access. A phone
cannot complete Access login. `/phone/status` and `/phone/setup` stay behind
Access.

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
- discovered and adopted PJLink projectors (optional encrypted password)
- discovered and adopted Roku devices (connector adoption, not discovery flags)
- court Sony IRCC Blu-ray host/MAC and optional encrypted auth cookie/PSK

By default the database is stored at
`~/.kody/home-connector/home-connector.sqlite`. Operators can override the base
directory with `HOME_CONNECTOR_DATA_PATH` or the full file path with
`HOME_CONNECTOR_DB_PATH`.

This persistence is intentionally local to the connector host so that pairing
survives process restarts without pushing device-local secrets into Kody.

### Data layer

Persistence goes through `remix/data-table` with the SQLite driver
(`remix/data-table/sqlite`, backed by `node:sqlite`):

- `src/storage/schema.ts` declares every table with `table()` / `column`.
  Repository modules import these table objects and use the typed CRUD helpers
  (`db.find`, `db.findMany`, `db.create`, `db.update`, `db.deleteMany`, ...) or
  `db.query(table)` for filtered reads. Row types come from
  `TableRow<typeof table>`; there are no hand-written row types or casts.
- `src/storage/index.ts` opens the database (`createHomeConnectorDatabase`) and
  runs pending migrations before the process serves its first request
  (`createHomeConnectorStorage`). Docker deploys have no separate migrate step,
  so startup migration is the production path.
- All reads and writes are async. Adapter methods that touch storage return
  promises, and `HomeConnectorLogger` queues its writes and exposes `flush()`.
- Tests use `new DatabaseSync(':memory:')` through
  `createTestHomeConnectorConfig({ dbPath: ':memory:' })`.

### Migrations

Migrations live in `db/migrations/<YYYYMMDDHHmmss>_<slug>/up.sql` (plus an
optional `down.sql`). They are SQL-first and journaled in the
`data_table_migrations` table. To change the schema, add a new directory with
the next timestamp; never edit an applied migration.

`20260910000000_baseline_schema` recreates the schema that earlier releases
built at startup with `CREATE TABLE IF NOT EXISTS`. Every statement is
idempotent, so the first boot of this release adopts an existing database
(tables already present, only the journal row is added) and creates a fresh
database identically. The baseline has no `down.sql` because rolling it back
would drop live data.

`remix.json` configures the `remix db` CLI for humans and CI. The CLI reads the
database file from `HOME_CONNECTOR_DB_PATH` and does not apply the app's
`HOME_CONNECTOR_DATA_PATH` / `~/.kody/home-connector` default, so point it at
the file explicitly:

```sh
HOME_CONNECTOR_DB_PATH=~/.kody/home-connector/home-connector.sqlite npx remix db status
HOME_CONNECTOR_DB_PATH=... npx remix db migrate
HOME_CONNECTOR_DB_PATH=... npx remix db rollback --dry-run
HOME_CONNECTOR_DB_PATH=... npx remix db reset --force   # destructive: wipes the file
```

SQLite migrations have no cross-process lock, so run the CLI while the connector
is stopped.

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
