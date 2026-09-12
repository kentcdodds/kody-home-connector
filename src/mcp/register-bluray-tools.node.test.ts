import { expect, test } from 'vitest'
import {
	createSonyBlurayAdapter,
	type SonyIrccCommandName,
} from '../adapters/sony-bluray/index.ts'
import { registerBlurayHomeConnectorTools } from './register-bluray-tools.ts'

function createFakeBluray(input: {
	status?: Record<string, unknown>
	onPress?: (command: SonyIrccCommandName) => Record<string, unknown>
}) {
	const disconnected = {
		connected: false,
		reason: 'Court Blu-ray host is not configured.',
		reasonCode: 'not_configured',
		configured: false,
		host: null,
		macAddress: null,
		...input.status,
	}
	const calls: Array<string> = []
	const bluray = {
		async getStatus() {
			return disconnected
		},
		async listPlayers() {
			return []
		},
		async setHost() {
			return disconnected
		},
		async forget() {
			return disconnected
		},
		async scan() {
			return { players: [], rejected: [], probes: [] }
		},
		async press(command: SonyIrccCommandName) {
			calls.push(command)
			return (
				input.onPress?.(command) ?? {
					...disconnected,
					command,
					irccCode: 'AAAAAwAAHFoAAAAaAw==',
					transport: null,
					wakeOnLan: null,
					httpStatus: null,
				}
			)
		},
		async powerOn() {
			return { ...disconnected, command: 'powerOn', transport: null }
		},
		async powerOff() {
			return { ...disconnected, command: 'powerOff', transport: null }
		},
	} as unknown as ReturnType<typeof createSonyBlurayAdapter>
	return { bluray, calls }
}

function registerAll(bluray: ReturnType<typeof createSonyBlurayAdapter>) {
	const tools = new Map<
		string,
		{
			description: string
			handler: (args: Record<string, unknown>) => Promise<{
				isError?: boolean
				structuredContent?: unknown
			}>
		}
	>()
	registerBlurayHomeConnectorTools({
		bluray,
		registerTool(descriptor, handler) {
			tools.set(descriptor.name, {
				description: descriptor.description,
				handler,
			})
		},
	})
	return tools
}

test('bluray_status reports disconnected without isError', async () => {
	const { bluray } = createFakeBluray({})
	const tools = registerAll(bluray)
	const result = await tools.get('bluray_status')?.handler({})
	expect(result).not.toMatchObject({ isError: true })
	expect(result).toMatchObject({
		structuredContent: {
			connected: false,
			reasonCode: 'not_configured',
		},
	})
})

test('transport tools stay in the catalog and return the same disconnected shape', async () => {
	const { bluray, calls } = createFakeBluray({})
	const tools = registerAll(bluray)
	for (const name of [
		'bluray_play',
		'bluray_pause',
		'bluray_stop',
		'bluray_eject',
		'bluray_up',
		'bluray_home',
		'bluray_power_off',
	] as const) {
		const result = await tools.get(name)?.handler({})
		expect(result).not.toMatchObject({ isError: true })
		expect(result).toMatchObject({
			structuredContent: {
				connected: false,
			},
		})
	}
	expect(calls).toEqual([
		'play',
		'pause',
		'stop',
		'eject',
		'up',
		'home',
	])
})

test('bluray tool descriptions mention offline status and the Sony camera', async () => {
	const { bluray } = createFakeBluray({})
	const tools = registerAll(bluray)
	expect(tools.get('bluray_status')?.description).toMatch(/connected: false/)
	expect(tools.get('bluray_play')?.description).toMatch(/192\.168\.0\.115/)
	expect(tools.get('bluray_scan')?.description).toMatch(/camera/)
})
