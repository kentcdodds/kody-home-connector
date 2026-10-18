import {
	allowlistedImageRef,
	getNasContainerServiceDefinition,
	type NasContainerServiceId,
} from './allowlist.ts'
import { assertPulledImageMatchesAllowlist } from './validation.ts'
import {
	type DockerContainerCreateBody,
	type DockerContainerInspect,
	type DockerImageInspect,
	type NasContainerPreservedConfigPlan,
	type NasDockerEngineClient,
} from './types.ts'

const OCI_REVISION_LABEL = 'org.opencontainers.image.revision'

export function extractEnvKeys(env: Array<string> | null | undefined) {
	return (env ?? [])
		.map((entry) => entry.split('=', 1)[0] ?? '')
		.filter(Boolean)
}

export function buildPreservedConfigPlan(
	container: DockerContainerInspect,
	imageRef: string,
): NasContainerPreservedConfigPlan {
	const hostConfig = container.HostConfig ?? {}
	return {
		name: normalizeContainerName(container.Name),
		image: imageRef,
		networkMode: hostConfig['NetworkMode'] ?? null,
		restartPolicy: hostConfig['RestartPolicy'] ?? null,
		binds: hostConfig['Binds'] ?? null,
		portBindings: hostConfig['PortBindings'] ?? null,
		privileged: hostConfig['Privileged'] ?? false,
		extraHosts: hostConfig['ExtraHosts'] ?? null,
		labels: { ...container.Config.Labels },
		envKeys: extractEnvKeys(container.Config.Env),
		cmd: container.Config.Cmd ?? null,
		entrypoint: container.Config.Entrypoint ?? null,
		workingDir: container.Config.WorkingDir ?? null,
	}
}

export function normalizeContainerName(name: string) {
	return name.startsWith('/') ? name.slice(1) : name
}

export function buildCreateBodyFromInspect(
	container: DockerContainerInspect,
	imageRef: string,
): DockerContainerCreateBody {
	const config = container.Config
	const hostConfig = { ...container.HostConfig }
	// Drop ephemeral runtime fields that break create.
	delete hostConfig['ConsoleSize']

	const body: DockerContainerCreateBody = {
		Hostname: config.Hostname,
		Domainname: config.Domainname,
		User: config.User,
		AttachStdin: false,
		AttachStdout: false,
		AttachStderr: false,
		ExposedPorts: config.ExposedPorts,
		Tty: config.Tty,
		OpenStdin: config.OpenStdin,
		StdinOnce: config.StdinOnce,
		Env: config.Env,
		Cmd: config.Cmd,
		Healthcheck: config.Healthcheck,
		ArgsEscaped: config.ArgsEscaped,
		Image: imageRef,
		Volumes: config.Volumes,
		WorkingDir: config.WorkingDir,
		Entrypoint: config.Entrypoint,
		Labels: config.Labels,
		StopSignal: config.StopSignal,
		StopTimeout: config.StopTimeout,
		HostConfig: hostConfig,
	}

	const networks = container.NetworkSettings?.Networks
	if (networks && Object.keys(networks).length > 0) {
		const networkMode = String(hostConfig['NetworkMode'] ?? '')
		if (networkMode !== 'host' && networkMode !== 'none') {
			body.NetworkingConfig = { EndpointsConfig: networks }
		}
	}

	return body
}

export function pickRepoDigest(
	image: DockerImageInspect,
	repository: string,
): string | null {
	const digests = image.RepoDigests ?? []
	const match = digests.find((digest) => digest.startsWith(`${repository}@`))
	return match?.split('@')[1] ?? digests[0]?.split('@')[1] ?? null
}

export function pickOciRevision(
	image: DockerImageInspect | null | undefined,
	container?: DockerContainerInspect | null,
): string | null {
	const fromImage = image?.Config?.Labels?.[OCI_REVISION_LABEL]?.trim()
	if (fromImage) return fromImage
	const fromContainer = container?.Config.Labels?.[OCI_REVISION_LABEL]?.trim()
	return fromContainer || null
}

export function previousContainerName(containerName: string, at = new Date()) {
	const stamp = at.toISOString().replaceAll(/[:.]/g, '-').replace(/Z$/, 'Z')
	return `${containerName}-prev-${stamp}`
}

