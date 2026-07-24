const CERTIFICATE_FAILURE_MARKERS = [
	'unable to verify the first certificate',
	'self-signed certificate',
	'self signed certificate',
	'depth_zero_self_signed_cert',
	'cert_untrusted',
] as const

export class AccessNetworksUnleashedRequestError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options)
		this.name = 'AccessNetworksUnleashedRequestError'
	}
}

export function getErrorCauseMessage(error: Error): string | null {
	const cause = error.cause
	if (cause instanceof Error) {
		return cause.message
	}
	if (typeof cause === 'string') {
		return cause
	}
	if (cause && typeof cause === 'object') {
		const message = (cause as { message?: unknown }).message
		if (typeof message === 'string' && message.trim()) {
			return message
		}
		if (message != null) {
			return String(message)
		}
	}
	return null
}

function formatFailureReason(error: unknown) {
	if (error instanceof Error) {
		const causeMessage = getErrorCauseMessage(error)
		return causeMessage
			? `${error.message}; cause=${causeMessage}`
			: error.message
	}
	return String(error)
}

function isCertificateVerificationFailure(causeMessage: string | null) {
	if (!causeMessage) return false
	const normalized = causeMessage.toLowerCase()
	return CERTIFICATE_FAILURE_MARKERS.some((marker) =>
		normalized.includes(marker),
	)
}

function getRemediation(input: {
	url: string
	allowInsecureTls: boolean
	causeMessage: string | null
}) {
	if (!isCertificateVerificationFailure(input.causeMessage)) {
		return null
	}
	if (!input.allowInsecureTls) {
		return "Set ACCESS_NETWORKS_UNLEASHED_ALLOW_INSECURE_TLS=true on the connector (these controllers ship with self-signed LAN certificates), or install the controller's root CA on the host."
	}
	let host = input.url
	try {
		host = new URL(input.url).host
	} catch {
		// Keep the raw URL when it is not parseable.
	}
	return `Verify ${host} is reachable from this connector host and that the Unleashed controller is still online.`
}

export function createAccessNetworksUnleashedRequestError(input: {
	url: string
	operation: string
	allowInsecureTls: boolean
	error: unknown
}): AccessNetworksUnleashedRequestError {
	if (input.error instanceof AccessNetworksUnleashedRequestError) {
		return input.error
	}
	const causeMessage =
		input.error instanceof Error ? getErrorCauseMessage(input.error) : null
	const failureReason = formatFailureReason(input.error)
	const remediation = getRemediation({
		url: input.url,
		allowInsecureTls: input.allowInsecureTls,
		causeMessage,
	})
	const message = remediation
		? `Access Networks Unleashed could not ${input.operation} at ${input.url}. ${failureReason}. ${remediation}`
		: `Access Networks Unleashed could not ${input.operation} at ${input.url}. ${failureReason}`
	return new AccessNetworksUnleashedRequestError(message, {
		cause: input.error,
	})
}
