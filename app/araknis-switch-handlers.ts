import { type Action } from 'remix/router'
import { html } from 'remix/html-template'
import { renderEmptyState } from './admin-ui.ts'
import { renderBanner, renderInfoRows } from './handler-utils.ts'
import { render } from './render.ts'
import { RootLayout } from './root.ts'
import { routes } from './routes.ts'
import { type createAraknisSwitchAdapter } from '../src/adapters/araknis-switch/index.ts'
import { captureHomeConnectorException } from '../src/sentry.ts'
import { type HomeConnectorState } from '../src/state.ts'

type Banner = { tone: 'success' | 'error'; message: string } | null

type AraknisSwitchAdapter = ReturnType<typeof createAraknisSwitchAdapter>

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
		} catch (error) {
			if (
				error instanceof Error &&
				error.message === 'Rejected cross-origin credential submission.'
			) {
				throw error
			}
			throw new Error('Rejected cross-origin credential submission.')
		}
	}
}

function renderAraknisSwitchStatusPage(input: {
	state: HomeConnectorState
	status: Awaited<ReturnType<AraknisSwitchAdapter['getConfigStatus']>>
}) {
	const { status } = input
	return render(
		RootLayout({
			title: 'home connector - araknis switch status',
			currentPath: routes.araknisSwitchStatus.href(),
			body: html`<section class="card">
					<h1>Araknis switch status</h1>
					<p class="muted">
						Read-only readiness for the Araknis AN-620 OpEN HTTPS diagnostics.
						Credentials are stored locally in encrypted SQLite and are never
						rendered back to the browser. Use
						<code>araknis_get_status</code> for a live OpEN probe.
					</p>
					<p>
						<a href="${routes.araknisSwitchSetup.href()}"
							>Araknis switch setup</a
						>
						<span class="muted">— save or clear local credentials</span>
					</p>
					${renderInfoRows([
						{
							label: 'MCP server',
							value: input.state.connection.listening
								? 'connected'
								: 'disconnected',
						},
						{
							label: 'Connector ID',
							value: input.state.connection.connectorId || 'not registered yet',
						},
						{
							label: 'Configured',
							value: status.configured ? 'yes' : 'no',
						},
						{
							label: 'Credentials stored',
							value: status.hasStoredCredentials ? 'yes' : 'no',
						},
						{
							label: 'Base URL',
							value: html`<code>${status.baseUrl}</code>`,
						},
						{
							label: 'Allow insecure TLS',
							value: status.allowInsecureTls ? 'yes' : 'no',
						},
						{
							label: 'SSH LLDP fallback',
							value: status.sshEnabled
								? `enabled (port ${String(status.sshPort)})`
								: 'disabled',
						},
						{
							label: 'Last auth success',
							value: status.lastAuthenticatedAt ?? 'never',
						},
						{
							label: 'Last auth error',
							value: status.lastAuthError ?? 'none',
						},
					])}
				</section>
				<section class="card">
					<h2>Usage</h2>
					<p class="muted">
						After credentials are stored, callers can use the read-only
						<code>araknis_*</code> MCP tools for VLAN/port/LLDP verification.
						There are no write/config-change tools.
					</p>
				</section>`,
		}),
	)
}

