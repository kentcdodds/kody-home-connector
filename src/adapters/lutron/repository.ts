import {
	createCipheriv,
	createDecipheriv,
	createHash,
	randomBytes,
} from 'node:crypto'
import { and, notInList, type TableRow } from 'remix/data-table'
import { type HomeConnectorStorage } from '../../storage/index.ts'
import { lutronCredentials, lutronProcessors } from '../../storage/schema.ts'
import { compareNoCase, compareText } from '../../storage/sort.ts'
import {
	type LutronDiscoveredProcessor,
	type LutronPublicProcessor,
	type LutronPersistedProcessor,
} from './types.ts'
import { LutronProcessorNotFoundError } from './errors.ts'

const PASSWORD_PREFIX = 'enc:v1:'
const PASSWORD_AUTH_TAG_BYTES = 16

function getPasswordKey(sharedSecret: string) {
	return createHash('sha256').update(sharedSecret).digest()
}

function encryptPassword(password: string, sharedSecret: string | null) {
	if (!sharedSecret) {
		throw new Error(
			'Cannot store Lutron credentials without HOME_CONNECTOR_SHARED_SECRET.',
		)
	}
	const iv = randomBytes(12)
	const key = getPasswordKey(sharedSecret)
	const cipher = createCipheriv('aes-256-gcm', key, iv)
	const encrypted = Buffer.concat([
		cipher.update(password, 'utf8'),
		cipher.final(),
	])
	const tag = cipher.getAuthTag()
	return `${PASSWORD_PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`
}

function decryptPassword(password: string | null, sharedSecret: string | null) {
	if (!password || !password.startsWith(PASSWORD_PREFIX)) {
		return password
	}
	if (!sharedSecret) {
		return null
	}
	const payload = password.slice(PASSWORD_PREFIX.length)
	const [ivBase64, tagBase64, encryptedBase64] = payload.split(':')
	if (!ivBase64 || !tagBase64 || !encryptedBase64) {
		return null
	}
	try {
		const key = getPasswordKey(sharedSecret)
		const iv = Buffer.from(ivBase64, 'base64')
		const tag = Buffer.from(tagBase64, 'base64')
		const encrypted = Buffer.from(encryptedBase64, 'base64')
		if (iv.length !== 12 || tag.length !== PASSWORD_AUTH_TAG_BYTES) {
			return null
		}
		const decipher = createDecipheriv('aes-256-gcm', key, iv)
		decipher.setAuthTag(tag)
		const decrypted = Buffer.concat([
			decipher.update(encrypted),
			decipher.final(),
		])
		return decrypted.toString('utf8')
	} catch {
		return null
	}
}

function mapLutronProcessorRow(
	storage: HomeConnectorStorage,
	row: TableRow<typeof lutronProcessors>,
	credentials: TableRow<typeof lutronCredentials> | undefined,
): LutronPersistedProcessor {
	return {
		processorId: row.processor_id,
		instanceName: row.instance_name,
		name: row.name,
		host: row.host,
		discoveryPort: row.discovery_port,
		leapPort: row.port,
		address: row.address,
		serialNumber: row.serial_number,
		macAddress: row.mac_address,
		systemType: row.system_type,
		codeVersion: row.code_version,
		deviceClass: row.device_class,
		claimStatus: row.claim_status,
		networkStatus: row.network_status,
		firmwareStatus: row.firmware_status,
		status: row.status,
		lastSeenAt: row.last_seen_at,
		rawDiscovery: row.raw_discovery_json
			? (JSON.parse(row.raw_discovery_json) as Record<string, unknown>)
			: null,
		username: credentials?.username ?? null,
		password: decryptPassword(
			credentials?.password ?? null,
			storage.sharedSecret,
		),
		lastAuthenticatedAt: credentials?.last_authenticated_at ?? null,
		lastAuthError: credentials?.last_auth_error ?? null,
	}
}

function toPublicLutronProcessor(
	processor: LutronPersistedProcessor,
): LutronPublicProcessor {
	const {
		username,
		password: _password,
		lastAuthenticatedAt,
		lastAuthError,
		...rest
	} = processor
	return {
		...rest,
		hasStoredCredentials: Boolean(username),
		lastAuthenticatedAt,
		lastAuthError,
	}
}

