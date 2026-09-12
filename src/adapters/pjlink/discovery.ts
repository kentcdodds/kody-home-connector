import { type HomeConnectorConfig } from '../../config.ts'
import {
	setPjlinkDiscoveredProjectors,
	setPjlinkDiscoveryDiagnostics,
	type HomeConnectorState,
} from '../../state.ts'
import { createTcpPjlinkCommandClient, probePjlinkHandshake } from './client.ts'
import { getMockPjlinkProjectors } from './mock-driver.ts'
import { pjlinkDefaultPort } from './protocol.ts'
import {
	courtOptomaDefaults,
	type PjlinkDiscoveredProjector,
	type PjlinkDiscoveryDiagnostics,
	type PjlinkDiscoveryProbeDiagnostic,
	type PjlinkDiscoveryResult,
} from './types.ts'

function expandPjlinkScanCidr(cidr: string): Array<string> {
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
			`Invalid PJLink scan CIDR "${cidr}". Use a.b.c.0/24 or a.b.c.d/32.`,
		)
	}
	const a = Number(slash24[1])
	const b = Number(slash24[2])
	const c = Number(slash24[3])
	if ([a, b, c].some((octet) => octet < 0 || octet > 255)) {
		throw new Error(`Invalid PJLink scan CIDR "${cidr}".`)
	}
	return Array.from(
		{ length: 254 },
		(_, index) => `${a}.${b}.${c}.${String(index + 1)}`,
	)
}

function tryExpandPjlinkScanCidr(cidr: string): Array<string> {
	try {
		return expandPjlinkScanCidr(cidr)
	} catch (error) {
		console.warn(
			`Skipping PJLink scan CIDR "${cidr}": ${error instanceof Error ? error.message : String(error)}`,
		)
		return []
	}
}

export function normalizePjlinkMacAddress(value: string | null | undefined) {
	if (!value) return null
	const hex = value.replaceAll(/[^0-9A-Fa-f]/g, '').toUpperCase()
	if (hex.length !== 12) return null
	return hex.match(/.{2}/g)?.join(':') ?? null
}

export function buildPjlinkProjectorId(input: {
	macAddress?: string | null
	host: string
	port: number
}) {
	const mac = normalizePjlinkMacAddress(input.macAddress)
	if (mac) return `pjlink-${mac.replaceAll(':', '').toLowerCase()}`
	const hostSlug = input.host
		.trim()
		.toLowerCase()
		.replaceAll(/[^a-z0-9]+/g, '-')
	return `pjlink-${hostSlug}-${String(input.port)}`
}

