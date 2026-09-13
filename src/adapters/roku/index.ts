import {
	adoptRokuDevice,
	deleteRokuDevice,
	getAdoptedRokuDevices,
	getDiscoveredRokuDevices,
	listRokuDevices,
	mergePersistedAdoptedRokuDevices,
	persistRokuAdoption,
	syncRokuAdoptionFlags,
	upsertDiscoveredRokuDevices,
	ignoreRokuDevice,
	updateDiscoveredRokuDevices,
} from './devices/repository.ts'
import { discoverRokuDevicesWithDiagnostics } from './discovery/client.ts'
import {
	setRokuDevices,
	setRokuDiscoveryDiagnostics,
	type HomeConnectorState,
} from '../../state.ts'
import { type HomeConnectorConfig } from '../../config.ts'
import { type HomeConnectorStorage } from '../../storage/index.ts'
import {
	type RokuActiveAppResult,
	type RokuAppInfo,
	type RokuAppListResult,
	type RokuDeviceRecord,
	type RokuDiscoveredDevice,
} from './types.ts'

function createDeviceId(input: RokuDiscoveredDevice) {
	const base = input.serialNumber || input.location || input.id || input.name
	return `roku-${base.replaceAll(/[^a-zA-Z0-9]+/g, '-').toLowerCase()}`
}

export async function scanRokuDevices(
	state: HomeConnectorState,
	config: HomeConnectorConfig,
	storage?: HomeConnectorStorage,
) {
	const result = await discoverRokuDevicesWithDiagnostics({
		discoveryUrl: config.rokuDiscoveryUrl,
	})
	const now = new Date().toISOString()
	// Discovery `isAdopted` / mock `adopted` is NOT connector adoption.
	const normalized = result.devices.map((device) => ({
		...device,
		deviceId: createDeviceId(device),
		lastSeenAt: now,
		adopted: false,
		isAdopted: false,
	}))
	setRokuDiscoveryDiagnostics(state, result.diagnostics)

	if (!storage) {
		updateDiscoveredRokuDevices(state, normalized)
		return syncRokuAdoptionFlags(state.devices)
	}

	const persisted = await upsertDiscoveredRokuDevices(
		storage,
		config.homeConnectorId,
		normalized,
	)
	const merged = mergePersistedAdoptedRokuDevices({
		scanned: normalized.map((device) => {
			const known = persisted.find(
				(entry) => entry.deviceId === device.deviceId,
			)
			return {
				...device,
				adopted: Boolean(known?.adopted),
				isAdopted: Boolean(known?.adopted),
				controlEnabled: known?.controlEnabled ?? device.controlEnabled,
			}
		}),
		persisted,
	})
	setRokuDevices(state, merged)
	return merged
}

export function getRokuStatus(state: HomeConnectorState) {
	return {
		discovered: getDiscoveredRokuDevices(state),
		adopted: getAdoptedRokuDevices(state),
		diagnostics: state.rokuDiscoveryDiagnostics,
	}
}

export async function adoptRoku(
	state: HomeConnectorState,
	deviceId: string,
	storage?: HomeConnectorStorage,
	connectorId?: string,
) {
	const existing =
		state.devices.find((device) => device.deviceId === deviceId) ?? null
	if (!existing) {
		throw new Error(`Roku device "${deviceId}" was not found.`)
	}
	const toPersist = syncRokuAdoptionFlags([
		{ ...existing, adopted: true, isAdopted: true },
	])[0]!
	if (storage && connectorId) {
		const persisted = await persistRokuAdoption(storage, connectorId, toPersist)
		if (!persisted) {
			throw new Error(`Failed to persist Roku device "${deviceId}".`)
		}
		const adopted = adoptRokuDevice(state, deviceId)
		if (!adopted) {
			throw new Error(`Roku device "${deviceId}" was not found.`)
		}
		setRokuDevices(
			state,
			syncRokuAdoptionFlags(
				state.devices.map((device) =>
					device.deviceId === deviceId ? persisted : device,
				),
			),
		)
		return persisted
	}
	const adopted = adoptRokuDevice(state, deviceId)
	if (!adopted) {
		throw new Error(`Roku device "${deviceId}" was not found.`)
	}
	return adopted
}

