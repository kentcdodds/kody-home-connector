import { expect, test } from 'vitest'
import {
	isLutronUnsupportedZoneLevelError,
	LutronLeapResponseError,
} from './leap-client.ts'

test('classifies unsupported Lutron zone level responses as expected', () => {
	const error = new LutronLeapResponseError({
		action: 'zone 495 level set',
		statusCode: '405 MethodNotAllowed',
		responseBody: {
			Message: 'GoToLevel not supported for the specified ZoneType',
		},
	})

	expect(isLutronUnsupportedZoneLevelError(error)).toBe(true)
	expect(error.homeConnectorCaptureContext).toMatchObject({
		shouldCapture: false,
		tags: {
			connector_vendor: 'lutron',
			lutron_failure_code: 'unsupported_zone_level',
		},
	})
})

test('does not classify other Lutron response errors as unsupported zone levels', () => {
	const error = new LutronLeapResponseError({
		action: 'zone 495 status read',
		statusCode: '500 ServerError',
		responseBody: {
			Message: 'Unexpected response',
		},
	})

	expect(isLutronUnsupportedZoneLevelError(error)).toBe(false)
	expect(error.homeConnectorCaptureContext).toBeUndefined()
})
