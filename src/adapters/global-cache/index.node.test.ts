import { expect, test } from 'vitest'
import { createTestHomeConnectorConfig } from '../../test-home-connector-config.ts'
import { createGlobalCacheAdapter } from './index.ts'
import { type GlobalCacheCommandClient } from './types.ts'

test('lists court IR commands with reliability notes', () => {
	const adapter = createGlobalCacheAdapter({
		config: createTestHomeConnectorConfig(),
	})
	const commands = adapter.listIrCommands()
	expect(commands.some((command) => command.commandId === 'hdmi-input-1')).toBe(
		true,
	)
	expect(
		commands.some((command) => command.commandId === 'rotosphere-green'),
	).toBe(true)
	const auto = commands.find(
		(command) => command.commandId === 'rotosphere-auto',
	)
	expect(auto?.reliability).toBe('unreliable-flipper')
})

test('sends named IR and sets the Rotosphere port to blaster first', async () => {
	const sent: Array<string> = []
	const commandClient: GlobalCacheCommandClient = async ({ command }) => {
		sent.push(command)
		if (command.startsWith('set_IR,')) {
			return ['IR,1:3,IR_BLASTER']
		}
		return ['completeir,1:3,1']
	}
	const adapter = createGlobalCacheAdapter({
		config: createTestHomeConnectorConfig({ mocksEnabled: false }),
		commandClient,
	})
	const result = await adapter.sendIr('rotosphere-green')
	expect(sent[0]).toBe('set_IR,1:3,IR_BLASTER')
	expect(sent[1]?.startsWith('sendir,1:3,')).toBe(true)
	expect(result.response).toBe('completeir,1:3,1')
	expect(result.setIrResponse).toBe('IR,1:3,IR_BLASTER')
})

test('mock mode completes IR without opening a socket', async () => {
	const adapter = createGlobalCacheAdapter({
		config: createTestHomeConnectorConfig({ mocksEnabled: true }),
	})
	const result = await adapter.sendIr('hdmi-input-2')
	expect(result.connector).toBe('1:1')
	expect(result.response.startsWith('completeir,1:1,')).toBe(true)
})

test('unknown command ids fail closed', async () => {
	const adapter = createGlobalCacheAdapter({
		config: createTestHomeConnectorConfig(),
	})
	await expect(adapter.sendIr('not-a-command')).rejects.toThrow(
		'Unknown Global Cache IR command',
	)
})