function renderAraknisSwitchSetupPage(input: {
	state: HomeConnectorState
	status: Awaited<ReturnType<AraknisSwitchAdapter['getConfigStatus']>>
	banner: Banner
}) {
	const { status } = input
	return render(
		RootLayout({
			title: 'home connector - araknis switch setup',
			currentPath: routes.araknisSwitchSetup.href(),
			body: html`<section class="card">
					<h1>Araknis switch setup</h1>
					<p class="muted">
						Store the Araknis AN-620 management username and password locally so
						the connector can authenticate to OpEN HTTPS from inside the LAN.
						The saved values are encrypted with
						<code>HOME_CONNECTOR_SHARED_SECRET</code> and are never rendered
						back to the browser or returned by MCP tools.
					</p>
					<p>
						<a href="${routes.araknisSwitchStatus.href()}"
							>Araknis switch status</a
						>
						<span class="muted">— review diagnostics readiness</span>
					</p>
					${renderInfoRows([
						{
							label: 'Connector ID',
							value: input.state.connection.connectorId || 'not registered yet',
						},
						{
							label: 'Configured',
							value: status.configured ? 'yes' : 'no',
						},
						{
							label: 'Credentials stored',
							value: status.hasStoredCredentials ? 'yes' : 'no',
						},
						{
							label: 'Base URL',
							value: html`<code>${status.baseUrl}</code>`,
						},
						{
							label: 'Last auth error',
							value: status.lastAuthError ?? 'none',
						},
					])}
				</section>
				${input.banner ? renderBanner(input.banner) : ''}
				<section class="card">
					<h2>Set credentials</h2>
					<p class="muted">
						Enter the switch management username and password. Saving replaces
						any credentials currently stored for this connector.
					</p>
					<form method="POST" class="field-stack">
						<input type="hidden" name="intent" value="save-credentials" />
						<label>
							Username
							<input
								type="text"
								name="username"
								required
								autocomplete="username"
								placeholder="Araknis management username"
							/>
						</label>
						<label>
							Password
							<input
								type="password"
								name="password"
								required
								autocomplete="current-password"
								placeholder="Araknis management password"
							/>
						</label>
						<div class="form-actions">
							<button type="submit">Save credentials</button>
						</div>
					</form>
				</section>
				<section class="card">
					<h2>Clear credentials</h2>
					<p class="muted">
						Remove the encrypted username and password from local SQLite
						storage. Non-secret Araknis env settings such as base URL and TLS
						flags are not affected.
					</p>
					${status.hasStoredCredentials
						? html`<form method="POST">
								<input type="hidden" name="intent" value="clear-credentials" />
								<button type="submit">Clear stored credentials</button>
							</form>`
						: renderEmptyState(
								'No Araknis switch credentials are stored locally.',
							)}
				</section>`,
		}),
	)
}

export function createAraknisSwitchStatusHandler(
	state: HomeConnectorState,
	araknisSwitch: AraknisSwitchAdapter,
) {
	return {
		middleware: [],
		async handler() {
			return renderAraknisSwitchStatusPage({
				state,
				status: await araknisSwitch.getConfigStatus(),
			})
		},
	} satisfies Action<typeof routes.araknisSwitchStatus>
}

export function createAraknisSwitchSetupHandler(
	state: HomeConnectorState,
	araknisSwitch: AraknisSwitchAdapter,
) {
	async function renderPage(banner: Banner = null) {
		return renderAraknisSwitchSetupPage({
			state,
			status: await araknisSwitch.getConfigStatus(),
			banner,
		})
	}

	return {
		middleware: [],
		async handler({ request }: { request: Request }) {
			if (request.method === 'POST') {
				try {
					assertSameOriginFormPost(request)
					const form = await request.formData()
					const intent = String(form.get('intent') ?? '')

					if (intent === 'save-credentials') {
						await araknisSwitch.setCredentials(
							String(form.get('username') ?? ''),
							String(form.get('password') ?? ''),
						)
						return renderPage({
							tone: 'success',
							message: 'Saved Araknis switch credentials.',
						})
					}

					if (intent === 'clear-credentials') {
						await araknisSwitch.clearCredentials()
						return renderPage({
							tone: 'success',
							message: 'Cleared Araknis switch credentials.',
						})
					}

					return renderPage({
						tone: 'error',
						message: 'Unknown form action.',
					})
				} catch (error) {
					captureHomeConnectorException(error, {
						tags: {
							route: '/araknis-switch/setup',
							action: 'form',
						},
						contexts: {
							araknisSwitch: {
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
	} satisfies Action<typeof routes.araknisSwitchSetup>
}
