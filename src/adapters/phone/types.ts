export const phoneProtocolVersion = 1 as const
export const phoneWebSocketPath = '/phone/ws'
export const phoneDefaultRpcTimeoutMs = 25_000
export const phoneMdnsScanTimeoutMs = 60_000
export const defaultCastMdnsServiceType = '_googlecast._tcp'

export const teslaPackageName = 'com.teslamotors.tesla'
export const googleHomePackageName = 'com.google.android.apps.chromecast.app'
export const youtubePackageName = 'com.google.android.youtube'
export const gmsPackageName = 'com.google.android.gms'

export const defaultPhonePermissionPackages = [
	teslaPackageName,
	googleHomePackageName,
	youtubePackageName,
	gmsPackageName,
] as const

export const phoneOfflineError = {
	code: 'phone_offline',
	message: 'No Android companion is connected.',
} as const

export const phoneTokenNotConfiguredError = {
	code: 'phone_token_not_configured',
	message: 'Phone token not configured.',
} as const

export const phoneTimeoutError = {
	code: 'phone_timeout',
	message: 'The Android companion did not respond before the RPC timeout.',
} as const

export type PhoneHelloInfo = {
	protocolVersion: typeof phoneProtocolVersion
	deviceId: string
	deviceName: string
	androidVersion: string
	sdkInt: number
	appVersion: string
}

export type PhoneHelloMessage = PhoneHelloInfo & {
	type: 'hello'
}

export type PhoneHelloAckMessage = {
	type: 'hello_ack'
	protocolVersion: typeof phoneProtocolVersion
}

export type PhoneCallMessage = {
	type: 'call'
	id: string
	tool: string
	args: Record<string, unknown>
}

export type PhoneResultError = {
	code: string
	message: string
}

export type PhoneResultMessage =
	| {
			type: 'result'
			id: string
			ok: true
			payload: unknown
	  }
	| {
			type: 'result'
			id: string
			ok: false
			error: PhoneResultError
	  }

export type PhonePingMessage = {
	type: 'ping'
	id: string
}

export type PhonePongMessage = {
	type: 'pong'
	id: string
}

export type PhoneClientMessage =
	| PhoneHelloMessage
	| PhoneResultMessage
	| PhonePingMessage
	| PhonePongMessage

export type PhoneServerMessage =
	| PhoneHelloAckMessage
	| PhoneCallMessage
	| PhonePingMessage
	| PhonePongMessage

export type PhoneStructuredError = {
	ok: false
	error: PhoneResultError
}

export type PhoneCallSuccess<T = unknown> = {
	ok: true
	payload: T
}

export type PhoneCallResult<T = unknown> =
	| PhoneCallSuccess<T>
	| PhoneStructuredError

export type PhoneTokenSource = 'stored' | 'env'

export type PhoneConnectionStatus = {
	tokenConfigured: boolean
	hasStoredToken: boolean
	hasEnvToken: boolean
	tokenSource: PhoneTokenSource | null
	connected: boolean
	websocketPath: typeof phoneWebSocketPath
	publicWebSocketUrl: string
	localWebSocketUrl: string
	lanWebSocketUrl: string
	lastHello: PhoneHelloInfo | null
	lastSeenAt: string | null
	connectedAt: string | null
	deviceId: string | null
}

export type PhoneSocket = {
	send(data: string): void
	close(code?: number, reason?: string): void
	on(event: 'message', listener: (data: unknown) => void): unknown
	on(event: 'close', listener: () => void): unknown
	on(event: 'error', listener: (error: Error) => void): unknown
}

export type PhoneUpgradeHeaders = {
	[key: string]: string | Array<string> | undefined
}

export type PhoneUpgradeRequest = {
	url?: string
	headers: PhoneUpgradeHeaders
}

export type PhoneUpgradeAuthorization =
	| { ok: true }
	| { ok: false; status: number; statusText: string; reason: string }
