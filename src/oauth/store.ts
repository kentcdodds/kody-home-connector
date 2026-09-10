import { createHash, randomBytes } from 'node:crypto'
import { and, gt, isNull, type TableRow } from 'remix/data-table'
import { type HomeConnectorDatabase } from '../storage/index.ts'
import { oauthAuthorizationCodes, oauthTokens } from '../storage/schema.ts'

export const mcpOAuthScope = 'mcp'
export const authorizationCodeTtlSeconds = 10 * 60
export const accessTokenTtlSeconds = 60 * 60
export const refreshTokenTtlSeconds = 30 * 24 * 60 * 60

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

export async function insertAuthorizationCode(
	db: HomeConnectorDatabase,
	record: OAuthAuthorizationCodeRecord,
) {
	await db.create(oauthAuthorizationCodes, {
		code_hash: record.codeHash,
		client_id: record.clientId,
		redirect_uri: record.redirectUri,
		code_challenge: record.codeChallenge,
		code_challenge_method: record.codeChallengeMethod,
		resource: record.resource,
		scope: record.scope,
		expires_at: record.expiresAt,
		consumed_at: record.consumedAt,
	})
}

export async function consumeAuthorizationCode(
	db: HomeConnectorDatabase,
	codeHash: string,
	nowSeconds: number,
): Promise<OAuthAuthorizationCodeRecord | null> {
	const row = await db.find(oauthAuthorizationCodes, { code_hash: codeHash })
	if (!row || row.consumed_at != null || row.expires_at <= nowSeconds) {
		return null
	}
	const consumed = await db.updateMany(
		oauthAuthorizationCodes,
		{ consumed_at: nowSeconds },
		{
			where: and(
				{ code_hash: codeHash },
				isNull('consumed_at'),
				gt('expires_at', nowSeconds),
			),
		},
	)
	if (consumed.affectedRows !== 1) return null
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

export async function insertOAuthToken(
	db: HomeConnectorDatabase,
	record: OAuthTokenRecord,
) {
	await db.create(oauthTokens, {
		token_hash: record.tokenHash,
		token_kind: record.tokenKind,
		client_id: record.clientId,
		resource: record.resource,
		scope: record.scope,
		expires_at: record.expiresAt,
		revoked_at: record.revokedAt,
	})
}

function mapOAuthTokenRow(row: TableRow<typeof oauthTokens>): OAuthTokenRecord {
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

export async function readActiveOAuthToken(
	db: HomeConnectorDatabase,
	tokenHash: string,
	nowSeconds: number,
): Promise<OAuthTokenRecord | null> {
	const row = await db.find(oauthTokens, { token_hash: tokenHash })
	if (!row || row.revoked_at != null || row.expires_at <= nowSeconds) {
		return null
	}
	return mapOAuthTokenRow(row)
}

export async function revokeOAuthToken(
	db: HomeConnectorDatabase,
	tokenHash: string,
): Promise<boolean> {
	const revoked = await db.updateMany(
		oauthTokens,
		{ revoked_at: Math.floor(Date.now() / 1000) },
		{ where: and({ token_hash: tokenHash }, isNull('revoked_at')) },
	)
	return revoked.affectedRows === 1
}
