import { and, notInList, type TableRow } from 'remix/data-table'
import { type HomeConnectorStorage } from '../../storage/index.ts'
import {
	bondBridges,
	bondReliabilityState,
	bondRequestLogs,
	bondTokens,
} from '../../storage/schema.ts'
import { compareNoCase, compareText } from '../../storage/sort.ts'
import { type BondDiscoveredBridge, type BondPersistedBridge } from './types.ts'

export type BondRequestLogInput = {
	connectorId: string
	bridgeId: string
	operation: string
	status: 'success' | 'failure' | 'cooldown'
	startedAt: string
	finishedAt: string
	durationMs: number
	baseUrlsTried: Array<string>
	errorName?: string | null
	errorMessage?: string | null
	networkFailure: boolean
}

export type BondReliabilityState = {
	connectorId: string
	bridgeId: string
	cooldownUntil: string | null
	lastFailureAt: string | null
	lastFailureReason: string | null
	updatedAt: string
}

function parseBondRequestBaseUrls(value: string | null): Array<string> {
	if (typeof value !== 'string') return []
	try {
		const parsed = JSON.parse(value) as unknown
		return Array.isArray(parsed)
			? parsed.filter((entry) => typeof entry === 'string')
			: []
	} catch {
		return []
	}
}

function mapBondBridgeRow(
	row: TableRow<typeof bondBridges>,
	token: string | undefined,
): BondPersistedBridge {
	let rawDiscovery: Record<string, unknown> | null = null
	if (row.raw_discovery_json) {
		try {
			rawDiscovery = JSON.parse(row.raw_discovery_json) as Record<
				string,
				unknown
			>
		} catch {
			rawDiscovery = null
		}
	}
	return {
		bridgeId: row.bridge_id,
		bondid: row.bondid,
		instanceName: row.instance_name,
		host: row.host,
		port: row.port,
		model: row.model,
		fwVer: row.fw_ver,
		adopted: Boolean(row.adopted),
		lastSeenAt: row.last_seen_at,
		hasStoredToken: Boolean(token),
		rawDiscovery,
	}
}

function mapBondReliabilityStateRow(
	row: TableRow<typeof bondReliabilityState>,
): BondReliabilityState {
	return {
		connectorId: row.connector_id,
		bridgeId: row.bridge_id,
		cooldownUntil: row.cooldown_until,
		lastFailureAt: row.last_failure_at,
		lastFailureReason: row.last_failure_reason,
		updatedAt: row.updated_at,
	}
}

export async function listBondBridges(
	storage: HomeConnectorStorage,
	connectorId: string,
) {
	const [rows, tokens] = await Promise.all([
		storage.db.findMany(bondBridges, { where: { connector_id: connectorId } }),
		storage.db.findMany(bondTokens, { where: { connector_id: connectorId } }),
	])
	const tokensByBridge = new Map(
		tokens.map((token) => [token.bridge_id, token.token]),
	)
	return rows
		.sort(
			(a, b) =>
				compareNoCase(a.instance_name, b.instance_name) ||
				compareText(a.bridge_id, b.bridge_id),
		)
		.map((row) => mapBondBridgeRow(row, tokensByBridge.get(row.bridge_id)))
}

export async function getBondBridge(
	storage: HomeConnectorStorage,
	connectorId: string,
	bridgeId: string,
) {
	const key = { connector_id: connectorId, bridge_id: bridgeId }
	const row = await storage.db.find(bondBridges, key)
	if (!row) return null
	const token = await storage.db.find(bondTokens, key)
	return mapBondBridgeRow(row, token?.token)
}

export async function requireBondBridge(
	storage: HomeConnectorStorage,
	connectorId: string,
	bridgeId: string,
) {
	const bridge = await getBondBridge(storage, connectorId, bridgeId)
	if (!bridge) {
		throw new Error(`Bond bridge "${bridgeId}" was not found.`)
	}
	return bridge
}

export async function getBondTokenSecret(
	storage: HomeConnectorStorage,
	connectorId: string,
	bridgeId: string,
): Promise<string | null> {
	const row = await storage.db.find(bondTokens, {
		connector_id: connectorId,
		bridge_id: bridgeId,
	})
	return row?.token ?? null
}

export async function insertBondRequestLog(
	storage: HomeConnectorStorage,
	input: BondRequestLogInput,
) {
	await storage.db.create(bondRequestLogs, {
		connector_id: input.connectorId,
		bridge_id: input.bridgeId,
		operation: input.operation,
		status: input.status,
		started_at: input.startedAt,
		finished_at: input.finishedAt,
		duration_ms: Math.max(0, Math.round(input.durationMs)),
		base_urls_tried_json: JSON.stringify(input.baseUrlsTried),
		error_name: input.errorName ?? null,
		error_message: input.errorMessage ?? null,
		network_failure: input.networkFailure ? 1 : 0,
	})
}

export async function pruneBondRequestLogs(input: {
	storage: HomeConnectorStorage
	connectorId: string
	bridgeId: string
	limit: number
}) {
	const limit = Math.max(1, Math.floor(input.limit))
	const where = { connector_id: input.connectorId, bridge_id: input.bridgeId }
	const keep = await input.storage.db.findMany(bondRequestLogs, {
		where,
		orderBy: [
			['started_at', 'desc'],
			['id', 'desc'],
		],
		limit,
	})
	await input.storage.db.deleteMany(bondRequestLogs, {
		where: and(
			where,
			notInList(
				bondRequestLogs.id,
				keep.map((row) => row.id),
			),
		),
	})
}