export async function listLutronProcessors(
	storage: HomeConnectorStorage,
	connectorId: string,
) {
	const processors = await storage.db.findMany(lutronProcessors, {
		where: { connector_id: connectorId },
	})
	const credentials = await storage.db.findMany(lutronCredentials, {
		where: { connector_id: connectorId },
	})
	const credentialsByProcessor = new Map(
		credentials.map((row) => [row.processor_id, row]),
	)
	return processors
		.sort(
			(a, b) =>
				compareNoCase(a.name, b.name) ||
				compareText(a.processor_id, b.processor_id),
		)
		.map((row) =>
			mapLutronProcessorRow(
				storage,
				row,
				credentialsByProcessor.get(row.processor_id),
			),
		)
}

export async function listLutronPublicProcessors(
	storage: HomeConnectorStorage,
	connectorId: string,
) {
	return (await listLutronProcessors(storage, connectorId)).map(
		toPublicLutronProcessor,
	)
}

export function toLutronPublicProcessor(
	processor: LutronPersistedProcessor,
): LutronPublicProcessor {
	return toPublicLutronProcessor(processor)
}

export async function getLutronProcessor(
	storage: HomeConnectorStorage,
	connectorId: string,
	processorId: string,
) {
	const key = { connector_id: connectorId, processor_id: processorId }
	const row = await storage.db.find(lutronProcessors, key)
	if (!row) return null
	const credentials = await storage.db.find(lutronCredentials, key)
	return mapLutronProcessorRow(storage, row, credentials ?? undefined)
}

export async function upsertDiscoveredLutronProcessors(
	storage: HomeConnectorStorage,
	connectorId: string,
	processors: Array<LutronDiscoveredProcessor>,
) {
	for (const processor of processors) {
		await storage.db.query(lutronProcessors).upsert({
			connector_id: connectorId,
			processor_id: processor.processorId,
			instance_name: processor.instanceName,
			name: processor.name,
			host: processor.host,
			port: processor.leapPort,
			discovery_port: processor.discoveryPort,
			address: processor.address,
			serial_number: processor.serialNumber,
			mac_address: processor.macAddress,
			system_type: processor.systemType,
			code_version: processor.codeVersion,
			device_class: processor.deviceClass,
			claim_status: processor.claimStatus,
			network_status: processor.networkStatus,
			firmware_status: processor.firmwareStatus,
			status: processor.status,
			raw_discovery_json: processor.rawDiscovery
				? JSON.stringify(processor.rawDiscovery)
				: null,
			last_seen_at: processor.lastSeenAt,
		})
	}

	const credentialed = await storage.db.findMany(lutronCredentials, {
		where: { connector_id: connectorId },
	})
	await storage.db.deleteMany(lutronProcessors, {
		where: and(
			{ connector_id: connectorId },
			notInList('processor_id', [
				...processors.map((processor) => processor.processorId),
				...credentialed.map((row) => row.processor_id),
			]),
		),
	})

	return listLutronProcessors(storage, connectorId)
}

export async function saveLutronCredentials(input: {
	storage: HomeConnectorStorage
	connectorId: string
	processorId: string
	username: string
	password: string
	lastAuthenticatedAt?: string | null
	lastAuthError?: string | null
}) {
	await input.storage.db.query(lutronCredentials).upsert({
		connector_id: input.connectorId,
		processor_id: input.processorId,
		username: input.username,
		password: encryptPassword(input.password, input.storage.sharedSecret),
		last_authenticated_at: input.lastAuthenticatedAt ?? null,
		last_auth_error: input.lastAuthError ?? null,
	})
}

export async function updateLutronAuthStatus(input: {
	storage: HomeConnectorStorage
	connectorId: string
	processorId: string
	lastAuthenticatedAt: string | null
	lastAuthError: string | null
}) {
	await input.storage.db.updateMany(
		lutronCredentials,
		{
			last_authenticated_at: input.lastAuthenticatedAt,
			last_auth_error: input.lastAuthError,
		},
		{
			where: {
				connector_id: input.connectorId,
				processor_id: input.processorId,
			},
		},
	)
}

export async function requireLutronProcessor(
	storage: HomeConnectorStorage,
	connectorId: string,
	processorId: string,
) {
	const processor = await getLutronProcessor(storage, connectorId, processorId)
	if (!processor) {
		throw new LutronProcessorNotFoundError(processorId)
	}
	return processor
}
