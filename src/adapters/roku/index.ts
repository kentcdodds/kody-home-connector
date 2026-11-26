import {
	adoptRokuDevice,
	deleteRokuDevice,
	getAdoptedRokuDevices,
	getDiscoveredRokuDevices,
	deleteUnadoptedRokuDevices,
	listRokuDevices,
	mergePersistedAdoptedRokuDevices,
	persistRokuAdoption,
	syncRokuAdoptionFlags,
	upsertDiscoveredRokuDevices,
	ignoreRokuDevice,
	updateAdoptedRokuDeviceLocation,
	updateDiscoveredRokuDevices,
} from './devices/repository.ts'
import {
	discoverRokuDevicesWithDiagnostics,
	isStableRokuDiscoveryId,
	parseRokuDeviceInfoXml,
} from './discovery/client.ts'
import {
	setRokuDevices,
	setRokuDiscoveryDiagnostics,
	type HomeConnectorState,
} from '../../state.ts'
import { type HomeConnectorConfig } from '../../config.ts'
import { type HomeConnectorStorage } from '../../storage/index.ts'
import {
	type RokuActiveAppResult,
	type RokuAddressHealed,
	type RokuAppInfo,
	type RokuAppListResult,
	type RokuDeviceRecord,
	type RokuDiscoveredDevice,
	type RokuMediaPlayerResult,
	type RokuPlayYouTubeResult,
} from './types.ts'
import { parseYouTubeVideoId, ROKU_YOUTUBE_APP_ID } from './youtube.ts'

// Location is only a last resort: a device that moves address must keep its id.
function createDeviceId(input: RokuDiscoveredDevice) {
	const base =
		input.serialNumber ||
		(isStableRokuDiscoveryId(input.id) ? input.id.trim() : null) ||
		input.location ||
		input.name
	const slug = base.replaceAll(/[^a-zA-Z0-9]+/g, '-').toLowerCase()
	return slug.startsWith('roku-') ? slug : `roku-${slug}`
}

function normalizeSerial(value: string | null | undefined) {
	return value?.trim().toLowerCase() || null
}

function sameRokuIdentity(a: RokuDiscoveredDevice, b: RokuDiscoveredDevice) {
	const serialA = normalizeSerial(a.serialNumber)
	const serialB = normalizeSerial(b.serialNumber)
	if (serialA && serialB) return serialA === serialB
	return isStableRokuDiscoveryId(a.id) && a.id.trim() === b.id.trim()
}

// Keeps existing deviceIds (adopted first) for rediscovered devices so ids
// derived by older rules, or from a since-changed location, stay valid.
function reuseKnownDeviceIds(
	scanned: Array<RokuDeviceRecord>,
	known: Array<RokuDeviceRecord>,
) {
	const candidates = [...known].sort(
		(a, b) => Number(b.adopted) - Number(a.adopted),
	)
	const claimed = new Set<string>()
	return scanned.map((device) => {
		const match = candidates.find(
			(entry) =>
				!claimed.has(entry.deviceId) &&
				(sameRokuIdentity(entry, device) || entry.deviceId === device.deviceId),
		)
		if (!match) return device
		claimed.add(match.deviceId)
		return { ...device, deviceId: match.deviceId }
	})
}

export async function scanRokuDevices(
	state: HomeConnectorState,
	config: HomeConnectorConfig,
	storage?: HomeConnectorStorage,
) {
	return (await runRokuScan(state, config, storage)).devices
}

