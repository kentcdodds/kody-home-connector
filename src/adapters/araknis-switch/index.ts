import { type HomeConnectorConfig } from '../../config.ts'
import { createAraknisSwitchOpenClient } from './client.ts'
import {
	buildVlanMembership,
	parseAraknisInterfacesPayload,
} from './parsing.ts'
import { fetchAraknisLldpNeighborsOverSsh } from './ssh-client.ts'
import {
	type AraknisSwitchClient,
	type AraknisSwitchLldpNeighbor,
	type AraknisSwitchPort,
	type AraknisSwitchStatus,
	type AraknisSwitchVlan,
	type AraknisSwitchVlanMembership,
} from './types.ts'
import {
	assertAraknisSwitchConfigured,
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
	clientFactory?: () => AraknisSwitchClient
	sshLldpFetcher?: () => Promise<Array<AraknisSwitchLldpNeighbor>>
}) {
	const { config } = input
	let cachedClient: AraknisSwitchClient | null = null

	function getClient() {
		assertAraknisSwitchConfigured(config)
		if (input.clientFactory) return input.clientFactory()
		cachedClient ??= createAraknisSwitchOpenClient({ config })
		return cachedClient
	}

	function getConfigStatus() {
		return getAraknisSwitchConfigStatus(config)
	}

	async function listVlans(): Promise<Array<AraknisSwitchVlan>> {
		return await getClient().listVlans()
	}

	async function listPorts(): Promise<Array<AraknisSwitchPort>> {
		const interfaces = await getClient().listInterfaces()
		return parseAraknisInterfacesPayload({ interfaces })
	}

	async function getVlanMembership(
		vlanId: number,
	): Promise<AraknisSwitchVlanMembership> {
		const client = getClient()
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
			const neighbors = await getClient().listLldpNeighbors()
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
			const neighbors = input.sshLldpFetcher
				? await input.sshLldpFetcher()
				: await fetchAraknisLldpNeighborsOverSsh({ config })
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

	return {
		getConfigStatus,
		async getStatus(): Promise<AraknisSwitchStatus> {
			const configStatus = getConfigStatus()
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
			const client = getClient()
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
			} catch (error) {
				errors.push(
					error instanceof Error
						? error.message
						: 'Araknis switch login failed.',
				)
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
				config: configStatus,
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
