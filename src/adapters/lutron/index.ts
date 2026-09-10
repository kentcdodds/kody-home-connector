import { type HomeConnectorConfig } from '../../config.ts'
import { type HomeConnectorState } from '../../state.ts'
import { type HomeConnectorStorage } from '../../storage/index.ts'
import {
	listMockLutronAreas,
	listMockLutronButtonsForDevice,
	listMockLutronControlStations,
	listMockLutronVirtualButtons,
	listMockLutronZones,
	pressMockLutronButton,
	setMockLutronShadeLevel,
	setMockLutronZoneColor,
	setMockLutronZoneLevel,
	setMockLutronZoneSwitchedLevel,
	setMockLutronZoneWhiteTuning,
	validateMockLutronCredentials,
} from './mock-driver.ts'
import { scanLutronProcessors } from './discovery.ts'
import {
	authenticateLutronProcessor,
	loadLutronInventory,
	normalizeLutronZoneId,
	pressLutronButton,
	isLutronExpectedClientError,
	isLutronInvalidCredentialsError,
	setLutronShadeLevel,
	setLutronZoneColor,
	setLutronZoneLevel,
	setLutronZoneSwitchedLevel,
	setLutronZoneWhiteTuning,
} from './leap-client.ts'
import {
	listLutronPublicProcessors,
	requireLutronProcessor,
	saveLutronCredentials,
	toLutronPublicProcessor,
	updateLutronAuthStatus,
	upsertDiscoveredLutronProcessors,
} from './repository.ts'
import { type LutronInventory, type LutronSceneButton } from './types.ts'

function isMockLutronHost(host: string) {
	return host.endsWith('.mock.local')
}

function requireLutronCredentials(processor: {
	processorId: string
	username: string | null
	password: string | null
}) {
	if (!processor.username || !processor.password) {
		throw new Error(
			`Lutron processor "${processor.processorId}" is missing stored credentials. Run lutron_set_credentials first.`,
		)
	}
	return {
		username: processor.username,
		password: processor.password,
	}
}

async function updateLutronAuthFailure(input: {
	storage: HomeConnectorStorage
	connectorId: string
	processorId: string
	error: unknown
}) {
	// Invalid credentials must still update lastAuthError. Other expected LEAP
	// client errors (unsupported commands, bad zone ids) are not auth failures.
	if (
		isLutronExpectedClientError(input.error) &&
		!isLutronInvalidCredentialsError(input.error)
	) {
		return
	}
	await updateLutronAuthStatus({
		storage: input.storage,
		connectorId: input.connectorId,
		processorId: input.processorId,
		lastAuthenticatedAt: null,
		lastAuthError:
			input.error instanceof Error ? input.error.message : String(input.error),
	})
}

