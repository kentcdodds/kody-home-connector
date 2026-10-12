import { type HomeConnectorConfig } from '../../config.ts'
import { type HomeConnectorStorage } from '../../storage/index.ts'
import { createAraknisSwitchOpenClient } from './client.ts'
import {
	buildVlanMembership,
	parseAraknisInterfacesPayload,
} from './parsing.ts'
import {
	clearAraknisSwitchCredentials,
	getAraknisSwitchAuthStatus,
	getAraknisSwitchCredentials,
	hasAraknisSwitchStoredCredentials,
	saveAraknisSwitchCredentials,
	updateAraknisSwitchAuthStatus,
} from './repository.ts'
import { fetchAraknisLldpNeighborsOverSsh } from './ssh-client.ts'
import {
	type AraknisSwitchClient,
	type AraknisSwitchCredentials,
	type AraknisSwitchLldpNeighbor,
	type AraknisSwitchPort,
	type AraknisSwitchStatus,
	type AraknisSwitchVlan,
	type AraknisSwitchVlanMembership,
} from './types.ts'
import {
	assertAraknisSwitchCredentialsPresent,
	getAraknisSwitchConfigStatus,
} from './validation.ts'

function asNumber(value: unknown): number | null {
	if (typeof value === 'number' && Number.isFinite(value)) {
		return Math.trunc(value)
	}
	if (typeof value === 'string' && value.trim()) {
		const parsed = Number(value)
		if (Number.isFinite(parsed)) return Math.trunc(parsed)
	}
	return null
}

function asString(value: unknown): string | null {
	if (typeof value !== 'string') return null
	const trimmed = value.trim()
	return trimmed.length > 0 ? trimmed : null
}

export function createAraknisSwitchAdapter(input: {
	config: HomeConnectorConfig
	storage: HomeConnectorStorage
	clientFactory?: (credentials: AraknisSwitchCredentials) => AraknisSwitchClient
	sshLldpFetcher?: (
		credentials: AraknisSwitchCredentials,
	) => Promise<Array<AraknisSwitchLldpNeighbor>>
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

	async function listVlans(): Promise<Array<AraknisSwitchVlan>> {
		return await (await getClient()).listVlans()
	}

	async function listPorts(): Promise<Array<AraknisSwitchPort>> {
		const interfaces = await (await getClient()).listInterfaces()
		return parseAraknisInterfacesPayload({ interfaces })
	}

	async function getVlanMembership(
		vlanId: number,
	): Promise<AraknisSwitchVlanMembership> {
		const client = await getClient()
		const [ports, vlanDetail] = await Promise.all([
			listPorts(),
			client.getVlan(vlanId),
		])
		return buildVlanMembership({
			vlan: vlanDetail.vlan,
			ports,
			memberRows: vlanDetail.members,
		})
	}

	async function listLldpNeighbors(): Promise<{
		neighbors: Array<AraknisSwitchLldpNeighbor>
		source: 'open-v1' | 'ssh-cli' | 'unavailable'
		errors: Array<string>
	}> {
		const errors: Array<string> = []
		try {
			const neighbors = await (await getClient()).listLldpNeighbors()
			if (neighbors.length > 0) {
				return { neighbors, source: 'open-v1', errors }
			}
		} catch (error) {
			errors.push(
				error instanceof Error ? error.message : 'OpEN LLDP request failed.',
			)
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
			errors.push(
				error instanceof Error ? error.message : 'SSH LLDP request failed.',
			)
			return { neighbors: [], source: 'unavailable', errors }
		}
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
			lastAuthError:
				error instanceof Error ? error.message : 'Araknis switch login failed.',
		})
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
		async getStatus(): Promise<AraknisSwitchStatus> {
			const configStatus = await getConfigStatus()
			if (!configStatus.configured) {
				return {
					config: configStatus,
					connected: false,
					api: {
						kind: 'unavailable',
						loginOk: false,
						vlansReadable: false,
						interfacesReadable: false,
						lldpReadable: false,
						lldpSource: 'unavailable',
					},
					system: {
						baseBridgeAddress: null,
						baseNumPorts: null,
					},
					vlanCount: 0,
					portCount: 0,
					errors: [
						`Araknis switch diagnostics are not configured: ${configStatus.missingFields.join(', ')}.`,
					],
				}
			}

			const errors: Array<string> = []
			const client = await getClient()
			let loginOk = false
			let vlansReadable = false
			let interfacesReadable = false
			let lldpReadable = false
			let lldpSource: AraknisSwitchStatus['api']['lldpSource'] = 'unavailable'
			let vlanCount = 0
			let portCount = 0
			let baseBridgeAddress: string | null = null
			let baseNumPorts: number | null = null

			try {
				await client.login()
				loginOk = true
				await recordAuthSuccess()
			} catch (error) {
				await recordAuthFailure(error)
				errors.push(
					error instanceof Error
						? error.message
						: 'Araknis switch login failed.',
				)
				return {
					config: await getConfigStatus(),
					connected: false,
					api: {
						kind: 'unavailable',
						loginOk: false,
						vlansReadable: false,
						interfacesReadable: false,
						lldpReadable: false,
						lldpSource: 'unavailable',
					},
					system: {
						baseBridgeAddress: null,
						baseNumPorts: null,
					},
					vlanCount: 0,
					portCount: 0,
					errors,
				}
			}

			try {
				const base = await client.getDot1dBaseConfig()
				baseBridgeAddress = asString(base['baseBridgeAddress'])
				baseNumPorts = asNumber(base['baseNumPorts'])
			} catch (error) {
				errors.push(
					error instanceof Error
						? error.message
						: 'Failed to read dot1dbaseconfig.',
				)
			}

			try {
				vlanCount = (await client.listVlans()).length
				vlansReadable = true
			} catch (error) {
				errors.push(
					error instanceof Error ? error.message : 'Failed to list VLANs.',
				)
			}

			try {
				portCount = (await listPorts()).length
				interfacesReadable = true
			} catch (error) {
				errors.push(
					error instanceof Error ? error.message : 'Failed to list interfaces.',
				)
			}

			const lldp = await listLldpNeighbors()
			lldpSource = lldp.source
			lldpReadable = lldp.neighbors.length > 0 || lldp.source !== 'unavailable'
			errors.push(...lldp.errors)

			try {
				await client.logout()
			} catch {
				// Best-effort logout; ignore failures.
			}

			return {
				config: await getConfigStatus(),
				connected: loginOk && vlansReadable && interfacesReadable,
				api: {
					kind: loginOk ? 'open-v1' : 'unavailable',
					loginOk,
					vlansReadable,
					interfacesReadable,
					lldpReadable,
					lldpSource,
				},
				system: {
					baseBridgeAddress,
					baseNumPorts,
				},
				vlanCount,
				portCount,
				errors,
			}
		},
		listVlans,
		listPorts,
		getVlanMembership,
		listLldpNeighbors,
	}
}
