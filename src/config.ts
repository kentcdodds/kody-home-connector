import { homedir, networkInterfaces } from 'node:os'
import path from 'node:path'
import {
	isValidRemoteConnectorName,
	normalizeRemoteConnectorInstanceId,
} from '@kody-bot/connector-kit/urls'
import {
	defaultAudiobookImportTimeoutMs,
	defaultAudiobookLibraryPath,
	defaultFfmpegPath,
} from './adapters/audiobook/types.ts'

export const defaultHomePublicBaseUrl = 'https://kody-home.doddsfamily.us'
export const defaultHomeLanListenHost = '192.168.1.234'
export const homeMcpPath = '/mcp'

export type HomeConnectorConfig = {
	/**
	 * Local persistence namespace for adopted devices and logs. Independent of
	 * the Kody MCP server display name (typically `home` at
	 * `/account/mcp-servers`). Keep an existing id so SQLite rows stay visible
	 * after the HTTP MCP cutover.
	 */
	homeConnectorId: string
	publicBaseUrl: string
	mcpPath: typeof homeMcpPath
	mcpUrl: string
	sharedSecret: string | null
	/**
	 * Access Networks / RUCKUS Unleashed discovery probes these CIDRs over HTTPS.
	 * When unset, the connector derives private `/24` networks from local IPv4
	 * interfaces. `ACCESS_NETWORKS_UNLEASHED_SCAN_CIDRS` can override the derived
	 * list.
	 */
	accessNetworksUnleashedScanCidrs: Array<string>
	accessNetworksUnleashedAllowInsecureTls: boolean
	accessNetworksUnleashedRequestTimeoutMs: number
	/**
	 * Kasa KLAP plug discovery probes UDP discovery ports and these CIDRs over
	 * HTTP. When unset, the connector derives private `/24` networks from local
	 * IPv4 interfaces. `KASA_SCAN_CIDRS` can override the derived list.
	 */
	kasaScanCidrs: Array<string>
	kasaRequestTimeoutMs: number
	kasaUsername: string | null
	kasaPassword: string | null
	/**
	 * Court iTach IP2IR. Defaults to the cage unit at 192.168.1.70:4998.
	 */
	globalCacheHost?: string
	globalCachePort?: number
	courtRokuDeviceId?: string | null
	courtSonosPlayerId?: string | null
	courtPjlinkProjectorId?: string | null
	/**
	 * Court Sony UHD Blu-ray IRCC host. Empty/unset is expected — the player is
	 * often unplugged. Never default this to 192.168.0.115 (Sony camera).
	 */
	courtBlurayHost: string | null
	courtBlurayMacAddress: string | null
	courtBlurayAuthCookie: string | null
	courtBlurayPsk: string | null
	/**
	 * Short IRCC probe/send timeout so a dark/unplugged player fails into
	 * `{ connected: false }` quickly. Default 1500ms.
	 */
	courtBlurayTimeoutMs: number
	/**
	 * Optional extra hosts to probe from `bluray_scan`. Default empty — do not
	 * auto-pick the Sony camera at 192.168.0.115.
	 */
	courtBlurayScanExtraHosts: Array<string>
	/**
	 * Optional `/32` (or explicit CIDR) list for `bluray_scan`. Default empty
	 * so status never sweeps 192.168.0.0/23.
	 */
	courtBlurayScanCidrs: Array<string>
	/**
	 * PJLink Class 1 discovery probes TCP 4352 across these CIDRs. When unset,
	 * the connector derives private `/24` networks from local IPv4 interfaces.
	 * `PJLINK_SCAN_CIDRS` can override the derived list.
	 */
	pjlinkScanCidrs: Array<string>
	/**
	 * Extra hosts always probed during PJLink scans. Defaults to the court
	 * Optoma at 192.168.0.128 because that subnet may not be on the NAS NIC.
	 */
	pjlinkScanExtraHosts: Array<string>
	pjlinkRequestTimeoutMs: number
	/**
	 * Court power tools use this shorter PJLink timeout so a dark LAN
	 * (typical after full Optoma off) fails fast into iTach IR2. Direct
	 * `pjlink_*` tools keep `pjlinkRequestTimeoutMs`.
	 */
	courtPjlinkTimeoutMs: number
	/**
	 * Optional env fallback for the Android companion token on `/phone/ws`.
	 * Prefer the encrypted token stored from `/phone/setup`. Never log the raw
	 * value.
	 */
	phoneDeviceToken: string | null
	islandRouterHost: string | null
	islandRouterPort: number
	islandRouterUsername: string | null
	islandRouterPrivateKeyPath: string | null
	islandRouterKnownHostsPath: string | null
	islandRouterHostFingerprint: string | null
	islandRouterCommandTimeoutMs: number
	islandRouterApiBaseUrl: string
	islandRouterApiRequestTimeoutMs: number
	islandRouterApiAllowInsecureTls: boolean
	rokuDiscoveryUrl: string
	samsungTvDiscoveryUrl: string
	lutronDiscoveryUrl: string
	sonosDiscoveryUrl: string
	bondDiscoveryUrl: string
	bondRequestPaceMs: number
	bondCircuitBreakerCooldownMs: number
	jellyfishDiscoveryUrl: string | null
	/**
	 * Venstar discovery uses direct HTTP probes to `/query/info` across these
	 * CIDRs. When unset, the connector derives private `/24` networks from local
	 * interfaces. `VENSTAR_SCAN_CIDRS` can override the derived list.
	 */
	venstarScanCidrs: Array<string>
	/**
	 * JellyFish discovery uses direct WebSocket probes to `ws://<host>:9000`
	 * across these CIDRs unless `JELLYFISH_DISCOVERY_URL` points to a JSON
	 * discovery feed.
	 */
	jellyfishScanCidrs: Array<string>
	/**
	 * Personal audiobook archive root. Docker mounts the NAS/Mac share here
	 * (default `/media/audiobooks`, matching mediarss). Host path on Kent's
	 * Synology is `/volume1/media/audio/audiobooks`.
	 */
	audiobookLibraryPath: string
	ffmpegPath: string
	audiobookImportTimeoutMs: number
	dataPath: string
	dbPath: string
	port: number
	mocksEnabled: boolean
}

