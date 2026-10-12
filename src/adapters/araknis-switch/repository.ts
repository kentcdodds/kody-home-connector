import { type TableRow } from 'remix/data-table'
import { decryptSecret, encryptSecret } from '../../storage/encrypted-secret.ts'
import { type HomeConnectorStorage } from '../../storage/index.ts'
import { araknisSwitchCredentials } from '../../storage/schema.ts'

export type AraknisSwitchStoredCredentials = {
	username: string
	password: string
	lastAuthenticatedAt: string | null
	lastAuthError: string | null
}

function encryptCredentialField(
	value: string,
	sharedSecret: string | null,
	fieldName: 'username' | 'password',
) {
	return encryptSecret({
		value,
		sharedSecret,
		missingSecretMessage: `Cannot store Araknis switch ${fieldName} without HOME_CONNECTOR_SHARED_SECRET.`,
	})
}

function mapCredentialRow(
	storage: HomeConnectorStorage,
	row: TableRow<typeof araknisSwitchCredentials>,
): AraknisSwitchStoredCredentials | null {
	const username = decryptSecret(row.username, storage.sharedSecret)
	const password = decryptSecret(row.password, storage.sharedSecret)
	if (!username || !password) return null
	return {
		username,
		password,
		lastAuthenticatedAt: row.last_authenticated_at,
		lastAuthError: row.last_auth_error,
	}
}

export async function getAraknisSwitchCredentials(
	storage: HomeConnectorStorage,
	connectorId: string,
): Promise<AraknisSwitchStoredCredentials | null> {
	const row = await storage.db.find(araknisSwitchCredentials, {
		connector_id: connectorId,
	})
	return row ? mapCredentialRow(storage, row) : null
}

export async function hasAraknisSwitchStoredCredentials(
	storage: HomeConnectorStorage,
	connectorId: string,
) {
	const row = await storage.db.find(araknisSwitchCredentials, {
		connector_id: connectorId,
	})
	return Boolean(row)
}

export async function getAraknisSwitchAuthStatus(
	storage: HomeConnectorStorage,
	connectorId: string,
) {
	const row = await storage.db.find(araknisSwitchCredentials, {
		connector_id: connectorId,
	})
	return row
		? {
				lastAuthenticatedAt: row.last_authenticated_at,
				lastAuthError: row.last_auth_error,
			}
		: null
}

export async function saveAraknisSwitchCredentials(input: {
	storage: HomeConnectorStorage
	connectorId: string
	username: string
	password: string
}) {
	const username = input.username.trim()
	const password = input.password
	if (!username) {
		throw new Error('Araknis switch username must not be empty.')
	}
	if (!password) {
		throw new Error('Araknis switch password must not be empty.')
	}
	await input.storage.db.query(araknisSwitchCredentials).upsert({
		connector_id: input.connectorId,
		username: encryptCredentialField(
			username,
			input.storage.sharedSecret,
			'username',
		),
		password: encryptCredentialField(
			password,
			input.storage.sharedSecret,
			'password',
		),
		last_authenticated_at: null,
		last_auth_error: null,
	})
}

export async function clearAraknisSwitchCredentials(
	storage: HomeConnectorStorage,
	connectorId: string,
) {
	await storage.db.delete(araknisSwitchCredentials, {
		connector_id: connectorId,
	})
}

export async function updateAraknisSwitchAuthStatus(input: {
	storage: HomeConnectorStorage
	connectorId: string
	lastAuthenticatedAt: string | null
	lastAuthError: string | null
}) {
	await input.storage.db.updateMany(
		araknisSwitchCredentials,
		{
			last_authenticated_at: input.lastAuthenticatedAt,
			last_auth_error: input.lastAuthError,
		},
		{ where: { connector_id: input.connectorId } },
	)
}
