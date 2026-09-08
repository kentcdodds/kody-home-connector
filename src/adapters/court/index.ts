import { type HomeConnectorConfig } from '../../config.ts'
import { type HomeConnectorState } from '../../state.ts'
import { type createGlobalCacheAdapter } from '../global-cache/index.ts'
import { getGlobalCacheIrCommand } from '../global-cache/codes.ts'
import { type createRokuAdapter } from '../roku/index.ts'
import { type createSonosAdapter } from '../sonos/index.ts'
import { type RokuDeviceRecord } from '../roku/types.ts'

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

export function createCourtAdapter(input: {
	config: HomeConnectorConfig
	state: HomeConnectorState
	globalCache: ReturnType<typeof createGlobalCacheAdapter>
	roku: ReturnType<typeof createRokuAdapter>
	sonos: ReturnType<typeof createSonosAdapter>
}) {
	function resolveSonosPlayerId(sonosPlayerId?: string) {
		const requested =
			sonosPlayerId?.trim() || input.config.courtSonosPlayerId?.trim() || ''
		if (requested) return requested
		const players = input.sonos.getStatus().allPlayers
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

	return {
		getStatus() {
			const rokuDevice = input.state.devices.find(
				(device) => device.adopted && matchesCourtName(device.name, /court/i),
			)
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
			const projector = await input.globalCache.sendIr('projector-on')
			const hdmi = await input.globalCache.sendIr('hdmi-input-1')
			const sonosPlayerId = resolveSonosPlayerId(startInput.sonosPlayerId)
			await input.sonos.selectAudioInput(sonosPlayerId)
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
				projector,
				hdmi,
				roku: rokuResult,
				notes:
					'Projector lamp may take 15-30s. HDMI 1 is the Roku. Sport Court Sonos is on the HDMI/TV (spdif) input. Do not bypass the HDMI switch or court audio is lost.',
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
			return await input.globalCache.sendIr('projector-on')
		},
		async projectorStandby() {
			return await input.globalCache.sendIr('projector-standby')
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
		async shutdown(inputArgs: { rotosphereBlackOut?: boolean } = {}) {
			const projector = await input.globalCache.sendIr('projector-standby')
			const rotosphere = inputArgs.rotosphereBlackOut
				? await input.globalCache.sendIr('rotosphere-black-out')
				: null
			return {
				projector,
				rotosphere,
				notes:
					'Projector standby is IR2. HDMI switch power/auto were never learned and are not sent. Rotosphere Black Out is optional and uses the Flipper codeset.',
			}
		},
	}
}
