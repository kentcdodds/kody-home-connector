import { type HomeConnectorConfig } from '../../config.ts'
import { type HomeConnectorStorage } from '../../storage/index.ts'
import {
	AraknisSwitchAuthError,
	createAraknisSwitchOpenClient,
} from './client.ts'
import {
	buildVlanMembership,
	emptyAraknisSystemInfo,
	parseAraknisInterfacesPayload,
	parseAraknisPoePayload,
	parseAraknisSystemInfo,
	parsePoePowerInlineCli,
} from './parsing.ts'
import {
	clearAraknisSwitchCredentials,
	getAraknisSwitchAuthStatus,
	getAraknisSwitchCredentials,
	hasAraknisSwitchStoredCredentials,
	saveAraknisSwitchCredentials,
	updateAraknisSwitchAuthStatus,
} from './repository.ts'
import {
	fetchAraknisLldpNeighborsOverSsh,
	fetchAraknisShowCommandOverSsh,
} from './ssh-client.ts'
import {
	type AraknisSwitchClient,
	type AraknisSwitchConfigSnapshot,
	type AraknisSwitchCredentials,
	type AraknisSwitchLldpNeighbor,
	type AraknisSwitchPoeStatus,
	type AraknisSwitchPort,
	type AraknisSwitchStatus,
	type AraknisSwitchSystemInfo,
	type AraknisSwitchVlan,
	type AraknisSwitchVlanMembership,
} from './types.ts'
import {
	assertAraknisSwitchCredentialsPresent,
	getAraknisSwitchConfigStatus,
} from './validation.ts'

function errorMessage(error: unknown, fallback: string) {
	return error instanceof Error ? error.message : fallback
}