export async function waitForHttpHealth(input: {
	port: number
	path: string
	timeoutMs: number
	fetchFn?: typeof fetch
	now?: () => number
	sleep?: (ms: number) => Promise<void>
}): Promise<{ ok: true; bodyText: string } | { ok: false; error: string }> {
	const fetchFn = input.fetchFn ?? fetch
	const now = input.now ?? Date.now
	const sleep =
		input.sleep ??
		((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
	const deadline = now() + input.timeoutMs
	let lastError = 'health check did not succeed'
	while (now() < deadline) {
		try {
			const response = await fetchFn(
				`http://127.0.0.1:${String(input.port)}${input.path}`,
				{ signal: AbortSignal.timeout(5_000) },
			)
			const bodyText = await response.text()
			if (response.ok) {
				return { ok: true, bodyText }
			}
			lastError = `HTTP ${String(response.status)}`
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error)
		}
		await sleep(1_000)
	}
	return { ok: false, error: lastError }
}

export async function pullAllowlistedImage(input: {
	docker: NasDockerEngineClient
	service: NasContainerServiceId
}): Promise<{
	imageRef: string
	image: DockerImageInspect
	digest: string | null
	ociRevision: string | null
}> {
	const definition = getNasContainerServiceDefinition(input.service)
	const imageRef = allowlistedImageRef(input.service)
	await input.docker.pullImage(definition.repository, definition.tag)
	const image = await input.docker.inspectImage(imageRef)
	assertPulledImageMatchesAllowlist({
		service: input.service,
		repoTags: image.RepoTags,
		repoDigests: image.RepoDigests,
	})
	return {
		imageRef,
		image,
		digest: pickRepoDigest(image, definition.repository),
		ociRevision: pickOciRevision(image),
	}
}

export async function recreateContainerWithRollback(input: {
	docker: NasDockerEngineClient
	service: NasContainerServiceId
	containerName: string
	imageRef: string
	healthTimeoutMs: number
	fetchFn?: typeof fetch
	keepPreviousOnSuccess?: boolean
}): Promise<{
	status: 'updated' | 'rolled_back'
	oldImageId: string | null
	newImageId: string | null
	oldDigest: string | null
	newDigest: string | null
	oldCommit: string | null
	newCommit: string | null
	previousContainerName: string | null
	error?: string
}> {
	const definition = getNasContainerServiceDefinition(input.service)
	const existing = await input.docker.inspectContainer(input.containerName)
	const oldImageId = existing.Image
	let oldImage: DockerImageInspect | null = null
	try {
		oldImage = await input.docker.inspectImage(oldImageId)
	} catch {
		oldImage = null
	}
	const oldDigest = oldImage
		? pickRepoDigest(oldImage, definition.repository)
		: null
	const oldCommit = pickOciRevision(oldImage, existing)

	const pulled = await pullAllowlistedImage({
		docker: input.docker,
		service: input.service,
	})

	const prevName = previousContainerName(input.containerName)
	const createBody = buildCreateBodyFromInspect(existing, input.imageRef)

	await input.docker.renameContainer(input.containerName, prevName)
	await input.docker.stopContainer(prevName)

	let createdId: string | null = null
	try {
		const created = await input.docker.createContainer({
			name: input.containerName,
			body: createBody,
		})
		createdId = created.id
		await input.docker.startContainer(input.containerName)

		const health = await waitForHttpHealth({
			port: definition.healthPort,
			path: definition.healthPath,
			timeoutMs: input.healthTimeoutMs,
			fetchFn: input.fetchFn,
		})
		const running = await input.docker.inspectContainer(input.containerName)
		if (!health.ok || !running.State.Running) {
			throw new Error(
				health.ok
					? 'Replacement container is not running after start.'
					: `Replacement health check failed: ${health.error}`,
			)
		}

		if (input.keepPreviousOnSuccess !== false) {
			// Keep the latest prev; prune older prev containers for this service.
			await pruneOlderPreviousContainers({
				docker: input.docker,
				containerName: input.containerName,
				keepName: prevName,
			})
		} else {
			await input.docker.removeContainer(prevName, { force: true })
		}

		return {
			status: 'updated',
			oldImageId,
			newImageId: pulled.image.Id,
			oldDigest,
			newDigest: pulled.digest,
			oldCommit,
			newCommit: pulled.ociRevision,
			previousContainerName: prevName,
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		if (createdId) {
			try {
				await input.docker.stopContainer(input.containerName)
			} catch {
				// best effort
			}
			try {
				await input.docker.removeContainer(input.containerName, { force: true })
			} catch {
				// best effort
			}
		}
		try {
			await input.docker.renameContainer(prevName, input.containerName)
			await input.docker.startContainer(input.containerName)
		} catch (rollbackError) {
			const rollbackMessage =
				rollbackError instanceof Error
					? rollbackError.message
					: String(rollbackError)
			return {
				status: 'rolled_back',
				oldImageId,
				newImageId: pulled.image.Id,
				oldDigest,
				newDigest: pulled.digest,
				oldCommit,
				newCommit: pulled.ociRevision,
				previousContainerName: prevName,
				error: `${message}; additionally failed to restore previous container: ${rollbackMessage}`,
			}
		}
		return {
			status: 'rolled_back',
			oldImageId,
			newImageId: pulled.image.Id,
			oldDigest,
			newDigest: pulled.digest,
			oldCommit,
			newCommit: pulled.ociRevision,
			previousContainerName: prevName,
			error: message,
		}
	}
}

async function pruneOlderPreviousContainers(input: {
	docker: NasDockerEngineClient
	containerName: string
	keepName: string
}) {
	const prefix = `/${input.containerName}-prev-`
	const containers = await input.docker.listContainers({ all: true })
	for (const container of containers) {
		const names = container.Names ?? []
		for (const name of names) {
			if (!name.startsWith(prefix)) continue
			const bare = normalizeContainerName(name)
			if (bare === input.keepName) continue
			try {
				await input.docker.removeContainer(bare, { force: true })
			} catch {
				// best effort prune
			}
		}
	}
}

export function parseCommitFromHealthBody(bodyText: string): string | null {
	try {
		const parsed = JSON.parse(bodyText) as {
			metadata?: { appCommitSha?: string | null }
			appCommitSha?: string | null
			commitSha?: string | null
			commit?: string | null
		}
		return (
			parsed.metadata?.appCommitSha?.trim() ||
			parsed.appCommitSha?.trim() ||
			parsed.commitSha?.trim() ||
			parsed.commit?.trim() ||
			null
		)
	} catch {
		return null
	}
}
