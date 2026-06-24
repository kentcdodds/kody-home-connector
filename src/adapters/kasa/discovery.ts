import dgram from 'node:dgram'
import { type HomeConnectorConfig } from '../../config.ts'
import {
	setKasaDiscoveryDiagnostics,
	type HomeConnectorState,
} from '../../state.ts'
import {
	createKasaKlapClient,
	kasaRelayStateFromSysinfo,
} from './klap-client.ts'
import {
	type KasaClient,
	type KasaClientCredentials,
	type KasaDiscoveredPlug,
	type KasaDiscoveryDiagnostics,
	type KasaDiscoveryProbeDiagnostic,
	type KasaDiscoveryResult,
	type KasaRelayState,
	type KasaSysInfo,
} from './types.ts'

type DiscoveryClientFactory = (input: {
	host: string
	port: number
	credentials: KasaClientCredentials
}) => KasaClient

type UdpDiscoveryHit = {
	host: string
	port: number
	rawDiscovery: Record<string, unknown>
}

const kasaUdpPorts = [9999, 20002]
const kasaPort = 80
const discoveryRequest = JSON.stringify({
	system: {
		get_sysinfo: {},
	},
})

function xorKasaPayload(payload: Buffer) {
	let key = 0xab
	const output = Buffer.alloc(payload.length)
	for (let index = 0; index < payload.length; index++) {
		const next = payload[index] ?? 0
		output[index] = next ^ key
		key = output[index] ?? 0
	}
	return output
}

function decodeXorKasaPayload(payload: Buffer) {
	let key = 0xab
	const output = Buffer.alloc(payload.length)
	for (let index = 0; index < payload.length; index++) {
		const encrypted = payload[index] ?? 0
		output[index] = encrypted ^ key
		key = encrypted
	}
	return output
}

function safeParseJsonPayload(payload: Buffer) {
	const candidates = [
		payload.toString('utf8'),
		decodeXorKasaPayload(payload).toString('utf8'),
	]
	for (const candidate of candidates) {
		try {
			const parsed = JSON.parse(candidate) as unknown
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				return parsed as Record<string, unknown>
			}
		} catch {
			// Try the next discovery response encoding.
		}
	}
	return null
}

function expandKasaScanCidr(cidr: string): Array<string> {
	const trimmed = cidr.trim()
	const single = /^(\d{1,3}(?:\.\d{1,3}){3})\/32$/i.exec(trimmed)
	if (single) {
		const ip = single[1] ?? ''
		const parts = ip.split('.').map((octet) => Number.parseInt(octet, 10))
		if (
			parts.length === 4 &&
			parts.every(
				(octet) => Number.isFinite(octet) && octet >= 0 && octet <= 255,
			)
		) {
			return [ip]
		}
		return []
	}

	const slash24 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.0\/24$/i.exec(trimmed)
	if (!slash24) {
		throw new Error(
			`Invalid Kasa scan CIDR "${cidr}". Use a.b.c.0/24 or a.b.c.d/32.`,
		)
	}
	const a = Number(slash24[1])
	const b = Number(slash24[2])
	const c = Number(slash24[3])
	if ([a, b, c].some((octet) => octet < 0 || octet > 255)) {
		throw new Error(`Invalid Kasa scan CIDR "${cidr}".`)
	}
	return Array.from(
		{ length: 254 },
		(_, index) => `${a}.${b}.${c}.${index + 1}`,
	)
}

function tryExpandKasaScanCidr(cidr: string): Array<string> {
	try {
		return expandKasaScanCidr(cidr)
	} catch (error) {
		console.warn(
			`Skipping Kasa scan CIDR "${cidr}": ${error instanceof Error ? error.message : String(error)}`,
		)
		return []
	}
}

