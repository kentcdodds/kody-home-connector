import { and, notInList, type TableRow } from 'remix/data-table'
import { type HomeConnectorStorage } from '../../storage/index.ts'
import { decryptSecret, encryptSecret } from '../../storage/encrypted-secret.ts'
import {
	accessNetworksUnleashedControllers,
	accessNetworksUnleashedCredentials,
} from '../../storage/schema.ts'
import { compareNoCase, compareText } from '../../storage/sort.ts'
import {
	type AccessNetworksUnleashedDiscoveredController,
	type AccessNetworksUnleashedPersistedController,
	type AccessNetworksUnleashedPublicController,
} from './types.ts'

function encryptPassword(password: string, sharedSecret: string | null) {
	return encryptSecret({
		value: password,
		sharedSecret,
		missingSecretMessage:
			'Cannot store Access Networks Unleashed credentials without HOME_CONNECTOR_SHARED_SECRET.',
	})
}

function decryptPassword(password: string | null, sharedSecret: string | null) {
	return decryptSecret(password, sharedSecret)
}

function mapControllerRow(
	storage: HomeConnectorStorage,
	row: TableRow<typeof accessNetworksUnleashedControllers>,
	credentials: TableRow<typeof accessNetworksUnleashedCredentials> | undefined,
): AccessNetworksUnleashedPersistedController {
	return {
		controllerId: row.controller_id,
		name: row.name,
		host: row.host,
		loginUrl: row.login_url,
		lastSeenAt: row.last_seen_at,
		rawDiscovery: row.raw_discovery_json
			? (JSON.parse(row.raw_discovery_json) as Record<string, unknown>)
			: null,
		adopted: Boolean(row.adopted),
		username: credentials?.username ?? null,
		password: decryptPassword(
			credentials?.password ?? null,
			storage.sharedSecret,
		),
		lastAuthenticatedAt: credentials?.last_authenticated_at ?? null,
		lastAuthError: credentials?.last_auth_error ?? null,
	}
}

function toPublicController(
	controller: AccessNetworksUnleashedPersistedController,
): AccessNetworksUnleashedPublicController {
	const { username, password, lastAuthenticatedAt, lastAuthError, ...rest } =
		controller
	return {
		...rest,
		hasStoredCredentials: Boolean(username && password),
		lastAuthenticatedAt,
		lastAuthError,
	}
}

export async function listAccessNetworksUnleashedControllers(
	storage: HomeConnectorStorage,
	connectorId: string,
) {
	const controllers = await storage.db.findMany(
		accessNetworksUnleashedControllers,
		{ where: { connector_id: connectorId } },
	)
	const credentials = await storage.db.findMany(
		accessNetworksUnleashedCredentials,
		{ where: { connector_id: connectorId } },
	)
	const credentialsByController = new Map(
		credentials.map((row) => [row.controller_id, row]),
	)
	return controllers
		.sort(
			(a, b) =>
				compareNoCase(a.name, b.name) ||
				compareText(a.controller_id, b.controller_id),
		)
		.map((row) =>
			mapControllerRow(
				storage,
				row,
				credentialsByController.get(row.controller_id),
			),
		)
}

export async function listAccessNetworksUnleashedPublicControllers(
	storage: HomeConnectorStorage,
	connectorId: string,
) {
	return (
		await listAccessNetworksUnleashedControllers(storage, connectorId)
	).map(toPublicController)
}

export function toAccessNetworksUnleashedPublicController(
	controller: AccessNetworksUnleashedPersistedController,
) {
	return toPublicController(controller)
}

export async function getAccessNetworksUnleashedController(
	storage: HomeConnectorStorage,
	connectorId: string,
	controllerId: string,
) {
	const key = { connector_id: connectorId, controller_id: controllerId }
	const row = await storage.db.find(accessNetworksUnleashedControllers, key)
	if (!row) return null
	const credentials = await storage.db.find(
		accessNetworksUnleashedCredentials,
		key,
	)
	return mapControllerRow(storage, row, credentials ?? undefined)
}