export async function ignoreRoku(
	state: HomeConnectorState,
	deviceId: string,
	storage?: HomeConnectorStorage,
	connectorId?: string,
) {
	if (storage && connectorId) {
		await deleteRokuDevice(storage, connectorId, deviceId)
	}
	ignoreRokuDevice(state, deviceId)
}

function getDeviceOrThrow(state: HomeConnectorState, deviceId: string) {
	const device =
		state.devices.find((entry) => entry.deviceId === deviceId) ?? null
	if (!device) {
		throw new Error(`Roku device "${deviceId}" was not found.`)
	}
	return device
}

function buildDeviceControlUrl(device: RokuDeviceRecord, key: string) {
	return `${device.location.replace(/\/$/, '')}/keypress/${encodeURIComponent(key)}`
}

function buildDeviceLaunchUrl(
	device: RokuDeviceRecord,
	appId: string,
	params: Record<string, string>,
) {
	const launchUrl = new URL(
		`${device.location.replace(/\/$/, '')}/launch/${encodeURIComponent(appId)}`,
	)
	for (const [key, value] of Object.entries(params)) {
		launchUrl.searchParams.set(key, value)
	}
	return launchUrl.toString()
}

function parseRokuAppInfoXml(appXml: string): RokuAppInfo {
	const idMatch = appXml.match(/\bid="([^"]*)"/i)
	const typeMatch = appXml.match(/\btype="([^"]*)"/i)
	const versionMatch = appXml.match(/\bversion="([^"]*)"/i)
	const nameMatch = appXml.match(/>([^<]*)<\/app>/i)
	return {
		id: idMatch?.[1]?.trim() || '',
		name: nameMatch?.[1]?.trim() || '',
		type: typeMatch?.[1]?.trim() || '',
		version: versionMatch?.[1]?.trim() || '',
	}
}

function parseRokuAppListXml(xml: string): Array<RokuAppInfo> {
	const appMatches = xml.match(/<app\b[^>]*?(?:\/>|>[\s\S]*?<\/app>)/gi) ?? []
	return appMatches
		.map((appXml) => parseRokuAppInfoXml(appXml))
		.filter((app) => app.id && app.name)
}

function parseRokuActiveAppXml(xml: string): RokuAppInfo | null {
	const match = xml.match(/<app\b[^>]*?(?:\/>|>[\s\S]*?<\/app>)/i)
	if (!match) return null
	const app = parseRokuAppInfoXml(match[0])
	if (!app.id || !app.name) return null
	return app
}

async function sendRokuKeypress(input: {
	device: RokuDeviceRecord
	key: string
}) {
	const targetUrl = buildDeviceControlUrl(input.device, input.key)
	const response = await fetch(targetUrl, {
		method: 'POST',
	})
	if (!response.ok) {
		throw new Error(`Roku keypress failed with status ${response.status}.`)
	}
	const responseText = await response.text()
	return {
		ok: true,
		deviceId: input.device.deviceId,
		key: input.key,
		responseText,
	}
}

async function launchRokuApp(input: {
	device: RokuDeviceRecord
	appId: string
	params?: Record<string, string>
}) {
	const params = input.params ?? {}
	const targetUrl = buildDeviceLaunchUrl(input.device, input.appId, params)
	const response = await fetch(targetUrl, {
		method: 'POST',
	})
	if (!response.ok) {
		throw new Error(`Roku app launch failed with status ${response.status}.`)
	}
	const responseText = await response.text()
	return {
		ok: true,
		deviceId: input.device.deviceId,
		appId: input.appId,
		params,
		responseText,
	}
}

