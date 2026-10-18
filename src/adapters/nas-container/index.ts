import { type HomeConnectorConfig } from '../../config.ts'
import {
	allowlistedImageRef,
	getNasContainerServiceDefinition,
	type NasContainerServiceId,
} from './allowlist.ts'
import { createDockerEngineClient } from './docker-engine-client.ts'
import {
	createNasContainerOperationId,
	listNasContainerOperations,
	readNasContainerOperation,
	writeNasContainerOperation,
} from './operation-status.ts'
import {
	assertRunningImageMatchesService,
	buildPreservedConfigPlan,
	parseCommitFromHealthBody,
	pickOciRevision,
	pickRepoDigest,
	pullAllowlistedImage,
	recreateContainerWithRollback,
} from './recreate.ts'
import {
	type NasContainerCheckResult,
	type NasContainerUpdateOperation,
	type NasContainerUpdateResult,
	type NasDockerEngineClient,
} from './types.ts'
import {
	assertNasContainerUpdatesEnabled,
	assertNasContainerWriteAllowed,
	nasContainerUpdateConfirmation,
	resolveContainerNameForService,
	resolveNasContainerService,
} from './validation.ts'

export {
	nasContainerAllowlist,
	nasContainerServiceIds,
	allowlistedImageRef,
	type NasContainerServiceId,
} from './allowlist.ts'
export {
	nasContainerUpdateConfirmation,
	nasContainerUpdatesDisabledMessage,
} from './validation.ts'

function helperContainerName(operationId: string) {
	return `kody-nas-update-helper-${operationId.slice(0, 12)}`
}

const updateLocks = new Map<NasContainerServiceId, Promise<unknown>>()

async function withServiceUpdateLock<T>(
	service: NasContainerServiceId,
	run: () => Promise<T>,
): Promise<T> {
	const previous = updateLocks.get(service) ?? Promise.resolve()
	let release!: () => void
	const gate = new Promise<void>((resolve) => {
		release = resolve
	})
	const tail = previous.catch(() => undefined).then(() => gate)
	updateLocks.set(service, tail)
	await previous.catch(() => undefined)
	try {
		return await run()
	} finally {
		release()
		if (updateLocks.get(service) === tail) {
			updateLocks.delete(service)
		}
	}
}