function getNestedRecord(
	value: Record<string, unknown>,
	path: Array<string>,
): Record<string, unknown> | null {
	let current: unknown = value
	for (const key of path) {
		if (!current || typeof current !== 'object' || Array.isArray(current)) {
			return null
		}
		current = (current as Record<string, unknown>)[key]
	}
	return current && typeof current === 'object' && !Array.isArray(current)
		? (current as Record<string, unknown>)
		: null
}

function getStringField(
	record: Record<string, unknown> | null,
	keys: Array<string>,
) {
	if (!record) return null
	for (const key of keys) {
		const value = record[key]
		if (typeof value === 'string' && value.trim()) return value.trim()
	}
	return null
}

function normalizeMac(value: string | null) {
	return (
		value
			?.trim()
			.replace(/[^a-f0-9]/gi, '')
			.toLowerCase() || null
	)
}

function normalizePlugId(value: string) {
	return value.trim().toLowerCase()
}

function relayStateFromUnknown(value: unknown): KasaRelayState {
	return value === true || value === 1
		? 'on'
		: value === false || value === 0
			? 'off'
			: 'unknown'
}

function looksLikeKlapDiscovery(raw: Record<string, unknown>) {
	const json = JSON.stringify(raw).toLowerCase()
	return (
		json.includes('klap') ||
		json.includes('ship') ||
		json.includes('tp-link') ||
		json.includes('tapo') ||
		json.includes('kasa')
	)
}

function createPlugFromRecords(input: {
	host: string
	port: number
	rawDiscovery: Record<string, unknown> | null
	sysinfo: KasaSysInfo | null
	lastSeenAt: string
}): KasaDiscoveredPlug {
	const rawDiscovery = input.rawDiscovery
	const discoveryResult =
		rawDiscovery && typeof rawDiscovery['result'] === 'object'
			? (rawDiscovery['result'] as Record<string, unknown>)
			: rawDiscovery
	const discoverySysinfo =
		rawDiscovery &&
		(getNestedRecord(rawDiscovery, ['system', 'get_sysinfo']) ??
			getNestedRecord(rawDiscovery, ['result', 'system', 'get_sysinfo']))
	const sysinfo = input.sysinfo ?? (discoverySysinfo as KasaSysInfo | null)
	const deviceId =
		getStringField(sysinfo, ['device_id', 'deviceId']) ??
		getStringField(discoveryResult, ['device_id', 'deviceId'])
	const mac =
		normalizeMac(
			getStringField(sysinfo, ['mac', 'mac_address', 'macAddress']),
		) ??
		normalizeMac(
			getStringField(discoveryResult, ['mac', 'mac_address', 'macAddress']),
		)
	const plugId = normalizePlugId(deviceId ?? mac ?? `host:${input.host}`)
	const alias =
		getStringField(sysinfo, ['alias', 'nickname', 'name']) ??
		getStringField(discoveryResult, ['alias', 'nickname', 'name']) ??
		`Kasa plug ${input.host}`
	const model =
		getStringField(sysinfo, ['model', 'mic_type', 'type']) ??
		getStringField(discoveryResult, ['model', 'device_model', 'deviceModel']) ??
		null
	const relayState =
		sysinfo != null
			? kasaRelayStateFromSysinfo(sysinfo)
			: relayStateFromUnknown(discoveryResult?.['relay_state'])
	return {
		plugId,
		alias,
		host: input.host,
		port: input.port,
		model,
		mac,
		deviceId,
		relayState,
		rawSysinfo: sysinfo,
		rawDiscovery,
		lastSeenAt: input.lastSeenAt,
	}
}