export async function getBondReliabilityState(
	storage: HomeConnectorStorage,
	connectorId: string,
	bridgeId: string,
) {
	const row = await storage.db.find(bondReliabilityState, {
		connector_id: connectorId,
		bridge_id: bridgeId,
	})
	return row ? mapBondReliabilityStateRow(row) : null
}

export async function saveBondReliabilityFailure(input: {
	storage: HomeConnectorStorage
	connectorId: string
	bridgeId: string
	cooldownUntil: string
	failureAt: string
	failureReason: string
}) {
	await input.storage.db.query(bondReliabilityState).upsert({
		connector_id: input.connectorId,
		bridge_id: input.bridgeId,
		cooldown_until: input.cooldownUntil,
		last_failure_at: input.failureAt,
		last_failure_reason: input.failureReason,
		updated_at: input.failureAt,
	})
}

export async function clearBondReliabilityCooldown(input: {
	storage: HomeConnectorStorage
	connectorId: string
	bridgeId: string
}) {
	await input.storage.db.updateMany(
		bondReliabilityState,
		{ cooldown_until: null },
		{
			where: { connector_id: input.connectorId, bridge_id: input.bridgeId },
		},
	)
}

export async function listRecentBondRequestLogs(input: {
	storage: HomeConnectorStorage
	connectorId: string
	bridgeId?: string
	limit?: number
}) {
	const limit = Math.max(1, Math.floor(input.limit ?? 100))
	const rows = await input.storage.db.findMany(bondRequestLogs, {
		where: input.bridgeId
			? { connector_id: input.connectorId, bridge_id: input.bridgeId }
			: { connector_id: input.connectorId },
		orderBy: [
			['started_at', 'desc'],
			['id', 'desc'],
		],
		limit,
	})
	return rows.map((row) => ({
		id: row.id,
		connectorId: row.connector_id,
		bridgeId: row.bridge_id,
		operation: row.operation,
		status: row.status,
		startedAt: row.started_at,
		finishedAt: row.finished_at,
		durationMs: row.duration_ms,
		baseUrlsTried: parseBondRequestBaseUrls(row.base_urls_tried_json),
		errorName: row.error_name,
		errorMessage: row.error_message,
		networkFailure: Boolean(row.network_failure),
	}))
}

export async function upsertDiscoveredBondBridges(
	storage: HomeConnectorStorage,
	connectorId: string,
	bridges: Array<BondDiscoveredBridge>,
) {
	for (const bridge of bridges) {
		const values = {
			bondid: bridge.bondid,
			instance_name: bridge.instanceName,
			host: bridge.host,
			port: bridge.port,
			model: bridge.model,
			fw_ver: bridge.fwVer,
			raw_discovery_json: JSON.stringify(bridge.rawDiscovery),
			last_seen_at: bridge.lastSeenAt,
		}
		const key = { connector_id: connectorId, bridge_id: bridge.bridgeId }
		if (await storage.db.find(bondBridges, key)) {
			await storage.db.update(bondBridges, key, values)
		} else {
			await storage.db.create(bondBridges, { ...key, adopted: 0, ...values })
		}
	}
	if (bridges.length > 0) {
		await storage.db.deleteMany(bondBridges, {
			where: and(
				{ connector_id: connectorId, adopted: 0 },
				notInList(
					bondBridges.bridge_id,
					bridges.map((bridge) => bridge.bridgeId),
				),
			),
		})
	}
	return listBondBridges(storage, connectorId)
}

export async function adoptBondBridge(
	storage: HomeConnectorStorage,
	connectorId: string,
	bridgeId: string,
) {
	await storage.db.updateMany(
		bondBridges,
		{ adopted: 1 },
		{ where: { connector_id: connectorId, bridge_id: bridgeId } },
	)
	return requireBondBridge(storage, connectorId, bridgeId)
}

export async function releaseBondBridge(
	storage: HomeConnectorStorage,
	connectorId: string,
	bridgeId: string,
) {
	const deleted = await storage.db.delete(bondBridges, {
		connector_id: connectorId,
		bridge_id: bridgeId,
	})
	if (!deleted) {
		throw new Error(`Bond bridge "${bridgeId}" was not found.`)
	}
}

export async function pruneNonAdoptedBondBridges(
	storage: HomeConnectorStorage,
	connectorId: string,
) {
	await storage.db.deleteMany(bondBridges, {
		where: { connector_id: connectorId, adopted: 0 },
	})
}

export async function saveBondToken(input: {
	storage: HomeConnectorStorage
	connectorId: string
	bridgeId: string
	token: string
	lastVerifiedAt: string | null
	lastAuthError: string | null
}) {
	await input.storage.db.query(bondTokens).upsert({
		connector_id: input.connectorId,
		bridge_id: input.bridgeId,
		token: input.token,
		last_verified_at: input.lastVerifiedAt,
		last_auth_error: input.lastAuthError,
	})
}

export async function updateBondBridgeConnection(
	storage: HomeConnectorStorage,
	connectorId: string,
	bridgeId: string,
	input: { host: string; port?: number },
) {
	await storage.db.updateMany(
		bondBridges,
		{ host: input.host, port: input.port ?? 80 },
		{ where: { connector_id: connectorId, bridge_id: bridgeId } },
	)
	return requireBondBridge(storage, connectorId, bridgeId)
}

export async function updateBondBridgeLastSeen(input: {
	storage: HomeConnectorStorage
	connectorId: string
	bridgeId: string
	lastSeenAt: string
}) {
	await input.storage.db.updateMany(
		bondBridges,
		{ last_seen_at: input.lastSeenAt },
		{ where: { connector_id: input.connectorId, bridge_id: input.bridgeId } },
	)
}