export function createNasContainerAdapter(input: {
	config: HomeConnectorConfig
	dockerClientFactory?: (socketPath: string) => NasDockerEngineClient
	fetchFn?: typeof fetch
	now?: () => Date
}) {
	const { config } = input
	const fetchFn = input.fetchFn ?? fetch
	const now = input.now ?? (() => new Date())

	function getDocker(): NasDockerEngineClient {
		const socketPath =
			config.nasDockerSocketPath?.trim() || '/var/run/docker.sock'
		if (input.dockerClientFactory) {
			return input.dockerClientFactory(socketPath)
		}
		return createDockerEngineClient({
			socketPath,
			requestTimeoutMs: Math.max(config.nasContainerHealthTimeoutMs, 60_000),
		})
	}

	async function requireDocker(): Promise<NasDockerEngineClient> {
		const docker = getDocker()
		try {
			await docker.ping()
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			throw new Error(
				`Docker Engine is unreachable at ${config.nasDockerSocketPath || '/var/run/docker.sock'}. Mount the host docker.sock into the connector (see docker/README.md). Underlying error: ${message}`,
			)
		}
		return docker
	}

	async function readRunningCommit(
		service: NasContainerServiceId,
	): Promise<string | null> {
		const definition = getNasContainerServiceDefinition(service)
		try {
			const response = await fetchFn(
				`http://127.0.0.1:${String(definition.healthPort)}${definition.healthPath}`,
				{ signal: AbortSignal.timeout(3_000) },
			)
			if (!response.ok) return null
			return parseCommitFromHealthBody(await response.text())
		} catch {
			return null
		}
	}

	async function checkContainerUpdate(rawService: unknown) {
		const service = resolveNasContainerService(rawService)
		const definition = getNasContainerServiceDefinition(service)
		const containerName = resolveContainerNameForService(config, service)
		const imageRef = allowlistedImageRef(service)
		const result: NasContainerCheckResult = {
			service,
			containerName,
			imageRef,
			running: false,
			containerId: null,
			imageId: null,
			repoDigest: null,
			createdAt: null,
			runningCommit: null,
			ociRevision: null,
			remoteDigest: null,
			updateAvailable: false,
			dockerSocketConfigured: true,
		}

		const docker = await requireDocker()
		try {
			const container = await docker.inspectContainer(containerName)
			result.running = container.State.Running
			result.containerId = container.Id
			result.imageId = container.Image
			result.createdAt = container.Created
			let image = null
			try {
				image = await docker.inspectImage(container.Image)
			} catch {
				image = null
			}
			if (image) {
				result.repoDigest = pickRepoDigest(image, definition.repository)
				result.ociRevision = pickOciRevision(image, container)
			}
			result.runningCommit =
				(await readRunningCommit(service)) ?? result.ociRevision
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			throw new Error(
				`Failed to inspect container "${containerName}" for ${service}: ${message}`,
			)
		}

		result.remoteDigest = await docker.getDistributionDigest(imageRef)
		if (result.remoteDigest && result.repoDigest) {
			result.updateAvailable = result.remoteDigest !== result.repoDigest
		} else if (result.remoteDigest && result.imageId) {
			// Fallback: treat missing local digest as unknown → available if remote exists
			result.updateAvailable = true
		}
		return result
	}

	async function updateContainer(request: {
		service: unknown
		dryRun?: boolean
		acknowledgeHighRisk?: boolean
		reason?: string
		confirmation?: string
	}): Promise<NasContainerUpdateResult> {
		const service = resolveNasContainerService(request.service)
		const definition = getNasContainerServiceDefinition(service)
		const dryRun = request.dryRun === true
		if (!dryRun) {
			assertNasContainerWriteAllowed(request)
			assertNasContainerUpdatesEnabled(config)
		}

		const run = async (): Promise<NasContainerUpdateResult> => {
			const docker = await requireDocker()
			const containerName = resolveContainerNameForService(config, service)
			const imageRef = allowlistedImageRef(service)
			const existing = await docker.inspectContainer(containerName)
			let currentImage = null
			try {
				currentImage = await docker.inspectImage(existing.Image)
			} catch {
				currentImage = null
			}
			assertRunningImageMatchesService({
				service,
				container: existing,
				image: currentImage,
			})
			const currentDigest = currentImage
				? pickRepoDigest(currentImage, definition.repository)
				: null
			const currentCommit =
				(await readRunningCommit(service)) ??
				pickOciRevision(currentImage, existing)
			const targetDigest = await docker.getDistributionDigest(imageRef)

			const plan = {
				service,
				containerName,
				imageRef,
				currentImageId: existing.Image,
				currentDigest,
				currentCommit,
				targetDigest,
				targetCommit: null as string | null,
				updateAvailable:
					Boolean(targetDigest) &&
					Boolean(currentDigest) &&
					targetDigest !== currentDigest,
				preservedConfig: buildPreservedConfigPlan(existing, imageRef),
				steps: definition.selfUpdate
					? [
							'Pull allowlisted image',
							'Write operation status to data volume',
							'Start detached helper container from the new image',
							'Return handed_off before this process exits',
							'Helper renames current container to *-prev-*',
							'Helper creates/starts replacement with preserved config',
							'Helper waits for /health then removes or rolls back',
						]
					: [
							'Pull allowlisted image',
							'Rename current container to *-prev-* and stop it',
							'Create/start replacement with preserved config',
							'Wait for /health',
							'On success keep latest prev and prune older prev containers',
							'On failure remove replacement and restore previous container',
						],
			}

			if (dryRun) {
				return { status: 'dry_run', plan }
			}

			const operationId = createNasContainerOperationId()
			await writeNasContainerOperation(config.dataPath, {
				operationId,
				service,
				status: 'pending',
				createdAt: now().toISOString(),
				updatedAt: now().toISOString(),
				containerName,
				imageRef,
				oldImageId: existing.Image,
				oldDigest: currentDigest,
				oldCommit: currentCommit,
			})

			if (definition.selfUpdate) {
				return await handOffSelfUpdate({
					docker,
					service,
					containerName,
					imageRef,
					operationId,
					existing,
				})
			}

			await writeNasContainerOperation(config.dataPath, {
				operationId,
				service,
				status: 'recreating',
				createdAt: now().toISOString(),
				updatedAt: now().toISOString(),
				containerName,
				imageRef,
				oldImageId: existing.Image,
				oldDigest: currentDigest,
				oldCommit: currentCommit,
			})

			const result = await recreateContainerWithRollback({
				docker,
				service,
				containerName,
				imageRef,
				healthTimeoutMs: config.nasContainerHealthTimeoutMs,
				fetchFn,
			})

			if (result.status === 'updated') {
				await writeNasContainerOperation(config.dataPath, {
					operationId,
					service,
					status: 'succeeded',
					createdAt: now().toISOString(),
					updatedAt: now().toISOString(),
					containerName,
					imageRef,
					oldImageId: result.oldImageId,
					newImageId: result.newImageId,
					oldDigest: result.oldDigest,
					newDigest: result.newDigest,
					oldCommit: result.oldCommit,
					newCommit: result.newCommit,
					previousContainerName: result.previousContainerName,
					message: 'Container updated successfully.',
				})
				return {
					status: 'updated',
					service,
					containerName,
					imageRef,
					oldImageId: result.oldImageId,
					newImageId: result.newImageId,
					oldDigest: result.oldDigest,
					newDigest: result.newDigest,
					oldCommit: result.oldCommit,
					newCommit: result.newCommit,
					previousContainerName: result.previousContainerName,
					operationId,
				}
			}

			await writeNasContainerOperation(config.dataPath, {
				operationId,
				service,
				status: 'rolled_back',
				createdAt: now().toISOString(),
				updatedAt: now().toISOString(),
				containerName,
				imageRef,
				oldImageId: result.oldImageId,
				newImageId: result.newImageId,
				oldDigest: result.oldDigest,
				newDigest: result.newDigest,
				oldCommit: result.oldCommit,
				newCommit: result.newCommit,
				previousContainerName: result.previousContainerName,
				error: result.error ?? 'Update failed; rolled back.',
			})
			return {
				status: 'rolled_back',
				service,
				containerName,
				operationId,
				error: result.error ?? 'Update failed; rolled back.',
				previousContainerName: result.previousContainerName,
			}
		}

		if (dryRun) return await run()
		return await withServiceUpdateLock(service, run)
	}

	async function handOffSelfUpdate(input: {
		docker: NasDockerEngineClient
		service: NasContainerServiceId
		containerName: string
		imageRef: string
		operationId: string
		existing: Awaited<ReturnType<NasDockerEngineClient['inspectContainer']>>
	}): Promise<NasContainerUpdateResult> {
		await writeNasContainerOperation(config.dataPath, {
			operationId: input.operationId,
			service: input.service,
			status: 'pulling',
			createdAt: now().toISOString(),
			updatedAt: now().toISOString(),
			containerName: input.containerName,
			imageRef: input.imageRef,
		})

		const pulled = await pullAllowlistedImage({
			docker: input.docker,
			service: input.service,
		})

		const helperName = helperContainerName(input.operationId)
		const helperBody = {
			Image: input.imageRef,
			Env: [
				...(input.existing.Config.Env ?? []).filter(
					(entry) =>
						!entry.startsWith('NAS_CONTAINER_UPDATE_HELPER=') &&
						!entry.startsWith('NAS_CONTAINER_UPDATE_OPERATION_ID=') &&
						!entry.startsWith('NAS_CONTAINER_UPDATE_SERVICE='),
				),
				'NAS_CONTAINER_UPDATE_HELPER=1',
				`NAS_CONTAINER_UPDATE_OPERATION_ID=${input.operationId}`,
				`NAS_CONTAINER_UPDATE_SERVICE=${input.service}`,
			],
			Labels: {
				...input.existing.Config.Labels,
				'kody.nas-container-update.helper': '1',
				'kody.nas-container-update.operation-id': input.operationId,
			},
			HostConfig: {
				Binds: input.existing.HostConfig['Binds'],
				NetworkMode: 'host',
				RestartPolicy: { Name: 'no' },
				Privileged: input.existing.HostConfig['Privileged'] === true,
			},
			Entrypoint: ['node', '--import', './src/sentry-init.ts', 'index.ts'],
			Cmd: [],
		}

		await input.docker.createContainer({
			name: helperName,
			body: helperBody,
		})
		// Persist handed_off BEFORE starting the helper so a fast helper cannot
		// finish and then be overwritten by a late parent write.
		await writeNasContainerOperation(config.dataPath, {
			operationId: input.operationId,
			service: input.service,
			status: 'handed_off',
			createdAt: now().toISOString(),
			updatedAt: now().toISOString(),
			containerName: input.containerName,
			imageRef: input.imageRef,
			newImageId: pulled.image.Id,
			newDigest: pulled.digest,
			newCommit: pulled.ociRevision,
			helperContainerName: helperName,
			message:
				'Self-update handed off to a helper container. Poll nas_container_update_status.',
		})
		await input.docker.startContainer(helperName)

		return {
			status: 'handed_off',
			service: input.service,
			operationId: input.operationId,
			helperContainerName: helperName,
			message:
				'Self-update handed off to a helper container. Poll nas_container_update_status until succeeded or rolled_back.',
		}
	}

	async function getUpdateStatus(operationId?: string | null): Promise<{
		operation: NasContainerUpdateOperation | null
		recent: Array<NasContainerUpdateOperation>
	}> {
		if (operationId) {
			const operation = await readNasContainerOperation(
				config.dataPath,
				operationId,
			)
			return {
				operation,
				recent: operation ? [operation] : [],
			}
		}
		const recent = await listNasContainerOperations(config.dataPath)
		return {
			operation: recent[0] ?? null,
			recent: recent.slice(0, 10),
		}
	}

	return {
		writeConfirmation: nasContainerUpdateConfirmation,
		checkContainerUpdate,
		updateContainer,
		getUpdateStatus,
		/** Exposed for the self-update helper process. */
		async runHelperOperation(operationId: string) {
			const operation = await readNasContainerOperation(
				config.dataPath,
				operationId,
			)
			if (!operation) {
				throw new Error(`Unknown NAS container update operation ${operationId}`)
			}
			const service = resolveNasContainerService(operation.service)
			// Prefer the name frozen into the operation file so runtime-config
			// differences in the helper cannot retarget the wrong container.
			const containerName =
				operation.containerName?.trim() ||
				resolveContainerNameForService(config, service)
			return await withServiceUpdateLock(service, async () => {
				const docker = await requireDocker()
				await writeNasContainerOperation(config.dataPath, {
					...operation,
					containerName,
					status: 'recreating',
				})
				const result = await recreateContainerWithRollback({
					docker,
					service,
					containerName,
					imageRef: allowlistedImageRef(service),
					healthTimeoutMs: config.nasContainerHealthTimeoutMs,
					fetchFn,
				})
				if (result.status === 'updated') {
					await writeNasContainerOperation(
						config.dataPath,
						{
							...operation,
							containerName,
							status: 'succeeded',
							oldImageId: result.oldImageId,
							newImageId: result.newImageId,
							oldDigest: result.oldDigest,
							newDigest: result.newDigest,
							oldCommit: result.oldCommit,
							newCommit: result.newCommit,
							previousContainerName: result.previousContainerName,
							error: null,
							message: 'Self-update completed successfully.',
						},
						{ overwriteTerminal: true },
					)
				} else {
					await writeNasContainerOperation(
						config.dataPath,
						{
							...operation,
							containerName,
							status: 'rolled_back',
							oldImageId: result.oldImageId,
							newImageId: result.newImageId,
							oldDigest: result.oldDigest,
							newDigest: result.newDigest,
							oldCommit: result.oldCommit,
							newCommit: result.newCommit,
							previousContainerName: result.previousContainerName,
							error: result.error ?? 'Self-update failed; rolled back.',
						},
						{ overwriteTerminal: true },
					)
				}
				return result
			})
		},
	}
}

export type NasContainerAdapter = ReturnType<typeof createNasContainerAdapter>