function trimTrailingSlash(value: string) {
	let trimmed = value
	while (trimmed.endsWith('/')) {
		trimmed = trimmed.slice(0, -1)
	}
	return trimmed
}

const remoteConnectorNameRulesMessage =
	'lowercase letters, numbers, and dashes; start and end with a letter or number; max 64 characters'

function resolveHomeConnectorId(
	rawValue: string | null | undefined,
	fieldName = 'HOME_CONNECTOR_ID',
) {
	const homeConnectorId = normalizeRemoteConnectorInstanceId(
		rawValue ?? 'default',
	)
	if (!isValidRemoteConnectorName(homeConnectorId)) {
		throw new Error(
			`${fieldName} must match Kody remote connector name rules: ${remoteConnectorNameRulesMessage}.`,
		)
	}
	return homeConnectorId
}

function resolvePublicBaseUrl() {
	return trimTrailingSlash(
		process.env.HOME_MCP_PUBLIC_BASE_URL?.trim() || defaultHomePublicBaseUrl,
	)
}

function resolveMcpUrl(publicBaseUrl: string) {
	return `${publicBaseUrl}${homeMcpPath}`
}

function resolveHomeConnectorDataPath() {
	return (
		process.env.HOME_CONNECTOR_DATA_PATH?.trim() ||
		path.join(homedir(), '.kody', 'home-connector')
	)
}

function resolveHomeConnectorDbPath(dataPath: string) {
	return (
		process.env.HOME_CONNECTOR_DB_PATH?.trim() ||
		path.join(dataPath, 'home-connector.sqlite')
	)
}

function resolveScanCidrsFromEnv(envVar: string): Array<string> {
	const raw = process.env[envVar]?.trim()
	if (!raw) return []
	return raw
		.split(',')
		.map((entry) => entry.trim())
		.filter(Boolean)
}

