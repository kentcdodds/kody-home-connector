import http from 'node:http'
import { createRequestListener } from 'remix/node-fetch-server'
import { createHomeConnectorRouter } from '../app/router.ts'
import {
	closeHomeConnectorSentry,
	captureHomeConnectorException,
	flushHomeConnectorSentry,
} from '../src/sentry.ts'
import { startHomeConnectorApp } from '../src/index.ts'
import {
	createHomeMcpHttpHandler,
	homeMcpHttpInstructions,
	serveHomeMcpRequest,
} from '../src/mcp/http-mcp.ts'
import { createHomeMcpOAuthHandler } from '../src/oauth/http.ts'
import { attachPhoneWebSocketUpgrade } from '../src/adapters/phone/index.ts'

const signalExitCodeByName = {
	SIGINT: 130,
	SIGTERM: 143,
} as const

function installGracefulShutdownHandlers(input: {
	server: http.Server
	connector: Awaited<ReturnType<typeof startHomeConnectorApp>>
}) {
	let shutdownPromise: Promise<void> | null = null

	async function closeServerWithWatchdog() {
		await new Promise<void>((resolve) => {
			const watchdog = setTimeout(() => {
				input.server.closeAllConnections()
				resolve()
			}, 5_000)
			input.server.close(() => {
				clearTimeout(watchdog)
				resolve()
			})
		})
	}

	function shutdown(reason: string) {
		if (shutdownPromise) {
			return shutdownPromise
		}

		shutdownPromise = (async () => {
			input.connector.logger.info(
				'server.shutdown.started',
				`Shutting down home MCP server reason=${reason}`,
				{ reason },
			)
			await closeServerWithWatchdog()
			input.connector.storage.close()
			await closeHomeConnectorSentry()
		})()

		return shutdownPromise
	}

	for (const signal of ['SIGINT', 'SIGTERM'] as const) {
		process.once(signal, () => {
			void shutdown(`signal:${signal}`).finally(() => {
				process.exit(signalExitCodeByName[signal])
			})
		})
	}

	process.once('uncaughtException', (error) => {
		captureHomeConnectorException(error, {
			tags: {
				area: 'process',
				process_event: 'uncaughtException',
			},
		})
		void flushHomeConnectorSentry().finally(() => {
			process.exit(1)
		})
	})

	process.once('unhandledRejection', (reason, _promise) => {
		captureHomeConnectorException(reason, {
			tags: {
				area: 'process',
				process_event: 'unhandledRejection',
			},
			extra: {
				...(typeof reason === 'string' ||
				typeof reason === 'number' ||
				typeof reason === 'boolean'
					? { reason: String(reason) }
					: {}),
				reasonType: typeof reason,
				...(reason instanceof Error ? { reasonName: reason.name } : {}),
			},
		})
		void flushHomeConnectorSentry().finally(() => {
			process.exit(1)
		})
	})
}

async function main() {
	const connector = await startHomeConnectorApp()
	const oauth = createHomeMcpOAuthHandler({
		config: connector.config,
		storage: connector.storage,
	})
	const mcpHttp = createHomeMcpHttpHandler({
		toolRegistry: connector.toolRegistry,
		instructions: homeMcpHttpInstructions,
	})
	const router = createHomeConnectorRouter(
		connector.state,
		connector.config,
		connector.lutron,
		connector.samsungTv,
		connector.sonos,
		connector.bond,
		connector.accessNetworksUnleashed,
		connector.islandRouter,
		connector.islandRouterApi,
		connector.jellyfish,
		connector.venstar,
		connector.kasa,
		connector.phone,
	)

	const server = http.createServer(
		createRequestListener(
			async (request) => {
				try {
					const oauthResponse = await oauth.handle(request)
					if (oauthResponse) return oauthResponse

					const url = new URL(request.url)
					if (url.pathname === connector.config.mcpPath) {
						const auth = await oauth.authenticateMcp(request)
						if (auth instanceof Response) return auth
						return serveHomeMcpRequest({
							request,
							handler: mcpHttp,
							authInfo: auth,
						})
					}

					return await router.fetch(request)
				} catch (error) {
					captureHomeConnectorException(error, {
						tags: {
							area: 'http',
						},
						contexts: {
							request: {
								method: request.method,
								url: request.url,
							},
						},
					})
					throw error
				}
			},
			{
				host: `localhost:${connector.config.port}`,
			},
		),
	)

	server.listen(connector.config.port, () => {
		connector.logger.info(
			'server.http.listening',
			`home MCP listening on http://localhost:${connector.config.port} (public ${connector.config.mcpUrl})`,
			{
				port: connector.config.port,
				mcpUrl: connector.config.mcpUrl,
			},
		)
	})

	attachPhoneWebSocketUpgrade({
		server,
		phone: connector.phone,
	})

	installGracefulShutdownHandlers({
		server,
		connector,
	})
}

try {
	await main()
} catch (error) {
	captureHomeConnectorException(error, {
		tags: {
			area: 'startup',
		},
	})
	await flushHomeConnectorSentry()
	throw error
}