async function discoverKasaUdp(
	timeoutMs: number,
): Promise<Array<UdpDiscoveryHit>> {
	const hits = new Map<string, UdpDiscoveryHit>()
	await Promise.all(
		kasaUdpPorts.map(
			(port) =>
				new Promise<void>((resolve) => {
					const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
					let finished = false
					const finish = () => {
						if (finished) return
						finished = true
						socket.close()
						resolve()
					}
					const timer = setTimeout(finish, Math.min(timeoutMs, 1_500))
					socket.on('message', (message, remote) => {
						const parsed = safeParseJsonPayload(message)
						if (!parsed || !looksLikeKlapDiscovery(parsed)) return
						hits.set(`${remote.address}:${String(port)}`, {
							host: remote.address,
							port: kasaPort,
							rawDiscovery: parsed,
						})
					})
					socket.on('error', finish)
					socket.bind(() => {
						try {
							socket.setBroadcast(true)
							const plain = Buffer.from(discoveryRequest, 'utf8')
							socket.send(plain, port, '255.255.255.255')
							socket.send(xorKasaPayload(plain), port, '255.255.255.255')
						} catch {
							clearTimeout(timer)
							finish()
						}
					})
				}),
		),
	)
	return [...hits.values()]
}

async function fetchWithTimeout(url: string, timeoutMs: number) {
	const controller = new AbortController()
	const timeout = setTimeout(() => controller.abort(), timeoutMs)
	try {
		return await fetch(url, {
			method: 'GET',
			signal: controller.signal,
		})
	} finally {
		clearTimeout(timeout)
	}
}

async function probeShipHost(input: {
	host: string
	timeoutMs: number
	credentials: KasaClientCredentials | null
	clientFactory: DiscoveryClientFactory
}): Promise<{
	plug: KasaDiscoveredPlug | null
	diagnostic: KasaDiscoveryProbeDiagnostic
}> {
	const url = `http://${input.host}:${String(kasaPort)}/`
	let server: string | null = null
	try {
		const response = await fetchWithTimeout(url, Math.min(input.timeoutMs, 750))
		server = response.headers.get('server')
		const matched = /ship\s*2\.0/i.test(server ?? '')
		if (!matched) {
			return {
				plug: null,
				diagnostic: {
					host: input.host,
					port: kasaPort,
					source: 'subnet',
					matched: false,
					alias: null,
					plugId: null,
					status: response.status,
					server,
					error: null,
				},
			}
		}
		if (!input.credentials) {
			const plug = createPlugFromRecords({
				host: input.host,
				port: kasaPort,
				rawDiscovery: {
					server,
					probeUrl: url,
					message:
						'SHIP 2.0 host matched, but Kasa credentials are missing so sysinfo could not be read.',
				},
				sysinfo: null,
				lastSeenAt: new Date().toISOString(),
			})
			return {
				plug,
				diagnostic: {
					host: input.host,
					port: kasaPort,
					source: 'subnet',
					matched: true,
					alias: plug.alias,
					plugId: plug.plugId,
					status: response.status,
					server,
					error:
						'Kasa credentials are missing. Set KASA_USERNAME/KASA_PASSWORD or call kasa_set_credentials to read aliases and stable device ids.',
				},
			}
		}
		const client = input.clientFactory({
			host: input.host,
			port: kasaPort,
			credentials: input.credentials,
		})
		const sysinfo = await client.getSysInfo()
		const plug = createPlugFromRecords({
			host: input.host,
			port: kasaPort,
			rawDiscovery: {
				server,
				probeUrl: url,
			},
			sysinfo,
			lastSeenAt: new Date().toISOString(),
		})
		return {
			plug,
			diagnostic: {
				host: input.host,
				port: kasaPort,
				source: 'subnet',
				matched: true,
				alias: plug.alias,
				plugId: plug.plugId,
				status: response.status,
				server,
				error: null,
			},
		}
	} catch (error) {
		return {
			plug: null,
			diagnostic: {
				host: input.host,
				port: kasaPort,
				source: 'subnet',
				matched: false,
				alias: null,
				plugId: null,
				status: null,
				server,
				error:
					error instanceof Error && error.name === 'AbortError'
						? `Request timed out for ${url}`
						: error instanceof Error
							? error.message
							: String(error),
			},
		}
	}
}

function isHostFallbackPlugId(plugId: string) {
	return plugId.startsWith('host:')
}

