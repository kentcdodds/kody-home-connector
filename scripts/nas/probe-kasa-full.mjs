import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const host = process.env.HOST?.trim()
if (!host) {
	console.error('Missing HOST environment variable.')
	process.exit(1)
}

const report = {
	host,
	appCommitSha: process.env.APP_COMMIT_SHA ?? null,
	credentialEnvMeta: null,
	credentialStoredMeta: null,
	tests: {},
}

function describeCredentialField(value, kind) {
	if (value == null || value === '') {
		return { set: false, kind }
	}
	const raw = String(value)
	const trimmed = raw.trim()
	const wrappedInDoubleQuotes =
		trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')
	const unquoted = wrappedInDoubleQuotes ? trimmed.slice(1, -1) : trimmed
	return {
		set: true,
		kind,
		charLength: raw.length,
		trimmedCharLength: trimmed.length,
		unquotedCharLength: unquoted.length,
		hasLeadingOrTrailingWhitespace: raw.length !== trimmed.length,
		wrappedInDoubleQuotes,
		looksLikeEmail: kind === 'username' && unquoted.includes('@'),
		reasonableLength:
			kind === 'username'
				? unquoted.length >= 3 && unquoted.length <= 320
				: unquoted.length >= 1 && unquoted.length <= 256,
	}
}

function describeCredentialPair(username, password, source) {
	return {
		source,
		username: describeCredentialField(username, 'username'),
		password: describeCredentialField(password, 'password'),
		pairLooksUsable:
			Boolean(username?.trim()) &&
			Boolean(password?.trim()) &&
			describeCredentialField(username, 'username').reasonableLength !==
				false &&
			describeCredentialField(password, 'password').reasonableLength !== false,
	}
}

function normalizeCredentialValue(value) {
	const trimmed = String(value).trim()
	if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
		return trimmed.slice(1, -1)
	}
	return trimmed
}

function rawHandshake1() {
	const localSeed = randomBytes(16)
	const headerBlock = [
		'POST /app/handshake1 HTTP/1.1',
		`Host: ${host}`,
		'Content-Type: application/octet-stream',
		`Content-Length: ${String(localSeed.length)}`,
		'Connection: close',
		'',
		'',
	].join('\r\n')
	return new Promise((resolve, reject) => {
		const chunks = []
		const socket = net.connect({ host, port: 80, family: 4, timeout: 8000 })
		socket.on('connect', () => {
			socket.end(Buffer.concat([Buffer.from(headerBlock, 'utf8'), localSeed]))
		})
		socket.on('data', (c) =>
			chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)),
		)
		socket.on('error', reject)
		socket.on('timeout', () => reject(new Error('timeout')))
		socket.on('end', () => {
			const raw = Buffer.concat(chunks)
			const headerEnd = raw.indexOf('\r\n\r\n')
			const headers =
				headerEnd >= 0 ? raw.subarray(0, headerEnd).toString('utf8') : ''
			const body = headerEnd >= 0 ? raw.subarray(headerEnd + 4) : raw
			const cl = headers.match(/^content-length:\s*(\d+)/im)?.[1] ?? null
			resolve({
				rawLen: raw.length,
				bodyLen: body.length,
				contentLength: cl,
				hasSetCookie: /set-cookie:/i.test(headers),
				statusLine: raw
					.subarray(0, Math.max(0, raw.indexOf('\r\n')))
					.toString('utf8'),
			})
		})
	})
}

function nodeHandshake1() {
	const localSeed = randomBytes(16)
	return new Promise((resolve, reject) => {
		const req = http.request(
			{
				hostname: host,
				port: 80,
				path: '/app/handshake1',
				method: 'POST',
				family: 4,
				headers: {
					'Content-Type': 'application/octet-stream',
					'Content-Length': localSeed.length,
					Connection: 'close',
				},
				timeout: 8000,
			},
			(res) => {
				const chunks = []
				res.on('data', (c) => chunks.push(c))
				res.on('end', () => {
					const body = Buffer.concat(chunks)
					resolve({
						status: res.statusCode,
						bodyLen: body.length,
						contentLength: res.headers['content-length'] ?? null,
						hasCookie: Boolean(res.headers['set-cookie']),
					})
				})
			},
		)
		req.on('error', reject)
		req.end(localSeed)
	})
}

