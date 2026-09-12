import { type HomeConnectorConfig } from '../../config.ts'
import { type HomeConnectorStorage } from '../../storage/index.ts'
import { getSonyIrccCode, type SonyIrccCommandName } from './commands.ts'
import {
	createSonyIrccHttpClient,
	probeSonyIrccHost,
	sendSonyIrccCommand,
} from './client.ts'
import {
	blockedSonyCameraReason,
	buildSonyIrccPlayerId,
	isBlockedSonyCamera,
	normalizeSonyIrccHost,
	normalizeSonyIrccMacAddress,
} from './identity.ts'
import {
	getCourtSonyIrccPlayer,
	getSonyIrccAuth,
	getSonyIrccPlayer,
	listSonyIrccPlayers,
	removeSonyIrccPlayer,
	upsertSonyIrccPlayer,
} from './repository.ts'
import {
	courtBlurayAvPath,
	courtBlurayPlayerId,
	courtSonyCameraNotThePlayer,
	sonyIrccDefaultName,
	type SonyIrccCommandResult,
	type SonyIrccHttpClient,
	type SonyIrccPersistedPlayer,
	type SonyIrccScanResult,
	type SonyIrccSetHostInput,
	type SonyIrccStatus,
	type SonyIrccWakeOnLanSender,
} from './types.ts'
import { sendWakeOnLan } from './wol.ts'

export {
	courtBlurayAvPath,
	courtBlurayPlayerId,
	courtSonyCameraNotThePlayer,
	sonyIrccDefaultTimeoutMs,
} from './types.ts'
export {
	getSonyIrccCode,
	isSonyIrccCommandName,
	sonyIrccBd1Codes,
	sonyIrccCommandNames,
	sonyIrccTvCodes,
	type SonyIrccCommandName,
} from './commands.ts'
export { isBlockedSonyCamera, normalizeSonyIrccHost } from './identity.ts'

const pairingNotes =
	'Live pairing needs the player powered with network standby on. After on-screen confirm, persist the auth cookie or PSK with bluray_set_host. 192.168.0.115 is the Sony camera (bisyamon), not the Blu-ray.'

function notConfiguredReason() {
	return `Court Blu-ray host is not configured. Set COURT_BLURAY_HOST or call bluray_set_host after the player is powered with network standby on. ${courtSonyCameraNotThePlayer.reason}`
}

function probeFailedReason(host: string) {
	return `Sony IRCC endpoints on ${host} did not respond (player unplugged, network standby off, or not a Blu-ray). Probe Ircc.xml:50001, actionList:50002, and dmr.xml:52323 with a short timeout. ${courtSonyCameraNotThePlayer.host} is not the player.`
}

function disconnectedStatus(input: {
	reason: string
	reasonCode: SonyIrccStatus['reasonCode']
	configured: boolean
	host?: string | null
	macAddress?: string | null
	name?: string | null
	model?: string | null
	manufacturer?: string | null
	playerId?: string | null
	irccControlUrl?: string | null
	hasAuth?: boolean
	probedEndpoints?: SonyIrccStatus['probedEndpoints']
	player?: SonyIrccPersistedPlayer | null
}): SonyIrccStatus {
	return {
		connected: false,
		reason: input.reason,
		reasonCode: input.reasonCode,
		configured: input.configured,
		host: input.host ?? null,
		macAddress: input.macAddress ?? null,
		name: input.name ?? null,
		model: input.model ?? null,
		manufacturer: input.manufacturer ?? null,
		playerId: input.playerId ?? null,
		irccControlUrl: input.irccControlUrl ?? null,
		hasAuth: Boolean(input.hasAuth),
		probedEndpoints: input.probedEndpoints ?? [],
		avPath: courtBlurayAvPath,
		rejectedSonyCamera: courtSonyCameraNotThePlayer,
		pairingNotes,
		player: input.player ?? null,
	}
}

function connectedStatus(input: {
	host: string
	macAddress: string | null
	name: string | null
	model: string | null
	manufacturer: string | null
	playerId: string
	irccControlUrl: string | null
	hasAuth: boolean
	probedEndpoints: SonyIrccStatus['probedEndpoints']
	player: SonyIrccPersistedPlayer | null
}): SonyIrccStatus {
	return {
		connected: true,
		reason: `Sony IRCC Blu-ray at ${input.host} responded.`,
		reasonCode: null,
		configured: true,
		host: input.host,
		macAddress: input.macAddress,
		name: input.name,
		model: input.model,
		manufacturer: input.manufacturer,
		playerId: input.playerId,
		irccControlUrl: input.irccControlUrl,
		hasAuth: input.hasAuth,
		probedEndpoints: input.probedEndpoints,
		avPath: courtBlurayAvPath,
		rejectedSonyCamera: courtSonyCameraNotThePlayer,
		pairingNotes,
		player: input.player,
	}
}

