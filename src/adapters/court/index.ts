import { type HomeConnectorConfig } from '../../config.ts'
import { type HomeConnectorState } from '../../state.ts'
import { type createGlobalCacheAdapter } from '../global-cache/index.ts'
import { getGlobalCacheIrCommand } from '../global-cache/codes.ts'
import {
	isPjlinkUnavailableTimeError,
	isPjlinkUnreachableError,
	type createPjlinkAdapter,
} from '../pjlink/index.ts'
import { type PjlinkPowerState } from '../pjlink/protocol.ts'
import { courtOptomaDefaults } from '../pjlink/types.ts'
import { type createRokuAdapter } from '../roku/index.ts'
import { type createSonyBlurayAdapter } from '../sony-bluray/index.ts'
import { type createSonosAdapter } from '../sonos/index.ts'
import { type RokuDeviceRecord } from '../roku/types.ts'
import { type GlobalCacheSendIrResult } from '../global-cache/types.ts'

export const rotosphereActions = [
	'black-out',
	'auto',
	'sound',
	'strobe',
	'speed',
	'manual',
	'fade',
	'red',
	'green',
	'blue',
	'white',
	'plus',
	'minus',
] as const

export type CourtRotosphereAction = (typeof rotosphereActions)[number]

export type CourtHdmiInput = 1 | 2 | 3 | 4 | 5

export type CourtStartRokuInput = {
	appId?: string
	appName?: string
	rokuDeviceId?: string
	sonosPlayerId?: string
}

function matchesCourtName(value: string, pattern: RegExp) {
	return pattern.test(value)
}

function requireNever(value: never, label: string): never {
	throw new Error(`Unhandled ${label}: ${JSON.stringify(value)}`)
}

function hdmiInputCommandId(input: CourtHdmiInput) {
	switch (input) {
		case 1:
			return 'hdmi-input-1'
		case 2:
			return 'hdmi-input-2'
		case 3:
			return 'hdmi-input-3'
		case 4:
			return 'hdmi-input-4'
		case 5:
			return 'hdmi-input-5'
		default:
			return requireNever(input, 'HDMI input')
	}
}

function rotosphereCommandId(action: CourtRotosphereAction) {
	switch (action) {
		case 'black-out':
		case 'auto':
		case 'sound':
		case 'strobe':
		case 'speed':
		case 'manual':
		case 'fade':
		case 'red':
		case 'green':
		case 'blue':
		case 'white':
		case 'plus':
		case 'minus':
			return `rotosphere-${action}`
		default:
			return requireNever(action, 'Rotosphere action')
	}
}

function resolveCourtRokuDevice(input: {
	state: HomeConnectorState
	config: HomeConnectorConfig
	rokuDeviceId?: string
}): RokuDeviceRecord {
	const devices = input.state.devices
	const requestedId =
		input.rokuDeviceId?.trim() || input.config.courtRokuDeviceId?.trim() || ''
	if (requestedId) {
		const match = devices.find((device) => device.deviceId === requestedId)
		if (!match) {
			throw new Error(
				`Court Roku "${requestedId}" was not found. Scan and adopt it with roku_scan_devices / roku_adopt_device.`,
			)
		}
		if (!match.adopted) {
			throw new Error(
				`Court Roku "${match.name}" (${match.deviceId}) must be adopted before control.`,
			)
		}
		return match
	}
	const adopted = devices.filter((device) => device.adopted)
	const courtNamed = adopted.filter((device) =>
		matchesCourtName(device.name, /court/i),
	)
	if (courtNamed.length === 1) return courtNamed[0]!
	if (courtNamed.length > 1) {
		throw new Error(
			`Multiple adopted Rokus match "court": ${courtNamed
				.map((device) => `${device.name} (${device.deviceId})`)
				.join(', ')}. Pass rokuDeviceId.`,
		)
	}
	throw new Error(
		'No adopted court Roku found. Adopt the Court Projector Roku or set COURT_ROKU_DEVICE_ID.',
	)
}