async function testFullKlap(credentials, label) {
	const { createKasaKlapClient } = await import(
		pathToFileURL(path.join(process.cwd(), 'src/adapters/kasa/klap-client.ts'))
			.href
	)
	try {
		const client = createKasaKlapClient({
			host,
			credentials,
			timeoutMs: 8_000,
		})
		const info = await client.getSysInfo()
		return {
			ok: true,
			source: label,
			alias: info.alias ?? info.nickname ?? null,
			model: info.model ?? null,
			authLabel: client.authLabel,
			usedConfiguredCredentials: client.usedConfiguredCredentials,
		}
	} catch (error) {
		return {
			ok: false,
			source: label,
			error: error instanceof Error ? error.message : String(error),
		}
	}
}

function wrapReadonlySqliteDatabase(dbPath) {
	const db = new DatabaseSync(dbPath, { readonly: true })
	return {
		exec(sql) {
			db.exec(sql)
		},
		query(sql) {
			const statement = db.prepare(sql)
			return {
				all(...params) {
					return statement.all(...params)
				},
				get(...params) {
					return statement.get(...params)
				},
				run(...params) {
					return statement.run(...params)
				},
			}
		},
		close() {
			db.close()
		},
	}
}

async function loadStoredCredentials() {
	const dataPath = process.env.HOME_CONNECTOR_DATA_PATH?.trim()
	const sharedSecret = process.env.HOME_CONNECTOR_SHARED_SECRET?.trim()
	const connectorId = process.env.HOME_CONNECTOR_ID?.trim() ?? 'default'
	if (!dataPath || !sharedSecret) return null

	const dbPath = path.join(dataPath, 'home-connector.sqlite')
	const db = wrapReadonlySqliteDatabase(dbPath)
	const storage = {
		db,
		sharedSecret,
		close() {
			db.close()
		},
	}
	try {
		const { getKasaCredentials } = await import(
			pathToFileURL(path.join(process.cwd(), 'src/adapters/kasa/repository.ts'))
				.href
		)
		return getKasaCredentials(storage, connectorId)
	} finally {
		storage.close()
	}
}

try {
	const rawEnvUsername = process.env.KASA_USERNAME
	const rawEnvPassword = process.env.KASA_PASSWORD
	report.credentialEnvMeta = describeCredentialPair(
		rawEnvUsername,
		rawEnvPassword,
		'env-file',
	)

	report.tests.rawHandshake1 = await rawHandshake1()
	report.tests.nodeHandshake1 = await nodeHandshake1()

	if (rawEnvUsername?.trim() && rawEnvPassword?.trim()) {
		report.tests.fullKlapEnv = await testFullKlap(
			{
				username: rawEnvUsername.trim(),
				password: rawEnvPassword.trim(),
			},
			'env-file-as-loaded',
		)

		const envMeta = report.credentialEnvMeta
		if (
			envMeta.username.wrappedInDoubleQuotes ||
			envMeta.password.wrappedInDoubleQuotes
		) {
			report.tests.fullKlapEnvNormalized = await testFullKlap(
				{
					username: normalizeCredentialValue(rawEnvUsername),
					password: normalizeCredentialValue(rawEnvPassword),
				},
				'env-file-quotes-stripped',
			)
			report.credentialEnvMeta.note =
				'Docker --env-file may pass quote characters literally; fullKlapEnvNormalized tests the same values with surrounding double quotes removed.'
		}
	} else {
		report.tests.fullKlapEnv = {
			skipped: true,
			reason: 'KASA_USERNAME or KASA_PASSWORD missing/empty in container env',
		}
	}

	const stored = await loadStoredCredentials().catch((error) => {
		report.credentialStoredMeta = {
			source: 'connector-sqlite',
			loaded: false,
			error: error instanceof Error ? error.message : String(error),
		}
		report.tests.fullKlapStored = {
			skipped: true,
			reason: report.credentialStoredMeta.error,
		}
		return null
	})
	if (stored) {
		report.credentialStoredMeta = describeCredentialPair(
			stored.username,
			stored.password,
			'connector-sqlite',
		)
		report.tests.fullKlapStored = await testFullKlap(
			{ username: stored.username, password: stored.password },
			'connector-sqlite',
		)
	} else if (!report.credentialStoredMeta) {
		report.credentialStoredMeta = {
			source: 'connector-sqlite',
			loaded: false,
			reason:
				'No HOME_CONNECTOR_DATA_PATH/HOME_CONNECTOR_SHARED_SECRET, sqlite missing, or no stored row',
		}
		report.tests.fullKlapStored = {
			skipped: true,
			reason: report.credentialStoredMeta.reason,
		}
	}

	console.log(JSON.stringify(report, null, 2))
} catch (error) {
	console.error(
		JSON.stringify(
			{
				host,
				fatal: error instanceof Error ? error.message : String(error),
			},
			null,
			2,
		),
	)
	process.exit(1)
}
