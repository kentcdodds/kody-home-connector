import { type Action } from 'remix/router'
import { html } from 'remix/html-template'
import { renderEmptyState } from './admin-ui.ts'
import { formatJson, renderCodeBlock, renderInfoRows } from './handler-utils.ts'
import { render } from './render.ts'
import { RootLayout } from './root.ts'
import { routes } from './routes.ts'
import { type createPhoneAdapter } from '../src/adapters/phone/index.ts'
import { type HomeConnectorState } from '../src/state.ts'

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
						<span class="muted">— PHONE_DEVICE_TOKEN and Access bypass</span>
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
							label: 'LAN WebSocket',
							value: html`<code>${status.localWebSocketUrl}</code>`,
						},
						{
							label: 'NAS WebSocket',
							value: html`<code>ws://192.168.1.234:4040/phone/ws</code>`,
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
}) {
	const status = input.phone.getStatus()
	return render(
		RootLayout({
			title: 'home connector - phone setup',
			currentPath: routes.phoneSetup.href(),
			body: html`<section class="card">
					<h1>Android phone setup</h1>
					<p class="muted">
						v1 uses an env-only device token. Set
						<code>PHONE_DEVICE_TOKEN</code> on the connector host and put the
						same value in the Android companion. The token is never rendered
						here.
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
							label: 'WebSocket path',
							value: html`<code>${status.websocketPath}</code>`,
						},
						{
							label: 'Production URL',
							value: html`<code>${status.publicWebSocketUrl}</code>`,
						},
						{
							label: 'LAN URL',
							value: html`<code>ws://192.168.1.234:4040/phone/ws</code>`,
						},
					])}
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
				</section>
				<section class="card">
					<h2>Environment</h2>
					<p class="muted">
						Set <code>PHONE_DEVICE_TOKEN</code> in the connector process
						environment, then restart. This page only reports
						<code>configured: ${status.tokenConfigured ? 'true' : 'false'}</code
						>.
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
	return {
		middleware: [],
		handler() {
			return renderPhoneSetupPage({ state, phone })
		},
	} satisfies Action<typeof routes.phoneSetup>
}
