# Remix v3 Beta 5 adoption audit

Audit date: 2026-07-09

## Current version

This repository is already on Remix v3 Beta 5:

- `package.json` declares `remix` as `^3.0.0-beta.5`.
- `package-lock.json` resolves `remix@3.0.0-beta.5`,
  `@remix-run/ui@0.4.0`, and `@remix-run/node-fetch-server@0.14.0`.
- The Beta 5 upgrade and public Remix entrypoint migration landed previously in
  [PR #29](https://github.com/kentcdodds/kody-home-connector/pull/29).

No framework upgrade is a prerequisite for the Beta 5 features covered here.

## Repository-specific findings

### UI entrypoints

Beta 5 moved first-party component exports to `remix/ui/*`. This application,
however, does not have an older component import path to replace. Its admin UI
uses `remix/html-template` in `app/root.ts`, `app/admin-ui.ts`, and the route
handler modules. It sends complete HTML with no browser bundle or hydration.
There is no third-party component library.

The apparent component matches are:

- `remix/ui/button`: the native submit buttons in `app/*-handlers.ts`
- `remix/ui/input`: the text, password, and textarea fields in setup handlers
- `remix/ui/select`: the seven native selects in
  `app/bond-handlers.ts` and
  `app/access-networks-unleashed-handlers.ts`
- `remix/ui/breadcrumbs`: possible supplemental wayfinding for the page intros
  in `app/admin-ui.ts`
- `remix/ui/accordion` and `remix/ui/tabs`: possible organization for the dense
  diagnostics views in `app/dashboard-handlers.ts`

These are not drop-in substitutions. Button and input are `mix` style
descriptors for the Remix JSX runtime. Select, accordion, and tabs also need
the component runtime and client hydration for their interactive behavior.
Adopting them would require converting the rendering boundary to TSX with
`remix/ui/server`, introducing a client asset pipeline for interactive
controls, and reconciling the unlayered styles in `app/root.ts` with Remix UI's
`rmx` cascade layer.

The current native controls preserve form submissions and keyboard behavior
without JavaScript. A broad UI migration would increase complexity rather than
simplify this connector today.

### `trustProxy`

`server/index.ts` uses `createRequestListener` from
`remix/node-fetch-server`, but the documented production topology is direct
LAN access to port 4040 from a host-network Docker container on a NAS. The
repository contains no reverse-proxy or TLS-termination configuration.

Enabling `trustProxy` is therefore not recommended. Remix warns that clients
can spoof forwarded host, protocol, and address data unless the server is
reachable only through a trusted proxy that overwrites those headers.
Additionally, the existing `host: localhost:<port>` option takes precedence
over forwarded host values.

If deployment later moves exclusively behind nginx, Caddy, or another trusted
TLS-terminating proxy:

1. Remove or make conditional the fixed `host` option in `server/index.ts`.
2. Enable `trustProxy` only for that deployment.
3. Add integration tests for forwarded host/protocol and the Kasa
   same-origin check in `app/kasa-handlers.ts`.
4. Ensure direct access to the Node port is blocked.

### Production template comparison

The Beta 5 `remix new` template now sets `NODE_ENV` explicitly, uses Node's
watcher for development, minifies production browser assets, disables the
independent asset watcher, and resolves client/server frames by default.

The applicable defaults are already present:

- `package.json` sets `NODE_ENV=production` in `start`.
- `Dockerfile` sets `NODE_ENV=production`.
- `package.json` uses `node --watch` for `dev`.

The asset and frame changes do not apply. This project has no browser build,
asset server, or Remix frames; it runs TypeScript directly on Node 24 and
returns server-rendered HTML. Adding a template-style build solely to mirror
the starter would add an unused pipeline.

## Prioritized recommendations

### High

1. **Keep the server-only rendering boundary unless interactive UI is a product
   requirement.** A `remix/ui/*` migration spans `app/root.ts`,
   `app/admin-ui.ts`, every HTML handler, server rendering, CSS layering, and a
   new browser asset lifecycle. It is not a safe component-by-component import
   cleanup.
2. **Do not enable `trustProxy` for the current deployment.** The direct LAN
   topology does not have a trusted proxy boundary, so enabling it would add
   header-spoofing risk without improving behavior.

### Medium

1. **If richer client interaction is wanted, prototype one non-credential
   route before migrating the shell.** Use `remix/ui/server` with
   `remix/ui/button` and `remix/ui/input` first. Measure output, CSS integration,
   and hydration cost before considering Select, Tabs, or Accordion. Preserve
   native form names and no-JavaScript submissions.
2. **Keep one action implementation per route.** `app/handlers.ts` contained an
   unused legacy home action while `app/router.ts` maps the route to
   `createDashboardHandler` in `app/dashboard-handlers.ts`. This audit removes
   the dead implementation and consolidates its duplicate formatting helpers
   through `app/handler-utils.ts`.
3. **Standardize POST origin protection in a separate security change.** Only
   Kasa credential submission currently calls the same-origin guard in
   `app/kasa-handlers.ts`; other credential and device-mutation forms do not.
   This should be designed and tested across all POST routes rather than
   bundled into a UI migration.

### Low

1. Revisit `remix/ui/breadcrumbs` if setup/status navigation becomes hard to
   follow. The sidebar already supplies primary wayfinding.
2. Revisit Accordion or Tabs for diagnostics only after a hydration strategy
   exists. Static sections are currently more resilient for a local recovery
   interface.
3. Revisit `trustProxy` only when deployment documentation and network controls
   establish an exclusive trusted reverse proxy.

## Sources

- [Remix 3.0.0 Beta 5 release](https://github.com/remix-run/remix/releases/tag/remix@3.0.0-beta.5)
- [Remix UI 0.4.0 release](https://github.com/remix-run/remix/releases/tag/ui@0.4.0)
- [Improved default template change](https://github.com/remix-run/remix/pull/11496)
