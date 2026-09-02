import { type Action } from 'remix/router'
import { html } from 'remix/html-template'
import { renderEmptyState } from './admin-ui.ts'
import {
	formatJson,
	renderBanner,
	renderCodeBlock,
	renderInfoRows,
} from './handler-utils.ts'
import { render } from './render.ts'
import { RootLayout } from './root.ts'
import { routes } from './routes.ts'
import { type createPhoneAdapter } from '../src/adapters/phone/index.ts'
import { captureHomeConnectorException } from '../src/sentry.ts'
import { type HomeConnectorState } from '../src/state.ts'

type Banner = { tone: 'success' | 'error'; message: string } | null

function getAllowedFormOrigins(request: Request) {
	const requestUrl = new URL(request.url)
	const origins = new Set([requestUrl.origin])
	const host = request.headers.get('host')?.trim()
	if (host) {
		try {
			origins.add(`${requestUrl.protocol}//${host}`)
			if (requestUrl.port && !host.includes(':')) {
				const hostname = host.split(':')[0] ?? host
				origins.add(`${requestUrl.protocol}//${hostname}:${requestUrl.port}`)
			}
		} catch {
			// Ignore malformed Host headers; the request URL origin remains valid.
		}
	}
	return origins
}

function assertSameOriginFormPost(request: Request) {
	const allowedOrigins = getAllowedFormOrigins(request)
	const origin = request.headers.get('origin')
	if (origin && !allowedOrigins.has(origin)) {
		throw new Error('Rejected cross-origin credential submission.')
	}
	const referer = request.headers.get('referer')
	if (!origin && referer) {
		try {
			if (!allowedOrigins.has(new URL(referer).origin)) {
				throw new Error('Rejected cross-origin credential submission.')
			}
		} catch {
			throw new Error('Rejected cross-origin credential submission.')
		}
	}
}

function tokenSourceLabel(
	source: ReturnType<
		ReturnType<typeof createPhoneAdapter>['getStatus']
	>['tokenSource'],
) {
	switch (source) {
		case 'stored':
			return 'admin UI'
		case 'env':
			return 'PHONE_DEVICE_TOKEN'
		case null:
			return 'none'
		default: {
			const _never: never = source
			return _never
		}
	}
}

function renderPhoneStatusPage(input: {
	state: HomeConnectorState
	phone: ReturnType<typeof createPhoneAdapter>
}) {
	const status = input.phone.getStatus()
	return render(
		RootLayout({
			title: 'home connector - phone status',
			currentPath: routes.phoneStatus.href(),
			body: html`<section class="card">
					<h1>Android phone status</h1>
					<p class="muted">
						Kent’s Android companion dials this connector over WebSocket. Kody
						keeps using Streamable HTTP <code>/mcp</code>; phone tools appear as
						<code>kody.mcp["home"].phone_*</code>.
					</p>
					<p>
						<a href="${routes.phoneSetup.href()}">Phone setup</a>
						<span class="muted">— device token and Access bypass</span>
					</p>
					${renderInfoRows([
						{
							label: 'MCP server',
							value: input.state.connection.listening
								? 'connected'
								: 'disconnected',
						},
						{
							label: 'Token configured',
							value: status.tokenConfigured ? 'yes' : 'no',
						},
						{
							label: 'Token source',
							value: tokenSourceLabel(status.tokenSource),
						},
						{
							label: 'Companion',
							value: status.connected ? 'connected' : 'offline',
						},
						{
							label: 'Device name',
							value: status.lastHello?.deviceName ?? 'none',
						},
						{
							label: 'Device ID',
							value: status.deviceId
								? html`<code>${status.deviceId}</code>`
								: 'none',
						},
						{
							label: 'App version',
							value: status.lastHello?.appVersion ?? 'unknown',
						},
						{
							label: 'Android',
							value: status.lastHello
								? `${status.lastHello.androidVersion} (SDK ${String(status.lastHello.sdkInt)})`
								: 'unknown',
						},
						{
							label: 'Connected at',
							value: status.connectedAt ?? 'never',
						},
						{
							label: 'Last seen',
							value: status.lastSeenAt ?? 'never',
						},
						{
							label: 'WebSocket path',
							value: html`<code>${status.websocketPath}</code>`,
						},
						{
							label: 'Public WebSocket',
							value: html`<code>${status.publicWebSocketUrl}</code>`,
						},
						{
							label: 'Loopback WebSocket',
							value: html`<code>${status.localWebSocketUrl}</code>`,
						},
						{
							label: 'LAN WebSocket',
							value: html`<code>${status.lanWebSocketUrl}</code>`,
						},
					])}
				</section>
				<section class="card">
					<h2>Last hello</h2>
					${status.lastHello
						? renderCodeBlock(formatJson(status.lastHello))
						: renderEmptyState('No Android companion has completed hello yet.')}
				</section>`,
		}),
	)
}

