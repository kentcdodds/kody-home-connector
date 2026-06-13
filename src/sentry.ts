import * as Sentry from '@sentry/node'

type EnvRecord = Record<string, string | undefined>
type SentryContextValue = Record<string, unknown> | undefined
type SentryContextMap = Record<string, SentryContextValue>
type HomeConnectorSentryLevel =
	| 'fatal'
	| 'error'
	| 'warning'
	| 'log'
	| 'info'
	| 'debug'

export type HomeConnectorErrorCaptureContext = {
	tags?: Record<string, string>
	contexts?: SentryContextMap
	extra?: Record<string, unknown>
	fingerprint?: Array<string>
	level?: HomeConnectorSentryLevel
	shouldCapture?: boolean
	dedupe?: {
		key: string
		ttlMs: number
	}
}

type HomeConnectorErrorWithCaptureContext = {
	homeConnectorCaptureContext?: HomeConnectorErrorCaptureContext
}

const defaultTracesSampleRate = 1.0

let hasInitializedHomeConnectorSentry = false
const exceptionDedupeExpirations = new Map<string, number>()

function parseSentryTracesSampleRate(value: string | undefined) {
	const trimmedValue = value?.trim()
	if (!trimmedValue) {
		return defaultTracesSampleRate
	}

	const parsedValue = Number.parseFloat(trimmedValue)
	if (Number.isFinite(parsedValue) && parsedValue >= 0 && parsedValue <= 1) {
		return parsedValue
	}

	return defaultTracesSampleRate
}

function normalizeError(error: unknown) {
	return error instanceof Error ? error : new Error(String(error))
}

function mergeContextRecords(
	base: SentryContextMap | undefined,
	override: SentryContextMap | undefined,
) {
	if (!base && !override) return undefined
	const merged: SentryContextMap = {}
	for (const [key, value] of Object.entries(base ?? {})) {
		merged[key] = value ? { ...value } : undefined
	}
	for (const [key, value] of Object.entries(override ?? {})) {
		merged[key] =
			value === undefined
				? undefined
				: {
						...merged[key],
						...value,
					}
	}
	return merged
}

function shouldSkipForDedupe(
	dedupe: HomeConnectorErrorCaptureContext['dedupe'],
) {
	if (!dedupe) return false
	const key = dedupe.key.trim()
	const ttlMs = Math.max(0, dedupe.ttlMs)
	if (!key || ttlMs === 0) return false
	const now = Date.now()
	for (const [cachedKey, expiresAt] of exceptionDedupeExpirations) {
		if (expiresAt <= now) {
			exceptionDedupeExpirations.delete(cachedKey)
		}
	}
	const expiresAt = exceptionDedupeExpirations.get(key)
	if (expiresAt && expiresAt > now) {
		return true
	}
	exceptionDedupeExpirations.set(key, now + ttlMs)
	return false
}

export function getHomeConnectorErrorCaptureContext(
	error: unknown,
): HomeConnectorErrorCaptureContext {
	if (!error || typeof error !== 'object') {
		return {}
	}

	const captureContext = (error as HomeConnectorErrorWithCaptureContext)
		.homeConnectorCaptureContext
	if (!captureContext) {
		return {}
	}

	return {
		...(captureContext.tags ? { tags: { ...captureContext.tags } } : {}),
		...(captureContext.contexts
			? {
					contexts: Object.fromEntries(
						Object.entries(captureContext.contexts).map(([key, value]) => [
							key,
							value ? { ...value } : undefined,
						]),
					),
				}
			: {}),
		...(captureContext.extra ? { extra: { ...captureContext.extra } } : {}),
		...(captureContext.fingerprint
			? { fingerprint: [...captureContext.fingerprint] }
			: {}),
		...(captureContext.level ? { level: captureContext.level } : {}),
		...(captureContext.shouldCapture === false ? { shouldCapture: false } : {}),
		...(captureContext.dedupe ? { dedupe: { ...captureContext.dedupe } } : {}),
	}
}

