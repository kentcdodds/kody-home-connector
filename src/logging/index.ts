import { type SQLInputValue } from 'node:sqlite'
import { type HomeConnectorConfig } from '../config.ts'
import { type HomeConnectorStorage } from '../storage/index.ts'

export const homeConnectorLogRetentionDays = 8

const homeConnectorLogRetentionMs =
	homeConnectorLogRetentionDays * 24 * 60 * 60 * 1000
const maxLogStringLength = 2_000
const maxLogArrayLength = 50
const maxLogObjectKeys = 100
const maxLogDepth = 6
const redactedValue = '[redacted]'

const urlPattern = /\b(?:https?|wss?):\/\/[^\s"'<>]+/gi
const inlineSecretPattern =
	/\b((?:token|secret|password|passwd|pwd|pin|api[_-]?key|authorization|cookie|set-cookie|session|credential|private[_-]?key|shared[_-]?secret|csrf|nonce)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi
const authorizationHeaderPattern =
	/\b(Authorization\s*[:=]\s*)(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi
const bearerTokenPattern = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi
const basicAuthPattern = /\b(Basic\s+)[A-Za-z0-9+/=-]+/gi

export type HomeConnectorLogLevel = 'debug' | 'info' | 'warn' | 'error'

export type HomeConnectorLogEntry = {
	id: number
	connectorId: string
	level: HomeConnectorLogLevel
	event: string
	message: string
	metadata: unknown
	createdAt: string
}

export type ListHomeConnectorLogsInput = {
	level?: HomeConnectorLogLevel
	event?: string
	query?: string
	since?: string
	until?: string
	beforeId?: number
	limit?: number
}

export type HomeConnectorLogger = {
	debug(
		event: string,
		message: string,
		metadata?: Record<string, unknown>,
	): void
	info(event: string, message: string, metadata?: Record<string, unknown>): void
	warn(event: string, message: string, metadata?: Record<string, unknown>): void
	error(
		event: string,
		message: string,
		metadata?: Record<string, unknown>,
	): void
	listLogs(input?: ListHomeConnectorLogsInput): Array<HomeConnectorLogEntry>
	pruneExpiredLogs(): void
}

type LoggerConsole = Pick<Console, 'debug' | 'info' | 'warn' | 'error'>

type HomeConnectorLogRow = {
	id: number
	connector_id: string
	level: string
	event: string
	message: string
	metadata_json: string
	created_at: string
}

function normalizeKey(value: string) {
	return value.replace(/[^a-z0-9]/gi, '').toLowerCase()
}

function isSensitiveKey(key: string) {
	const normalized = normalizeKey(key)
	return (
		normalized.includes('token') ||
		normalized.includes('secret') ||
		normalized.includes('password') ||
		normalized === 'pwd' ||
		normalized.endsWith('pwd') ||
		normalized === 'pin' ||
		normalized.endsWith('pin') ||
		normalized.includes('pincode') ||
		normalized.includes('apikey') ||
		normalized.includes('authorization') ||
		normalized.includes('cookie') ||
		normalized.includes('session') ||
		normalized.includes('credential') ||
		normalized.includes('privatekey') ||
		normalized.includes('sharedsecret') ||
		normalized.includes('csrf') ||
		normalized.includes('nonce')
	)
}

function trimTrailingUrlPunctuation(value: string) {
	let trailing = ''
	let url = value
	while (/[),.;!?]$/.test(url)) {
		trailing = `${url.at(-1) ?? ''}${trailing}`
		url = url.slice(0, -1)
	}
	return { url, trailing }
}

function redactUrl(value: string) {
	const { url, trailing } = trimTrailingUrlPunctuation(value)
	try {
		const parsed = new URL(url)
		if (parsed.username) parsed.username = redactedValue
		if (parsed.password) parsed.password = redactedValue
		for (const key of parsed.searchParams.keys()) {
			if (isSensitiveKey(key)) {
				parsed.searchParams.set(key, redactedValue)
			}
		}
		return `${parsed.toString()}${trailing}`
	} catch {
		return value
	}
}

function truncateLogString(value: string) {
	if (value.length <= maxLogStringLength) return value
	return `${value.slice(0, maxLogStringLength)}...[truncated]`
}

function sanitizeLogString(value: string) {
	const withRedactedUrls = value.replace(urlPattern, (match) =>
		redactUrl(match),
	)
	const withRedactedInlineSecrets = withRedactedUrls
		.replace(authorizationHeaderPattern, `$1${redactedValue}`)
		.replace(bearerTokenPattern, `$1${redactedValue}`)
		.replace(basicAuthPattern, `$1${redactedValue}`)
		.replace(inlineSecretPattern, `$1${redactedValue}`)
	return truncateLogString(withRedactedInlineSecrets)
}

function sanitizeError(error: Error, depth: number, seen: WeakSet<object>) {
	return {
		name: sanitizeLogString(error.name),
		message: sanitizeLogString(error.message),
		...(error.stack
			? { stack: sanitizeLogValue(error.stack, depth + 1, seen) }
			: {}),
	}
}

export function sanitizeLogValue(
	value: unknown,
	depth = 0,
	seen = new WeakSet<object>(),
): unknown {
	if (value == null) return value
	if (typeof value === 'string') return sanitizeLogString(value)
	if (typeof value === 'number' || typeof value === 'boolean') return value
	if (typeof value === 'bigint') return value.toString()
	if (typeof value === 'symbol') return value.toString()
	if (typeof value === 'function') return '[function]'
	if (value instanceof Date) return value.toISOString()
	if (value instanceof Error) return sanitizeError(value, depth, seen)
	if (typeof value !== 'object') return String(value)
	if (seen.has(value)) return '[circular]'
	if (depth >= maxLogDepth) return '[max-depth]'

	seen.add(value)
	if (Array.isArray(value)) {
		const entries = value
			.slice(0, maxLogArrayLength)
			.map((entry) => sanitizeLogValue(entry, depth + 1, seen))
		if (value.length > maxLogArrayLength) {
			entries.push(`[${String(value.length - maxLogArrayLength)} more item(s)]`)
		}
		return entries
	}

	const output: Record<string, unknown> = {}
	const entries = Object.entries(value).slice(0, maxLogObjectKeys)
	for (const [key, entryValue] of entries) {
		output[key] = isSensitiveKey(key)
			? redactedValue
			: sanitizeLogValue(entryValue, depth + 1, seen)
	}
	const totalKeys = Object.keys(value).length
	if (totalKeys > maxLogObjectKeys) {
		output['truncatedKeys'] = totalKeys - maxLogObjectKeys
	}
	return output
}

function parseMetadata(value: string) {
	try {
		return JSON.parse(value) as unknown
	} catch {
		return null
	}
}

function stringifyMetadata(metadata: Record<string, unknown>) {
	const sanitized = sanitizeLogMetadata(metadata)
	try {
		return JSON.stringify(sanitized)
	} catch {
		return JSON.stringify({ serializationError: true })
	}
}

function sanitizeLogMetadata(metadata: Record<string, unknown>) {
	const sanitized = sanitizeLogValue(metadata)
	return sanitized && typeof sanitized === 'object' && !Array.isArray(sanitized)
		? (sanitized as Record<string, unknown>)
		: {}
}

function mapLogRow(row: HomeConnectorLogRow): HomeConnectorLogEntry {
	return {
		id: Number(row.id),
		connectorId: row.connector_id,
		level: row.level as HomeConnectorLogLevel,
		event: row.event,
		message: row.message,
		metadata: parseMetadata(row.metadata_json),
		createdAt: row.created_at,
	}
}

function normalizeLimit(limit: number | undefined) {
	if (limit == null) return 100
	return Math.min(500, Math.max(1, Math.floor(limit)))
}

function stringifyConsoleLog(input: {
	level: HomeConnectorLogLevel
	event: string
	message: string
	metadata?: Record<string, unknown>
}) {
	const sanitizedMetadata = input.metadata
		? sanitizeLogMetadata(input.metadata)
		: {}
	return JSON.stringify({
		level: input.level,
		event: input.event,
		message: sanitizeLogString(input.message),
		...(Object.keys(sanitizedMetadata).length > 0
			? { metadata: sanitizedMetadata }
			: {}),
	})
}

export function createHomeConnectorLogger(input: {
	config: HomeConnectorConfig
	storage: HomeConnectorStorage
	console?: LoggerConsole
	now?: () => Date
}): HomeConnectorLogger {
	const consoleSink = input.console ?? console
	const now = input.now ?? (() => new Date())
	let nextPruneAt = 0

	function pruneExpiredLogs() {
		const cutoff = new Date(
			now().getTime() - homeConnectorLogRetentionMs,
		).toISOString()
		input.storage.db
			.query(
				`
			DELETE FROM home_connector_logs
			WHERE connector_id = ? AND created_at < ?
		`,
			)
			.run(input.config.homeConnectorId, cutoff)
		nextPruneAt = now().getTime() + 60 * 60 * 1000
	}

	function tryPruneExpiredLogs() {
		try {
			pruneExpiredLogs()
		} catch (error) {
			nextPruneAt = now().getTime() + 5 * 60 * 1000
			consoleSink.warn(
				stringifyConsoleLog({
					level: 'warn',
					event: 'logger.prune_failed',
					message: 'Failed to prune expired home connector log entries.',
					metadata: { error },
				}),
			)
		}
	}

	function writeConsole(
		level: HomeConnectorLogLevel,
		event: string,
		message: string,
		metadata: Record<string, unknown>,
	) {
		consoleSink[level](
			stringifyConsoleLog({
				level,
				event,
				message,
				metadata,
			}),
		)
	}

	function write(
		level: HomeConnectorLogLevel,
		event: string,
		message: string,
		metadata: Record<string, unknown> = {},
	) {
		writeConsole(level, event, message, metadata)
		const createdAt = now().toISOString()
		const sanitizedMessage = sanitizeLogString(message)
		const sanitizedMetadata = stringifyMetadata(metadata)
		if (now().getTime() >= nextPruneAt) {
			tryPruneExpiredLogs()
		}
		try {
			input.storage.db
				.query(
					`
				INSERT INTO home_connector_logs (
					connector_id,
					level,
					event,
					message,
					metadata_json,
					created_at
				) VALUES (?, ?, ?, ?, ?, ?)
			`,
				)
				.run(
					input.config.homeConnectorId,
					level,
					event,
					sanitizedMessage,
					sanitizedMetadata,
					createdAt,
				)
		} catch (error) {
			consoleSink.warn(
				stringifyConsoleLog({
					level: 'warn',
					event: 'logger.persist_failed',
					message: 'Failed to persist home connector log entry.',
					metadata: { error },
				}),
			)
		}
	}

	tryPruneExpiredLogs()

	return {
		debug(event, message, metadata) {
			write('debug', event, message, metadata)
		},
		info(event, message, metadata) {
			write('info', event, message, metadata)
		},
		warn(event, message, metadata) {
			write('warn', event, message, metadata)
		},
		error(event, message, metadata) {
			write('error', event, message, metadata)
		},
		listLogs(listInput = {}) {
			const params: Array<SQLInputValue> = [input.config.homeConnectorId]
			const clauses = ['connector_id = ?']
			const retentionCutoff = new Date(
				now().getTime() - homeConnectorLogRetentionMs,
			).toISOString()
			clauses.push('created_at >= ?')
			params.push(retentionCutoff)
			if (listInput.level) {
				clauses.push('level = ?')
				params.push(listInput.level)
			}
			if (listInput.event) {
				clauses.push('event = ?')
				params.push(listInput.event)
			}
			if (listInput.since) {
				clauses.push('created_at >= ?')
				params.push(listInput.since)
			}
			if (listInput.until) {
				clauses.push('created_at <= ?')
				params.push(listInput.until)
			}
			if (listInput.beforeId != null) {
				clauses.push('id < ?')
				params.push(Math.floor(listInput.beforeId))
			}
			if (listInput.query) {
				const query = `%${listInput.query}%`
				clauses.push('(event LIKE ? OR message LIKE ? OR metadata_json LIKE ?)')
				params.push(query, query, query)
			}
			params.push(normalizeLimit(listInput.limit))
			const rows = input.storage.db
				.query(
					`
				SELECT
					id,
					connector_id,
					level,
					event,
					message,
					metadata_json,
					created_at
				FROM home_connector_logs
				WHERE ${clauses.join(' AND ')}
				ORDER BY created_at DESC, id DESC
				LIMIT ?
			`,
				)
				.all(...params) as Array<HomeConnectorLogRow>
			return rows.map(mapLogRow)
		},
		pruneExpiredLogs,
	}
}
