import { expect, test } from 'vitest'
import { installHomeConnectorMockServer } from '../../../mocks/test-server.ts'
import { loadHomeConnectorConfig } from '../../config.ts'
import { createAppState } from '../../state.ts'
import { createHomeConnectorStorage } from '../../storage/index.ts'
import { createJellyfishAdapter } from './index.ts'
import {
	resetMockJellyfishState,
	setMockJellyfishScheduleState,
} from './mock-driver.ts'

function createConfig() {
	process.env.MOCKS = 'true'
	process.env.HOME_CONNECTOR_ID = 'default'
	process.env.HOME_CONNECTOR_SHARED_SECRET =
		'home-connector-secret-home-connector-secret'
	process.env.WORKER_BASE_URL = 'http://localhost:3742'
	process.env.JELLYFISH_DISCOVERY_URL = 'http://jellyfish.mock.local/discovery'
	process.env.VENSTAR_SCAN_CIDRS = '192.168.10.40/32'
	process.env.HOME_CONNECTOR_DB_PATH = ':memory:'
	return loadHomeConnectorConfig()
}

installHomeConnectorMockServer()

test('jellyfish scan persists discovered controllers and diagnostics', async () => {
	const config = createConfig()
	const state = createAppState()
	const storage = createHomeConnectorStorage(config)
	const jellyfish = createJellyfishAdapter({
		config,
		state,
		storage,
	})

	try {
		const controllers = await jellyfish.scan()
		const status = jellyfish.getStatus()
		expect(controllers).toHaveLength(1)
		expect(controllers[0]).toMatchObject({
			hostname: 'JellyFish-F348.local',
			host: 'jellyfish-f348.mock.local',
		})
		expect(status.diagnostics?.protocol).toBe('json')
	} finally {
		storage.close()
	}
})

test('jellyfish list methods return structured zones, patterns, and parsed pattern data', async () => {
	const config = createConfig()
	const state = createAppState()
	const storage = createHomeConnectorStorage(config)
	const jellyfish = createJellyfishAdapter({
		config,
		state,
		storage,
	})

	try {
		const zones = await jellyfish.listZones()
		const patterns = await jellyfish.listPatterns()
		const pattern = await jellyfish.getPattern({
			patternPath: 'Colors/Blue',
		})

		expect(zones.controller).toMatchObject({
			hostname: 'JellyFish-F348.local',
		})
		expect(zones.zones).toEqual([
			expect.objectContaining({
				name: 'Zone',
				numPixels: 755,
			}),
		])
		expect(patterns.patterns).toEqual([
			expect.objectContaining({
				path: 'Christmas/Christmas Tree',
			}),
			expect.objectContaining({
				path: 'Colors/Blue',
			}),
		])
		expect(pattern.pattern).toMatchObject({
			path: 'Colors/Blue',
			data: expect.objectContaining({
				type: 'Color',
			}),
		})
	} finally {
		storage.close()
	}
})

test('jellyfish runPattern defaults to all zones when zoneNames are omitted', async () => {
	const config = createConfig()
	const state = createAppState()
	const storage = createHomeConnectorStorage(config)
	const jellyfish = createJellyfishAdapter({
		config,
		state,
		storage,
	})

	try {
		const result = await jellyfish.runPattern({
			patternPath: 'Christmas/Christmas Tree',
		})
		expect(result.zoneNames).toEqual(['Zone'])
		expect(result.runPattern).toMatchObject({
			file: 'Christmas/Christmas Tree',
			data: '',
			state: 1,
			zoneName: ['Zone'],
		})
	} finally {
		storage.close()
	}
})

