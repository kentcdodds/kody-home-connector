import {
	getNasContainerServiceDefinition,
	type NasContainerServiceId,
} from './allowlist.ts'
import { assertPulledImageMatchesAllowlist } from './validation.ts'
import {
	type DockerContainerCreateBody,
	type DockerContainerInspect,
	type DockerContainerMount,
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

function sameCommand(
	left: Array<string> | string | null | undefined,
	right: Array<string> | string | null | undefined,
) {
	return JSON.stringify(left ?? null) === JSON.stringify(right ?? null)
}

export function mountsFromInspect(
	mounts: Array<DockerContainerMount> | undefined,
): Array<Record<string, unknown>> {
	const result: Array<Record<string, unknown>> = []
	for (const mount of mounts ?? []) {
		const type = (mount.Type ?? 'bind').toLowerCase()
		const target = mount.Destination
		if (!target) continue
		if (type === 'volume') {
			const source = mount.Name || mount.Source
			if (!source) continue
			result.push({
				Type: 'volume',
				Source: source,
				Target: target,
				ReadOnly: mount.RW === false,
			})
			continue
		}
		if (type === 'bind') {
			if (!mount.Source) continue
			result.push({
				Type: 'bind',
				Source: mount.Source,
				Target: target,
				ReadOnly: mount.RW === false,
				BindOptions: mount.Propagation
					? { Propagation: mount.Propagation }
					: undefined,
			})
			continue
		}
		// tmpfs / other: preserve best-effort
		result.push({
			Type: type,
			Source: mount.Source,
			Target: target,
			ReadOnly: mount.RW === false,
		})
	}
	return result
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
		cmdPresent: Boolean(container.Config.Cmd?.length),
		entrypointPresent: Boolean(
			Array.isArray(container.Config.Entrypoint)
				? container.Config.Entrypoint.length
				: container.Config.Entrypoint,
		),
		workingDir: container.Config.WorkingDir ?? null,
		mounts: (container.Mounts ?? []).map((mount) => ({
			type: mount.Type ?? null,
			target: mount.Destination ?? null,
			readOnly: mount.RW === false,
			source: mount.Name || mount.Source || null,
		})),
	}
}

export function normalizeContainerName(name: string) {
	return name.startsWith('/') ? name.slice(1) : name
}

export function buildCreateBodyFromInspect(
	container: DockerContainerInspect,
	imageRef: string,
	oldImage?: DockerImageInspect | null,
): DockerContainerCreateBody {
	const config = container.Config
	const hostConfig = { ...container.HostConfig }
	// Drop ephemeral runtime fields that break create.
	delete hostConfig['ConsoleSize']

	// Prefer explicit Mounts reconstructed from inspect so anonymous/named
	// volumes keep their Source. Clear Binds to avoid duplicate mounts.
	const mounts = mountsFromInspect(container.Mounts)
	if (mounts.length > 0) {
		hostConfig['Mounts'] = mounts
		delete hostConfig['Binds']
	}

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
		Healthcheck: config.Healthcheck,
		ArgsEscaped: config.ArgsEscaped,
		Image: imageRef,
		Volumes: config.Volumes,
		WorkingDir: config.WorkingDir,
		Labels: config.Labels,
		StopSignal: config.StopSignal,
		StopTimeout: config.StopTimeout,
		HostConfig: hostConfig,
	}

	// Only copy Cmd/Entrypoint when they were operator overrides vs the old
	// image defaults. Otherwise let the new image supply startup defaults.
	const oldCmd = oldImage?.Config?.Cmd
	const oldEntrypoint = oldImage?.Config?.Entrypoint
	if (oldImage && !sameCommand(config.Cmd, oldCmd)) {
		body.Cmd = config.Cmd
	}
	if (oldImage && !sameCommand(config.Entrypoint, oldEntrypoint)) {
		body.Entrypoint = config.Entrypoint
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

export function assertRunningImageMatchesService(input: {
	service: NasContainerServiceId
	container: DockerContainerInspect
	image: DockerImageInspect | null
}) {
	const definition = getNasContainerServiceDefinition(input.service)
	const repo = definition.repository
	const tags = input.image?.RepoTags ?? []
	const digests = input.image?.RepoDigests ?? []
	const configImage = input.container.Config.Image ?? ''
	const tagMatch = tags.some(
		(tag) => tag === `${repo}:${definition.tag}` || tag.startsWith(`${repo}:`),
	)
	const digestMatch = digests.some((digest) => digest.startsWith(`${repo}@`))
	const configMatch =
		configImage === `${repo}:${definition.tag}` ||
		configImage.startsWith(`${repo}:`) ||
		configImage.startsWith(`${repo}@`)
	if (!tagMatch && !digestMatch && !configMatch) {
		throw new Error(
			`Container image does not match allowlisted repository ${repo} for service ${input.service}. Refusing to update an unrelated container. RepoTags=${JSON.stringify(tags)} Config.Image=${JSON.stringify(configImage)}.`,
		)
	}
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
	const imageRef = `${definition.repository}:${definition.tag}`
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
	assertRunningImageMatchesService({
		service: input.service,
		container: existing,
		image: oldImage,
	})
	const oldDigest = oldImage
		? pickRepoDigest(oldImage, definition.repository)
		: null
	const oldCommit = pickOciRevision(oldImage, existing)

	const pulled = await pullAllowlistedImage({
		docker: input.docker,
		service: input.service,
	})

	const prevName = previousContainerName(input.containerName)
	const createBody = buildCreateBodyFromInspect(
		existing,
		input.imageRef,
		oldImage,
	)

	let renamed = false
	let createdId: string | null = null
	try {
		await input.docker.renameContainer(input.containerName, prevName)
		renamed = true
		await input.docker.stopContainer(prevName)

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

		// Cleanup must not undo a healthy replacement.
		try {
			if (input.keepPreviousOnSuccess !== false) {
				await pruneOlderPreviousContainers({
					docker: input.docker,
					containerName: input.containerName,
					keepName: prevName,
				})
			} else {
				await input.docker.removeContainer(prevName, { force: true })
			}
		} catch {
			// best effort; the new container is already healthy
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
		if (renamed) {
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
		}
		return {
			status: 'rolled_back',
			oldImageId,
			newImageId: pulled.image.Id,
			oldDigest,
			newDigest: pulled.digest,
			oldCommit,
			newCommit: pulled.ociRevision,
			previousContainerName: renamed ? prevName : null,
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