function renderPhoneSetupPage(input: {
	state: HomeConnectorState
	phone: ReturnType<typeof createPhoneAdapter>
	banner: Banner
}) {
	const status = input.phone.getStatus()
	return render(
		RootLayout({
			title: 'home connector - phone setup',
			currentPath: routes.phoneSetup.href(),
			body: html`<section class="card">
					<h1>Android phone setup</h1>
					<p class="muted">
						Save the shared device token here, then put the same value in the
						Android companion. The token is encrypted in local SQLite with
						<code>HOME_CONNECTOR_DATA_KEY</code> and is never rendered back to
						the browser.
					</p>
					<p>
						<a href="${routes.phoneStatus.href()}">Phone status</a>
						<span class="muted">— connection and last hello</span>
						<br />
						<a href="${routes.home.href()}">Dashboard</a>
					</p>
					${renderInfoRows([
						{
							label: 'Connector ID',
							value: input.state.connection.connectorId || 'not registered yet',
						},
						{
							label: 'Token configured',
							value: status.tokenConfigured ? 'yes' : 'no',
						},
						{
							label: 'Stored token',
							value: status.hasStoredToken ? 'yes' : 'no',
						},
						{
							label: 'Env token',
							value: status.hasEnvToken ? 'yes' : 'no',
						},
						{
							label: 'Token source',
							value: tokenSourceLabel(status.tokenSource),
						},
						{
							label: 'WebSocket path',
							value: html`<code>${status.websocketPath}</code>`,
						},
						{
							label: 'Production URL',
							value: html`<code>${status.publicWebSocketUrl}</code>`,
						},
						{
							label: 'LAN URL',
							value: html`<code>${status.lanWebSocketUrl}</code>`,
						},
					])}
				</section>
				${input.banner ? renderBanner(input.banner) : ''}
				<section class="card">
					<h2>Set device token</h2>
					<p class="muted">
						Use any long random secret. Saving a new token replaces the stored
						value and disconnects a currently connected phone so it must
						reconnect with the new token. A stored token takes precedence over
						<code>PHONE_DEVICE_TOKEN</code>.
					</p>
					<form method="POST" class="field-stack">
						<input type="hidden" name="intent" value="set-token" />
						<label>
							Device token
							<input
								type="password"
								name="token"
								required
								autocomplete="off"
								placeholder="Phone device token"
							/>
						</label>
						<div class="form-actions">
							<button type="submit">Save token</button>
						</div>
					</form>
				</section>
				<section class="card">
					<h2>Clear stored token</h2>
					<p class="muted">
						Remove the encrypted token from SQLite. An env
						<code>PHONE_DEVICE_TOKEN</code> fallback still applies if set.
					</p>
					${status.hasStoredToken
						? html`<form method="POST">
								<input type="hidden" name="intent" value="clear-token" />
								<button type="submit">Clear stored token</button>
							</form>`
						: renderEmptyState('No phone device token is stored locally.')}
				</section>
				<section class="card">
					<h2>Cloudflare Access</h2>
					<p class="muted">
						A phone cannot complete Cloudflare Access login. Access Bypass must
						include <code>/phone/ws</code> on the same list as
						<code>/mcp</code>, <code>/token</code>, <code>/revoke</code>,
						<code>/.well-known</code>, and <code>/health</code>.
						<code>/phone/status</code> and <code>/phone/setup</code> stay behind
						Access like other admin pages.
					</p>
					<p class="muted">
						Do not put phone control behind Access on <code>/mcp</code>.
						<code>/mcp</code> stays machine Bypass so Kody can keep calling
						<code>phone_*</code> tools.
					</p>
				</section>`,
		}),
	)
}

export function createPhoneStatusHandler(
	state: HomeConnectorState,
	phone: ReturnType<typeof createPhoneAdapter>,
) {
	return {
		middleware: [],
		handler() {
			return renderPhoneStatusPage({ state, phone })
		},
	} satisfies Action<typeof routes.phoneStatus>
}

export function createPhoneSetupHandler(
	state: HomeConnectorState,
	phone: ReturnType<typeof createPhoneAdapter>,
) {
	function renderPage(banner: Banner = null) {
		return renderPhoneSetupPage({ state, phone, banner })
	}

	return {
		middleware: [],
		async handler({ request }: { request: Request }) {
			if (request.method === 'POST') {
				try {
					assertSameOriginFormPost(request)
					const form = await request.formData()
					const intent = String(form.get('intent') ?? '')

					if (intent === 'set-token') {
						phone.setDeviceToken(String(form.get('token') ?? ''))
						return renderPage({
							tone: 'success',
							message: 'Saved phone device token.',
						})
					}

					if (intent === 'clear-token') {
						phone.clearStoredDeviceToken()
						return renderPage({
							tone: 'success',
							message: 'Cleared stored phone device token.',
						})
					}

					return renderPage({
						tone: 'error',
						message: 'Unknown form action.',
					})
				} catch (error) {
					captureHomeConnectorException(error, {
						tags: {
							route: '/phone/setup',
							action: 'form',
						},
						contexts: {
							phone: {
								connectorId: state.connection.connectorId,
							},
						},
					})
					return renderPage({
						tone: 'error',
						message:
							error instanceof Error
								? error.message
								: `Request failed: ${String(error)}`,
					})
				}
			}

			return renderPage()
		},
	} satisfies Action<typeof routes.phoneSetup>
}
