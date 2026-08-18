import { createHash, randomBytes } from 'node:crypto'
import { type HomeConnectorStorage } from '../storage/index.ts'

export const mcpOAuthScope = 'mcp'
export const authorizationCodeTtlSeconds = 10 * 60
export const accessTokenTtlSeconds = 60 * 60
export const refreshTokenTtlSeconds = 30 * 24 * 60 * 60

type SqliteDatabase = HomeConnectorStorage['db']

export type OAuthAuthorizationCodeRecord = {
	codeHash: string
	clientId: string
	redirectUri: string
	codeChallenge: string
	codeChallengeMethod: string
	resource: string
	scope: string
	expiresAt: number
	consumedAt: number | null
}

export type OAuthTokenRecord = {
	tokenHash: string
	tokenKind: 'access' | 'refresh'
	clientId: string
	resource: string
	scope: string
	expiresAt: number
	revokedAt: number | null
}

export function hashOAuthSecret(value: string) {
	return createHash('sha256').update(value).digest('hex')
}

export function createOAuthSecret() {
	return randomBytes(32).toString('base64url')
}

export function initializeOAuthSchema(db: SqliteDatabase) {
	db.exec(`
		CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
			code_hash TEXT PRIMARY KEY NOT NULL,
			client_id TEXT NOT NULL,
			redirect_uri TEXT NOT NULL,
			code_challenge TEXT NOT NULL,
			code_challenge_method TEXT NOT NULL,
			resource TEXT NOT NULL,
			scope TEXT NOT NULL,
			expires_at INTEGER NOT NULL,
			consumed_at INTEGER
		);

		CREATE TABLE IF NOT EXISTS oauth_tokens (
			token_hash TEXT PRIMARY KEY NOT NULL,
			token_kind TEXT NOT NULL,
			client_id TEXT NOT NULL,
			resource TEXT NOT NULL,
			scope TEXT NOT NULL,
			expires_at INTEGER NOT NULL,
			revoked_at INTEGER
		);
	`)
}

export function insertAuthorizationCode(
	db: SqliteDatabase,
	record: OAuthAuthorizationCodeRecord,
) {
	db.query(
		`INSERT INTO oauth_authorization_codes (
			code_hash, client_id, redirect_uri, code_challenge,
			code_challenge_method, resource, scope, expires_at, consumed_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		record.codeHash,
		record.clientId,
		record.redirectUri,
		record.codeChallenge,
		record.codeChallengeMethod,
		record.resource,
		record.scope,
		record.expiresAt,
		record.consumedAt,
	)
}

export function consumeAuthorizationCode(
	db: SqliteDatabase,
	codeHash: string,
	nowSeconds: number,
): OAuthAuthorizationCodeRecord | null {
	const row = db
		.query(
			`SELECT code_hash, client_id, redirect_uri, code_challenge,
				code_challenge_method, resource, scope, expires_at, consumed_at
			FROM oauth_authorization_codes WHERE code_hash = ?`,
		)
		.get(codeHash) as
		| {
				code_hash: string
				client_id: string
				redirect_uri: string
				code_challenge: string
				code_challenge_method: string
				resource: string
				scope: string
				expires_at: number
				consumed_at: number | null
		  }
		| undefined
	if (!row || row.consumed_at != null || row.expires_at <= nowSeconds) {
		return null
	}
	db.query(
		`UPDATE oauth_authorization_codes SET consumed_at = ? WHERE code_hash = ?`,
	).run(nowSeconds, codeHash)
	return {
		codeHash: row.code_hash,
		clientId: row.client_id,
		redirectUri: row.redirect_uri,
		codeChallenge: row.code_challenge,
		codeChallengeMethod: row.code_challenge_method,
		resource: row.resource,
		scope: row.scope,
		expiresAt: row.expires_at,
		consumedAt: nowSeconds,
	}
}

export function insertOAuthToken(db: SqliteDatabase, record: OAuthTokenRecord) {
	db.query(
		`INSERT INTO oauth_tokens (
			token_hash, token_kind, client_id, resource, scope, expires_at, revoked_at
		) VALUES (?, ?, ?, ?, ?, ?, ?)`,
	).run(
		record.tokenHash,
		record.tokenKind,
		record.clientId,
		record.resource,
		record.scope,
		record.expiresAt,
		record.revokedAt,
	)
}

export function readActiveOAuthToken(
	db: SqliteDatabase,
	tokenHash: string,
	nowSeconds: number,
): OAuthTokenRecord | null {
	const row = db
		.query(
			`SELECT token_hash, token_kind, client_id, resource, scope, expires_at, revoked_at
			FROM oauth_tokens WHERE token_hash = ?`,
		)
		.get(tokenHash) as
		| {
				token_hash: string
				token_kind: 'access' | 'refresh'
				client_id: string
				resource: string
				scope: string
				expires_at: number
				revoked_at: number | null
		  }
		| undefined
	if (!row || row.revoked_at != null || row.expires_at <= nowSeconds) {
		return null
	}
	return {
		tokenHash: row.token_hash,
		tokenKind: row.token_kind,
		clientId: row.client_id,
		resource: row.resource,
		scope: row.scope,
		expiresAt: row.expires_at,
		revokedAt: row.revoked_at,
	}
}

export function revokeOAuthToken(db: SqliteDatabase, tokenHash: string) {
	db.query(`UPDATE oauth_tokens SET revoked_at = ? WHERE token_hash = ?`).run(
		Math.floor(Date.now() / 1000),
		tokenHash,
	)
}