// `devices` also carries persisted adopted Rokus that this scan did not see;
// `discoveredDeviceIds` is only what discovery actually returned.
async function runRokuScan(
	state: HomeConnectorState,
	config: HomeConnectorConfig,
	storage?: HomeConnectorStorage,
) {
	const result = await discoverRokuDevicesWithDiagnostics({
		discoveryUrl: config.rokuDiscoveryUrl,
	})
	const now = new Date().toISOString()
	// Discovery `isAdopted` / mock `adopted` is NOT connector adoption.
	const normalized = reuseKnownDeviceIds(
		result.devices.map((device) => ({
			...device,
			deviceId: createDeviceId(device),
			lastSeenAt: now,
			adopted: false,
			isAdopted: false,
		})),
		storage
			? await listRokuDevices(storage, config.homeConnectorId)
			: state.devices,
	)
	setRokuDiscoveryDiagnostics(state, result.diagnostics)

	const discoveredDeviceIds = new Set(
		normalized.map((device) => device.deviceId),
	)

	if (!storage) {
		updateDiscoveredRokuDevices(state, normalized)
		return {
			devices: syncRokuAdoptionFlags(state.devices),
			discoveredDeviceIds,
		}
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
	return { devices: merged, discoveredDeviceIds }
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

function getDeviceOrThrow(state: HomeConnectorState, deviceId: string) {
	const device =
		state.devices.find((entry) => entry.deviceId === deviceId) ?? null
	if (!device) {
		throw new Error(`Roku device "${deviceId}" was not found.`)
	}
	return device
}

function getAdoptedDeviceOrThrow(state: HomeConnectorState, deviceId: string) {
	const device = getDeviceOrThrow(state, deviceId)
	if (!device.adopted) {
		throw new Error(`Roku device "${deviceId}" must be adopted before control.`)
	}
	return device
}

export const ROKU_ECP_TIMEOUT_MS = 5_000

type RokuEcpRequest = {
	method: 'GET' | 'POST'
	path: string
	params?: Record<string, string>
}

function buildEcpUrl(location: string, request: RokuEcpRequest) {
	const url = new URL(`${location.replace(/\/$/, '')}${request.path}`)
	for (const [key, value] of Object.entries(request.params ?? {})) {
		url.searchParams.set(key, value)
	}
	return url.toString()
}

// fetch only throws for transport failures (refused, unreachable, timeout, DNS);
// HTTP non-2xx responses resolve normally and are never retried.
async function fetchEcp(
	location: string,
	request: RokuEcpRequest,
	timeoutMs: number,
) {
	return fetch(buildEcpUrl(location, request), {
		method: request.method,
		signal: AbortSignal.timeout(timeoutMs),
	})
}

function describeError(error: unknown) {
	if (!(error instanceof Error)) return String(error)
	const cause = error.cause
	const causeCode =
		cause && typeof cause === 'object' && 'code' in cause
			? String((cause as { code: unknown }).code)
			: null
	return causeCode ? `${error.message} (${causeCode})` : error.message
}

function findRediscoveredDevice(
	target: RokuDeviceRecord,
	devices: Array<RokuDeviceRecord>,
) {
	const serial = normalizeSerial(target.serialNumber)
	if (serial) {
		const bySerial = devices.find(
			(device) => normalizeSerial(device.serialNumber) === serial,
		)
		if (bySerial) return bySerial
	}
	return devices.find((device) => sameRokuIdentity(target, device)) ?? null
}

function normalizeText(value: string) {
	return value.trim().toLowerCase()
}

// Same trust bar as adoption: the address must report the adopted identity.
function describeIdentityMismatch(
	target: RokuDeviceRecord,
	info: ReturnType<typeof parseRokuDeviceInfoXml>,
) {
	const serial = normalizeSerial(target.serialNumber)
	if (serial) {
		return normalizeSerial(info.serialNumber) === serial
			? null
			: `reports serial ${info.serialNumber ?? '(none)'}, not ${target.serialNumber}`
	}
	const mismatches: Array<string> = []
	if (
		target.modelName &&
		info.modelName &&
		normalizeText(target.modelName) !== normalizeText(info.modelName)
	) {
		mismatches.push(`model ${info.modelName}, not ${target.modelName}`)
	}
	// Serial-less records often fall back to the discovery id as their name.
	if (
		target.name !== target.id &&
		info.name &&
		normalizeText(target.name) !== normalizeText(info.name)
	) {
		mismatches.push(`name ${info.name}, not ${target.name}`)
	}
	return mismatches.length > 0 ? `reports ${mismatches.join(' and ')}` : null
}

function readXmlTagText(xml: string, tagName: string) {
	const match = xml.match(
		new RegExp(`<${tagName}\\b[^>]*>([^<]*)</${tagName}>`, 'i'),
	)
	return match?.[1]?.trim() || null
}

function readXmlAttribute(tagXml: string, attribute: string) {
	const match = tagXml.match(new RegExp(`\\b${attribute}="([^"]*)"`, 'i'))
	return match?.[1]?.trim() ?? null
}

function parseMilliseconds(value: string | null) {
	if (!value) return null
	const match = value.match(/-?\d+(?:\.\d+)?/)
	if (!match) return null
	const parsed = Number(match[0])
	return Number.isFinite(parsed) ? Math.round(parsed) : null
}

function parseBoolean(value: string | null) {
	if (value == null) return null
	const normalized = value.trim().toLowerCase()
	if (normalized === 'true') return true
	if (normalized === 'false') return false
	return null
}

export function parseRokuMediaPlayerXml(xml: string) {
	const playerTag = xml.match(/<player\b[^>]*>/i)?.[0] ?? null
	const pluginTag = xml.match(/<plugin\b[^>]*>/i)?.[0] ?? null
	const pluginId = pluginTag ? readXmlAttribute(pluginTag, 'id') : null
	return {
		state: playerTag ? readXmlAttribute(playerTag, 'state') || null : null,
		error: playerTag
			? parseBoolean(readXmlAttribute(playerTag, 'error'))
			: null,
		plugin:
			pluginTag && pluginId
				? { id: pluginId, name: readXmlAttribute(pluginTag, 'name') ?? '' }
				: null,
		positionMs: parseMilliseconds(readXmlTagText(xml, 'position')),
		durationMs: parseMilliseconds(readXmlTagText(xml, 'duration')),
		isLive: parseBoolean(readXmlTagText(xml, 'is_live')),
	}
}

const loadedPlayerStates = new Set(['play', 'buffer', 'open', 'pause'])

export function createRokuAdapter(input: {
	state: HomeConnectorState
	config: HomeConnectorConfig
	storage?: HomeConnectorStorage
	ecpTimeoutMs?: number
	delay?: (ms: number) => Promise<void>
	now?: () => number
	youTubeVerifyTimeoutMs?: number
	youTubeVerifyIntervalMs?: number
}) {
	let hydratePromise: Promise<Array<RokuDeviceRecord>> | null = null
	const ecpTimeoutMs = input.ecpTimeoutMs ?? ROKU_ECP_TIMEOUT_MS
	const delay =
		input.delay ??
		((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
	const now = input.now ?? (() => Date.now())

	function remainingMs(deadline: number | undefined) {
		return deadline == null ? Infinity : deadline - now()
	}

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

	function isAdoptedNow(deviceId: string) {
		return (
			input.state.devices.find((device) => device.deviceId === deviceId)
				?.adopted === true
		)
	}

	async function verifyRediscoveredIdentity(
		target: RokuDeviceRecord,
		location: string,
		deadline: number | undefined,
	) {
		const prefix = `Rediscovery reported Roku device "${target.name}" (${target.deviceId}) at ${location}`
		let info: ReturnType<typeof parseRokuDeviceInfoXml>
		try {
			const remaining = remainingMs(deadline)
			if (remaining <= 0) throw new Error('the time budget ran out')
			const response = await fetchEcp(
				location,
				{ method: 'GET', path: '/query/device-info' },
				Math.min(ecpTimeoutMs, remaining),
			)
			if (!response.ok) throw new Error(`status ${response.status}`)
			info = parseRokuDeviceInfoXml(await response.text())
		} catch (error) {
			throw new Error(
				`${prefix}, but /query/device-info there failed (${describeError(error)}), so its identity could not be confirmed. The stored address was not changed and the command was not sent there.`,
			)
		}
		const mismatch = describeIdentityMismatch(target, info)
		if (mismatch) {
			throw new Error(
				`${prefix}, but /query/device-info there ${mismatch}. The stored address was not changed and the command was not sent there.`,
			)
		}
	}

	// Only moves an already-adopted device; never creates or re-adopts a row.
	async function storeHealedLocation(
		target: RokuDeviceRecord,
		location: string,
	) {
		const notAdopted = () =>
			new Error(
				`Roku device "${target.name}" (${target.deviceId}) was rediscovered at ${location}, but it is no longer adopted (it was ignored or removed during rediscovery), so the stored address was not changed and the command was not retried.`,
			)
		if (!isAdoptedNow(target.deviceId)) throw notAdopted()
		const lastSeenAt = new Date().toISOString()
		if (input.storage) {
			const stored = await updateAdoptedRokuDeviceLocation(
				input.storage,
				input.config.homeConnectorId,
				target.deviceId,
				{ location, lastSeenAt },
			)
			if (!stored || !isAdoptedNow(target.deviceId)) throw notAdopted()
			const duplicates = (
				await listRokuDevices(input.storage, input.config.homeConnectorId)
			).filter(
				(device) =>
					device.deviceId !== target.deviceId &&
					!device.adopted &&
					sameRokuIdentity(device, target),
			)
			await deleteUnadoptedRokuDevices(
				input.storage,
				input.config.homeConnectorId,
				duplicates.map((device) => device.deviceId),
			)
			if (!isAdoptedNow(target.deviceId)) throw notAdopted()
		}
		let healed: RokuDeviceRecord | null = null
		setRokuDevices(
			input.state,
			syncRokuAdoptionFlags(
				input.state.devices
					.filter(
						(device) =>
							device.deviceId === target.deviceId ||
							device.adopted ||
							!sameRokuIdentity(device, target),
					)
					.map((device) => {
						if (device.deviceId !== target.deviceId) return device
						healed = { ...device, location, lastSeenAt }
						return healed
					}),
			),
		)
		if (!healed) throw notAdopted()
		return healed as RokuDeviceRecord
	}

	// Discovery only: unlike runRokuScan this never prunes or adds inventory.
	async function rediscoverDevice(
		target: RokuDeviceRecord,
		failure: unknown,
		deadline: number | undefined,
	) {
		const prefix = `Roku device "${target.name}" (${target.deviceId}) did not respond at its stored address ${target.location} (${describeError(failure)}). Rediscovery was attempted`
		let discovered: Array<RokuDeviceRecord>
		try {
			const remaining = remainingMs(deadline)
			const result = await discoverRokuDevicesWithDiagnostics({
				discoveryUrl: input.config.rokuDiscoveryUrl,
				signal: Number.isFinite(remaining)
					? AbortSignal.timeout(Math.max(1, remaining))
					: undefined,
			})
			setRokuDiscoveryDiagnostics(input.state, result.diagnostics)
			discovered = result.devices
				.filter((device) => device.location)
				.map((device) => ({
					...device,
					deviceId: createDeviceId(device),
					adopted: false,
					isAdopted: false,
				}))
		} catch (error) {
			throw new Error(`${prefix} but the scan failed: ${describeError(error)}`)
		}
		const found = findRediscoveredDevice(target, discovered)
		if (!found) {
			const seen = discovered.map(
				(device) => `${device.name} (${device.deviceId}) at ${device.location}`,
			)
			throw new Error(
				`${prefix} and found ${seen.length === 0 ? 'no Roku devices' : seen.join(', ')}, but not this device. Check that it is powered on and on the network.`,
			)
		}
		if (found.location === target.location) {
			throw new Error(
				`${prefix} and found it at the same address, so it is reachable on the network but did not answer ECP. Try again shortly.`,
			)
		}
		return found
	}

	async function requestEcp(
		target: RokuDeviceRecord,
		request: RokuEcpRequest,
		deadline?: number,
	) {
		const label = `Roku device "${target.name}" (${target.deviceId})`
		const budget = remainingMs(deadline)
		if (budget <= 0) {
			throw new Error(
				`${label}: ${request.method} ${request.path} was not sent because the time budget ran out.`,
			)
		}
		try {
			const response = await fetchEcp(
				target.location,
				request,
				Math.min(ecpTimeoutMs, budget),
			)
			return { response, device: target, addressHealed: null }
		} catch (failure) {
			if (remainingMs(deadline) <= 0) {
				throw new Error(
					`${label} did not answer ${request.method} ${request.path} at ${target.location} before the time budget ran out (${describeError(failure)}). Rediscovery was skipped.`,
				)
			}
			const rediscovered = await rediscoverDevice(target, failure, deadline)
			await verifyRediscoveredIdentity(target, rediscovered.location, deadline)
			const healed = await storeHealedLocation(target, rediscovered.location)
			const addressHealed: RokuAddressHealed = {
				from: target.location,
				to: healed.location,
			}
			try {
				const retryBudget = remainingMs(deadline)
				if (retryBudget <= 0) throw new Error('the time budget ran out')
				const response = await fetchEcp(
					healed.location,
					request,
					Math.min(ecpTimeoutMs, retryBudget),
				)
				return { response, device: healed, addressHealed }
			} catch (retryFailure) {
				throw new Error(
					`${label} did not respond at its stored address ${target.location} (${describeError(failure)}). Rediscovery found it at ${healed.location} and the stored address was updated, but the retry also failed: ${describeError(retryFailure)}`,
				)
			}
		}
	}

	function healedField(addressHealed: RokuAddressHealed | null) {
		return addressHealed ? { addressHealed } : {}
	}

	async function pressKey(device: RokuDeviceRecord, key: string) {
		const result = await requestEcp(device, {
			method: 'POST',
			path: `/keypress/${encodeURIComponent(key)}`,
		})
		if (!result.response.ok) {
			throw new Error(
				`Roku keypress failed with status ${result.response.status}.`,
			)
		}
		return {
			ok: true,
			deviceId: device.deviceId,
			key,
			responseText: await result.response.text(),
			...healedField(result.addressHealed),
		}
	}

	async function launchApp(
		device: RokuDeviceRecord,
		appId: string,
		params: Record<string, string>,
	) {
		const result = await requestEcp(device, {
			method: 'POST',
			path: `/launch/${encodeURIComponent(appId)}`,
			params,
		})
		if (!result.response.ok) {
			throw new Error(
				`Roku app launch failed with status ${result.response.status}.`,
			)
		}
		return {
			ok: true,
			deviceId: device.deviceId,
			appId,
			params,
			responseText: await result.response.text(),
			...healedField(result.addressHealed),
		}
	}

	async function fetchAppList(
		device: RokuDeviceRecord,
	): Promise<RokuAppListResult> {
		const result = await requestEcp(device, {
			method: 'GET',
			path: '/query/apps',
		})
		if (!result.response.ok) {
			throw new Error(
				`Roku app list failed with status ${result.response.status}.`,
			)
		}
		const responseText = await result.response.text()
		return {
			deviceId: device.deviceId,
			deviceName: device.name,
			apps: parseRokuAppListXml(responseText),
			responseText,
			...healedField(result.addressHealed),
		}
	}

	async function fetchActiveApp(
		device: RokuDeviceRecord,
		deadline?: number,
	): Promise<RokuActiveAppResult> {
		const result = await requestEcp(
			device,
			{ method: 'GET', path: '/query/active-app' },
			deadline,
		)
		if (!result.response.ok) {
			throw new Error(
				`Roku active app query failed with status ${result.response.status}.`,
			)
		}
		const responseText = await result.response.text()
		return {
			deviceId: device.deviceId,
			deviceName: device.name,
			app: parseRokuActiveAppXml(responseText),
			responseText,
			...healedField(result.addressHealed),
		}
	}

	async function fetchMediaPlayerXml(
		device: RokuDeviceRecord,
		deadline?: number,
	) {
		const result = await requestEcp(
			device,
			{ method: 'GET', path: '/query/media-player' },
			deadline,
		)
		if (!result.response.ok) {
			throw new Error(
				`Roku media player query failed with status ${result.response.status}.`,
			)
		}
		return {
			responseText: await result.response.text(),
			addressHealed: result.addressHealed,
		}
	}

	async function getMediaPlayer(
		deviceId: string,
		deadline?: number,
	): Promise<RokuMediaPlayerResult> {
		const device = getAdoptedDeviceOrThrow(input.state, deviceId)
		let addressHealed: RokuAddressHealed | null = null
		let mediaPlayer: Awaited<ReturnType<typeof fetchMediaPlayerXml>> | null =
			null
		let mediaPlayerError: string | null = null
		try {
			mediaPlayer = await fetchMediaPlayerXml(device, deadline)
			addressHealed = mediaPlayer.addressHealed
		} catch (error) {
			mediaPlayerError = describeError(error)
		}
		// Re-read so a heal from the first request is used by the second.
		const current = getAdoptedDeviceOrThrow(input.state, deviceId)
		let activeApp: RokuActiveAppResult | null = null
		let activeAppError: string | null = null
		try {
			activeApp = await fetchActiveApp(current, deadline)
			addressHealed ??= activeApp.addressHealed ?? null
		} catch (error) {
			activeAppError = describeError(error)
		}
		if (!mediaPlayer && !activeApp) {
			throw new Error(
				`Roku media player query failed: ${mediaPlayerError}. Active app query failed: ${activeAppError}.`,
			)
		}
		const parsed = mediaPlayer
			? parseRokuMediaPlayerXml(mediaPlayer.responseText)
			: null
		return {
			deviceId: device.deviceId,
			deviceName: device.name,
			state: parsed?.state ?? null,
			error: parsed?.error ?? null,
			plugin: parsed?.plugin ?? null,
			positionMs: parsed?.positionMs ?? null,
			durationMs: parsed?.durationMs ?? null,
			isLive: parsed?.isLive ?? null,
			responseText: mediaPlayer?.responseText ?? '',
			mediaPlayerError,
			activeApp: activeApp?.app ?? null,
			activeAppError,
			...healedField(addressHealed),
		}
	}

	async function playYouTube(
		deviceId: string,
		options: { url: string; mediaType?: string; verify?: boolean },
	): Promise<RokuPlayYouTubeResult> {
		const videoId = parseYouTubeVideoId(options.url)
		const device = getAdoptedDeviceOrThrow(input.state, deviceId)
		const warnings: Array<string> = []
		let addressHealed: RokuAddressHealed | null = null

		try {
			const apps = await fetchAppList(device)
			addressHealed ??= apps.addressHealed ?? null
			if (!apps.apps.some((app) => app.id === ROKU_YOUTUBE_APP_ID)) {
				warnings.push(
					`YouTube (app id ${ROKU_YOUTUBE_APP_ID}) is not in this Roku's installed apps list; launching anyway.`,
				)
			}
		} catch (error) {
			warnings.push(
				`Could not verify YouTube is installed via /query/apps: ${describeError(error)}`,
			)
		}

		const mediaType = options.mediaType?.trim() || null
		const launch = await launchApp(
			getAdoptedDeviceOrThrow(input.state, deviceId),
			ROKU_YOUTUBE_APP_ID,
			{ contentId: videoId, ...(mediaType ? { mediaType } : {}) },
		)
		addressHealed ??= launch.addressHealed ?? null

		let playerState: string | null = null
		let activeApp: RokuAppInfo | null = null
		let youtubeActive = false
		if (options.verify ?? true) {
			const timeoutMs = input.youTubeVerifyTimeoutMs ?? 10_000
			const intervalMs = input.youTubeVerifyIntervalMs ?? 1_000
			const deadline = now() + timeoutMs
			let playerLoaded = false
			let lastError: string | null = null
			let pollComplete = false
			for (;;) {
				try {
					const status = await getMediaPlayer(deviceId, deadline)
					addressHealed ??= status.addressHealed ?? null
					if (!status.mediaPlayerError) playerState = status.state
					if (!status.activeAppError) activeApp = status.activeApp
					pollComplete = !status.mediaPlayerError && !status.activeAppError
					lastError = null
				} catch (error) {
					pollComplete = false
					lastError = describeError(error)
				}
				youtubeActive = activeApp?.id === ROKU_YOUTUBE_APP_ID
				playerLoaded =
					pollComplete &&
					youtubeActive &&
					playerState != null &&
					loadedPlayerStates.has(playerState)
				if (playerLoaded || now() + intervalMs >= deadline) break
				await delay(intervalMs)
			}
			if (lastError) {
				warnings.push(`Playback verification query failed: ${lastError}`)
			}
			warnings.push(
				playerLoaded
					? `YouTube is active with player state ${playerState}, but Roku did not expose a content id, so video ${videoId} could not be confirmed (a previous video may still be playing). Check the screen to confirm.`
					: `Playback was not confirmed within ${timeoutMs}ms (last player state: ${playerState ?? 'unknown'}, active app: ${activeApp ? `${activeApp.name} (${activeApp.id})` : 'unknown'}). YouTube may still be starting or showing an ad; check again with roku_get_media_player.`,
			)
		}

		return {
			launched: true,
			deviceId: device.deviceId,
			deviceName: device.name,
			videoId,
			appId: ROKU_YOUTUBE_APP_ID,
			mediaType,
			// ECP /query/media-player exposes no content id for YouTube, so a
			// specific video can never be confirmed from the Roku side.
			verified: false,
			youtubeActive,
			playerState,
			activeApp,
			warnings,
			...healedField(addressHealed),
		}
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
			return pressKey(getAdoptedDeviceOrThrow(input.state, deviceId), key)
		},
		async launchApp(
			deviceId: string,
			appId: string,
			params?: Record<string, string>,
		) {
			await ensureHydrated()
			return launchApp(
				getAdoptedDeviceOrThrow(input.state, deviceId),
				appId,
				params ?? {},
			)
		},
		async listApps(deviceId: string) {
			await ensureHydrated()
			return fetchAppList(getAdoptedDeviceOrThrow(input.state, deviceId))
		},
		async getActiveApp(deviceId: string) {
			await ensureHydrated()
			return fetchActiveApp(getAdoptedDeviceOrThrow(input.state, deviceId))
		},
		async getMediaPlayer(deviceId: string) {
			await ensureHydrated()
			return getMediaPlayer(deviceId)
		},
		async playYouTube(
			deviceId: string,
			options: { url: string; mediaType?: string; verify?: boolean },
		) {
			await ensureHydrated()
			return playYouTube(deviceId, options)
		},
	}
}
