import { type HomeConnectorConfig } from '../../config.ts'
import { buildSendirCommand } from './ir.ts'
import {
	getGlobalCacheIrCommand,
	globalCacheIrCommands,
	globalCachePortMap,
} from './codes.ts'
import { createTcpGlobalCacheCommandClient } from './client.ts'
import {
	type GlobalCacheCommandClient,
	type GlobalCacheIrCommand,
	type GlobalCacheSendIrResult,
	type GlobalCacheStatus,
} from './types.ts'

export function resolveGlobalCacheHost(config: HomeConnectorConfig) {
	return config.globalCacheHost?.trim() || '192.168.1.70'
}

export function resolveGlobalCachePort(config: HomeConnectorConfig) {
	return config.globalCachePort && config.globalCachePort > 0
		? config.globalCachePort
		: 4998
}

function createMockGlobalCacheCommandClient(): GlobalCacheCommandClient {
	return async ({ command }) => {
		if (command.startsWith('sendir,')) {
			const connector = command.split(',')[1] ?? '1:1'
			return [`completeir,${connector},1`]
		}
		if (command.startsWith('set_IR,')) {
			return [command.replace('set_IR', 'IR')]
		}
		if (command === 'getdevices') {
			return ['device,0,0 ETHERNET', 'device,1,3 IR', 'endlistdevices']
		}
		return ['OK']
	}
}

export function createGlobalCacheAdapter(input: {
	config: HomeConnectorConfig
	commandClient?: GlobalCacheCommandClient
}) {
	const host = resolveGlobalCacheHost(input.config)
	const port = resolveGlobalCachePort(input.config)
	const commandClient =
		input.commandClient ??
		(input.config.mocksEnabled
			? createMockGlobalCacheCommandClient()
			: createTcpGlobalCacheCommandClient({ host, port }))

	async function sendCommand(inputCommand: {
		command: string
		isComplete: (line: string, lines: Array<string>) => boolean
	}) {
		const lines = await commandClient(inputCommand)
		return lines.at(-1) ?? ''
	}

	async function setPortMode(command: GlobalCacheIrCommand) {
		if (command.portMode !== 'IR_BLASTER') {
			return null
		}
		return await sendCommand({
			command: `set_IR,${command.connector},${command.portMode}`,
			isComplete: (line) =>
				line.startsWith('IR,') || line.startsWith('set_IR,'),
		})
	}

	return {
		getStatus(): GlobalCacheStatus {
			return {
				host,
				port,
				mocksEnabled: input.config.mocksEnabled,
				portMap: globalCachePortMap,
				commandCount: globalCacheIrCommands.length,
			}
		},
		listIrCommands() {
			return globalCacheIrCommands.map((command) => ({
				commandId: command.commandId,
				title: command.title,
				target: command.target,
				connector: command.connector,
				reliability: command.reliability,
				notes: command.notes,
			}))
		},
		async sendIr(commandId: string): Promise<GlobalCacheSendIrResult> {
			const command = getGlobalCacheIrCommand(commandId)
			const setIrResponse = await setPortMode(command)
			const sendir = buildSendirCommand({
				connector: command.connector,
				freq: command.freq,
				repeat: command.repeat,
				pulses: command.pulses,
			})
			const response = await sendCommand({
				command: sendir,
				isComplete: (line) => line.startsWith('completeir'),
			})
			return {
				commandId: command.commandId,
				connector: command.connector,
				response,
				setIrResponse,
			}
		},
		async getDevices() {
			const lines = await commandClient({
				command: 'getdevices',
				isComplete: (line) => line === 'endlistdevices',
			})
			return { host, port, lines }
		},
	}
}