test('jellyfish schedule methods read and replace daily and calendar schedules', async () => {
	const config = createConfig()
	const state = createAppState()
	const storage = createHomeConnectorStorage(config)
	const jellyfish = createJellyfishAdapter({
		config,
		state,
		storage,
	})

	try {
		const daily = await jellyfish.getDailySchedule()
		expect(daily).toMatchObject({
			scheduleType: 'daily',
			controller: {
				hostname: 'JellyFish-F348.local',
			},
			events: [
				{
					label: 'Daily Accent',
					days: ['M', 'T', 'W', 'TH', 'F', 'SA', 'S'],
				},
			],
		})

		const updatedDaily = await jellyfish.setDailySchedule({
			events: [
				{
					label: 'Birthday celebration',
					days: ['S'],
					actions: [
						{
							type: 'RUN',
							startFrom: 'time',
							hour: 18,
							minute: 30,
							patternFile: 'Colors/Blue',
							zones: ['Zone'],
						},
					],
				},
			],
		})
		expect(updatedDaily).toMatchObject({
			scheduleType: 'daily',
			availableZones: [
				{
					name: 'Zone',
				},
			],
			events: [
				{
					label: 'Birthday celebration',
					days: ['S'],
					actions: [
						{
							startFrom: 'time',
							hour: 18,
							minute: 30,
						},
					],
				},
			],
		})

		const updatedCalendar = await jellyfish.setCalendarSchedule({
			events: [
				{
					label: 'Brooke birthday',
					days: ['20260628'],
					actions: [
						{
							type: 'RUN',
							startFrom: 'sunset',
							hour: 0,
							minute: -5,
							patternFile: 'Christmas/Christmas Tree',
							zones: ['Zone'],
						},
					],
				},
			],
		})
		expect(updatedCalendar).toMatchObject({
			scheduleType: 'calendar',
			events: [
				{
					label: 'Brooke birthday',
					days: ['20260628'],
					actions: [
						{
							startFrom: 'sunset',
							hour: 0,
							minute: -5,
						},
					],
				},
			],
		})
	} finally {
		storage.close()
	}
})

test('jellyfish schedule reads preserve existing controller payloads', async () => {
	setMockJellyfishScheduleState({
		daily: [
			{
				label: 'Controller legacy stop',
				days: ['Everyday'],
				actions: [
					{
						type: 'STOP',
						startFrom: 'sunrise',
						hour: 1,
						minute: 7,
						zones: ['Zone'],
					},
				],
			},
		],
	})
	const config = createConfig()
	const state = createAppState()
	const storage = createHomeConnectorStorage(config)
	const jellyfish = createJellyfishAdapter({
		config,
		state,
		storage,
	})

	try {
		const daily = await jellyfish.getDailySchedule()
		expect(daily.events).toEqual([
			{
				label: 'Controller legacy stop',
				days: ['Everyday'],
				actions: [
					{
						type: 'STOP',
						startFrom: 'sunrise',
						hour: 1,
						minute: 7,
						zones: ['Zone'],
					},
				],
			},
		])
	} finally {
		resetMockJellyfishState()
		storage.close()
	}
})

test('jellyfish schedule writes validate timing, days, and known zones', async () => {
	const config = createConfig()
	const state = createAppState()
	const storage = createHomeConnectorStorage(config)
	const jellyfish = createJellyfishAdapter({
		config,
		state,
		storage,
	})

	try {
		await expect(
			jellyfish.setDailySchedule({
				events: [
					{
						days: ['MO'],
						actions: [
							{
								type: 'RUN',
								startFrom: 'time',
								hour: 18,
								minute: 0,
								patternFile: 'Colors/Blue',
								zones: ['Zone'],
							},
						],
					},
				],
			}),
		).rejects.toThrow('Invalid JellyFish daily schedule day')

		await expect(
			jellyfish.setDailySchedule({
				events: [
					{
						days: ['S'],
						actions: [
							{
								type: 'RUN',
								startFrom: 'sunrise',
								hour: 0,
								minute: 7,
								patternFile: 'Colors/Blue',
								zones: ['Zone'],
							},
						],
					},
				],
			}),
		).rejects.toThrow(
			'JellyFish schedule sunrise/sunset actions require minute offset',
		)

		await expect(
			jellyfish.setDailySchedule({
				events: [
					{
						days: ['S'],
						actions: [
							{
								type: 'RUN',
								startFrom: 'time',
								hour: 18,
								minute: 0,
								patternFile: 'Colors/Blue',
								zones: ['Unknown Zone'],
							},
						],
					},
				],
			}),
		).rejects.toThrow('Unknown JellyFish zone(s): Unknown Zone')

		await expect(
			jellyfish.setCalendarSchedule({
				events: [
					{
						days: ['2026-06-28'],
						actions: [
							{
								type: 'RUN',
								startFrom: 'time',
								hour: 18,
								minute: 0,
								patternFile: 'Colors/Blue',
								zones: ['Zone'],
							},
						],
					},
				],
			}),
		).rejects.toThrow('Invalid JellyFish calendar schedule day')
	} finally {
		storage.close()
	}
})
