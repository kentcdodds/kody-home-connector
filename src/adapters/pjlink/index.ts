import { type HomeConnectorErrorCaptureContext } from '../../sentry.ts'
import { type HomeConnectorConfig } from '../../config.ts'
import { type HomeConnectorState } from '../../state.ts'
import { type HomeConnectorStorage } from '../../storage/index.ts'
import { createTcpPjlinkCommandClient } from './client.ts'
import {
	buildPjlinkProjectorId,
	normalizePjlinkHost,
	normalizePjlinkMacAddress,
	scanPjlinkProjectors,
} from './discovery.ts'
import { createMockPjlinkCommandClient } from './mock-driver.ts'
import {
	encodePjlinkAvMute,
	encodePjlinkInput,
	encodePjlinkPowerCommand,
	parsePjlinkAvMute,
	parsePjlinkInput,
	parsePjlinkLampStatus,
	parsePjlinkPowerState,
	type PjlinkAvMuteMode,
	type PjlinkInputClass,
	type PjlinkPowerCommand,
} from './protocol.ts'
import {
	adoptPjlinkProjector,
	getPjlinkProjector,
	getPjlinkProjectorPassword,
	listPjlinkProjectors,
	removePjlinkProjector,
	updatePjlinkLastSeen,
	upsertDiscoveredPjlinkProjectors,
	upsertPjlinkProjector,
} from './repository.ts'
import {
	courtOptomaDefaults,
	type PjlinkAdoptInput,
	type PjlinkCommandClient,
	type PjlinkPersistedProjector,
	type PjlinkProjectorSelector,
	type PjlinkPublicProjector,
} from './types.ts'

export { isPjlinkUnreachableError, PjlinkUnreachableError } from './client.ts'
export {
	isPjlinkProtocolError,
	isPjlinkUnavailableTimeError,
	PjlinkProtocolError,
} from './protocol.ts'
export { courtOptomaDefaults } from './types.ts'
export {
	buildPjlinkProjectorId,
	normalizePjlinkHost,
	normalizePjlinkMacAddress,
} from './discovery.ts'

type PjlinkSelectionErrorCode =
	| 'pjlink_projector_not_found'
	| 'pjlink_projector_name_not_found'
	| 'pjlink_projector_name_ambiguous'
	| 'pjlink_projector_not_adopted'
	| 'pjlink_projector_selector_invalid'

export class PjlinkProjectorSelectionError extends Error {
	readonly code: PjlinkSelectionErrorCode
	readonly projectorId: string | undefined
	readonly projectorName: string | undefined
	homeConnectorCaptureContext?: HomeConnectorErrorCaptureContext

	constructor(input: {
		code: PjlinkSelectionErrorCode
		message: string
		projectorId?: string
		projectorName?: string
	}) {
		super(input.message)
		this.name = 'PjlinkProjectorSelectionError'
		this.code = input.code
		this.projectorId = input.projectorId
		this.projectorName = input.projectorName
		this.homeConnectorCaptureContext = {
			shouldCapture: false,
			tags: {
				connector_vendor: 'pjlink',
				pjlink_selection_error: input.code,
			},
		}
	}
}

export function isPjlinkProjectorSelectionError(
	error: unknown,
): error is PjlinkProjectorSelectionError {
	return error instanceof PjlinkProjectorSelectionError
}

function normalizeName(value: string) {
	return value.trim().toLowerCase()
}

function toPublicProjector(
	projector: PjlinkPersistedProjector,
): PjlinkPublicProjector {
	return projector
}

