import {
	courtSonyCameraNotThePlayer,
	type SonyIrccDisconnectReason,
} from './types.ts'

export function normalizeSonyIrccHost(value: string | null | undefined) {
	const trimmed = value?.trim() ?? ''
	if (!trimmed) return null
	return trimmed
		.replace(/^https?:\/\//i, '')
		.replace(/\/.*$/, '')
		.toLowerCase()
}

export function normalizeSonyIrccMacAddress(value: string | null | undefined) {
	if (!value) return null
	const hex = value.replaceAll(/[^0-9A-Fa-f]/g, '').toUpperCase()
	if (hex.length !== 12) return null
	return hex.match(/.{2}/g)?.join(':') ?? null
}

export function isBlockedSonyCamera(input: {
	host?: string | null
	macAddress?: string | null
}) {
	const host = normalizeSonyIrccHost(input.host)
	const mac = normalizeSonyIrccMacAddress(input.macAddress)
	return (
		host === courtSonyCameraNotThePlayer.host ||
		mac === courtSonyCameraNotThePlayer.macAddress
	)
}

export function blockedSonyCameraReason(): {
	reason: string
	reasonCode: SonyIrccDisconnectReason
} {
	return {
		reason: courtSonyCameraNotThePlayer.reason,
		reasonCode: 'blocked_sony_camera',
	}
}

export function looksLikeSonyIrccDocument(body: string) {
	const text = body.toLowerCase()
	if (!text.trim()) return false
	const mentionsCameraOnly =
		(text.includes('bisyamon') ||
			text.includes('sonycamera') ||
			/\bcamera\b/.test(text)) &&
		!text.includes('ircc')
	if (mentionsCameraOnly) return false
	return (
		text.includes('urn:schemas-sony-com:service:ircc') ||
		text.includes('urn:schemas-sony-com:serviceid:ircc') ||
		text.includes('x_sendircc') ||
		text.includes('getremotecommandlist') ||
		(text.includes('ircc') &&
			(text.includes('controlurl') ||
				text.includes('actionlist') ||
				text.includes('mediarenderer') ||
				text.includes('bluray') ||
				text.includes('bdplayer')))
	)
}

export function extractXmlTag(body: string, tagNames: Array<string>) {
	for (const tagName of tagNames) {
		const match = new RegExp(`<${tagName}[^>]*>([^<]+)</${tagName}>`, 'i').exec(
			body,
		)
		const value = match?.[1]?.trim()
		if (value) return value
	}
	return null
}

export function extractIrccControlUrl(input: {
	host: string
	body: string
	baseUrl?: string
}) {
	const controlPath = extractXmlTag(input.body, ['controlURL', 'controlUrl'])
	if (!controlPath) return null
	if (/^https?:\/\//i.test(controlPath)) return controlPath
	const path = controlPath.startsWith('/') ? controlPath : `/${controlPath}`
	if (input.baseUrl) {
		try {
			return new URL(path, input.baseUrl).toString()
		} catch {
			// fall through to host + default IRCC port
		}
	}
	return `http://${input.host}:50001${path}`
}

export function buildSonyIrccPlayerId(host: string) {
	const normalized = normalizeSonyIrccHost(host) ?? host
	return `sony-ircc-${normalized.replaceAll(/[^a-z0-9]+/g, '-')}`
}