export function normalizePjlinkHost(value: string) {
	return value
		.trim()
		.replace(/^https?:\/\//i, '')
		.replace(/\/$/, '')
		.replace(/:\d+$/, '')
}

function collectScanTargets(config: HomeConnectorConfig) {
	const hosts = new Set<string>()
	for (const cidr of config.pjlinkScanCidrs) {
		for (const ip of tryExpandPjlinkScanCidr(cidr)) {
			hosts.add(ip)
		}
	}
	for (const host of config.pjlinkScanExtraHosts) {
		const normalized = normalizePjlinkHost(host)
		if (normalized) hosts.add(normalized)
	}
	return [...hosts]
}

async function probeLiveProjector(input: {
	host: string
	port: number
	timeoutMs: number
	commandClient: ReturnType<typeof createTcpPjlinkCommandClient>
}): Promise<{
	projector: PjlinkDiscoveredProjector | null
	diagnostic: PjlinkDiscoveryProbeDiagnostic
}> {
	try {
		const handshake = await probePjlinkHandshake({
			host: input.host,
			port: input.port,
			timeoutMs: Math.min(input.timeoutMs, 750),
		})
		let name = `PJLink projector ${input.host}`
		let manufacturer: string | null = null
		let model: string | null = null
		if (!handshake.authRequired) {
			try {
				const [nameResult, manufacturerResult, modelResult] = await Promise.all(
					[
						input.commandClient({
							host: input.host,
							port: input.port,
							command: 'NAME',
							parameter: '?',
							timeoutMs: input.timeoutMs,
						}),
						input.commandClient({
							host: input.host,
							port: input.port,
							command: 'INF1',
							parameter: '?',
							timeoutMs: input.timeoutMs,
						}),
						input.commandClient({
							host: input.host,
							port: input.port,
							command: 'INF2',
							parameter: '?',
							timeoutMs: input.timeoutMs,
						}),
					],
				)
				if (nameResult.value.trim()) name = nameResult.value.trim()
				if (manufacturerResult.value.trim()) {
					manufacturer = manufacturerResult.value.trim()
				}
				if (modelResult.value.trim()) model = modelResult.value.trim()
			} catch {
				// Identity queries are optional during scan.
			}
		}
		const macAddress = normalizePjlinkMacAddress(
			input.host === courtOptomaDefaults.host
				? courtOptomaDefaults.macAddress
				: null,
		)
		const projector: PjlinkDiscoveredProjector = {
			projectorId: buildPjlinkProjectorId({
				macAddress,
				host: input.host,
				port: input.port,
			}),
			name,
			host: input.host,
			port: input.port,
			macAddress,
			manufacturer,
			model,
			authRequired: handshake.authRequired,
			lastSeenAt: new Date().toISOString(),
			rawDiscovery: {
				handshake: handshake.raw,
			},
		}
		return {
			projector,
			diagnostic: {
				host: input.host,
				port: input.port,
				matched: true,
				authRequired: handshake.authRequired,
				name,
				projectorId: projector.projectorId,
				error: null,
			},
		}
	} catch (error) {
		return {
			projector: null,
			diagnostic: {
				host: input.host,
				port: input.port,
				matched: false,
				authRequired: null,
				name: null,
				projectorId: null,
				error: error instanceof Error ? error.message : String(error),
			},
		}
	}
}

function mockDiscoveryResult(): PjlinkDiscoveryResult {
	const now = new Date().toISOString()
	const projectors = getMockPjlinkProjectors().map((projector) => {
		const macAddress = normalizePjlinkMacAddress(projector.macAddress)
		return {
			projectorId: buildPjlinkProjectorId({
				macAddress,
				host: projector.host,
				port: projector.port,
			}),
			name: projector.name,
			host: projector.host,
			port: projector.port,
			macAddress,
			manufacturer: projector.manufacturer,
			model: projector.model,
			authRequired: projector.authRequired,
			lastSeenAt: now,
			rawDiscovery: {
				handshake: projector.authRequired ? 'PJLINK 1 a1b2c3d4' : 'PJLINK 0',
				mock: true,
			},
		} satisfies PjlinkDiscoveredProjector
	})
	return {
		projectors,
		diagnostics: {
			protocol: 'pjlink',
			discoveryUrl: 'mock://pjlink',
			scannedAt: now,
			probes: projectors.map((projector) => ({
				host: projector.host,
				port: projector.port,
				matched: true,
				authRequired: projector.authRequired,
				name: projector.name,
				projectorId: projector.projectorId,
				error: null,
			})),
			subnetProbe: {
				cidrs: [],
				extraHosts: projectors.map((projector) => projector.host),
				hostsProbed: projectors.length,
				pjlinkMatches: projectors.length,
			},
		},
	}
}

export async function scanPjlinkProjectors(
	state: HomeConnectorState,
	config: HomeConnectorConfig,
): Promise<PjlinkDiscoveryResult> {
	if (config.mocksEnabled) {
		const result = mockDiscoveryResult()
		setPjlinkDiscoveredProjectors(state, result.projectors)
		setPjlinkDiscoveryDiagnostics(state, result.diagnostics)
		return result
	}

	const now = new Date().toISOString()
	const targets = collectScanTargets(config)
	const commandClient = createTcpPjlinkCommandClient({
		timeoutMs: config.pjlinkRequestTimeoutMs,
	})
	const probes = await Promise.all(
		targets.map((host) =>
			probeLiveProjector({
				host,
				port: pjlinkDefaultPort,
				timeoutMs: config.pjlinkRequestTimeoutMs,
				commandClient,
			}),
		),
	)
	const projectors = probes
		.map((probe) => probe.projector)
		.filter((projector): projector is PjlinkDiscoveredProjector =>
			Boolean(projector),
		)
	const diagnostics: PjlinkDiscoveryDiagnostics = {
		protocol: 'pjlink',
		discoveryUrl:
			config.pjlinkScanCidrs.length > 0
				? config.pjlinkScanCidrs.join(', ')
				: 'no-scan-cidrs',
		scannedAt: now,
		probes: probes.map((probe) => probe.diagnostic),
		subnetProbe: {
			cidrs: config.pjlinkScanCidrs,
			extraHosts: config.pjlinkScanExtraHosts,
			hostsProbed: targets.length,
			pjlinkMatches: projectors.length,
		},
	}
	setPjlinkDiscoveredProjectors(state, projectors)
	setPjlinkDiscoveryDiagnostics(state, diagnostics)
	return { projectors, diagnostics }
}
