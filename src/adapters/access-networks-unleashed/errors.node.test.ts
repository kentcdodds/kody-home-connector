import { expect, test } from 'vitest'
import {
	AccessNetworksUnleashedRequestError,
	annotateAccessNetworksUnleashedTransientError,
	createAccessNetworksUnleashedRequestError,
	isAccessNetworksUnleashedTransientNetworkError,
} from './errors.ts'

const certificateCauseMessage =
	'unable to verify the first certificate; if the root CA is installed locally, try running Node.js with --use-system-ca'

function createCertificateFetchError() {
	return new TypeError('fetch failed', {
		cause: new Error(certificateCauseMessage),
	})
}

test('certificate failure with allowInsecureTls false names the env var remediation', () => {
	const original = createCertificateFetchError()
	const error = createAccessNetworksUnleashedRequestError({
		url: 'https://unleashed.local',
		operation: 'establish a session',
		allowInsecureTls: false,
		error: original,
	})

	expect(error).toBeInstanceOf(AccessNetworksUnleashedRequestError)
	expect(error.name).toBe('AccessNetworksUnleashedRequestError')
	expect(error.message).toContain('establish a session')
	expect(error.message).toContain('https://unleashed.local')
	expect(error.message).toContain(`cause=${certificateCauseMessage}`)
	expect(error.message).toContain(
		'ACCESS_NETWORKS_UNLEASHED_ALLOW_INSECURE_TLS',
	)
	expect(error.cause).toBe(original)
})

test('certificate failure with allowInsecureTls true does not suggest the env var', () => {
	const error = createAccessNetworksUnleashedRequestError({
		url: 'https://unleashed.local/admin/_cmdstat.jsp',
		operation: 'post _cmdstat.jsp',
		allowInsecureTls: true,
		error: createCertificateFetchError(),
	})

	expect(error.message).toContain('post _cmdstat.jsp')
	expect(error.message).toContain('unleashed.local')
	expect(error.message).not.toContain(
		'ACCESS_NETWORKS_UNLEASHED_ALLOW_INSECURE_TLS=true',
	)
	expect(error.message).toMatch(/reachable/i)
})

test('ECONNREFUSED does not mention TLS or the env var', () => {
	const original = new TypeError('fetch failed', {
		cause: new Error('connect ECONNREFUSED 192.168.10.88:443'),
	})
	const error = createAccessNetworksUnleashedRequestError({
		url: 'https://192.168.10.88',
		operation: 'establish a session',
		allowInsecureTls: false,
		error: original,
	})

	expect(error.message).toBe(
		'Access Networks Unleashed could not establish a session at https://192.168.10.88. fetch failed; cause=connect ECONNREFUSED 192.168.10.88:443',
	)
	expect(error.message).not.toMatch(
		/tls|certificate|ACCESS_NETWORKS_UNLEASHED_ALLOW_INSECURE_TLS/i,
	)
})

test('AbortError does not mention TLS or the env var', () => {
	const original = new DOMException('The operation was aborted.', 'AbortError')
	const error = createAccessNetworksUnleashedRequestError({
		url: 'https://unleashed.local',
		operation: 'establish a session',
		allowInsecureTls: false,
		error: original,
	})

	expect(error.message).toBe(
		'Access Networks Unleashed could not establish a session at https://unleashed.local. The operation was aborted.',
	)
	expect(error.message).not.toMatch(
		/tls|certificate|ACCESS_NETWORKS_UNLEASHED_ALLOW_INSECURE_TLS/i,
	)
	expect(error.cause).toBe(original)
	expect(error.homeConnectorCaptureContext).toMatchObject({
		shouldCapture: false,
		tags: {
			connector_vendor: 'access-networks-unleashed',
			access_networks_unleashed_failure_class: 'transient_network',
		},
	})
})

test('raw AbortError scan failures are annotated as expected network noise', () => {
	const original = new DOMException('This operation was aborted', 'AbortError')
	expect(isAccessNetworksUnleashedTransientNetworkError(original)).toBe(true)
	const annotated = annotateAccessNetworksUnleashedTransientError(
		original,
	) as Error & {
		homeConnectorCaptureContext?: { shouldCapture?: boolean }
	}
	expect(annotated.homeConnectorCaptureContext).toMatchObject({
		shouldCapture: false,
		tags: {
			connector_vendor: 'access-networks-unleashed',
			access_networks_unleashed_failure_class: 'transient_network',
		},
	})
})

test('error with no cause still produces a sensible message', () => {
	const original = new TypeError('fetch failed')
	const error = createAccessNetworksUnleashedRequestError({
		url: 'https://unleashed.local',
		operation: 'establish a session',
		allowInsecureTls: false,
		error: original,
	})

	expect(error.message).toBe(
		'Access Networks Unleashed could not establish a session at https://unleashed.local. fetch failed',
	)
	expect(error.cause).toBe(original)
})

test('passing an existing AccessNetworksUnleashedRequestError returns it unchanged', () => {
	const existing = createAccessNetworksUnleashedRequestError({
		url: 'https://unleashed.local',
		operation: 'establish a session',
		allowInsecureTls: false,
		error: createCertificateFetchError(),
	})
	const result = createAccessNetworksUnleashedRequestError({
		url: 'https://other.local',
		operation: 'post _cmdstat.jsp',
		allowInsecureTls: true,
		error: existing,
	})

	expect(result).toBe(existing)
})