function withCommand(
	status: SonyIrccStatus,
	extra: Omit<SonyIrccCommandResult, keyof SonyIrccStatus>,
): SonyIrccCommandResult {
	return {
		...status,
		...extra,
	}
}

export function createSonyBlurayAdapter(input: {
	config: HomeConnectorConfig
	storage: HomeConnectorStorage
	http?: SonyIrccHttpClient
	wakeOnLan?: SonyIrccWakeOnLanSender
}) {
	const { config, storage } = input
	const connectorId = config.homeConnectorId
	const timeoutMs = config.courtBlurayTimeoutMs
	const http = input.http ?? createSonyIrccHttpClient()
	const wakeOnLan = input.wakeOnLan ?? sendWakeOnLan

	function envHost() {
		return normalizeSonyIrccHost(config.courtBlurayHost)
	}

	function envMac() {
		return normalizeSonyIrccMacAddress(config.courtBlurayMacAddress)
	}

	async function resolveTarget(): Promise<{
		host: string | null
		macAddress: string | null
		name: string | null
		player: SonyIrccPersistedPlayer | null
	}> {
		const persisted = await getCourtSonyIrccPlayer(storage, connectorId)
		const host = envHost() ?? persisted?.host ?? null
		const macAddress = envMac() ?? persisted?.macAddress ?? null
		return {
			host,
			macAddress,
			name: persisted?.name ?? sonyIrccDefaultName,
			player: persisted,
		}
	}

	async function persistSuccessfulProbe(inputProbe: {
		host: string
		macAddress: string | null
		name: string | null
		model: string | null
		manufacturer: string | null
		irccControlUrl: string | null
		probedEndpoints: SonyIrccStatus['probedEndpoints']
		playerId?: string
	}) {
		const playerId = inputProbe.playerId ?? courtBlurayPlayerId
		return await upsertSonyIrccPlayer({
			storage,
			connectorId,
			player: {
				playerId,
				name: inputProbe.name ?? sonyIrccDefaultName,
				host: inputProbe.host,
				macAddress: inputProbe.macAddress,
				model: inputProbe.model,
				manufacturer: inputProbe.manufacturer,
				irccControlUrl: inputProbe.irccControlUrl,
				lastSeenAt: new Date().toISOString(),
				rawProbe: {
					probedEndpoints: inputProbe.probedEndpoints,
				},
			},
			adopted: playerId === courtBlurayPlayerId,
		})
	}

	async function statusFromProbe(): Promise<SonyIrccStatus> {
		const target = await resolveTarget()
		if (!target.host) {
			return disconnectedStatus({
				reason: notConfiguredReason(),
				reasonCode: 'not_configured',
				configured: false,
			})
		}
		if (isBlockedSonyCamera(target)) {
			const blocked = blockedSonyCameraReason()
			return disconnectedStatus({
				reason: blocked.reason,
				reasonCode: blocked.reasonCode,
				configured: true,
				host: target.host,
				macAddress: target.macAddress,
				name: target.name,
				playerId: target.player?.playerId ?? courtBlurayPlayerId,
				player: target.player,
			})
		}

		const probe = await probeSonyIrccHost({
			host: target.host,
			http,
			timeoutMs,
		})
		const persistedAuth = target.player
			? await getSonyIrccAuth({
					storage,
					connectorId,
					playerId: target.player.playerId,
				})
			: { authCookie: config.courtBlurayAuthCookie, psk: config.courtBlurayPsk }
		const hasAuth = Boolean(
			persistedAuth.authCookie ||
			persistedAuth.psk ||
			config.courtBlurayAuthCookie ||
			config.courtBlurayPsk,
		)

		if (!probe.matched) {
			return disconnectedStatus({
				reason: probeFailedReason(target.host),
				reasonCode: 'probe_failed',
				configured: true,
				host: target.host,
				macAddress: target.macAddress,
				name: target.name,
				playerId: target.player?.playerId ?? courtBlurayPlayerId,
				irccControlUrl: target.player?.irccControlUrl ?? null,
				hasAuth,
				probedEndpoints: probe.probedEndpoints,
				player: target.player,
			})
		}

		const player = await persistSuccessfulProbe({
			host: target.host,
			macAddress: target.macAddress,
			name: probe.name ?? target.name,
			model: probe.model,
			manufacturer: probe.manufacturer,
			irccControlUrl: probe.irccControlUrl,
			probedEndpoints: probe.probedEndpoints,
			playerId: target.player?.playerId ?? courtBlurayPlayerId,
		})

		return connectedStatus({
			host: target.host,
			macAddress: target.macAddress,
			name: probe.name ?? target.name,
			model: probe.model,
			manufacturer: probe.manufacturer,
			playerId: player?.playerId ?? courtBlurayPlayerId,
			irccControlUrl: probe.irccControlUrl,
			hasAuth,
			probedEndpoints: probe.probedEndpoints,
			player,
		})
	}

	async function sendCommand(
		command: SonyIrccCommandName,
	): Promise<SonyIrccCommandResult> {
		const status = await statusFromProbe()
		const irccCode = getSonyIrccCode(command)
		if (!status.connected || !status.host) {
			return withCommand(status, {
				command,
				irccCode,
				transport: null,
				wakeOnLan: null,
				httpStatus: null,
			})
		}
		const auth = status.playerId
			? await getSonyIrccAuth({
					storage,
					connectorId,
					playerId: status.playerId,
				})
			: { authCookie: null, psk: null }
		const sent = await sendSonyIrccCommand({
			host: status.host,
			http,
			irccCode,
			controlUrl: status.irccControlUrl,
			authCookie: auth.authCookie ?? config.courtBlurayAuthCookie,
			psk: auth.psk ?? config.courtBlurayPsk,
			timeoutMs,
		})
		if (!sent.ok) {
			return withCommand(
				disconnectedStatus({
					reason: sent.error ?? probeFailedReason(status.host),
					reasonCode: 'unreachable',
					configured: true,
					host: status.host,
					macAddress: status.macAddress,
					name: status.name,
					model: status.model,
					manufacturer: status.manufacturer,
					playerId: status.playerId,
					irccControlUrl: sent.controlUrl ?? status.irccControlUrl,
					hasAuth: status.hasAuth,
					probedEndpoints: status.probedEndpoints,
					player: status.player,
				}),
				{
					command,
					irccCode,
					transport: 'ircc',
					wakeOnLan: null,
					httpStatus: sent.httpStatus,
				},
			)
		}
		return withCommand(
			{
				...status,
				irccControlUrl: sent.controlUrl ?? status.irccControlUrl,
				reason: `Sent IRCC ${command} to ${status.host}.`,
			},
			{
				command,
				irccCode,
				transport: 'ircc',
				wakeOnLan: null,
				httpStatus: sent.httpStatus,
			},
		)
	}

	return {
		async getStatus() {
			return await statusFromProbe()
		},
		async listPlayers() {
			return await listSonyIrccPlayers(storage, connectorId)
		},
		async setHost(setInput: SonyIrccSetHostInput) {
			const host = normalizeSonyIrccHost(setInput.host)
			if (!host) {
				return disconnectedStatus({
					reason: 'bluray_set_host requires a host or IP.',
					reasonCode: 'not_configured',
					configured: false,
				})
			}
			const macAddress =
				normalizeSonyIrccMacAddress(setInput.macAddress) ?? envMac()
			if (isBlockedSonyCamera({ host, macAddress })) {
				const blocked = blockedSonyCameraReason()
				return disconnectedStatus({
					reason: blocked.reason,
					reasonCode: blocked.reasonCode,
					configured: true,
					host,
					macAddress,
				})
			}
			await upsertSonyIrccPlayer({
				storage,
				connectorId,
				player: {
					playerId: courtBlurayPlayerId,
					name: setInput.name?.trim() || sonyIrccDefaultName,
					host,
					macAddress,
				},
				adopted: true,
				authCookie: setInput.authCookie,
				psk: setInput.psk,
			})
			return await statusFromProbe()
		},
		async forget() {
			const existing = await getSonyIrccPlayer(
				storage,
				connectorId,
				courtBlurayPlayerId,
			)
			await removeSonyIrccPlayer({
				storage,
				connectorId,
				playerId: courtBlurayPlayerId,
			})
			if (existing) {
				await removeSonyIrccPlayer({
					storage,
					connectorId,
					playerId: existing.playerId,
				})
			}
			if (envHost()) {
				return await statusFromProbe()
			}
			return disconnectedStatus({
				reason: notConfiguredReason(),
				reasonCode: 'not_configured',
				configured: false,
			})
		},
		async scan(scanInput: { hosts?: Array<string> } = {}) {
			const configuredExtra = config.courtBlurayScanExtraHosts
			const explicit = (scanInput.hosts ?? [])
				.map((host) => normalizeSonyIrccHost(host))
				.filter((host): host is string => Boolean(host))
			const hosts = [
				...new Set([
					...explicit,
					...configuredExtra
						.map((host) => normalizeSonyIrccHost(host))
						.filter((host): host is string => Boolean(host)),
					...config.courtBlurayScanCidrs
						.filter((cidr) => cidr.endsWith('/32'))
						.map((cidr) => cidr.replace(/\/32$/, '')),
				]),
			]
			const result: SonyIrccScanResult = {
				players: [],
				rejected: [],
				probes: [],
			}
			for (const host of hosts) {
				if (isBlockedSonyCamera({ host })) {
					const blocked = blockedSonyCameraReason()
					result.rejected.push({
						host,
						reason: blocked.reason,
						reasonCode: blocked.reasonCode,
					})
					continue
				}
				const probe = await probeSonyIrccHost({
					host,
					http,
					timeoutMs,
				})
				result.probes.push(
					...probe.probedEndpoints.map((endpoint) => ({
						...endpoint,
						host,
					})),
				)
				if (!probe.matched) {
					result.rejected.push({
						host,
						reason: probeFailedReason(host),
						reasonCode: 'probe_failed',
					})
					continue
				}
				const player = await persistSuccessfulProbe({
					host,
					macAddress: null,
					name: probe.name,
					model: probe.model,
					manufacturer: probe.manufacturer,
					irccControlUrl: probe.irccControlUrl,
					probedEndpoints: probe.probedEndpoints,
					playerId:
						envHost() === host || !envHost()
							? courtBlurayPlayerId
							: buildSonyIrccPlayerId(host),
				})
				if (player) result.players.push(player)
			}
			if (result.players.length === 0 && result.rejected.length === 0) {
				result.rejected.push({
					host: '',
					reason:
						'No Blu-ray scan hosts were provided. Pass hosts to bluray_scan, or set COURT_BLURAY_SCAN_EXTRA_HOSTS / COURT_BLURAY_HOST. Do not scan 192.168.0.115 — that is the Sony camera.',
					reasonCode: 'not_configured',
				})
			}
			return result
		},
		async press(command: SonyIrccCommandName) {
			return await sendCommand(command)
		},
		async powerOn() {
			const target = await resolveTarget()
			const emptyWol = {
				sent: false,
				macAddress: target.macAddress,
				targets: [] as Array<string>,
				error: null as string | null,
			}
			if (!target.host) {
				return withCommand(
					disconnectedStatus({
						reason: notConfiguredReason(),
						reasonCode: 'not_configured',
						configured: false,
						macAddress: target.macAddress,
					}),
					{
						command: 'powerOn',
						irccCode: getSonyIrccCode('powerOn'),
						transport: null,
						wakeOnLan: emptyWol,
						httpStatus: null,
					},
				)
			}
			if (isBlockedSonyCamera(target)) {
				const blocked = blockedSonyCameraReason()
				return withCommand(
					disconnectedStatus({
						reason: blocked.reason,
						reasonCode: blocked.reasonCode,
						configured: true,
						host: target.host,
						macAddress: target.macAddress,
					}),
					{
						command: 'powerOn',
						irccCode: getSonyIrccCode('powerOn'),
						transport: null,
						wakeOnLan: emptyWol,
						httpStatus: null,
					},
				)
			}

			let wake: SonyIrccCommandResult['wakeOnLan'] = emptyWol
			if (target.macAddress) {
				try {
					const sent = await wakeOnLan({
						host: target.host,
						macAddress: target.macAddress,
					})
					wake = {
						sent: true,
						macAddress: target.macAddress,
						targets: sent.targets,
						error: null,
					}
				} catch (error) {
					wake = {
						sent: false,
						macAddress: target.macAddress,
						targets: [],
						error: error instanceof Error ? error.message : String(error),
					}
				}
			}

			const command = await sendCommand('powerOn')
			if (command.connected) {
				return {
					...command,
					transport: command.transport ?? 'ircc',
					wakeOnLan: wake,
				}
			}
			if (wake.sent) {
				return {
					...command,
					reason: `${command.reason} Wake-on-LAN was sent to ${target.macAddress}; the player may still be unplugged or network standby may be off.`,
					transport: 'wol',
					wakeOnLan: wake,
				}
			}
			return {
				...command,
				wakeOnLan: wake,
			}
		},
		async powerOff() {
			return await sendCommand('powerOff')
		},
	}
}

export type SonyBlurayAdapter = ReturnType<typeof createSonyBlurayAdapter>