export function createPjlinkAdapter(input: {
	config: HomeConnectorConfig
	state: HomeConnectorState
	storage: HomeConnectorStorage
	commandClient?: PjlinkCommandClient
}) {
	const { config, state, storage } = input
	const connectorId = config.homeConnectorId
	const commandClient =
		input.commandClient ??
		(config.mocksEnabled
			? createMockPjlinkCommandClient()
			: createTcpPjlinkCommandClient({
					timeoutMs: config.pjlinkRequestTimeoutMs,
				}))

	async function listProjectors() {
		return (await listPjlinkProjectors(storage, connectorId)).map(
			toPublicProjector,
		)
	}

	async function resolveProjector(
		selector: PjlinkProjectorSelector = {},
		options: { requireAdopted?: boolean } = {},
	) {
		const projectorId = selector.projectorId?.trim()
		const name = selector.name?.trim()
		const host = selector.host ? normalizePjlinkHost(selector.host) : ''
		const provided = [projectorId, name, host].filter(Boolean)
		if (provided.length > 1) {
			throw new PjlinkProjectorSelectionError({
				code: 'pjlink_projector_selector_invalid',
				message: 'Provide exactly one of projectorId, name, or host.',
				projectorId,
				projectorName: name,
			})
		}

		const projectors = await listPjlinkProjectors(storage, connectorId)
		let match: PjlinkPersistedProjector | undefined
		if (projectorId) {
			match = projectors.find(
				(projector) => projector.projectorId === projectorId,
			)
			if (!match) {
				throw new PjlinkProjectorSelectionError({
					code: 'pjlink_projector_not_found',
					message: `PJLink projector "${projectorId}" was not found.`,
					projectorId,
				})
			}
		} else if (name) {
			const normalized = normalizeName(name)
			const matches = projectors.filter(
				(projector) => normalizeName(projector.name) === normalized,
			)
			if (matches.length === 0) {
				throw new PjlinkProjectorSelectionError({
					code: 'pjlink_projector_name_not_found',
					message: `PJLink projector named "${name}" was not found.`,
					projectorName: name,
				})
			}
			if (matches.length > 1) {
				throw new PjlinkProjectorSelectionError({
					code: 'pjlink_projector_name_ambiguous',
					message: `Multiple PJLink projectors match "${name}". Pass projectorId.`,
					projectorName: name,
				})
			}
			match = matches[0]
		} else if (host) {
			match = projectors.find(
				(projector) => normalizePjlinkHost(projector.host) === host,
			)
			if (!match) {
				throw new PjlinkProjectorSelectionError({
					code: 'pjlink_projector_not_found',
					message: `PJLink projector at "${host}" was not found.`,
				})
			}
		} else if (projectors.length === 1) {
			match = projectors[0]
		} else {
			throw new PjlinkProjectorSelectionError({
				code: 'pjlink_projector_selector_invalid',
				message:
					projectors.length === 0
						? 'No PJLink projectors are known. Scan or adopt one first.'
						: 'Multiple PJLink projectors are known. Pass projectorId, name, or host.',
			})
		}

		if (!match) {
			throw new PjlinkProjectorSelectionError({
				code: 'pjlink_projector_not_found',
				message: 'PJLink projector was not found.',
			})
		}
		if (options.requireAdopted && !match.adopted) {
			throw new PjlinkProjectorSelectionError({
				code: 'pjlink_projector_not_adopted',
				message: `PJLink projector "${match.name}" must be adopted before control.`,
				projectorId: match.projectorId,
				projectorName: match.name,
			})
		}
		return match
	}

	async function sendCommand(inputCommand: {
		projector: PjlinkPersistedProjector
		command: string
		parameter: string
		timeoutMs?: number
	}) {
		const password = await getPjlinkProjectorPassword({
			storage,
			connectorId,
			projectorId: inputCommand.projector.projectorId,
		})
		const result = await commandClient({
			host: inputCommand.projector.host,
			port: inputCommand.projector.port,
			password,
			timeoutMs: inputCommand.timeoutMs ?? config.pjlinkRequestTimeoutMs,
			command: inputCommand.command,
			parameter: inputCommand.parameter,
		})
		await updatePjlinkLastSeen({
			storage,
			connectorId,
			projectorId: inputCommand.projector.projectorId,
			lastSeenAt: new Date().toISOString(),
		})
		return result
	}

	async function withProjector<T>(
		selector: PjlinkProjectorSelector,
		handler: (projector: PjlinkPersistedProjector) => Promise<T>,
	) {
		const projector = await resolveProjector(selector, { requireAdopted: true })
		return await handler(projector)
	}

	function discoveredFromAdoptInput(
		inputAdopt: PjlinkAdoptInput,
		existing?: PjlinkPersistedProjector | null,
	) {
		const host = normalizePjlinkHost(
			inputAdopt.host ?? existing?.host ?? courtOptomaDefaults.host,
		)
		const port = inputAdopt.port ?? existing?.port ?? 4352
		const macAddress = normalizePjlinkMacAddress(
			inputAdopt.macAddress ?? existing?.macAddress ?? null,
		)
		const projectorId =
			inputAdopt.projectorId?.trim() ||
			existing?.projectorId ||
			buildPjlinkProjectorId({ macAddress, host, port })
		return {
			projectorId,
			name:
				inputAdopt.name?.trim() ||
				existing?.name ||
				(host === courtOptomaDefaults.host
					? courtOptomaDefaults.name
					: `PJLink projector ${host}`),
			host,
			port,
			macAddress,
			manufacturer: existing?.manufacturer ?? null,
			model: existing?.model ?? null,
			authRequired:
				Boolean(inputAdopt.password) || Boolean(existing?.authRequired),
			lastSeenAt: existing?.lastSeenAt ?? new Date().toISOString(),
			rawDiscovery: existing?.rawDiscovery ?? null,
		}
	}

	return {
		async scan() {
			const result = await scanPjlinkProjectors(state, config)
			await upsertDiscoveredPjlinkProjectors({
				storage,
				connectorId,
				projectors: result.projectors,
			})
			return await listProjectors()
		},
		async getStatus() {
			const projectors = await listProjectors()
			const adopted = projectors.filter((projector) => projector.adopted)
			const discoveredIds = new Set(
				state.pjlinkDiscoveredProjectors.map(
					(projector) => projector.projectorId,
				),
			)
			return {
				projectors,
				adopted,
				discovered: state.pjlinkDiscoveredProjectors.filter(
					(projector) =>
						!projectors.some(
							(known) => known.projectorId === projector.projectorId,
						),
				),
				allDiscovered: state.pjlinkDiscoveredProjectors,
				diagnostics: state.pjlinkDiscoveryDiagnostics,
				knownDiscoveredIds: [...discoveredIds],
			}
		},
		getDiscoveryDiagnostics() {
			return state.pjlinkDiscoveryDiagnostics
		},
		listProjectors,
		async adoptProjector(inputAdopt: PjlinkAdoptInput) {
			const projectorId = inputAdopt.projectorId?.trim()
			const existing = projectorId
				? await getPjlinkProjector(storage, connectorId, projectorId)
				: null
			const discovered = state.pjlinkDiscoveredProjectors.find((projector) => {
				if (projectorId && projector.projectorId === projectorId) return true
				if (
					inputAdopt.host &&
					normalizePjlinkHost(projector.host) ===
						normalizePjlinkHost(inputAdopt.host)
				) {
					return true
				}
				return false
			})
			if (!existing && !discovered && !inputAdopt.host && !projectorId) {
				throw new PjlinkProjectorSelectionError({
					code: 'pjlink_projector_selector_invalid',
					message:
						'Adopt a discovered projectorId or pass host (and optional MAC/name) to register a PJLink projector.',
				})
			}
			const record = discoveredFromAdoptInput(
				{
					...inputAdopt,
					host: inputAdopt.host ?? discovered?.host ?? existing?.host,
					name: inputAdopt.name ?? discovered?.name ?? existing?.name,
					macAddress:
						inputAdopt.macAddress ??
						discovered?.macAddress ??
						existing?.macAddress ??
						undefined,
					port: inputAdopt.port ?? discovered?.port ?? existing?.port,
					projectorId:
						projectorId || discovered?.projectorId || existing?.projectorId,
				},
				existing ??
					(discovered
						? {
								...discovered,
								adopted: false,
								hasPassword: false,
							}
						: null),
			)
			const saved = await upsertPjlinkProjector({
				storage,
				connectorId,
				projector: discovered
					? {
							...discovered,
							...record,
							name: record.name,
							macAddress: record.macAddress,
						}
					: record,
				adopted: true,
				password: inputAdopt.password,
			})
			if (!saved) {
				throw new Error('Failed to save PJLink projector.')
			}
			await adoptPjlinkProjector({
				storage,
				connectorId,
				projectorId: saved.projectorId,
				password: inputAdopt.password,
			})
			const adopted = await getPjlinkProjector(
				storage,
				connectorId,
				saved.projectorId,
			)
			if (!adopted) {
				throw new Error('Failed to adopt PJLink projector.')
			}
			return toPublicProjector(adopted)
		},
		async forgetProjector(selector: PjlinkProjectorSelector) {
			const projector = await resolveProjector(selector)
			await removePjlinkProjector({
				storage,
				connectorId,
				projectorId: projector.projectorId,
			})
			return toPublicProjector(projector)
		},
		async getPower(
			selector: PjlinkProjectorSelector = {},
			options: { timeoutMs?: number } = {},
		) {
			return await withProjector(selector, async (projector) => {
				const result = await sendCommand({
					projector,
					command: 'POWR',
					parameter: '?',
					timeoutMs: options.timeoutMs,
				})
				return {
					projector: toPublicProjector(projector),
					power: parsePjlinkPowerState(result.value),
					command: 'query' as const,
					raw: result.raw,
				}
			})
		},
		async setPower(
			selector: PjlinkProjectorSelector,
			command: PjlinkPowerCommand,
			options: { timeoutMs?: number } = {},
		) {
			return await withProjector(selector, async (projector) => {
				const result = await sendCommand({
					projector,
					command: 'POWR',
					parameter: encodePjlinkPowerCommand(command),
					timeoutMs: options.timeoutMs,
				})
				return {
					projector: toPublicProjector(projector),
					power: command === 'on' ? ('on' as const) : ('standby' as const),
					command,
					raw: result.raw,
				}
			})
		},
		async getInput(selector: PjlinkProjectorSelector = {}) {
			return await withProjector(selector, async (projector) => {
				const result = await sendCommand({
					projector,
					command: 'INPT',
					parameter: '?',
				})
				const parsed = parsePjlinkInput(result.value)
				return {
					projector: toPublicProjector(projector),
					...parsed,
					raw: result.raw,
				}
			})
		},
		async setInput(
			selector: PjlinkProjectorSelector,
			inputValue: { inputClass: PjlinkInputClass; channel: number },
		) {
			return await withProjector(selector, async (projector) => {
				const result = await sendCommand({
					projector,
					command: 'INPT',
					parameter: encodePjlinkInput(inputValue),
				})
				return {
					projector: toPublicProjector(projector),
					...inputValue,
					code: encodePjlinkInput(inputValue),
					raw: result.raw,
				}
			})
		},
		async getAvMute(selector: PjlinkProjectorSelector = {}) {
			return await withProjector(selector, async (projector) => {
				const result = await sendCommand({
					projector,
					command: 'AVMT',
					parameter: '?',
				})
				return {
					projector: toPublicProjector(projector),
					mode: parsePjlinkAvMute(result.value),
					raw: result.raw,
				}
			})
		},
		async setAvMute(selector: PjlinkProjectorSelector, mode: PjlinkAvMuteMode) {
			return await withProjector(selector, async (projector) => {
				const result = await sendCommand({
					projector,
					command: 'AVMT',
					parameter: encodePjlinkAvMute(mode),
				})
				return {
					projector: toPublicProjector(projector),
					mode,
					raw: result.raw,
				}
			})
		},
		async getLamp(selector: PjlinkProjectorSelector = {}) {
			return await withProjector(selector, async (projector) => {
				const result = await sendCommand({
					projector,
					command: 'LAMP',
					parameter: '?',
				})
				return {
					projector: toPublicProjector(projector),
					lamps: parsePjlinkLampStatus(result.value),
					raw: result.raw,
				}
			})
		},
		async getInfo(selector: PjlinkProjectorSelector = {}) {
			return await withProjector(selector, async (projector) => {
				const commands = ['NAME', 'INF1', 'INF2', 'INFO', 'CLSS'] as const
				const raw: Record<string, string> = {}
				for (const command of commands) {
					const result = await sendCommand({
						projector,
						command,
						parameter: '?',
					})
					raw[command] = result.value
				}
				return {
					projector: toPublicProjector(projector),
					name: raw['NAME'] ?? null,
					manufacturer: raw['INF1'] ?? null,
					model: raw['INF2'] ?? null,
					info: raw['INFO'] ?? null,
					pjlinkClass: raw['CLSS'] ?? null,
					raw,
				}
			})
		},
		async resolveCourtProjector() {
			const configuredId = config.courtPjlinkProjectorId?.trim()
			const projectors = (
				await listPjlinkProjectors(storage, connectorId)
			).filter((projector) => projector.adopted)
			if (configuredId) {
				const match = projectors.find(
					(projector) => projector.projectorId === configuredId,
				)
				return match ?? null
			}
			const courtMac = normalizePjlinkMacAddress(courtOptomaDefaults.macAddress)
			const byMac = projectors.filter(
				(projector) =>
					normalizePjlinkMacAddress(projector.macAddress) === courtMac,
			)
			if (byMac.length === 1) return byMac[0]!
			const byHost = projectors.filter(
				(projector) =>
					normalizePjlinkHost(projector.host) === courtOptomaDefaults.host,
			)
			if (byHost.length === 1) return byHost[0]!
			const byName = projectors.filter((projector) =>
				/court|optoma/i.test(projector.name),
			)
			if (byName.length === 1) return byName[0]!
			if (byName.length > 1) {
				throw new Error(
					`Multiple adopted PJLink projectors match court/Optoma. Set COURT_PJLINK_PROJECTOR_ID.`,
				)
			}
			return null
		},
	}
}
