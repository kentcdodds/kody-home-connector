import { readFileSync } from 'node:fs'
import { homedir, networkInterfaces } from 'node:os'
import path from 'node:path'
import {
	connectorSessionUrl,
	connectorWebSocketUrl,
	isValidRemoteConnectorName,
	normalizeRemoteConnectorInstanceId,
	userScopedConnectorSessionUrl,
	userScopedConnectorWebSocketUrl,
} from '@kody-bot/connector-kit/urls'

/**
 * One outbound Worker WebSocket session target. Household deployments can dial
 * any number of independent Kody accounts from a single process.
 */
export type HomeConnectorWorkerTarget = {
	kodyUsername: string | null
	homeConnectorId: string
	sharedSecret: string | null
	workerBaseUrl: string
	workerSessionUrl: string
	workerWebSocketUrl: string
}

export type HomeConnectorConfig = {
	/**
	 * Primary / legacy connector id (first worker target). Kept for local
	 * persistence namespaces, logging, and single-session callers.
	 */
	homeConnectorId: string
	/**
	 * Primary / legacy Kody username (first worker target).
	 */
	kodyUsername: string | null
	workerBaseUrl: string
	workerSessionUrl: string
	workerWebSocketUrl: string
	sharedSecret: string | null
	/**
	 * All Worker connection targets for this process. Length is 1 for legacy
	 * single-target env configuration.
	 */
	workerTargets: Array<HomeConnectorWorkerTarget>
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

function resolveWorkerConnectorUrls(input: {
	workerBaseUrl: string
	homeConnectorId: string
	kodyUsername: string | null
}) {
	if (input.kodyUsername) {
		return {
			workerSessionUrl: userScopedConnectorSessionUrl({
				workerBaseUrl: input.workerBaseUrl,
				username: input.kodyUsername,
				instanceId: input.homeConnectorId,
			}),
			workerWebSocketUrl: userScopedConnectorWebSocketUrl({
				workerBaseUrl: input.workerBaseUrl,
				username: input.kodyUsername,
				instanceId: input.homeConnectorId,
			}),
		}
	}
	return {
		workerSessionUrl: connectorSessionUrl({
			workerBaseUrl: input.workerBaseUrl,
			instanceId: input.homeConnectorId,
		}),
		workerWebSocketUrl: connectorWebSocketUrl({
			workerBaseUrl: input.workerBaseUrl,
			instanceId: input.homeConnectorId,
		}),
	}
}

function isLocalWorkerBaseUrl(workerBaseUrl: string) {
	try {
		const { hostname } = new URL(trimTrailingSlash(workerBaseUrl))
		const normalizedHostname = hostname.toLowerCase()
		return (
			normalizedHostname === 'localhost' ||
			normalizedHostname.endsWith('.localhost') ||
			normalizedHostname === '127.0.0.1' ||
			normalizedHostname === '0.0.0.0' ||
			normalizedHostname === '[::1]'
		)
	} catch {
		return false
	}
}

function requireKodyUsernameForProductionWorker(input: {
	kodyUsername: string | null
	workerBaseUrl: string
	fieldName: string
}) {
	if (input.kodyUsername) return input.kodyUsername
	if (
		process.env.NODE_ENV === 'production' &&
		!isLocalWorkerBaseUrl(input.workerBaseUrl)
	) {
		throw new Error(
			`${input.fieldName} is required when connecting the home connector to a production Kody Worker.`,
		)
	}
	return null
}

function resolveLegacyKodyUsername(workerBaseUrl: string) {
	return requireKodyUsernameForProductionWorker({
		kodyUsername: process.env.KODY_USERNAME?.trim() || null,
		workerBaseUrl,
		fieldName: 'KODY_USERNAME',
	})
}

function readOptionalStringField(
	record: Record<string, unknown>,
	keys: Array<string>,
) {
	for (const key of keys) {
		const value = record[key]
		if (typeof value === 'string') {
			const trimmed = value.trim()
			if (trimmed) return trimmed
		}
	}
	return null
}

function parseWorkerTargetsJson(raw: string, sourceLabel: string) {
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error)
		throw new Error(
			`${sourceLabel} must be valid JSON (${detail}). Expected an array of worker targets.`,
		)
	}
	if (!Array.isArray(parsed)) {
		throw new Error(
			`${sourceLabel} must be a JSON array of worker targets. Received ${typeof parsed}.`,
		)
	}
	return parsed
}

function resolveWorkerTargetFromRecord(input: {
	record: Record<string, unknown>
	index: number
	defaultWorkerBaseUrl: string
	sourceLabel: string
}): HomeConnectorWorkerTarget {
	const label = `${input.sourceLabel}[${input.index}]`
	const workerBaseUrl =
		readOptionalStringField(input.record, [
			'workerBaseUrl',
			'WORKER_BASE_URL',
		]) || input.defaultWorkerBaseUrl
	const homeConnectorId = resolveHomeConnectorId(
		readOptionalStringField(input.record, [
			'connectorId',
			'homeConnectorId',
			'HOME_CONNECTOR_ID',
		]),
		`${label}.connectorId`,
	)
	const kodyUsername = requireKodyUsernameForProductionWorker({
		kodyUsername: readOptionalStringField(input.record, [
			'kodyUsername',
			'KODY_USERNAME',
		]),
		workerBaseUrl,
		fieldName: `${label}.kodyUsername`,
	})
	const sharedSecret = readOptionalStringField(input.record, [
		'sharedSecret',
		'HOME_CONNECTOR_SHARED_SECRET',
	])
	const { workerSessionUrl, workerWebSocketUrl } = resolveWorkerConnectorUrls({
		workerBaseUrl,
		homeConnectorId,
		kodyUsername,
	})
	return {
		kodyUsername,
		homeConnectorId,
		sharedSecret,
		workerBaseUrl,
		workerSessionUrl,
		workerWebSocketUrl,
	}
}

