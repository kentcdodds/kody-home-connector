import { expect, test } from 'vitest'
import { createHomeConnectorStorage } from '../storage/index.ts'
import { createTestHomeConnectorConfig } from '../test-home-connector-config.ts'
import {
	consumeAuthorizationCode,
	hashOAuthSecret,
	insertAuthorizationCode,
	insertOAuthToken,
	readActiveOAuthToken,
	refreshTokenTtlSeconds,
	renewActiveRefreshToken,
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
			revokeOAuthToken(storage.db, tokenHash, now),
			revokeOAuthToken(storage.db, tokenHash, now),
			revokeOAuthToken(storage.db, tokenHash, now),
		])

		expect(results.filter(Boolean)).toHaveLength(1)
		expect(await revokeOAuthToken(storage.db, tokenHash, now)).toBe(false)
		expect(await readActiveOAuthToken(storage.db, tokenHash, now)).toBeNull()
	} finally {
		await storage.close()
	}
})

test('expired refresh tokens cannot be revoked for rotation', async () => {
	const storage = await createStorage()
	const tokenHash = hashOAuthSecret('expired-refresh')
	try {
		await insertOAuthToken(storage.db, {
			tokenHash,
			tokenKind: 'refresh',
			clientId: 'client',
			resource: 'https://example.com/mcp',
			scope: 'mcp',
			expiresAt: now,
			revokedAt: null,
		})
		expect(await revokeOAuthToken(storage.db, tokenHash, now)).toBe(false)
	} finally {
		await storage.close()
	}
})

test('renewing an active refresh token slides its expiry', async () => {
	const storage = await createStorage()
	const tokenHash = hashOAuthSecret('renew-refresh')
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
		expect(
			await renewActiveRefreshToken(storage.db, {
				tokenHash,
				clientId: 'client',
				nowSeconds: now,
			}),
		).toBe(true)
		const renewed = await readActiveOAuthToken(storage.db, tokenHash, now)
		expect(renewed?.expiresAt).toBe(now + refreshTokenTtlSeconds)
	} finally {
		await storage.close()
	}
})

test('expired or revoked refresh tokens cannot be renewed', async () => {
	const storage = await createStorage()
	const expiredHash = hashOAuthSecret('expired-renew')
	const revokedHash = hashOAuthSecret('revoked-renew')
	const otherClientHash = hashOAuthSecret('other-client-renew')
	try {
		await insertOAuthToken(storage.db, {
			tokenHash: expiredHash,
			tokenKind: 'refresh',
			clientId: 'client',
			resource: 'https://example.com/mcp',
			scope: 'mcp',
			expiresAt: now,
			revokedAt: null,
		})
		await insertOAuthToken(storage.db, {
			tokenHash: revokedHash,
			tokenKind: 'refresh',
			clientId: 'client',
			resource: 'https://example.com/mcp',
			scope: 'mcp',
			expiresAt: now + 60,
			revokedAt: null,
		})
		await insertOAuthToken(storage.db, {
			tokenHash: otherClientHash,
			tokenKind: 'refresh',
			clientId: 'client',
			resource: 'https://example.com/mcp',
			scope: 'mcp',
			expiresAt: now + 60,
			revokedAt: null,
		})
		expect(await revokeOAuthToken(storage.db, revokedHash, now)).toBe(true)
		expect(
			await renewActiveRefreshToken(storage.db, {
				tokenHash: expiredHash,
				clientId: 'client',
				nowSeconds: now,
			}),
		).toBe(false)
		expect(
			await renewActiveRefreshToken(storage.db, {
				tokenHash: revokedHash,
				clientId: 'client',
				nowSeconds: now,
			}),
		).toBe(false)
		expect(
			await renewActiveRefreshToken(storage.db, {
				tokenHash: otherClientHash,
				clientId: 'other-client',
				nowSeconds: now,
			}),
		).toBe(false)
	} finally {
		await storage.close()
	}
})
