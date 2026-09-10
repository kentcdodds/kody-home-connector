import { expect, test } from 'vitest'
import { createHomeConnectorStorage } from '../storage/index.ts'
import { createTestHomeConnectorConfig } from '../test-home-connector-config.ts'
import {
	consumeAuthorizationCode,
	hashOAuthSecret,
	insertAuthorizationCode,
	insertOAuthToken,
	readActiveOAuthToken,
	revokeOAuthToken,
} from './store.ts'

const now = 1_800_000_000

async function createStorage() {
	return createHomeConnectorStorage(createTestHomeConnectorConfig())
}

test('concurrent authorization code consumption succeeds exactly once', async () => {
	const storage = await createStorage()
	const codeHash = hashOAuthSecret('code')
	try {
		await insertAuthorizationCode(storage.db, {
			codeHash,
			clientId: 'client',
			redirectUri: 'https://example.com/callback',
			codeChallenge: 'challenge',
			codeChallengeMethod: 'S256',
			resource: 'https://example.com/mcp',
			scope: 'mcp',
			expiresAt: now + 60,
			consumedAt: null,
		})

		const results = await Promise.all([
			consumeAuthorizationCode(storage.db, codeHash, now),
			consumeAuthorizationCode(storage.db, codeHash, now),
			consumeAuthorizationCode(storage.db, codeHash, now),
		])

		expect(results.filter(Boolean)).toHaveLength(1)
		expect(await consumeAuthorizationCode(storage.db, codeHash, now)).toBeNull()
	} finally {
		await storage.close()
	}
})

test('expired authorization codes cannot be consumed', async () => {
	const storage = await createStorage()
	const codeHash = hashOAuthSecret('expired')
	try {
		await insertAuthorizationCode(storage.db, {
			codeHash,
			clientId: 'client',
			redirectUri: 'https://example.com/callback',
			codeChallenge: 'challenge',
			codeChallengeMethod: 'S256',
			resource: 'https://example.com/mcp',
			scope: 'mcp',
			expiresAt: now,
			consumedAt: null,
		})
		expect(await consumeAuthorizationCode(storage.db, codeHash, now)).toBeNull()
	} finally {
		await storage.close()
	}
})

test('concurrent refresh token revocation succeeds exactly once', async () => {
	const storage = await createStorage()
	const tokenHash = hashOAuthSecret('refresh')
	try {
		await insertOAuthToken(storage.db, {
			tokenHash,
			tokenKind: 'refresh',
			clientId: 'client',
			resource: 'https://example.com/mcp',
			scope: 'mcp',
			expiresAt: now + 60,
			revokedAt: null,
		})

		const results = await Promise.all([
			revokeOAuthToken(storage.db, tokenHash),
			revokeOAuthToken(storage.db, tokenHash),
			revokeOAuthToken(storage.db, tokenHash),
		])

		expect(results.filter(Boolean)).toHaveLength(1)
		expect(await revokeOAuthToken(storage.db, tokenHash)).toBe(false)
		expect(await readActiveOAuthToken(storage.db, tokenHash, now)).toBeNull()
	} finally {
		await storage.close()
	}
})