async function resolveRokuAppId(input: {
	roku: ReturnType<typeof createRokuAdapter>
	deviceId: string
	appId?: string
	appName?: string
}) {
	if (input.appId?.trim()) return input.appId.trim()
	const appName = input.appName?.trim()
	if (!appName) return null
	const listed = await input.roku.listApps(input.deviceId)
	const normalized = appName.toLowerCase()
	const exact = listed.apps.find((app) => app.name.toLowerCase() === normalized)
	if (exact) return exact.id
	const partial = listed.apps.filter((app) =>
		app.name.toLowerCase().includes(normalized),
	)
	if (partial.length === 1) return partial[0]!.id
	if (partial.length > 1) {
		throw new Error(
			`Roku app name "${appName}" is ambiguous: ${partial
				.map((app) => `${app.name} (${app.id})`)
				.join(', ')}.`,
		)
	}
	throw new Error(`No installed Roku app matches "${appName}".`)
}

export type CourtProjectorTransport = 'pjlink' | 'itach-ir'

export type CourtProjectorCommandResult = {
	transport: CourtProjectorTransport
	irFallback: boolean
	fallbackReason: 'pjlink-unreachable' | 'pjlink-not-configured' | null
	alreadyPowered: boolean
	observedPower: PjlinkPowerState | null
	pjlink: unknown
	ir: GlobalCacheSendIrResult | null
}

