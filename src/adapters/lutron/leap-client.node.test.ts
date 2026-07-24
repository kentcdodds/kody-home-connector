import { expect, test } from 'vitest'
import {
	buildLutronZoneLevelCommand,
	isLutronExpectedClientError,
	isLutronInvalidCredentialsError,
	isLutronInvalidZoneIdError,
	isLutronUnsupportedRequestError,
	isLutronUnsupportedZoneLevelError,
	LutronInvalidZoneIdError,
	LutronLeapResponseError,
	LutronUnsupportedZoneCommandError,
	normalizeLutronZoneId,
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
	expect(isLutronExpectedClientError(error)).toBe(true)
	expect(error.homeConnectorCaptureContext).toMatchObject({
		shouldCapture: false,
		tags: {
			connector_vendor: 'lutron',
			lutron_failure_code: 'unsupported_zone_level',
		},
	})
})

test('classifies unsupported LEAP requests and invalid credentials as expected', () => {
	const unsupportedRequest = new LutronLeapResponseError({
		action: 'zone /button/337 status read',
		statusCode: '400 BadRequest',
		responseBody: {
			Message: 'This request is not supported',
		},
	})
	const invalidCredentials = new LutronLeapResponseError({
		action: 'login',
		statusCode: '401 Unauthorized',
		responseBody: {
			Message: 'The provided credentials were invalid',
		},
	})

	expect(isLutronUnsupportedRequestError(unsupportedRequest)).toBe(true)
	expect(isLutronInvalidCredentialsError(invalidCredentials)).toBe(true)
	expect(isLutronExpectedClientError(unsupportedRequest)).toBe(true)
	expect(isLutronExpectedClientError(invalidCredentials)).toBe(true)
	expect(unsupportedRequest.homeConnectorCaptureContext).toMatchObject({
		shouldCapture: false,
		tags: {
			lutron_failure_code: 'unsupported_request',
		},
	})
	expect(invalidCredentials.homeConnectorCaptureContext).toMatchObject({
		shouldCapture: false,
		tags: {
			lutron_failure_code: 'invalid_credentials',
		},
	})
})

test('does not classify other Lutron response errors as expected client errors', () => {
	const error = new LutronLeapResponseError({
		action: 'zone 495 status read',
		statusCode: '500 ServerError',
		responseBody: {
			Message: 'Unexpected response',
		},
	})

	expect(isLutronUnsupportedZoneLevelError(error)).toBe(false)
	expect(isLutronUnsupportedRequestError(error)).toBe(false)
	expect(isLutronInvalidCredentialsError(error)).toBe(false)
	expect(isLutronExpectedClientError(error)).toBe(false)
	expect(error.homeConnectorCaptureContext).toBeUndefined()
})

test('normalizes numeric and href zone ids and rejects button hrefs', () => {
	expect(normalizeLutronZoneId('495')).toBe('495')
	expect(normalizeLutronZoneId('/zone/495')).toBe('495')
	expect(normalizeLutronZoneId(' /zone/512/ ')).toBe('512')

	expect(() => normalizeLutronZoneId('/button/337')).toThrowError(
		LutronInvalidZoneIdError,
	)
	expect(() => normalizeLutronZoneId('button-337')).toThrowError(
		LutronInvalidZoneIdError,
	)

	try {
		normalizeLutronZoneId('/button/337')
	} catch (error) {
		expect(isLutronInvalidZoneIdError(error)).toBe(true)
		expect(isLutronExpectedClientError(error)).toBe(true)
		expect(
			(error as LutronInvalidZoneIdError).homeConnectorCaptureContext,
		).toMatchObject({
			shouldCapture: false,
			tags: {
				lutron_failure_code: 'invalid_zone_id',
			},
		})
	}
})

test('routes zone level commands by ControlType', () => {
	expect(
		buildLutronZoneLevelCommand({
			zoneId: '595',
			controlType: 'Dimmed',
			level: 40,
			status: null,
		}),
	).toMatchObject({
		commandType: 'GoToLevel',
		body: {
			Command: {
				CommandType: 'GoToLevel',
				Parameter: [{ Type: 'Level', Value: 40 }],
			},
		},
	})

	expect(
		buildLutronZoneLevelCommand({
			zoneId: '495',
			controlType: 'SpectrumTune',
			level: 70,
			status: {
				level: 10,
				switchedLevel: null,
				vibrancy: 25,
				whiteTuningKelvin: null,
				hue: 32,
				saturation: 81,
				statusAccuracy: 'Good',
				zoneLockState: null,
			},
		}),
	).toMatchObject({
		commandType: 'GoToSpectrumTuningLevel',
		body: {
			Command: {
				CommandType: 'GoToSpectrumTuningLevel',
				SpectrumTuningLevelParameters: {
					Level: 70,
					Vibrancy: 25,
				},
			},
		},
	})

	expect(
		buildLutronZoneLevelCommand({
			zoneId: '755',
			controlType: 'Switched',
			level: 1,
			status: null,
		}),
	).toMatchObject({
		commandType: 'GoToSwitchedLevel',
		body: {
			Command: {
				CommandType: 'GoToSwitchedLevel',
				SwitchedLevelParameters: {
					SwitchedLevel: 'On',
				},
			},
		},
	})

	expect(
		buildLutronZoneLevelCommand({
			zoneId: '858',
			controlType: 'Shade',
			level: 0,
			status: null,
		}),
	).toMatchObject({
		commandType: 'GoToShadeLevel',
		body: {
			Command: {
				CommandType: 'GoToShadeLevel',
				ShadeLevelParameters: {
					Level: 0,
				},
			},
		},
	})
})

test('rejects unsupported ControlTypes for level set with a non-captured error', () => {
	expect(() =>
		buildLutronZoneLevelCommand({
			zoneId: '999',
			controlType: 'FanSpeed',
			level: 50,
			status: null,
		}),
	).toThrowError(LutronUnsupportedZoneCommandError)

	try {
		buildLutronZoneLevelCommand({
			zoneId: '999',
			controlType: 'FanSpeed',
			level: 50,
			status: null,
		})
	} catch (error) {
		expect(isLutronUnsupportedZoneLevelError(error)).toBe(true)
		expect(isLutronExpectedClientError(error)).toBe(true)
		expect(
			(error as LutronUnsupportedZoneCommandError).homeConnectorCaptureContext,
		).toMatchObject({
			shouldCapture: false,
			tags: {
				lutron_failure_code: 'unsupported_zone_command',
				lutron_control_type: 'FanSpeed',
			},
		})
	}
})