export function createAraknisSwitchAdapter(input: {
	config: HomeConnectorConfig
	storage: HomeConnectorStorage
	clientFactory?: (credentials: AraknisSwitchCredentials) => AraknisSwitchClient
	sshLldpFetcher?: (
		credentials: AraknisSwitchCredentials,
	) => Promise<Array<AraknisSwitchLldpNeighbor>>
	sshShowFetcher?: (
		credentials: AraknisSwitchCredentials,
		command: string,
	) => Promise<string>
}) {
	const { config, storage } = input
	const connectorId = config.homeConnectorId
	let cachedClient: {
		credentialsKey: string
		client: AraknisSwitchClient
	} | null = null

	async function loadCredentials() {
		if (!storage.sharedSecret) return null
		return await getAraknisSwitchCredentials(storage, connectorId)
	}

	async function getConfigStatus() {
		const hasStoredCredentials = await hasAraknisSwitchStoredCredentials(
			storage,
			connectorId,
		)
		const authStatus = await getAraknisSwitchAuthStatus(storage, connectorId)
		const credentials = storage.sharedSecret
			? await getAraknisSwitchCredentials(storage, connectorId)
			: null
		return getAraknisSwitchConfigStatus({
			config,
			hasStoredCredentials: Boolean(hasStoredCredentials && credentials),
			hasSharedSecret: Boolean(storage.sharedSecret),
			lastAuthenticatedAt: authStatus?.lastAuthenticatedAt ?? null,
			lastAuthError: authStatus?.lastAuthError ?? null,
		})
	}

	async function requireCredentials() {
		return assertAraknisSwitchCredentialsPresent(await loadCredentials())
	}

	async function getClient() {
		const credentials = await requireCredentials()
		if (input.clientFactory) return input.clientFactory(credentials)
		const credentialsKey = `${credentials.username}\0${credentials.password}`
		if (cachedClient?.credentialsKey === credentialsKey) {
			return cachedClient.client
		}
		const client = createAraknisSwitchOpenClient({ config, credentials })
		cachedClient = { credentialsKey, client }
		return client
	}

	async function recordAuthSuccess() {
		await updateAraknisSwitchAuthStatus({
			storage,
			connectorId,
			lastAuthenticatedAt: new Date().toISOString(),
			lastAuthError: null,
		})
	}

	async function recordAuthFailure(error: unknown) {
		const previous = await getAraknisSwitchAuthStatus(storage, connectorId)
		await updateAraknisSwitchAuthStatus({
			storage,
			connectorId,
			lastAuthenticatedAt: previous?.lastAuthenticatedAt ?? null,
			lastAuthError: errorMessage(error, 'Araknis switch login failed.'),
		})
	}

	async function withAuthRecording<T>(operation: () => Promise<T>): Promise<T> {
		try {
			const result = await operation()
			await recordAuthSuccess()
			return result
		} catch (error) {
			// Only treat login/session failures as credential problems. A missing
			// OpEN resource (404) or parse issue must not wipe lastAuthenticatedAt.
			if (error instanceof AraknisSwitchAuthError) {
				await recordAuthFailure(error)
			}
			throw error
		}
	}

	async function listVlans(): Promise<Array<AraknisSwitchVlan>> {
		return await withAuthRecording(async () => (await getClient()).listVlans())
	}

	async function listPorts(): Promise<Array<AraknisSwitchPort>> {
		return await withAuthRecording(async () => {
			const interfaces = await (await getClient()).listInterfaces()
			return parseAraknisInterfacesPayload({ interfaces })
		})
	}

	async function getVlanMembership(
		vlanId: number,
	): Promise<AraknisSwitchVlanMembership> {
		return await withAuthRecording(async () => {
			const client = await getClient()
			const [ports, vlanDetail] = await Promise.all([
				listPortsWithoutAuthRecording(client),
				client.getVlan(vlanId),
			])
			return buildVlanMembership({
				vlan: vlanDetail.vlan,
				ports,
				memberRows: vlanDetail.members,
			})
		})
	}

	async function listPortsWithoutAuthRecording(client: AraknisSwitchClient) {
		const interfaces = await client.listInterfaces()
		return parseAraknisInterfacesPayload({ interfaces })
	}

	async function getSystemInfo(): Promise<AraknisSwitchSystemInfo> {
		return await withAuthRecording(async () => {
			const client = await getClient()
			const [system1213, systemMisc, registry, dot1dBase] =
				await Promise.allSettled([
					client.getSystem1213(),
					client.getSystemMisc(),
					client.getRegistry(),
					client.getDot1dBaseConfig(),
				])
			const results = [system1213, systemMisc, registry, dot1dBase]
			if (results.every((result) => result.status === 'rejected')) {
				const first = results[0]
				throw first.status === 'rejected'
					? first.reason
					: new Error('Araknis switch system info reads all failed.')
			}
			const authFailure = results.find(
				(result) =>
					result.status === 'rejected' &&
					result.reason instanceof AraknisSwitchAuthError,
			)
			if (authFailure && authFailure.status === 'rejected') {
				throw authFailure.reason
			}
			const system = parseAraknisSystemInfo({
				system1213: system1213.status === 'fulfilled' ? system1213.value : null,
				systemMisc: systemMisc.status === 'fulfilled' ? systemMisc.value : null,
				registry: registry.status === 'fulfilled' ? registry.value : null,
				dot1dBase: dot1dBase.status === 'fulfilled' ? dot1dBase.value : null,
			})
			const hasUsefulField = Boolean(
				system.sysName ||
				system.sysDescr ||
				system.hostname ||
				system.baseBridgeAddress ||
				system.machineModel ||
				system.burnedInMacAddress ||
				system.baseNumPorts != null,
			)
			if (!hasUsefulField) {
				throw new Error(
					'Araknis switch system info reads returned no usable fields.',
				)
			}
			return system
		})
	}

	async function listPoeStatus(): Promise<AraknisSwitchPoeStatus> {
		const errors: Array<string> = []
		try {
			const openResult = await withAuthRecording(async () => {
				const client = await getClient()
				return client.listPoe()
			})
			const parsed = parseAraknisPoePayload({
				interfaces: openResult.ports,
				poeGlobal: openResult.global ?? undefined,
			})
			if (parsed.ports.length > 0 || parsed.global) {
				return {
					ports: parsed.ports,
					source: 'open-v1',
					global: parsed.global,
					errors,
				}
			}
			errors.push(
				'OpEN PoE resources were not present (Dell OpEN 6.8.0 does not document PoE; AN-620 may omit them).',
			)
		} catch (error) {
			errors.push(errorMessage(error, 'OpEN PoE request failed.'))
		}

		if (!config.araknisSwitchSshEnabled) {
			return {
				ports: [],
				source: 'unavailable',
				global: null,
				errors: [
					...errors,
					'Set ARAKNIS_SWITCH_SSH_ENABLED=true to try read-only SSH `show power inline` for PoE status.',
				],
			}
		}

		try {
			const credentials = await requireCredentials()
			const cliText = input.sshShowFetcher
				? await input.sshShowFetcher(credentials, 'show power inline')
				: await fetchAraknisShowCommandOverSsh({
						config,
						credentials,
						command: 'show power inline',
					})
			const ports = parsePoePowerInlineCli(cliText)
			return {
				ports,
				source: ports.length > 0 ? 'ssh-cli' : 'unavailable',
				global: null,
				errors,
			}
		} catch (error) {
			errors.push(errorMessage(error, 'SSH PoE request failed.'))
			return { ports: [], source: 'unavailable', global: null, errors }
		}
	}

	async function listLldpNeighbors(): Promise<{
		neighbors: Array<AraknisSwitchLldpNeighbor>
		source: 'open-v1' | 'ssh-cli' | 'unavailable'
		errors: Array<string>
	}> {
		const errors: Array<string> = []
		try {
			const neighbors = await withAuthRecording(async () =>
				(await getClient()).listLldpNeighbors(),
			)
			if (neighbors.length > 0) {
				return { neighbors, source: 'open-v1', errors }
			}
		} catch (error) {
			errors.push(errorMessage(error, 'OpEN LLDP request failed.'))
		}

		if (!config.araknisSwitchSshEnabled) {
			return {
				neighbors: [],
				source: 'unavailable',
				errors: [
					...errors,
					'LLDP neighbors were not available over the OpEN HTTP API. Set ARAKNIS_SWITCH_SSH_ENABLED=true to try read-only SSH `show lldp remote-device`.',
				],
			}
		}

		try {
			const credentials = await requireCredentials()
			const neighbors = input.sshLldpFetcher
				? await input.sshLldpFetcher(credentials)
				: await fetchAraknisLldpNeighborsOverSsh({ config, credentials })
			return {
				neighbors,
				source: neighbors.length > 0 ? 'ssh-cli' : 'unavailable',
				errors,
			}
		} catch (error) {
			errors.push(errorMessage(error, 'SSH LLDP request failed.'))
			return { neighbors: [], source: 'unavailable', errors }
		}
	}

	async function getConfigSnapshot(): Promise<AraknisSwitchConfigSnapshot> {
		const [system, vlans, ports, poe] = await Promise.all([
			getSystemInfo().catch(() => emptyAraknisSystemInfo()),
			listVlans(),
			listPorts(),
			listPoeStatus(),
		])
		return {
			capturedAt: new Date().toISOString(),
			system,
			vlans,
			ports,
			poe,
		}
	}

	return {
		getConfigStatus,
		async setCredentials(username: string, password: string) {
			await saveAraknisSwitchCredentials({
				storage,
				connectorId,
				username,
				password,
			})
			cachedClient = null
			return getConfigStatus()
		},
		async clearCredentials() {
			await clearAraknisSwitchCredentials(storage, connectorId)
			cachedClient = null
			return getConfigStatus()
		},
		async authenticate() {
			return await withAuthRecording(async () => {
				const client = await getClient()
				// Force a fresh OpEN session; subsequent tools reuse the cookie.
				await client.login()
				return getConfigStatus()
			})
		},
		async getStatus(): Promise<AraknisSwitchStatus> {
			const configStatus = await getConfigStatus()
			if (!configStatus.configured) {
				return {
					config: configStatus,
					connected: false,
					api: {
						kind: 'unavailable',
						loginOk: false,
						systemReadable: false,
						vlansReadable: false,
						interfacesReadable: false,
						poeReadable: false,
						poeSource: 'unavailable',
						lldpReadable: false,
						lldpSource: 'unavailable',
					},
					system: emptyAraknisSystemInfo(),
					vlanCount: 0,
					portCount: 0,
					poePortCount: 0,
					errors: [
						`Araknis switch diagnostics are not configured: ${configStatus.missingFields.join(', ')}.`,
					],
				}
			}

			const errors: Array<string> = []
			const client = await getClient()
			let loginOk = false
			let systemReadable = false
			let vlansReadable = false
			let interfacesReadable = false
			let poeReadable = false
			let poeSource: AraknisSwitchPoeStatus['source'] = 'unavailable'
			let lldpReadable = false
			let lldpSource: AraknisSwitchStatus['api']['lldpSource'] = 'unavailable'
			let vlanCount = 0
			let portCount = 0
			let poePortCount = 0
			let system = emptyAraknisSystemInfo()

			// Reuse an existing OpEN session when present (keepalive). Only force
			// a fresh login via araknis_authenticate.
			try {
				await client.getDot1dBaseConfig()
				loginOk = true
				await recordAuthSuccess()
			} catch (error) {
				if (error instanceof AraknisSwitchAuthError) {
					await recordAuthFailure(error)
				}
				errors.push(errorMessage(error, 'Araknis switch login failed.'))
				return {
					config: await getConfigStatus(),
					connected: false,
					api: {
						kind: 'unavailable',
						loginOk: false,
						systemReadable: false,
						vlansReadable: false,
						interfacesReadable: false,
						poeReadable: false,
						poeSource: 'unavailable',
						lldpReadable: false,
						lldpSource: 'unavailable',
					},
					system: emptyAraknisSystemInfo(),
					vlanCount: 0,
					portCount: 0,
					poePortCount: 0,
					errors,
				}
			}

			try {
				system = await getSystemInfo()
				systemReadable = true
			} catch (error) {
				if (error instanceof AraknisSwitchAuthError) {
					await recordAuthFailure(error)
				}
				errors.push(errorMessage(error, 'Failed to read system info.'))
			}

			try {
				vlanCount = (await client.listVlans()).length
				vlansReadable = true
			} catch (error) {
				errors.push(errorMessage(error, 'Failed to list VLANs.'))
			}

			try {
				portCount = (await listPortsWithoutAuthRecording(client)).length
				interfacesReadable = true
			} catch (error) {
				errors.push(errorMessage(error, 'Failed to list interfaces.'))
			}

			const poe = await listPoeStatus()
			poeSource = poe.source
			poePortCount = poe.ports.length
			poeReadable = poe.ports.length > 0 || poe.source !== 'unavailable'
			errors.push(...poe.errors)

			const lldp = await listLldpNeighbors()
			lldpSource = lldp.source
			lldpReadable = lldp.neighbors.length > 0 || lldp.source !== 'unavailable'
			errors.push(...lldp.errors)

			return {
				config: await getConfigStatus(),
				connected: loginOk && vlansReadable && interfacesReadable,
				api: {
					kind: loginOk ? 'open-v1' : 'unavailable',
					loginOk,
					systemReadable,
					vlansReadable,
					interfacesReadable,
					poeReadable,
					poeSource,
					lldpReadable,
					lldpSource,
				},
				system,
				vlanCount,
				portCount,
				poePortCount,
				errors,
			}
		},
		listVlans,
		listPorts,
		getVlanMembership,
		getSystemInfo,
		listPoeStatus,
		listLldpNeighbors,
		getConfigSnapshot,
	}
}
