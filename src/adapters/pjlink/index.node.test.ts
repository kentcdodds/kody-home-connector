import { expect, test } from 'vitest'
import { createTestHomeConnectorConfig } from '../../test-home-connector-config.ts'
import { createAppState } from '../../state.ts'
import { createHomeConnectorStorage } from '../../storage/index.ts'
import { createPjlinkAdapter } from './index.ts'
import { resetMockPjlinkState, setMockPjlinkReachable } from './mock-driver.ts'
import { courtOptomaDefaults } from './types.ts'

async function createFixture() {
	resetMockPjlinkState()
	const config = createTestHomeConnectorConfig()
	const state = createAppState()
	const storage = await createHomeConnectorStorage(config)
	return {
		storage,
		pjlink: createPjlinkAdapter({ config, state, storage }),
	}
}

test('scan and adopt the mock court Optoma, then power via PJLink', async () => {
	const { storage, pjlink } = await createFixture()
	try {
		const scanned = await pjlink.scan()
		expect(scanned).toHaveLength(1)
		expect(scanned[0]).toMatchObject({
			host: courtOptomaDefaults.host,
			macAddress: courtOptomaDefaults.macAddress,
			authRequired: false,
			adopted: false,
		})

		const adopted = await pjlink.adoptProjector({
			projectorId: scanned[0]!.projectorId,
		})
		expect(adopted.adopted).toBe(true)

		const on = await pjlink.setPower({ projectorId: adopted.projectorId }, 'on')
		expect(on.power).toBe('on')
		const status = await pjlink.getPower({ projectorId: adopted.projectorId })
		expect(status.power).toBe('on')
		const off = await pjlink.setPower(
			{ projectorId: adopted.projectorId },
			'off',
		)
		expect(off.power).toBe('standby')
		const lamp = await pjlink.getLamp({ projectorId: adopted.projectorId })
		expect(lamp.lamps[0]).toMatchObject({ hours: 123, on: false })
		const info = await pjlink.getInfo({ projectorId: adopted.projectorId })
		expect(info.manufacturer).toBe('Optoma')
		expect(await pjlink.resolveCourtProjector()).toMatchObject({
			projectorId: adopted.projectorId,
			host: courtOptomaDefaults.host,
		})
	} finally {
		await storage.close()
	}
})

test('adopt by explicit court IP/MAC without a prior scan', async () => {
	const { storage, pjlink } = await createFixture()
	try {
		const adopted = await pjlink.adoptProjector({
			host: courtOptomaDefaults.host,
			macAddress: courtOptomaDefaults.macAddress,
			name: courtOptomaDefaults.name,
		})
		expect(adopted.projectorId).toBe('pjlink-005041b2fd09')
		expect(adopted.adopted).toBe(true)
	} finally {
		await storage.close()
	}
})

test('control fails closed when the mock projector is unreachable', async () => {
	const { storage, pjlink } = await createFixture()
	try {
		await pjlink.adoptProjector({
			host: courtOptomaDefaults.host,
			macAddress: courtOptomaDefaults.macAddress,
		})
		setMockPjlinkReachable(courtOptomaDefaults.host, false)
		await expect(pjlink.getPower()).rejects.toMatchObject({
			name: 'PjlinkUnreachableError',
		})
	} finally {
		await storage.close()
	}
})