export function createCourtAdapter(input: {
	config: HomeConnectorConfig
	state: HomeConnectorState
	globalCache: ReturnType<typeof createGlobalCacheAdapter>
	pjlink: ReturnType<typeof createPjlinkAdapter>
	roku: ReturnType<typeof createRokuAdapter>
	sonos: ReturnType<typeof createSonosAdapter>
	bluray?: ReturnType<typeof createSonyBlurayAdapter>
}) {
	async function resolveSonosPlayerId(sonosPlayerId?: string) {
		const requested =
			sonosPlayerId?.trim() || input.config.courtSonosPlayerId?.trim() || ''
		if (requested) return requested
		const players = (await input.sonos.getStatus()).allPlayers
		const matches = players.filter((player) => {
			const haystack = `${player.roomName} ${player.friendlyName} ${player.displayName}`
			return /sport\s*court/i.test(haystack)
		})
		if (matches.length === 1) return matches[0]!.playerId
		if (matches.length > 1) {
			throw new Error(
				`Multiple Sonos players match Sport Court: ${matches
					.map((player) => `${player.roomName} (${player.playerId})`)
					.join(', ')}. Pass sonosPlayerId.`,
			)
		}
		throw new Error(
			'No Sport Court Sonos player found. Scan/adopt it or set COURT_SONOS_PLAYER_ID.',
		)
	}

	async function sendProjectorCommand(
		command: 'on' | 'standby',
	): Promise<CourtProjectorCommandResult> {
		const irCommandId = command === 'on' ? 'projector-on' : 'projector-standby'
		const powerCommand = command === 'on' ? ('on' as const) : ('off' as const)
		const timeoutMs = input.config.courtPjlinkTimeoutMs

		function powerMatchesDesired(power: PjlinkPowerState) {
			if (command === 'on') {
				return power === 'on' || power === 'warming'
			}
			return power === 'standby' || power === 'cooling'
		}

		async function sendIrFallback(inputFallback: {
			fallbackReason: 'pjlink-unreachable' | 'pjlink-not-configured'
			pjlink: unknown
			observedPower: PjlinkPowerState | null
		}): Promise<CourtProjectorCommandResult> {
			const ir = await input.globalCache.sendIr(irCommandId)
			return {
				transport: 'itach-ir',
				irFallback: true,
				fallbackReason: inputFallback.fallbackReason,
				alreadyPowered: false,
				observedPower: inputFallback.observedPower,
				pjlink: inputFallback.pjlink,
				ir,
			}
		}

		try {
			const projector = await input.pjlink.resolveCourtProjector()
			if (!projector) {
				return await sendIrFallback({
					fallbackReason: 'pjlink-not-configured',
					pjlink: null,
					observedPower: null,
				})
			}

			try {
				const pjlink = await input.pjlink.setPower(
					{ projectorId: projector.projectorId },
					powerCommand,
					{ timeoutMs },
				)
				return {
					transport: 'pjlink',
					irFallback: false,
					fallbackReason: null,
					alreadyPowered: false,
					observedPower: pjlink.power,
					pjlink,
					ir: null,
				}
			} catch (error) {
				if (isPjlinkUnavailableTimeError(error)) {
					try {
						const status = await input.pjlink.getPower(
							{ projectorId: projector.projectorId },
							{ timeoutMs },
						)
						if (command === 'on' && status.power === 'cooling') {
							throw new Error(
								'Court projector is cooling and cannot accept power-on yet. Retry after cooldown.',
							)
						}
						if (command === 'standby' && status.power === 'warming') {
							throw new Error(
								'Court projector is warming and cannot accept standby yet. Retry after warm-up.',
							)
						}
						if (powerMatchesDesired(status.power)) {
							return {
								transport: 'pjlink',
								irFallback: false,
								fallbackReason: null,
								alreadyPowered: true,
								observedPower: status.power,
								pjlink: {
									projector,
									power: status.power,
									command: 'query' as const,
									raw: status.raw,
									unavailableTime: true,
									error: error instanceof Error ? error.message : String(error),
								},
								ir: null,
							}
						}
						return await sendIrFallback({
							fallbackReason: 'pjlink-unreachable',
							pjlink: {
								error: error instanceof Error ? error.message : String(error),
								observedPower: status.power,
								raw: status.raw,
							},
							observedPower: status.power,
						})
					} catch (queryError) {
						if (
							isPjlinkUnreachableError(queryError) ||
							isPjlinkUnavailableTimeError(queryError)
						) {
							return await sendIrFallback({
								fallbackReason: 'pjlink-unreachable',
								pjlink: {
									error: error instanceof Error ? error.message : String(error),
									queryError:
										queryError instanceof Error
											? queryError.message
											: String(queryError),
									host: isPjlinkUnreachableError(queryError)
										? queryError.host
										: undefined,
									port: isPjlinkUnreachableError(queryError)
										? queryError.port
										: undefined,
								},
								observedPower: null,
							})
						}
						throw queryError
					}
				}

				if (!isPjlinkUnreachableError(error)) {
					throw error
				}

				return await sendIrFallback({
					fallbackReason: 'pjlink-unreachable',
					pjlink: {
						error: error.message,
						host: error.host,
						port: error.port,
					},
					observedPower: null,
				})
			}
		} catch (error) {
			if (!isPjlinkUnreachableError(error)) {
				throw error
			}
			return await sendIrFallback({
				fallbackReason: 'pjlink-unreachable',
				pjlink: {
					error: error.message,
					host: error.host,
					port: error.port,
				},
				observedPower: null,
			})
		}
	}

	return {
		async getStatus() {
			const rokuDevice = input.state.devices.find(
				(device) => device.adopted && matchesCourtName(device.name, /court/i),
			)
			const pjlinkProjector = await input.pjlink.resolveCourtProjector()
			return {
				globalCache: input.globalCache.getStatus(),
				rokuDeviceId:
					input.config.courtRokuDeviceId ?? rokuDevice?.deviceId ?? null,
				rokuName: rokuDevice?.name ?? null,
				sonosPlayerId: input.config.courtSonosPlayerId ?? null,
				hdmiInputs: {
					1: 'proven',
					2: 'proven',
					3: 'guessed',
					4: 'guessed',
					5: 'guessed',
				},
				rotosphere:
					'IRC-6 codes from Flipper. Black Out / Manual / Red were seen on the court; other buttons are unreliable and should be re-learned.',
				projector: {
					preferredTransport: 'pjlink',
					fallbackTransport: 'itach-ir2',
					pjlink: pjlinkProjector
						? {
								projectorId: pjlinkProjector.projectorId,
								name: pjlinkProjector.name,
								host: pjlinkProjector.host,
								macAddress: pjlinkProjector.macAddress,
								adopted: pjlinkProjector.adopted,
							}
						: {
								projectorId: null,
								name: courtOptomaDefaults.name,
								host: courtOptomaDefaults.host,
								macAddress: courtOptomaDefaults.macAddress,
								adopted: false,
							},
					lanDarkAfterFullOff: true,
					courtPjlinkTimeoutMs: input.config.courtPjlinkTimeoutMs,
					notes:
						'Prefer PJLink %1POWR for court power. After a full Optoma off the LAN goes dark (ping/4352/80 fail); court power uses a short PJLink timeout then falls back to iTach IR2. Physical power or IR is required until network standby is enabled.',
				},
				rokuPower: {
					reliableHardOff: false,
					ecpPowerOffLeavesPowerModeOn: true,
					kasaPlug: null,
					notes:
						'Court Roku Ultra ECP PowerOff/Power leave power-mode=PowerOn. There is no court Kasa plug and no reliable hard-off path.',
				},
				bluray: input.bluray
					? await input.bluray.getStatus()
					: {
							connected: false,
							reason:
								'Court Blu-ray adapter is not wired. HDMI IN 2 is still the Blu-ray path.',
							host: input.config.courtBlurayHost ?? null,
							macAddress: input.config.courtBlurayMacAddress ?? null,
						},
			}
		},
		async startRoku(startInput: CourtStartRokuInput = {}) {
			const rokuDevice = resolveCourtRokuDevice({
				state: input.state,
				config: input.config,
				rokuDeviceId: startInput.rokuDeviceId,
			})
			const appId = await resolveRokuAppId({
				roku: input.roku,
				deviceId: rokuDevice.deviceId,
				appId: startInput.appId,
				appName: startInput.appName,
			})
			const projector = await sendProjectorCommand('on')
			const hdmi = await input.globalCache.sendIr('hdmi-input-1')
			const sonosPlayerId = await resolveSonosPlayerId(startInput.sonosPlayerId)
			const sonosInput = await input.sonos.selectTvInput(sonosPlayerId)
			let rokuResult: unknown
			if (appId) {
				rokuResult = await input.roku.launchApp(rokuDevice.deviceId, appId)
			} else {
				rokuResult = await input.roku.pressKey(rokuDevice.deviceId, 'Home')
			}
			return {
				rokuDeviceId: rokuDevice.deviceId,
				rokuName: rokuDevice.name,
				appId,
				sonosPlayerId: sonosPlayerId ?? null,
				sonosInput: 'tv' as const,
				sonosInputUri: sonosInput.uri,
				projector,
				hdmi,
				roku: rokuResult,
				notes:
					'Projector uses PJLink when reachable, otherwise iTach IR2. Lamp may take 15-30s. HDMI 1 is the Roku. Sport Court Sonos is on the HDMI/TV (spdif) input. Do not bypass the HDMI switch or court audio is lost. After full projector off, LAN/PJLink are dark until IR (or network standby) brings it back.',
			}
		},
		async setHdmiInput(hdmiInput: CourtHdmiInput) {
			const commandId = hdmiInputCommandId(hdmiInput)
			const command = getGlobalCacheIrCommand(commandId)
			const result = await input.globalCache.sendIr(commandId)
			return {
				...result,
				reliability: command.reliability,
				notes: command.notes,
			}
		},
		async projectorOn() {
			return await sendProjectorCommand('on')
		},
		async projectorStandby() {
			return await sendProjectorCommand('standby')
		},
		async setRotosphere(action: CourtRotosphereAction) {
			const commandId = rotosphereCommandId(action)
			const command = getGlobalCacheIrCommand(commandId)
			const result = await input.globalCache.sendIr(commandId)
			return {
				...result,
				reliability: command.reliability,
				notes: command.notes,
			}
		},
		async startBluray(startInput: { sonosPlayerId?: string } = {}) {
			const projector = await sendProjectorCommand('on')
			const hdmi = await input.globalCache.sendIr('hdmi-input-2')
			const sonosPlayerId = await resolveSonosPlayerId(startInput.sonosPlayerId)
			const sonosInput = await input.sonos.selectTvInput(sonosPlayerId)
			const bluray = input.bluray
				? await input.bluray.powerOn()
				: {
						connected: false,
						reason:
							'Court Blu-ray adapter is not wired. HDMI 2 is selected anyway.',
					}
			return {
				sonosPlayerId: sonosPlayerId ?? null,
				sonosInput: 'tv' as const,
				sonosInputUri: sonosInput.uri,
				projector,
				hdmi,
				bluray,
				notes:
					'Projector uses PJLink when reachable, otherwise iTach IR2. HDMI 2 is the Blu-ray (Blustream HEX150CS-TX). Sport Court Sonos stays on HDMI/TV. The Sony player is often unplugged — bluray_status / power tools return connected:false instead of throwing. 192.168.0.115 is the Sony camera, not this player.',
			}
		},
		async shutdown(inputArgs: { rotosphereBlackOut?: boolean } = {}) {
			const projector = await sendProjectorCommand('standby')
			const rotosphere = inputArgs.rotosphereBlackOut
				? await input.globalCache.sendIr('rotosphere-black-out')
				: null
			return {
				projector,
				rotosphere,
				notes:
					'Projector standby prefers PJLink %1POWR 0 and falls back to iTach IR2 when PJLink is unreachable. HDMI switch power/auto were never learned and are not sent. Rotosphere Black Out is optional and uses the Flipper codeset. Court Roku ECP has no reliable hard-off.',
			}
		},
	}
}