function resolveConfiguredWorkerTargets(defaultWorkerBaseUrl: string) {
	const targetsJson = process.env.HOME_CONNECTOR_TARGETS?.trim()
	const targetsFile = process.env.HOME_CONNECTOR_TARGETS_FILE?.trim()
	if (targetsJson && targetsFile) {
		throw new Error(
			'Set only one of HOME_CONNECTOR_TARGETS or HOME_CONNECTOR_TARGETS_FILE, not both.',
		)
	}
	if (!targetsJson && !targetsFile) {
		return null
	}

	const sourceLabel = targetsJson
		? 'HOME_CONNECTOR_TARGETS'
		: 'HOME_CONNECTOR_TARGETS_FILE'
	let raw = targetsJson ?? ''
	if (targetsFile) {
		try {
			raw = readFileSync(targetsFile, 'utf8')
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error)
			throw new Error(
				`Failed to read HOME_CONNECTOR_TARGETS_FILE (${targetsFile}): ${detail}`,
			)
		}
	}

	const parsed = parseWorkerTargetsJson(raw, sourceLabel)
	if (parsed.length === 0) {
		throw new Error(
			`${sourceLabel} must include at least one worker target. For a single account, omit multi-target config and use KODY_USERNAME + HOME_CONNECTOR_SHARED_SECRET instead.`,
		)
	}

	return parsed.map((entry, index) => {
		if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) {
			throw new Error(
				`${sourceLabel}[${index}] must be a JSON object with kodyUsername, sharedSecret, and optional connectorId / workerBaseUrl.`,
			)
		}
		return resolveWorkerTargetFromRecord({
			record: entry as Record<string, unknown>,
			index,
			defaultWorkerBaseUrl,
			sourceLabel,
		})
	})
}

function resolveLegacyWorkerTarget(defaultWorkerBaseUrl: string) {
	const homeConnectorId = resolveHomeConnectorId(process.env.HOME_CONNECTOR_ID)
	const kodyUsername = resolveLegacyKodyUsername(defaultWorkerBaseUrl)
	const { workerSessionUrl, workerWebSocketUrl } = resolveWorkerConnectorUrls({
		workerBaseUrl: defaultWorkerBaseUrl,
		homeConnectorId,
		kodyUsername,
	})
	return {
		kodyUsername,
		homeConnectorId,
		sharedSecret: process.env.HOME_CONNECTOR_SHARED_SECRET?.trim() || null,
		workerBaseUrl: defaultWorkerBaseUrl,
		workerSessionUrl,
		workerWebSocketUrl,
	} satisfies HomeConnectorWorkerTarget
}

function resolveWorkerTargets(): Array<HomeConnectorWorkerTarget> {
	const defaultWorkerBaseUrl =
		process.env.WORKER_BASE_URL?.trim() || 'http://localhost:3742'
	const configuredTargets = resolveConfiguredWorkerTargets(defaultWorkerBaseUrl)
	if (configuredTargets) {
		return configuredTargets
	}
	return [resolveLegacyWorkerTarget(defaultWorkerBaseUrl)]
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
	const islandRouterApiRequestTimeoutMs = Number.parseInt(
		process.env.ISLAND_ROUTER_API_REQUEST_TIMEOUT_MS ?? '8000',
		10,
	)
	const workerTargets = resolveWorkerTargets()
	const primaryTarget = workerTargets[0]
	if (!primaryTarget) {
		throw new Error(
			'Home connector requires at least one Worker target. Configure HOME_CONNECTOR_TARGETS / HOME_CONNECTOR_TARGETS_FILE, or the legacy KODY_USERNAME + HOME_CONNECTOR_SHARED_SECRET env vars.',
		)
	}
	const homeConnectorId = primaryTarget.homeConnectorId
	const kodyUsername = primaryTarget.kodyUsername
	const workerBaseUrl = primaryTarget.workerBaseUrl
	const workerSessionUrl = primaryTarget.workerSessionUrl
	const workerWebSocketUrl = primaryTarget.workerWebSocketUrl
	// Local SQLite secret encryption uses the process-level secret when set,
	// otherwise the first worker target's shared secret.
	const sharedSecret =
		process.env.HOME_CONNECTOR_SHARED_SECRET?.trim() ||
		primaryTarget.sharedSecret
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
		kodyUsername,
		workerBaseUrl,
		workerSessionUrl,
		workerWebSocketUrl,
		sharedSecret,
		workerTargets,
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
		dataPath,
		dbPath: resolveHomeConnectorDbPath(dataPath),
		port: Number.isFinite(port) ? port : 4040,
		mocksEnabled,
	}
}
