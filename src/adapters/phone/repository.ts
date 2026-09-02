import { decryptSecret, encryptSecret } from '../../storage/encrypted-secret.ts'
import { type HomeConnectorStorage } from '../../storage/index.ts'

type PhoneDeviceTokenRow = {
	connector_id: string
	token: string
	updated_at: string
}

export function getPhoneDeviceToken(
	storage: HomeConnectorStorage,
	connectorId: string,
) {
	const row = storage.db
		.query(
			`
				SELECT connector_id, token, updated_at
				FROM phone_device_tokens
				WHERE connector_id = ?
			`,
		)
		.get(connectorId) as PhoneDeviceTokenRow | undefined
	if (!row) return null
	return decryptSecret(row.token, storage.sharedSecret)
}

export function hasStoredPhoneDeviceToken(
	storage: HomeConnectorStorage,
	connectorId: string,
) {
	const row = storage.db
		.query(
			`
				SELECT 1 AS found
				FROM phone_device_tokens
				WHERE connector_id = ?
			`,
		)
		.get(connectorId) as { found: number } | undefined
	return Boolean(row)
}

export function savePhoneDeviceToken(input: {
	storage: HomeConnectorStorage
	connectorId: string
	token: string
}) {
	const trimmedToken = input.token.trim()
	if (!trimmedToken) {
		throw new Error('token must not be empty.')
	}
	const encryptedToken = encryptSecret({
		value: trimmedToken,
		sharedSecret: input.storage.sharedSecret,
		missingSecretMessage:
			'Cannot store the phone device token without HOME_CONNECTOR_DATA_KEY.',
	})
	input.storage.db
		.query(
			`
				INSERT INTO phone_device_tokens (
					connector_id,
					token,
					updated_at
				) VALUES (?, ?, ?)
				ON CONFLICT(connector_id) DO UPDATE SET
					token = excluded.token,
					updated_at = excluded.updated_at
			`,
		)
		.run(input.connectorId, encryptedToken, new Date().toISOString())
	return getPhoneDeviceToken(input.storage, input.connectorId)
}

export function clearPhoneDeviceToken(
	storage: HomeConnectorStorage,
	connectorId: string,
) {
	storage.db
		.query(
			`
				DELETE FROM phone_device_tokens
				WHERE connector_id = ?
			`,
		)
		.run(connectorId)
}
