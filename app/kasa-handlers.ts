import { type BuildAction } from 'remix/fetch-router'
import { html } from 'remix/html-template'
import { renderDataTable, renderEmptyState } from './admin-ui.ts'
import {
	formatJson,
	renderBanner,
	renderCodeBlock,
	renderInfoRows,
} from './handler-utils.ts'
import { render } from './render.ts'
import { RootLayout } from './root.ts'
import { routes } from './routes.ts'
import { type createKasaAdapter } from '../src/adapters/kasa/index.ts'
import {
	type KasaDiscoveryDiagnostics,
	type KasaPublicPlug,
} from '../src/adapters/kasa/types.ts'
import { captureHomeConnectorException } from '../src/sentry.ts'
import { type HomeConnectorState } from '../src/state.ts'

type Banner = { tone: 'success' | 'error'; message: string } | null

function renderKasaPlugList(plugs: Array<KasaPublicPlug>) {
	if (plugs.length === 0) {
		return renderEmptyState('No Kasa smart plugs are currently known.')
	}

	return renderDataTable({
		headers: [
			'Alias',
			'Plug ID',
			'Host',
			'Model',
			'Relay',
			'Adopted',
			'Last seen',
		],
		rows: plugs.map((plug) => [
			plug.alias,
			html`<code>${plug.plugId}</code>`,
			html`<code>${plug.host}:${String(plug.port)}</code>`,
			plug.model ?? 'unknown',
			plug.relayState,
			plug.adopted ? 'yes' : 'no',
			plug.lastSeenAt ?? 'unknown',
		]),
	})
}

function renderKasaDiscoveryDiagnostics(
	diagnostics: KasaDiscoveryDiagnostics | null,
) {
	if (!diagnostics) {
		return renderEmptyState('No Kasa scan diagnostics captured yet.')
	}

	return html`
		<section class="card">
			<h2>Discovery diagnostics</h2>
			${renderInfoRows([
				{ label: 'Protocol', value: diagnostics.protocol },
				{
					label: 'Discovery target',
					value: html`<code>${diagnostics.discoveryUrl}</code>`,
				},
				{ label: 'Last scan', value: diagnostics.scannedAt },
				{
					label: 'UDP ports',
					value: html`<code>${diagnostics.udpPorts.join(', ')}</code>`,
				},
				{
					label: 'Credential status',
					value: diagnostics.credentialStatus,
				},
				{
					label: 'Hosts probed',
					value: diagnostics.subnetProbe.hostsProbed,
				},
				{
					label: 'SHIP matches',
					value: diagnostics.subnetProbe.shipMatches,
				},
				{
					label: 'Authenticated matches',
					value: diagnostics.subnetProbe.authenticatedMatches,
				},
			])}
		</section>
		<section class="card">
			<h2>Probe results</h2>
			${renderDataTable({
				headers: [
					'Host',
					'Source',
					'Matched',
					'Status',
					'Server',
					'Alias',
					'Error',
				],
				rows: diagnostics.probes.map((probe) => [
					html`<code>${probe.host}:${String(probe.port)}</code>`,
					probe.source,
					probe.matched ? 'yes' : 'no',
					probe.status ?? 'n/a',
					probe.server ?? 'none',
					probe.alias ?? 'unknown',
					probe.error ?? 'none',
				]),
				className: 'data-table-diagnostics',
			})}
		</section>
		<section class="card">
			<h2>Raw diagnostics payload</h2>
			${renderCodeBlock(formatJson(diagnostics))}
		</section>
	`
}

function renderKasaSetupPage(input: {
	state: HomeConnectorState
	kasa: ReturnType<typeof createKasaAdapter>
	banner: Banner
}) {
	const configStatus = input.kasa.getConfigStatus()
	return render(
		RootLayout({
			title: 'home connector - kasa setup',
			currentPath: routes.kasaSetup.pattern,
			body: html`<section class="card">
					<h1>Kasa setup</h1>
					<p class="muted">
						Store the TP-Link/Kasa app account email and password used when the
						plugs were set up. The connector uses these credentials locally for
						KLAP authentication and never renders the saved password back to the
						browser.
					</p>
					<p>
						<a href="${routes.kasaStatus.pattern}">Kasa status</a>
						<span class="muted">— scan plugs and inspect readiness</span>
						<br />
						<a href="${routes.home.pattern}">Dashboard</a>
					</p>
					${renderInfoRows([
						{
							label: 'Connector ID',
							value: input.state.connection.connectorId || 'not registered yet',
						},
						{
							label: 'Credential state',
							value: configStatus.configured ? 'configured' : 'missing',
						},
						{
							label: 'Stored credentials',
							value: configStatus.hasStoredCredentials ? 'yes' : 'no',
						},
						{
							label: 'Env credentials',
							value: configStatus.hasEnvCredentials ? 'yes' : 'no',
						},
						{
							label: 'Credential source',
							value: configStatus.credentialSource ?? 'none',
						},
						{
							label: 'Username',
							value: configStatus.username ?? 'not stored',
						},
						{
							label: 'Missing requirements',
							value:
								configStatus.missingRequirements.length > 0
									? configStatus.missingRequirements.join(', ')
									: 'none',
						},
						{
							label: 'Last auth success',
							value: configStatus.lastAuthenticatedAt ?? 'never',
						},
						{
							label: 'Last auth error',
							value: configStatus.lastAuthError ?? 'none',
						},
					])}
				</section>
				${input.banner ? renderBanner(input.banner) : ''}
				<section class="card">
					<h2>Set credentials</h2>
					<p class="muted">
						Use the TP-Link/Kasa app email address and password. The saved
						password is encrypted in the connector SQLite database with
						<code>HOME_CONNECTOR_SHARED_SECRET</code>.
					</p>
					<form method="POST" class="field-stack">
						<input type="hidden" name="intent" value="save-credentials" />
						<label>
							TP-Link email
							<input
								type="text"
								name="username"
								required
								autocomplete="username"
								placeholder="name@example.com"
							/>
						</label>
						<label>
							Password
							<input
								type="password"
								name="password"
								required
								autocomplete="current-password"
								placeholder="TP-Link/Kasa password"
							/>
						</label>
						<div class="form-actions">
							<button type="submit">Save credentials</button>
						</div>
					</form>
				</section>`,
		}),
	)
}

