import { decryptSecret, encryptSecret } from '../../storage/encrypted-secret.ts'
import { type HomeConnectorStorage } from '../../storage/index.ts'
import { phoneDeviceTokens } from '../../storage/schema.ts'

export async function getPhoneDeviceToken(
	storage: HomeConnectorStorage,
	connectorId: string,
) {
	const row = await storage.db.find(phoneDeviceTokens, {
		connector_id: connectorId,
	})
	if (!row) return null
	return decryptSecret(row.token, storage.sharedSecret)
}

export async function hasStoredPhoneDeviceToken(
	storage: HomeConnectorStorage,
	connectorId: string,
) {
	const row = await storage.db.find(phoneDeviceTokens, {
		connector_id: connectorId,
	})
	return Boolean(row)
}

export async function savePhoneDeviceToken(input: {
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
	await input.storage.db.query(phoneDeviceTokens).upsert({
		connector_id: input.connectorId,
		token: encryptedToken,
	})
	return getPhoneDeviceToken(input.storage, input.connectorId)
}

export async function clearPhoneDeviceToken(
	storage: HomeConnectorStorage,
	connectorId: string,
) {
	await storage.db.delete(phoneDeviceTokens, { connector_id: connectorId })
}
