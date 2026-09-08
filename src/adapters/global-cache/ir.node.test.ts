import { expect, test } from 'vitest'
import { getGlobalCacheIrCommand } from './codes.ts'
import {
	buildSendirCommand,
	encodeNecPulses,
	flipperRawToGcPulses,
	hdmiSwitchPulseProfile,
} from './ir.ts'

test('hdmi switch input 1 matches the learned iTach frame', () => {
	const pulses = encodeNecPulses({
		address: 0x4c,
		command: 0x01,
		profile: hdmiSwitchPulseProfile,
	})
	expect(pulses.join(',')).toBe(
		'342,170,22,21,22,21,22,64,22,64,22,21,22,21,22,64,22,21,22,64,22,64,22,21,22,21,22,64,22,64,22,21,22,64,22,64,22,21,22,21,22,21,22,21,22,21,22,21,22,21,22,21,22,64,22,64,22,64,22,64,22,64,22,64,22,64,22,1502',
	)
})

test('flipper raw conversion keeps an even on/off pulse list', () => {
	const pulses = flipperRawToGcPulses(
		'9121 4373 678 449 679 1565 40519 9120 2125 674',
	)
	expect(pulses.length % 2).toBe(0)
	expect(pulses.length).toBeGreaterThan(4)
})

test('sendir rejects an odd pulse list', () => {
	expect(() =>
		buildSendirCommand({
			connector: '1:3',
			freq: 38000,
			pulses: [345, 167, 25],
		}),
	).toThrow(/even/)
})

test('named hdmi-input-1 uses connector 1:1', () => {
	const command = getGlobalCacheIrCommand('hdmi-input-1')
	expect(command.connector).toBe('1:1')
	expect(command.reliability).toBe('proven')
})
