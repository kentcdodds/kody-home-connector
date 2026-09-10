import { type TableRow } from 'remix/data-table'
import { decryptSecret, encryptSecret } from '../../storage/encrypted-secret.ts'
import { type HomeConnectorStorage } from '../../storage/index.ts'
import { islandRouterApiCredentials } from '../../storage/schema.ts'

function mapCredentialRow(
	storage: HomeConnectorStorage,
	row: TableRow<typeof islandRouterApiCredentials>,
) {
	return {
		connectorId: row.connector_id,
		pin: decryptSecret(row.pin, storage.sharedSecret),
		lastAuthenticatedAt: row.last_authenticated_at,
		lastAuthError: row.last_auth_error,
	}
}

export async function getIslandRouterApiCredentials(
	storage: HomeConnectorStorage,
	connectorId: string,
) {
	const row = await storage.db.find(islandRouterApiCredentials, {
		connector_id: connectorId,
	})
	return row ? mapCredentialRow(storage, row) : null
}

export async function getIslandRouterApiPin(
	storage: HomeConnectorStorage,
	connectorId: string,
) {
	return (
		(await getIslandRouterApiCredentials(storage, connectorId))?.pin ?? null
	)
}

export async function hasIslandRouterApiStoredPin(
	storage: HomeConnectorStorage,
	connectorId: string,
) {
	const row = await storage.db.find(islandRouterApiCredentials, {
		connector_id: connectorId,
	})
	return Boolean(row)
}

export async function getIslandRouterApiAuthStatus(
	storage: HomeConnectorStorage,
	connectorId: string,
) {
	const credentials = await getIslandRouterApiCredentials(storage, connectorId)
	return credentials
		? {
				lastAuthenticatedAt: credentials.lastAuthenticatedAt,
				lastAuthError: credentials.lastAuthError,
			}
		: null
}

export async function saveIslandRouterApiPin(input: {
	storage: HomeConnectorStorage
	connectorId: string
	pin: string
}) {
	const trimmedPin = input.pin.trim()
	if (!trimmedPin) {
		throw new Error('pin must not be empty.')
	}
	const encryptedPin = encryptSecret({
		value: trimmedPin,
		sharedSecret: input.storage.sharedSecret,
		missingSecretMessage:
			'Cannot store Island Router API PIN without HOME_CONNECTOR_SHARED_SECRET.',
	})
	await input.storage.db.query(islandRouterApiCredentials).upsert({
		connector_id: input.connectorId,
		pin: encryptedPin,
		last_authenticated_at: null,
		last_auth_error: null,
	})
}

export async function clearIslandRouterApiPin(
	storage: HomeConnectorStorage,
	connectorId: string,
) {
	await storage.db.delete(islandRouterApiCredentials, {
		connector_id: connectorId,
	})
}

export async function updateIslandRouterApiAuthStatus(input: {
	storage: HomeConnectorStorage
	connectorId: string
	lastAuthenticatedAt: string | null
	lastAuthError: string | null
}) {
	await input.storage.db.updateMany(
		islandRouterApiCredentials,
		{
			last_authenticated_at: input.lastAuthenticatedAt,
			last_auth_error: input.lastAuthError,
		},
		{ where: { connector_id: input.connectorId } },
	)
}