function renderKasaStatusPage(input: {
	state: HomeConnectorState
	kasa: ReturnType<typeof createKasaAdapter>
	scanMessage?: string | null
	scanError?: string | null
}) {
	const status = input.kasa.getStatus()
	return render(
		RootLayout({
			title: 'home connector - kasa status',
			currentPath: routes.kasaStatus.pattern,
			body: html`<section class="card">
					<h1>Kasa status</h1>
					<p class="muted">
						Scan for TP-Link Kasa KLAP/SHIP 2.0 smart plugs, review credential
						readiness, and inspect the latest discovery diagnostics.
					</p>
					<p>
						<a href="${routes.kasaSetup.pattern}">Kasa setup</a>
						<span class="muted">— save TP-Link account credentials</span>
					</p>
					<form method="POST">
						<button type="submit">Scan plugs</button>
					</form>
					${renderInfoRows([
						{
							label: 'Worker connection',
							value: input.state.connection.connected
								? 'connected'
								: 'disconnected',
						},
						{
							label: 'Credential state',
							value: status.config.configured ? 'configured' : 'missing',
						},
						{
							label: 'Username',
							value: status.config.username ?? 'not stored',
						},
						{
							label: 'Known plugs',
							value: status.plugs.length,
						},
						{
							label: 'Adopted plugs',
							value: status.adopted.length,
						},
					])}
				</section>
				${input.scanMessage
					? renderBanner({ tone: 'success', message: input.scanMessage })
					: ''}
				${input.scanError
					? renderBanner({ tone: 'error', message: input.scanError })
					: ''}
				<section class="card">
					<h2>Known plugs</h2>
					${renderKasaPlugList(status.plugs)}
				</section>
				${renderKasaDiscoveryDiagnostics(status.diagnostics)}`,
		}),
	)
}

export function createKasaSetupHandler(
	state: HomeConnectorState,
	kasa: ReturnType<typeof createKasaAdapter>,
) {
	function renderPage(banner: Banner = null) {
		return renderKasaSetupPage({ state, kasa, banner })
	}

	return {
		middleware: [],
		async handler({ request }: { request: Request }) {
			if (request.method === 'POST') {
				try {
					const form = await request.formData()
					const intent = String(form.get('intent') ?? '')
					if (intent !== 'save-credentials') {
						return renderPage({
							tone: 'error',
							message: 'Unknown form action.',
						})
					}
					kasa.setCredentials(
						String(form.get('username') ?? ''),
						String(form.get('password') ?? ''),
					)
					return renderPage({
						tone: 'success',
						message: 'Saved Kasa credentials.',
					})
				} catch (error) {
					captureHomeConnectorException(error, {
						tags: {
							route: '/kasa/setup',
							action: 'save-credentials',
						},
						contexts: {
							kasa: {
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
	} satisfies BuildAction<
		typeof routes.kasaSetup.method,
		typeof routes.kasaSetup.pattern
	>
}

export function createKasaStatusHandler(
	state: HomeConnectorState,
	kasa: ReturnType<typeof createKasaAdapter>,
) {
	function renderPage(banner?: { scanMessage?: string; scanError?: string }) {
		return renderKasaStatusPage({
			state,
			kasa,
			scanMessage: banner?.scanMessage,
			scanError: banner?.scanError,
		})
	}

	return {
		middleware: [],
		async handler({ request }: { request: Request }) {
			if (request.method === 'POST') {
				try {
					const plugs = await kasa.scan()
					return renderPage({
						scanMessage: `Scan complete. Discovered ${plugs.length} Kasa smart plug(s).`,
					})
				} catch (error) {
					captureHomeConnectorException(error, {
						tags: {
							route: '/kasa/status',
							action: 'scan',
						},
						contexts: {
							kasa: {
								connectorId: state.connection.connectorId,
							},
						},
					})
					return renderPage({
						scanError:
							error instanceof Error
								? `Scan failed: ${error.message}`
								: `Scan failed: ${String(error)}`,
					})
				}
			}
			return renderPage()
		},
	} satisfies BuildAction<
		typeof routes.kasaStatus.method,
		typeof routes.kasaStatus.pattern
	>
}