async function fetchRokuAppList(input: {
	device: RokuDeviceRecord
}): Promise<RokuAppListResult> {
	const targetUrl = `${input.device.location.replace(/\/$/, '')}/query/apps`
	const response = await fetch(targetUrl, {
		method: 'GET',
	})
	if (!response.ok) {
		throw new Error(`Roku app list failed with status ${response.status}.`)
	}
	const responseText = await response.text()
	const apps = parseRokuAppListXml(responseText)
	return {
		deviceId: input.device.deviceId,
		deviceName: input.device.name,
		apps,
		responseText,
	}
}

async function fetchRokuActiveApp(input: {
	device: RokuDeviceRecord
}): Promise<RokuActiveAppResult> {
	const targetUrl = `${input.device.location.replace(/\/$/, '')}/query/active-app`
	const response = await fetch(targetUrl, {
		method: 'GET',
	})
	if (!response.ok) {
		throw new Error(
			`Roku active app query failed with status ${response.status}.`,
		)
	}
	const responseText = await response.text()
	const app = parseRokuActiveAppXml(responseText)
	return {
		deviceId: input.device.deviceId,
		deviceName: input.device.name,
		app,
		responseText,
	}
}

export function createRokuAdapter(input: {
	state: HomeConnectorState
	config: HomeConnectorConfig
	storage?: HomeConnectorStorage
}) {
	let hydratePromise: Promise<Array<RokuDeviceRecord>> | null = null

	async function hydrate() {
		if (!input.storage) {
			return syncRokuAdoptionFlags(input.state.devices)
		}
		const devices = syncRokuAdoptionFlags(
			await listRokuDevices(input.storage, input.config.homeConnectorId),
		)
		setRokuDevices(input.state, devices)
		return devices
	}

	async function ensureHydrated() {
		if (!input.storage) return
		if (!hydratePromise) {
			hydratePromise = hydrate()
		}
		await hydratePromise
	}

	return {
		hydrate,
		ensureHydrated,
		async scan() {
			await ensureHydrated()
			return scanRokuDevices(input.state, input.config, input.storage)
		},
		async getStatus() {
			await ensureHydrated()
			const status = getRokuStatus(input.state)
			return {
				discovered: status.discovered,
				adopted: status.adopted,
				diagnostics: status.diagnostics,
				allDevices: [...status.adopted, ...status.discovered],
			}
		},
		async adoptDevice(deviceId: string) {
			await ensureHydrated()
			return adoptRoku(
				input.state,
				deviceId,
				input.storage,
				input.config.homeConnectorId,
			)
		},
		async ignoreDevice(deviceId: string) {
			await ensureHydrated()
			const device = getDeviceOrThrow(input.state, deviceId)
			await ignoreRoku(
				input.state,
				deviceId,
				input.storage,
				input.config.homeConnectorId,
			)
			return device
		},
		async pressKey(deviceId: string, key: string) {
			await ensureHydrated()
			const device = getDeviceOrThrow(input.state, deviceId)
			if (!device.adopted) {
				throw new Error(
					`Roku device "${deviceId}" must be adopted before control.`,
				)
			}
			return sendRokuKeypress({
				device,
				key,
			})
		},
		async launchApp(
			deviceId: string,
			appId: string,
			params?: Record<string, string>,
		) {
			await ensureHydrated()
			const device = getDeviceOrThrow(input.state, deviceId)
			if (!device.adopted) {
				throw new Error(
					`Roku device "${deviceId}" must be adopted before control.`,
				)
			}
			return launchRokuApp({
				device,
				appId,
				params,
			})
		},
		async listApps(deviceId: string) {
			await ensureHydrated()
			const device = getDeviceOrThrow(input.state, deviceId)
			if (!device.adopted) {
				throw new Error(
					`Roku device "${deviceId}" must be adopted before control.`,
				)
			}
			return fetchRokuAppList({ device })
		},
		async getActiveApp(deviceId: string) {
			await ensureHydrated()
			const device = getDeviceOrThrow(input.state, deviceId)
			if (!device.adopted) {
				throw new Error(
					`Roku device "${deviceId}" must be adopted before control.`,
				)
			}
			return fetchRokuActiveApp({ device })
		},
	}
}