function resolveNonNegativeIntegerFromEnv(envVar: string, fallback: number) {
	const raw = process.env[envVar]?.trim()
	if (!raw) return fallback
	const parsed = Number.parseInt(raw, 10)
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

function parseStrictIntegerEnv(value: string | undefined) {
	const trimmed = value?.trim()
	if (!trimmed) return null
	if (!/^\d+$/.test(trimmed)) return null
	const parsed = Number(trimmed)
	if (!Number.isInteger(parsed)) return null
	return parsed
}

function isPrivateRfc1918Ipv4(parts: Array<number>) {
	const [a, b] = parts
	return (
		a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
	)
}

function parseIpv4Parts(value: string) {
	const parts = value.split('.').map((octet) => Number.parseInt(octet, 10))
	if (
		parts.length !== 4 ||
		parts.some((octet) => !Number.isFinite(octet) || octet < 0 || octet > 255)
	) {
		return null
	}
	return parts
}

function ipv4PartsToInt(parts: Array<number>) {
	return (
		(((parts[0] ?? 0) << 24) |
			((parts[1] ?? 0) << 16) |
			((parts[2] ?? 0) << 8) |
			(parts[3] ?? 0)) >>>
		0
	)
}

function ipv4IntToCidr24(value: number) {
	const a = (value >>> 24) & 255
	const b = (value >>> 16) & 255
	const c = (value >>> 8) & 255
	return `${a}.${b}.${c}.0/24`
}

function derivePrivateAutoscanCidrsFromCidr(cidr: string): Array<string> {
	const match = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(cidr.trim())
	if (!match) return []
	const address = match[1] ?? ''
	const prefix = Number.parseInt(match[2] ?? '', 10)
	if (!Number.isFinite(prefix) || prefix < 0 || prefix > 32) return []
	const parts = parseIpv4Parts(address)
	if (!parts || !isPrivateRfc1918Ipv4(parts)) return []
	if (prefix === 32) return [`${address}/32`]
	if (prefix >= 24) return [`${parts[0]}.${parts[1]}.${parts[2]}.0/24`]

	const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
	const addressInt = ipv4PartsToInt(parts)
	const networkInt = addressInt & mask
	const broadcastInt = (networkInt | (~mask >>> 0)) >>> 0
	const firstCidr24 = networkInt & 0xffffff00
	const lastCidr24 = broadcastInt & 0xffffff00
	const derived: Array<string> = []
	for (let current = firstCidr24; current <= lastCidr24; current += 256) {
		derived.push(ipv4IntToCidr24(current))
	}
	if (derived.length > 16) {
		console.warn(
			`Skipping broad autoscan CIDR "${cidr}" because it expands to ${derived.length} /24 scan blocks. Set a smaller scan range explicitly.`,
		)
		return []
	}
	return derived
}

function isLikelyContainerBridgeInterface(name: string) {
	const normalized = name.toLowerCase()
	return (
		normalized === 'docker0' ||
		normalized.startsWith('br-') ||
		normalized.startsWith('veth') ||
		normalized.startsWith('virbr') ||
		normalized.startsWith('podman')
	)
}

export function derivePrivateAutoscanCidrsFromInterfaces(
	interfaces: ReturnType<typeof networkInterfaces>,
) {
	const cidrs = new Set<string>()
	for (const [name, entries] of Object.entries(interfaces)) {
		if (!entries) continue
		if (isLikelyContainerBridgeInterface(name)) continue
		for (const entry of entries) {
			if (entry.internal || entry.family !== 'IPv4') continue
			const cidr = entry.cidr
			if (!cidr) continue
			for (const derived of derivePrivateAutoscanCidrsFromCidr(cidr)) {
				cidrs.add(derived)
			}
		}
	}
	return [...cidrs]
}

export function deriveVenstarAutoscanCidrsFromInterfaces(
	interfaces: ReturnType<typeof networkInterfaces>,
) {
	return derivePrivateAutoscanCidrsFromInterfaces(interfaces)
}

export function deriveAccessNetworksUnleashedAutoscanCidrsFromInterfaces(
	interfaces: ReturnType<typeof networkInterfaces>,
) {
	return derivePrivateAutoscanCidrsFromInterfaces(interfaces)
}

export function derivePjlinkAutoscanCidrsFromInterfaces(
	interfaces: ReturnType<typeof networkInterfaces>,
) {
	return derivePrivateAutoscanCidrsFromInterfaces(interfaces)
}

export function deriveKasaAutoscanCidrsFromInterfaces(
	interfaces: ReturnType<typeof networkInterfaces>,
) {
	return derivePrivateAutoscanCidrsFromInterfaces(interfaces)
}

function deriveVenstarAutoscanCidrs() {
	return deriveVenstarAutoscanCidrsFromInterfaces(networkInterfaces())
}

function deriveAccessNetworksUnleashedAutoscanCidrs() {
	return deriveAccessNetworksUnleashedAutoscanCidrsFromInterfaces(
		networkInterfaces(),
	)
}

function deriveKasaAutoscanCidrs() {
	return deriveKasaAutoscanCidrsFromInterfaces(networkInterfaces())
}

function derivePjlinkAutoscanCidrs() {
	return derivePjlinkAutoscanCidrsFromInterfaces(networkInterfaces())
}

function deriveJellyfishAutoscanCidrs() {
	return derivePrivateAutoscanCidrsFromInterfaces(networkInterfaces())
}

export function loadHomeConnectorConfig(): HomeConnectorConfig {
	const port = Number.parseInt(process.env.PORT ?? '4040', 10)
	const islandRouterPort = parseStrictIntegerEnv(process.env.ISLAND_ROUTER_PORT)
	const islandRouterCommandTimeoutMs = Number.parseInt(
		process.env.ISLAND_ROUTER_COMMAND_TIMEOUT_MS ?? '8000',
		10,
	)
	const accessNetworksUnleashedRequestTimeoutMs = Number.parseInt(
		process.env.ACCESS_NETWORKS_UNLEASHED_REQUEST_TIMEOUT_MS ?? '8000',
		10,
	)
	const kasaRequestTimeoutMs = Number.parseInt(
		process.env.KASA_REQUEST_TIMEOUT_MS ?? '8000',
		10,
	)
	const pjlinkRequestTimeoutMs = Number.parseInt(
		process.env.PJLINK_REQUEST_TIMEOUT_MS ?? '5000',
		10,
	)
	const courtPjlinkTimeoutMs = Number.parseInt(
		process.env.COURT_PJLINK_TIMEOUT_MS ?? '1500',
		10,
	)
	const courtBlurayTimeoutMs = Number.parseInt(
		process.env.COURT_BLURAY_TIMEOUT_MS ?? '1500',
		10,
	)
	const islandRouterApiRequestTimeoutMs = Number.parseInt(
		process.env.ISLAND_ROUTER_API_REQUEST_TIMEOUT_MS ?? '8000',
		10,
	)
	const audiobookImportTimeoutMs = Number.parseInt(
		process.env.AUDIOBOOK_IMPORT_TIMEOUT_MS ??
			String(defaultAudiobookImportTimeoutMs),
		10,
	)
	const homeConnectorId = resolveHomeConnectorId(process.env.HOME_CONNECTOR_ID)
	const publicBaseUrl = resolvePublicBaseUrl()
	const mcpPath = homeMcpPath
	const mcpUrl = resolveMcpUrl(publicBaseUrl)
	// Encrypts secrets in local SQLite. Not used for Worker or MCP auth.
	const sharedSecret =
		process.env.HOME_CONNECTOR_DATA_KEY?.trim() ||
		process.env.HOME_CONNECTOR_SHARED_SECRET?.trim() ||
		null
	const mocksEnabled = process.env.MOCKS === 'true'
	const dataPath = resolveHomeConnectorDataPath()
	const explicitAccessNetworksUnleashedCidrs = resolveScanCidrsFromEnv(
		'ACCESS_NETWORKS_UNLEASHED_SCAN_CIDRS',
	)
	const accessNetworksUnleashedScanCidrs =
		explicitAccessNetworksUnleashedCidrs.length > 0
			? explicitAccessNetworksUnleashedCidrs
			: deriveAccessNetworksUnleashedAutoscanCidrs()
	const explicitKasaCidrs = resolveScanCidrsFromEnv('KASA_SCAN_CIDRS')
	const kasaScanCidrs =
		explicitKasaCidrs.length > 0 ? explicitKasaCidrs : deriveKasaAutoscanCidrs()
	const explicitPjlinkCidrs = resolveScanCidrsFromEnv('PJLINK_SCAN_CIDRS')
	const pjlinkScanCidrs =
		explicitPjlinkCidrs.length > 0
			? explicitPjlinkCidrs
			: derivePjlinkAutoscanCidrs()
	const explicitPjlinkExtraHosts = resolveScanCidrsFromEnv(
		'PJLINK_SCAN_EXTRA_HOSTS',
	)
	const pjlinkScanExtraHosts =
		process.env.PJLINK_SCAN_EXTRA_HOSTS?.trim() === ''
			? []
			: explicitPjlinkExtraHosts.length > 0
				? explicitPjlinkExtraHosts
				: ['192.168.0.128']
	const explicitVenstarCidrs = resolveScanCidrsFromEnv('VENSTAR_SCAN_CIDRS')
	const venstarScanCidrs =
		explicitVenstarCidrs.length > 0
			? explicitVenstarCidrs
			: deriveVenstarAutoscanCidrs()
	const explicitJellyfishCidrs = resolveScanCidrsFromEnv('JELLYFISH_SCAN_CIDRS')
	const jellyfishScanCidrs =
		explicitJellyfishCidrs.length > 0
			? explicitJellyfishCidrs
			: deriveJellyfishAutoscanCidrs()
	return {
		homeConnectorId,
		publicBaseUrl,
		mcpPath,
		mcpUrl,
		sharedSecret,
		accessNetworksUnleashedScanCidrs,
		accessNetworksUnleashedAllowInsecureTls:
			process.env.ACCESS_NETWORKS_UNLEASHED_ALLOW_INSECURE_TLS === 'true',
		accessNetworksUnleashedRequestTimeoutMs:
			Number.isFinite(accessNetworksUnleashedRequestTimeoutMs) &&
			accessNetworksUnleashedRequestTimeoutMs >= 1000
				? accessNetworksUnleashedRequestTimeoutMs
				: 8000,
		kasaScanCidrs,
		kasaRequestTimeoutMs:
			Number.isFinite(kasaRequestTimeoutMs) && kasaRequestTimeoutMs >= 1000
				? kasaRequestTimeoutMs
				: 8000,
		kasaUsername: process.env.KASA_USERNAME?.trim() || null,
		kasaPassword: process.env.KASA_PASSWORD?.trim() || null,
		globalCacheHost: process.env.GLOBAL_CACHE_HOST?.trim() || '192.168.1.70',
		globalCachePort:
			parseStrictIntegerEnv(process.env.GLOBAL_CACHE_PORT) ?? 4998,
		courtRokuDeviceId: process.env.COURT_ROKU_DEVICE_ID?.trim() || null,
		courtSonosPlayerId: process.env.COURT_SONOS_PLAYER_ID?.trim() || null,
		courtPjlinkProjectorId:
			process.env.COURT_PJLINK_PROJECTOR_ID?.trim() || null,
		courtBlurayHost: process.env.COURT_BLURAY_HOST?.trim() || null,
		courtBlurayMacAddress: process.env.COURT_BLURAY_MAC?.trim() || null,
		courtBlurayAuthCookie: process.env.COURT_BLURAY_AUTH_COOKIE?.trim() || null,
		courtBlurayPsk: process.env.COURT_BLURAY_PSK?.trim() || null,
		courtBlurayTimeoutMs:
			Number.isFinite(courtBlurayTimeoutMs) && courtBlurayTimeoutMs >= 250
				? courtBlurayTimeoutMs
				: 1500,
		courtBlurayScanExtraHosts: resolveScanCidrsFromEnv(
			'COURT_BLURAY_SCAN_EXTRA_HOSTS',
		),
		courtBlurayScanCidrs: resolveScanCidrsFromEnv('COURT_BLURAY_SCAN_CIDRS'),
		pjlinkScanCidrs,
		pjlinkScanExtraHosts,
		pjlinkRequestTimeoutMs:
			Number.isFinite(pjlinkRequestTimeoutMs) && pjlinkRequestTimeoutMs >= 1000
				? pjlinkRequestTimeoutMs
				: 5000,
		courtPjlinkTimeoutMs:
			Number.isFinite(courtPjlinkTimeoutMs) && courtPjlinkTimeoutMs >= 250
				? courtPjlinkTimeoutMs
				: 1500,
		phoneDeviceToken: process.env.PHONE_DEVICE_TOKEN?.trim() || null,
		islandRouterHost: process.env.ISLAND_ROUTER_HOST?.trim() || null,
		islandRouterPort:
			islandRouterPort != null &&
			islandRouterPort >= 1 &&
			islandRouterPort <= 65535
				? islandRouterPort
				: 22,
		islandRouterUsername: process.env.ISLAND_ROUTER_USERNAME?.trim() || null,
		islandRouterPrivateKeyPath:
			process.env.ISLAND_ROUTER_PRIVATE_KEY_PATH?.trim() || null,
		islandRouterKnownHostsPath:
			process.env.ISLAND_ROUTER_KNOWN_HOSTS_PATH?.trim() || null,
		islandRouterHostFingerprint:
			process.env.ISLAND_ROUTER_HOST_FINGERPRINT?.trim() || null,
		islandRouterCommandTimeoutMs:
			Number.isFinite(islandRouterCommandTimeoutMs) &&
			islandRouterCommandTimeoutMs >= 1000
				? islandRouterCommandTimeoutMs
				: 8000,
		islandRouterApiBaseUrl: trimTrailingSlash(
			process.env.ISLAND_ROUTER_API_BASE_URL?.trim() ||
				'https://my.islandrouter.com',
		),
		islandRouterApiRequestTimeoutMs:
			Number.isFinite(islandRouterApiRequestTimeoutMs) &&
			islandRouterApiRequestTimeoutMs >= 1000
				? islandRouterApiRequestTimeoutMs
				: 8000,
		islandRouterApiAllowInsecureTls:
			process.env.ISLAND_ROUTER_API_ALLOW_INSECURE_TLS === 'true',
		rokuDiscoveryUrl:
			process.env.ROKU_DISCOVERY_URL?.trim() || 'ssdp://239.255.255.250:1900',
		samsungTvDiscoveryUrl:
			process.env.SAMSUNG_TV_DISCOVERY_URL?.trim() ||
			'mdns://_samsungmsf._tcp.local',
		lutronDiscoveryUrl:
			process.env.LUTRON_DISCOVERY_URL?.trim() || 'mdns://_lutron._tcp.local',
		sonosDiscoveryUrl:
			process.env.SONOS_DISCOVERY_URL?.trim() ||
			'ssdp://239.255.255.250:1900?st=urn:schemas-upnp-org:device:ZonePlayer:1',
		bondDiscoveryUrl:
			process.env.BOND_DISCOVERY_URL?.trim() || 'mdns://_bond._tcp.local',
		bondRequestPaceMs: resolveNonNegativeIntegerFromEnv(
			'BOND_REQUEST_PACE_MS',
			500,
		),
		bondCircuitBreakerCooldownMs: resolveNonNegativeIntegerFromEnv(
			'BOND_CIRCUIT_BREAKER_COOLDOWN_MS',
			60_000,
		),
		jellyfishDiscoveryUrl: process.env.JELLYFISH_DISCOVERY_URL?.trim() || null,
		venstarScanCidrs,
		jellyfishScanCidrs,
		audiobookLibraryPath:
			process.env.AUDIOBOOK_LIBRARY_PATH?.trim() || defaultAudiobookLibraryPath,
		ffmpegPath: process.env.FFMPEG_PATH?.trim() || defaultFfmpegPath,
		audiobookImportTimeoutMs:
			Number.isFinite(audiobookImportTimeoutMs) &&
			audiobookImportTimeoutMs >= 5_000
				? audiobookImportTimeoutMs
				: defaultAudiobookImportTimeoutMs,
		dataPath,
		dbPath: resolveHomeConnectorDbPath(dataPath),
		port: Number.isFinite(port) ? port : 4040,
		mocksEnabled,
	}
}
