import { timingSafeEqual } from 'node:crypto'
import {
	phoneTokenNotConfiguredError,
	phoneWebSocketPath,
	type PhoneUpgradeAuthorization,
	type PhoneUpgradeHeaders,
	type PhoneUpgradeRequest,
} from './types.ts'

function headerValue(
	headers: PhoneUpgradeHeaders,
	name: string,
): string | undefined {
	const raw = headers[name] ?? headers[name.toLowerCase()]
	if (Array.isArray(raw)) {
		const first = raw[0]
		return typeof first === 'string' ? first : undefined
	}
	return typeof raw === 'string' ? raw : undefined
}

function trimToken(value: string | null | undefined) {
	const trimmed = value?.trim()
	return trimmed ? trimmed : null
}

function readQueryToken(url: string | undefined) {
	try {
		const token = new URL(url ?? '/', 'http://localhost').searchParams.get(
			'token',
		)
		return trimToken(token)
	} catch {
		return null
	}
}

function readBearerToken(headers: PhoneUpgradeHeaders) {
	const authorization = headerValue(headers, 'authorization')
	if (!authorization) return null
	const match = /^Bearer\s+(\S+)/i.exec(authorization)
	return trimToken(match?.[1])
}

export function extractPhoneDeviceToken(request: PhoneUpgradeRequest) {
	return (
		readQueryToken(request.url) ??
		trimToken(headerValue(request.headers, 'x-phone-token')) ??
		readBearerToken(request.headers)
	)
}

export function getUpgradePathname(url: string | undefined) {
	try {
		return new URL(url ?? '/', 'http://localhost').pathname
	} catch {
		return ''
	}
}

export function isPhoneWebSocketUpgradePath(pathname: string) {
	return pathname === phoneWebSocketPath
}

function tokensEqual(expected: string, actual: string) {
	const expectedBuffer = Buffer.from(expected)
	const actualBuffer = Buffer.from(actual)
	if (expectedBuffer.length !== actualBuffer.length) {
		timingSafeEqual(actualBuffer, actualBuffer)
		return false
	}
	return timingSafeEqual(expectedBuffer, actualBuffer)
}

export function authorizePhoneUpgrade(input: {
	request: PhoneUpgradeRequest
	expectedToken: string | null
}): PhoneUpgradeAuthorization {
	if (!input.expectedToken) {
		return {
			ok: false,
			status: 503,
			statusText: 'Service Unavailable',
			reason: phoneTokenNotConfiguredError.message,
		}
	}

	const presentedToken = extractPhoneDeviceToken(input.request)
	if (!presentedToken || !tokensEqual(input.expectedToken, presentedToken)) {
		return {
			ok: false,
			status: 401,
			statusText: 'Unauthorized',
			reason: 'invalid phone device token',
		}
	}

	return { ok: true }
}
