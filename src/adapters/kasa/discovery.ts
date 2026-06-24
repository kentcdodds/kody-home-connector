import { type HomeConnectorConfig } from '../../config.ts'
import {
	setKasaDiscoveredPlugs,
	setKasaDiscoveryDiagnostics,
	type HomeConnectorState,
} from '../../state.ts'
import { createKasaLegacyClient } from './client.ts'
import {
	type KasaClient,
	type KasaDiscoveredPlug,
	type KasaDiscoveryDiagnostics,
	type KasaProbeDiagnostic,
	type KasaSysInfo,
} from './types.ts'

const defaultKasaPort = 9999
const defaultScanConcurrency = 64

function normalizeMacAddress(value: unknown) {
	if (typeof value !== 'string') return null
	const normalized = value
		.trim()
		.replaceAll('-', ':')
		.replaceAll(/[^a-fA-F0-9:]/g, '')
		.toLowerCase()
	if (!normalized) return null
	if (normalized.includes(':')) return normalized
	return normalized.length === 12
		? (normalized.match(/.{1,2}/g)?.join(':') ?? normalized)
		: normalized
}

function sanitizeIdentifier(value: string) {
	return value.replaceAll(/[^a-zA-Z0-9]+/g, '-').replaceAll(/^-|-$/g, '')
}

function readString(value: unknown) {
	return typeof value === 'string' && value.trim() ? value.trim() : null
}

function readNumber(value: unknown) {
	return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readRelayState(value: unknown) {
	if (value === 0 || value === 1) return value
	return null
}

export function createKasaPlugId(input: {
	host: string
	sysInfo: KasaSysInfo
}) {
	const base =
		readString(input.sysInfo['deviceId']) ??
		normalizeMacAddress(input.sysInfo['mac']) ??
		normalizeMacAddress(input.sysInfo['mic_mac']) ??
		input.host
	return `kasa-plug-${sanitizeIdentifier(base).toLowerCase()}`
}

export function summarizeKasaSysInfo(input: {
	host: string
	port?: number
	sysInfo: KasaSysInfo
	now?: string
}): KasaDiscoveredPlug {
	const alias =
		readString(input.sysInfo['alias']) ??
		readString(input.sysInfo['dev_name']) ??
		`Kasa plug ${input.host}`
	const macAddress =
		normalizeMacAddress(input.sysInfo['mac']) ??
		normalizeMacAddress(input.sysInfo['mic_mac'])
	return {
		plugId: createKasaPlugId({
			host: input.host,
			sysInfo: input.sysInfo,
		}),
		alias,
		host: input.host,
		port: input.port ?? defaultKasaPort,
		model: readString(input.sysInfo['model']),
		macAddress,
		deviceId: readString(input.sysInfo['deviceId']),
		hwId: readString(input.sysInfo['hwId']),
		swVer: readString(input.sysInfo['sw_ver']),
		relayState: readRelayState(input.sysInfo['relay_state']),
		ledOff: readNumber(input.sysInfo['led_off']),
		onTime: readNumber(input.sysInfo['on_time']),
		lastSeenAt: input.now ?? new Date().toISOString(),
		rawSysInfo: input.sysInfo,
	}
}

function expandKasaScanCidr(cidr: string): Array<string> {
	const trimmed = cidr.trim()
	const single = /^(\d{1,3}(?:\.\d{1,3}){3})\/32$/i.exec(trimmed)
	if (single) {
		const ip = single[1] ?? ''
		const parts = ip.split('.').map((octet) => Number.parseInt(octet, 10))
		return parts.length === 4 &&
			parts.every(
				(octet) => Number.isFinite(octet) && octet >= 0 && octet <= 255,
			)
			? [ip]
			: []
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

	const ips: Array<string> = []
	for (let host = 1; host <= 254; host++) {
		ips.push(`${String(a)}.${String(b)}.${String(c)}.${String(host)}`)
	}
	return ips
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

async function probeKasaSubnets(input: {
	cidrs: Array<string>
	client: KasaClient
	timeoutMs: number
}): Promise<{
	plugs: Array<KasaDiscoveredPlug>
	diagnostics: Array<KasaProbeDiagnostic>
}> {
	const targets: Array<string> = []
	for (const cidr of input.cidrs) {
		targets.push(...tryExpandKasaScanCidr(cidr))
	}

	const plugs: Array<KasaDiscoveredPlug> = []
	const diagnostics: Array<KasaProbeDiagnostic> = []
	const seen = new Set<string>()
	const concurrency = Math.min(
		defaultScanConcurrency,
		Math.max(1, targets.length),
	)
	let cursor = 0

	async function worker() {
		for (;;) {
			const index = cursor++
			if (index >= targets.length) return
			const host = targets[index]
			if (!host) continue
			try {
				const sysInfo = await input.client.getSysInfo({
					host,
					port: defaultKasaPort,
					timeoutMs: input.timeoutMs,
				})
				const plug = summarizeKasaSysInfo({
					host,
					port: defaultKasaPort,
					sysInfo,
				})
				if (!seen.has(plug.plugId)) {
					seen.add(plug.plugId)
					plugs.push(plug)
				}
				diagnostics.push({
					host,
					port: defaultKasaPort,
					matched: true,
					plugId: plug.plugId,
					alias: plug.alias,
					model: plug.model,
					error: null,
				})
			} catch (error) {
				diagnostics.push({
					host,
					port: defaultKasaPort,
					matched: false,
					plugId: null,
					alias: null,
					model: null,
					error: error instanceof Error ? error.message : String(error),
				})
			}
		}
	}

	await Promise.all(Array.from({ length: concurrency }, () => worker()))
	plugs.sort((left, right) => left.alias.localeCompare(right.alias))
	diagnostics.sort((left, right) => left.host.localeCompare(right.host))
	return { plugs, diagnostics }
}

export async function discoverKasaPlugs(input: {
	config: HomeConnectorConfig
	client?: KasaClient
}): Promise<{
	plugs: Array<KasaDiscoveredPlug>
	diagnostics: KasaDiscoveryDiagnostics
}> {
	const client = input.client ?? createKasaLegacyClient()
	const scannedAt = new Date().toISOString()
	const probe = await probeKasaSubnets({
		cidrs: input.config.kasaScanCidrs,
		client,
		timeoutMs: Math.min(input.config.kasaRequestTimeoutMs, 1_000),
	})
	return {
		plugs: probe.plugs,
		diagnostics: {
			protocol: 'subnet',
			discoveryUrl:
				input.config.kasaScanCidrs.length > 0
					? input.config.kasaScanCidrs.join(', ')
					: 'no-scan-cidrs',
			scannedAt,
			probes: probe.diagnostics,
			subnetProbe: {
				cidrs: input.config.kasaScanCidrs,
				hostsProbed: probe.diagnostics.length,
				plugMatches: probe.plugs.length,
			},
		},
	}
}

export async function scanKasaPlugs(
	state: HomeConnectorState,
	config: HomeConnectorConfig,
	client?: KasaClient,
) {
	const result = await discoverKasaPlugs({ config, client })
	setKasaDiscoveredPlugs(state, result.plugs)
	setKasaDiscoveryDiagnostics(state, result.diagnostics)
	return result
}