export function createLutronAdapter(input: {
	config: HomeConnectorConfig
	state: HomeConnectorState
	storage: HomeConnectorStorage
}) {
	function listProcessors() {
		return listLutronPublicProcessors(
			input.storage,
			input.config.homeConnectorId,
		)
	}

	async function buildMockInventory(processorId: string) {
		const processor = await requireLutronProcessor(
			input.storage,
			input.config.homeConnectorId,
			processorId,
		)
		const areas = listMockLutronAreas(processorId)
		const zones = areas.flatMap((area) =>
			listMockLutronZones(processorId, area.areaId),
		)
		const controlStations = areas.flatMap((area) =>
			listMockLutronControlStations(processorId, area.areaId),
		)
		const buttons = controlStations.flatMap((station) =>
			station.devices.flatMap((device) =>
				listMockLutronButtonsForDevice(device.deviceId),
			),
		)
		const virtualButtons = listMockLutronVirtualButtons(processorId)
		const sceneButtons: Array<LutronSceneButton> = [
			...buttons.map((button) => ({ kind: 'keypad' as const, ...button })),
			...virtualButtons
				.filter((button) => button.isProgrammed)
				.map((button) => ({ kind: 'virtual' as const, ...button })),
		]
		return {
			processor,
			areas,
			zones,
			controlStations,
			buttons,
			virtualButtons,
			sceneButtons,
		} satisfies LutronInventory
	}

	return {
		async scan() {
			const result = await scanLutronProcessors(input.state, input.config)
			await upsertDiscoveredLutronProcessors(
				input.storage,
				input.config.homeConnectorId,
				result.processors,
			)
			return listProcessors()
		},
		async getStatus() {
			const processors = await listProcessors()
			return {
				processors,
				diagnostics: input.state.lutronDiscoveryDiagnostics,
				configuredCredentialsCount: processors.filter(
					(processor) => processor.hasStoredCredentials,
				).length,
			}
		},
		async setCredentials(
			processorId: string,
			username: string,
			password: string,
		) {
			await requireLutronProcessor(
				input.storage,
				input.config.homeConnectorId,
				processorId,
			)
			await saveLutronCredentials({
				storage: input.storage,
				connectorId: input.config.homeConnectorId,
				processorId,
				username,
				password,
			})
			return toLutronPublicProcessor(
				await requireLutronProcessor(
					input.storage,
					input.config.homeConnectorId,
					processorId,
				),
			)
		},
		async authenticate(processorId: string) {
			const processor = await requireLutronProcessor(
				input.storage,
				input.config.homeConnectorId,
				processorId,
			)
			const credentials = requireLutronCredentials(processor)
			try {
				if (input.config.mocksEnabled && isMockLutronHost(processor.host)) {
					if (
						!validateMockLutronCredentials(
							processor.host,
							credentials.username,
							credentials.password,
						)
					) {
						throw new Error(
							'Lutron mock authorization failed because the credentials are invalid.',
						)
					}
				} else {
					await authenticateLutronProcessor({
						processor,
						credentials,
					})
				}
				await updateLutronAuthStatus({
					storage: input.storage,
					connectorId: input.config.homeConnectorId,
					processorId,
					lastAuthenticatedAt: new Date().toISOString(),
					lastAuthError: null,
				})
			} catch (error) {
				await updateLutronAuthFailure({
					storage: input.storage,
					connectorId: input.config.homeConnectorId,
					processorId,
					error,
				})
				throw error
			}
			return toLutronPublicProcessor(
				await requireLutronProcessor(
					input.storage,
					input.config.homeConnectorId,
					processorId,
				),
			)
		},
		async getInventory(processorId: string) {
			const processor = await requireLutronProcessor(
				input.storage,
				input.config.homeConnectorId,
				processorId,
			)
			const credentials = requireLutronCredentials(processor)
			try {
				const inventory =
					input.config.mocksEnabled && isMockLutronHost(processor.host)
						? {
								...(await buildMockInventory(processorId)),
								processor: toLutronPublicProcessor(processor),
							}
						: await loadLutronInventory({
								processor,
								credentials,
							})
				await updateLutronAuthStatus({
					storage: input.storage,
					connectorId: input.config.homeConnectorId,
					processorId,
					lastAuthenticatedAt: new Date().toISOString(),
					lastAuthError: null,
				})
				return inventory
			} catch (error) {
				await updateLutronAuthFailure({
					storage: input.storage,
					connectorId: input.config.homeConnectorId,
					processorId,
					error,
				})
				throw error
			}
		},
		async pressButton(processorId: string, buttonId: string) {
			const processor = await requireLutronProcessor(
				input.storage,
				input.config.homeConnectorId,
				processorId,
			)
			const credentials = requireLutronCredentials(processor)
			try {
				const response =
					input.config.mocksEnabled && isMockLutronHost(processor.host)
						? pressMockLutronButton(buttonId)
						: await pressLutronButton({
								processor,
								credentials,
								buttonId,
							})
				await updateLutronAuthStatus({
					storage: input.storage,
					connectorId: input.config.homeConnectorId,
					processorId,
					lastAuthenticatedAt: new Date().toISOString(),
					lastAuthError: null,
				})
				return {
					ok: true,
					processorId,
					buttonId,
					response,
				}
			} catch (error) {
				await updateLutronAuthFailure({
					storage: input.storage,
					connectorId: input.config.homeConnectorId,
					processorId,
					error,
				})
				throw error
			}
		},
		async setZoneLevel(processorId: string, zoneId: string, level: number) {
			const processor = await requireLutronProcessor(
				input.storage,
				input.config.homeConnectorId,
				processorId,
			)
			const credentials = requireLutronCredentials(processor)
			const normalizedZoneId = normalizeLutronZoneId(zoneId)
			try {
				const response =
					input.config.mocksEnabled && isMockLutronHost(processor.host)
						? setMockLutronZoneLevel(normalizedZoneId, level)
						: await setLutronZoneLevel({
								processor,
								credentials,
								zoneId: normalizedZoneId,
								level,
							})
				await updateLutronAuthStatus({
					storage: input.storage,
					connectorId: input.config.homeConnectorId,
					processorId,
					lastAuthenticatedAt: new Date().toISOString(),
					lastAuthError: null,
				})
				return {
					ok: true,
					processorId,
					zoneId: normalizedZoneId,
					level,
					response,
				}
			} catch (error) {
				await updateLutronAuthFailure({
					storage: input.storage,
					connectorId: input.config.homeConnectorId,
					processorId,
					error,
				})
				throw error
			}
		},
		async setZoneColor(
			processorId: string,
			zoneId: string,
			inputColor: {
				hue: number
				saturation: number
				level?: number
				vibrancy?: number
			},
		) {
			const processor = await requireLutronProcessor(
				input.storage,
				input.config.homeConnectorId,
				processorId,
			)
			const credentials = requireLutronCredentials(processor)
			const normalizedZoneId = normalizeLutronZoneId(zoneId)
			try {
				const response =
					input.config.mocksEnabled && isMockLutronHost(processor.host)
						? setMockLutronZoneColor({
								zoneId: normalizedZoneId,
								hue: inputColor.hue,
								saturation: inputColor.saturation,
								level: inputColor.level,
								vibrancy: inputColor.vibrancy,
							})
						: await setLutronZoneColor({
								processor,
								credentials,
								zoneId: normalizedZoneId,
								hue: inputColor.hue,
								saturation: inputColor.saturation,
								level: inputColor.level,
								vibrancy: inputColor.vibrancy,
							})
				await updateLutronAuthStatus({
					storage: input.storage,
					connectorId: input.config.homeConnectorId,
					processorId,
					lastAuthenticatedAt: new Date().toISOString(),
					lastAuthError: null,
				})
				return {
					ok: true,
					processorId,
					zoneId: normalizedZoneId,
					hue: inputColor.hue,
					saturation: inputColor.saturation,
					level: inputColor.level ?? null,
					vibrancy: inputColor.vibrancy ?? null,
					response,
				}
			} catch (error) {
				await updateLutronAuthFailure({
					storage: input.storage,
					connectorId: input.config.homeConnectorId,
					processorId,
					error,
				})
				throw error
			}
		},
		async setZoneWhiteTuning(
			processorId: string,
			zoneId: string,
			inputWhiteTuning: {
				kelvin: number
				level?: number
			},
		) {
			const processor = await requireLutronProcessor(
				input.storage,
				input.config.homeConnectorId,
				processorId,
			)
			const credentials = requireLutronCredentials(processor)
			const normalizedZoneId = normalizeLutronZoneId(zoneId)
			try {
				const response =
					input.config.mocksEnabled && isMockLutronHost(processor.host)
						? setMockLutronZoneWhiteTuning({
								zoneId: normalizedZoneId,
								kelvin: inputWhiteTuning.kelvin,
								level: inputWhiteTuning.level,
							})
						: await setLutronZoneWhiteTuning({
								processor,
								credentials,
								zoneId: normalizedZoneId,
								kelvin: inputWhiteTuning.kelvin,
								level: inputWhiteTuning.level,
							})
				await updateLutronAuthStatus({
					storage: input.storage,
					connectorId: input.config.homeConnectorId,
					processorId,
					lastAuthenticatedAt: new Date().toISOString(),
					lastAuthError: null,
				})
				return {
					ok: true,
					processorId,
					zoneId: normalizedZoneId,
					kelvin: inputWhiteTuning.kelvin,
					level: inputWhiteTuning.level ?? null,
					response,
				}
			} catch (error) {
				await updateLutronAuthFailure({
					storage: input.storage,
					connectorId: input.config.homeConnectorId,
					processorId,
					error,
				})
				throw error
			}
		},
		async setZoneSwitchedLevel(
			processorId: string,
			zoneId: string,
			state: 'On' | 'Off',
		) {
			const processor = await requireLutronProcessor(
				input.storage,
				input.config.homeConnectorId,
				processorId,
			)
			const credentials = requireLutronCredentials(processor)
			const normalizedZoneId = normalizeLutronZoneId(zoneId)
			try {
				const response =
					input.config.mocksEnabled && isMockLutronHost(processor.host)
						? setMockLutronZoneSwitchedLevel({
								zoneId: normalizedZoneId,
								state,
							})
						: await setLutronZoneSwitchedLevel({
								processor,
								credentials,
								zoneId: normalizedZoneId,
								state,
							})
				await updateLutronAuthStatus({
					storage: input.storage,
					connectorId: input.config.homeConnectorId,
					processorId,
					lastAuthenticatedAt: new Date().toISOString(),
					lastAuthError: null,
				})
				return {
					ok: true,
					processorId,
					zoneId: normalizedZoneId,
					state,
					response,
				}
			} catch (error) {
				await updateLutronAuthFailure({
					storage: input.storage,
					connectorId: input.config.homeConnectorId,
					processorId,
					error,
				})
				throw error
			}
		},
		async setShadeLevel(processorId: string, zoneId: string, level: number) {
			const processor = await requireLutronProcessor(
				input.storage,
				input.config.homeConnectorId,
				processorId,
			)
			const credentials = requireLutronCredentials(processor)
			const normalizedZoneId = normalizeLutronZoneId(zoneId)
			try {
				const response =
					input.config.mocksEnabled && isMockLutronHost(processor.host)
						? setMockLutronShadeLevel({ zoneId: normalizedZoneId, level })
						: await setLutronShadeLevel({
								processor,
								credentials,
								zoneId: normalizedZoneId,
								level,
							})
				await updateLutronAuthStatus({
					storage: input.storage,
					connectorId: input.config.homeConnectorId,
					processorId,
					lastAuthenticatedAt: new Date().toISOString(),
					lastAuthError: null,
				})
				return {
					ok: true,
					processorId,
					zoneId: normalizedZoneId,
					level,
					response,
				}
			} catch (error) {
				await updateLutronAuthFailure({
					storage: input.storage,
					connectorId: input.config.homeConnectorId,
					processorId,
					error,
				})
				throw error
			}
		},
	}
}