export function buildHomeConnectorSentryOptions(env: EnvRecord = process.env) {
	const dsn = env.SENTRY_DSN?.trim()
	if (!dsn) {
		return undefined
	}

	const environment =
		env.SENTRY_ENVIRONMENT?.trim() || env.NODE_ENV?.trim() || 'development'
	const release = env.APP_COMMIT_SHA?.trim()

	return {
		dsn,
		environment,
		...(release ? { release } : {}),
		// Default 1.0 = full trace sampling (low-traffic / personal use). Override
		// with `SENTRY_TRACES_SAMPLE_RATE` (for example `0.1`) if event volume grows.
		tracesSampleRate: parseSentryTracesSampleRate(
			env.SENTRY_TRACES_SAMPLE_RATE,
		),
		sendDefaultPii: false,
	}
}

export function initializeHomeConnectorSentry(env: EnvRecord = process.env) {
	if (hasInitializedHomeConnectorSentry || Sentry.isEnabled()) {
		return
	}

	const options = buildHomeConnectorSentryOptions(env)
	if (!options) {
		return
	}

	Sentry.init(options)
	Sentry.setTag('service', 'home-connector')

	const homeConnectorId = env.HOME_CONNECTOR_ID?.trim()
	if (homeConnectorId) {
		Sentry.setTag('home_connector_id', homeConnectorId)
	}

	const workerBaseUrl = env.WORKER_BASE_URL?.trim()
	if (workerBaseUrl) {
		Sentry.setContext('home_connector', {
			workerBaseUrl,
		})
	}

	hasInitializedHomeConnectorSentry = true
}

export function captureHomeConnectorException(
	error: unknown,
	captureContext: Parameters<typeof Sentry.captureException>[1] = {},
) {
	if (!Sentry.isEnabled()) {
		return
	}

	const derivedCaptureContext = getHomeConnectorErrorCaptureContext(error)
	const { shouldCapture, dedupe, ...derivedSentryCaptureContext } =
		derivedCaptureContext
	if (shouldCapture === false || shouldSkipForDedupe(dedupe)) {
		return
	}

	Sentry.captureException(normalizeError(error), {
		...derivedSentryCaptureContext,
		...captureContext,
		tags: {
			service: 'home-connector',
			...derivedSentryCaptureContext.tags,
			...captureContext.tags,
		},
		contexts: mergeContextRecords(
			derivedSentryCaptureContext.contexts,
			captureContext.contexts as SentryContextMap | undefined,
		),
		extra: {
			...derivedSentryCaptureContext.extra,
			...captureContext.extra,
		},
	})
}

export function resetHomeConnectorSentryDedupeForTests() {
	exceptionDedupeExpirations.clear()
}

export function captureHomeConnectorMessage(
	message: string,
	captureContext: Exclude<
		Parameters<typeof Sentry.captureMessage>[1],
		string
	> = {},
) {
	if (!Sentry.isEnabled()) {
		return
	}

	Sentry.captureMessage(message, {
		...captureContext,
		tags: {
			service: 'home-connector',
			...captureContext.tags,
		},
	})
}

export function addHomeConnectorSentryBreadcrumb(input: {
	message: string
	category: string
	level?: 'info' | 'warning' | 'error'
	data?: Record<string, unknown>
}) {
	if (!Sentry.isEnabled()) {
		return
	}

	Sentry.addBreadcrumb({
		type: 'default',
		category: input.category,
		message: input.message,
		level: input.level ?? 'info',
		data: {
			service: 'home-connector',
			...input.data,
		},
	})
}

export async function flushHomeConnectorSentry(timeout = 2_000) {
	if (!Sentry.isEnabled()) {
		return true
	}

	return Sentry.flush(timeout)
}

export async function closeHomeConnectorSentry(timeout = 2_000) {
	if (!Sentry.isEnabled()) {
		return true
	}

	return Sentry.close(timeout)
}