export async function getAdoptedAccessNetworksUnleashedController(
	storage: HomeConnectorStorage,
	connectorId: string,
) {
	return (
		(await listAccessNetworksUnleashedControllers(storage, connectorId)).find(
			(controller) => controller.adopted,
		) ?? null
	)
}

export async function upsertDiscoveredAccessNetworksUnleashedControllers(
	storage: HomeConnectorStorage,
	connectorId: string,
	controllers: Array<AccessNetworksUnleashedDiscoveredController>,
) {
	const existing = new Map(
		(await listAccessNetworksUnleashedControllers(storage, connectorId)).map(
			(controller) => [controller.controllerId, controller],
		),
	)
	for (const controller of controllers) {
		const values = {
			name: controller.name,
			host: controller.host,
			login_url: controller.loginUrl,
			raw_discovery_json: controller.rawDiscovery
				? JSON.stringify(controller.rawDiscovery)
				: null,
			last_seen_at: controller.lastSeenAt,
		}
		await storage.db.query(accessNetworksUnleashedControllers).upsert(
			{
				connector_id: connectorId,
				controller_id: controller.controllerId,
				adopted: existing.get(controller.controllerId)?.adopted ? 1 : 0,
				...values,
			},
			{ update: values },
		)
	}
	const credentialed = await storage.db.findMany(
		accessNetworksUnleashedCredentials,
		{ where: { connector_id: connectorId } },
	)
	await storage.db.deleteMany(accessNetworksUnleashedControllers, {
		where: and(
			{ connector_id: connectorId, adopted: 0 },
			notInList('controller_id', [
				...controllers.map((controller) => controller.controllerId),
				...credentialed.map((row) => row.controller_id),
			]),
		),
	})
	return listAccessNetworksUnleashedControllers(storage, connectorId)
}

export async function adoptAccessNetworksUnleashedController(
	storage: HomeConnectorStorage,
	connectorId: string,
	controllerId: string,
) {
	await storage.db.updateMany(
		accessNetworksUnleashedControllers,
		{ adopted: 0 },
		{ where: { connector_id: connectorId, adopted: 1 } },
	)
	await storage.db.updateMany(
		accessNetworksUnleashedControllers,
		{ adopted: 1 },
		{ where: { connector_id: connectorId, controller_id: controllerId } },
	)
	return getAccessNetworksUnleashedController(
		storage,
		connectorId,
		controllerId,
	)
}

export async function removeAccessNetworksUnleashedController(input: {
	storage: HomeConnectorStorage
	connectorId: string
	controllerId: string
}) {
	const where = {
		connector_id: input.connectorId,
		controller_id: input.controllerId,
	}
	await input.storage.db.deleteMany(accessNetworksUnleashedCredentials, {
		where,
	})
	await input.storage.db.deleteMany(accessNetworksUnleashedControllers, {
		where,
	})
}

export async function saveAccessNetworksUnleashedCredentials(input: {
	storage: HomeConnectorStorage
	connectorId: string
	controllerId: string
	username: string
	password: string
	lastAuthenticatedAt?: string | null
	lastAuthError?: string | null
}) {
	await input.storage.db.query(accessNetworksUnleashedCredentials).upsert({
		connector_id: input.connectorId,
		controller_id: input.controllerId,
		username: input.username,
		password: encryptPassword(input.password, input.storage.sharedSecret),
		last_authenticated_at: input.lastAuthenticatedAt ?? null,
		last_auth_error: input.lastAuthError ?? null,
	})
}

export async function updateAccessNetworksUnleashedAuthStatus(input: {
	storage: HomeConnectorStorage
	connectorId: string
	controllerId: string
	lastAuthenticatedAt: string | null
	lastAuthError: string | null
}) {
	await input.storage.db.updateMany(
		accessNetworksUnleashedCredentials,
		{
			last_authenticated_at: input.lastAuthenticatedAt,
			last_auth_error: input.lastAuthError,
		},
		{
			where: {
				connector_id: input.connectorId,
				controller_id: input.controllerId,
			},
		},
	)
}