export function upsertKasaDiscoveredPlugByStableIdentity(
	plugs: Map<string, KasaDiscoveredPlug>,
	plug: KasaDiscoveredPlug,
) {
	const sameHostEntries = [...plugs.entries()].filter(
		([, current]) => current.host === plug.host && current.port === plug.port,
	)
	if (isHostFallbackPlugId(plug.plugId)) {
		const stableExisting = sameHostEntries.find(
			([plugId]) => !isHostFallbackPlugId(plugId),
		)
		if (stableExisting) return
	} else {
		for (const [plugId] of sameHostEntries) {
			if (isHostFallbackPlugId(plugId)) {
				plugs.delete(plugId)
			}
		}
	}
	plugs.set(plug.plugId, plug)
}

async function discoverKasaPlugs(input: {
	config: HomeConnectorConfig
	credentials: KasaClientCredentials | null
	clientFactory?: DiscoveryClientFactory
}): Promise<KasaDiscoveryResult> {
	const startedAt = new Date().toISOString()
	const clientFactory =
		input.clientFactory ??
		((clientInput) =>
			createKasaKlapClient({
				host: clientInput.host,
				port: clientInput.port,
				credentials: clientInput.credentials,
				timeoutMs: input.config.kasaRequestTimeoutMs,
			}))
	const plugs = new Map<string, KasaDiscoveredPlug>()
	const probes: Array<KasaDiscoveryProbeDiagnostic> = []

	for (const hit of await discoverKasaUdp(input.config.kasaRequestTimeoutMs)) {
		const plug = createPlugFromRecords({
			host: hit.host,
			port: hit.port,
			rawDiscovery: hit.rawDiscovery,
			sysinfo: null,
			lastSeenAt: new Date().toISOString(),
		})
		upsertKasaDiscoveredPlugByStableIdentity(plugs, plug)
		probes.push({
			host: hit.host,
			port: hit.port,
			source: 'udp',
			matched: true,
			alias: plug.alias,
			plugId: plug.plugId,
			status: null,
			server: null,
			error: null,
		})
	}

	const targets = input.config.kasaScanCidrs.flatMap(tryExpandKasaScanCidr)
	let cursor = 0
	const concurrency = Math.max(1, Math.min(targets.length, 64))
	async function worker() {
		for (;;) {
			const index = cursor++
			if (index >= targets.length) return
			const host = targets[index]
			if (!host) continue
			const result = await probeShipHost({
				host,
				timeoutMs: input.config.kasaRequestTimeoutMs,
				credentials: input.credentials,
				clientFactory,
			})
			probes.push(result.diagnostic)
			if (result.plug) {
				upsertKasaDiscoveredPlugByStableIdentity(plugs, result.plug)
			}
		}
	}
	await Promise.all(Array.from({ length: concurrency }, () => worker()))

	const diagnostics: KasaDiscoveryDiagnostics = {
		protocol: 'klap',
		discoveryUrl:
			input.config.kasaScanCidrs.length > 0
				? input.config.kasaScanCidrs.join(', ')
				: 'no-scan-cidrs',
		scannedAt: startedAt,
		udpPorts: kasaUdpPorts,
		probes,
		subnetProbe: {
			cidrs: input.config.kasaScanCidrs,
			hostsProbed: targets.length,
			shipMatches: probes.filter(
				(probe) => probe.source === 'subnet' && probe.matched,
			).length,
			authenticatedMatches: probes.filter(
				(probe) =>
					probe.source === 'subnet' && probe.matched && probe.error == null,
			).length,
		},
		credentialStatus: input.credentials ? 'present' : 'missing',
	}
	return {
		plugs: [...plugs.values()],
		diagnostics,
	}
}

export async function scanKasaPlugs(input: {
	state: HomeConnectorState
	config: HomeConnectorConfig
	credentials: KasaClientCredentials | null
	clientFactory?: DiscoveryClientFactory
}) {
	const result = await discoverKasaPlugs(input)
	setKasaDiscoveryDiagnostics(input.state, result.diagnostics)
	return result
}
