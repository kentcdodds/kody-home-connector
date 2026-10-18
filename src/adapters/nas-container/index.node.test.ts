import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import { loadHomeConnectorConfig } from '../../config.ts'
import {
	allowlistedImageRef,
	createNasContainerAdapter,
	nasContainerUpdateConfirmation,
	nasContainerUpdatesDisabledMessage,
} from './index.ts'
import {
	type DockerContainerInspect,
	type DockerImageInspect,
	type NasDockerEngineClient,
} from './types.ts'
import { assertAllowlistedImageRef } from './allowlist.ts'
import { assertPulledImageMatchesAllowlist } from './validation.ts'
import {
	buildCreateBodyFromInspect,
	buildPreservedConfigPlan,
	extractEnvKeys,
} from './recreate.ts'

function baseEnv() {
	return {
		HOME_CONNECTOR_ID: 'default',
		HOME_CONNECTOR_SHARED_SECRET: 'home-connector-secret-home-connector-secret',
		HOME_CONNECTOR_DATA_PATH: '',
		MOCKS: 'true',
	}
}

function createInspect(input?: {
	name?: string
	image?: string
	env?: Array<string>
	binds?: Array<string>
}): DockerContainerInspect {
	return {
		Id: 'container-id-1',
		Name: `/${input?.name ?? 'mediarss'}`,
		Created: '2026-10-01T00:00:00Z',
		State: { Status: 'running', Running: true },
		Image: input?.image ?? 'sha256:oldimage',
		Config: {
			Env: input?.env ?? [
				'SECRET_TOKEN=super-secret-value',
				'PORT=22050',
				'HOME_CONNECTOR_SHARED_SECRET=do-not-leak',
			],
			Cmd: ['node', 'index.js'],
			Entrypoint: ['/sbin/tini', '--'],
			WorkingDir: '/app',
			Labels: {
				'org.opencontainers.image.revision': 'abc123old',
			},
			Image: 'kentcdodds/mediarss:main',
		},
		HostConfig: {
			NetworkMode: 'host',
			RestartPolicy: { Name: 'unless-stopped' },
			Binds: input?.binds ?? [
				'/volume1/media/audio/audiobooks:/media/audiobooks:ro',
			],
			PortBindings: {},
			Privileged: false,
		},
		NetworkSettings: { Networks: {} },
	}
}

function createImage(input?: {
	id?: string
	tags?: Array<string>
	digests?: Array<string>
	revision?: string
	cmd?: Array<string> | null
	entrypoint?: Array<string> | null
}): DockerImageInspect {
	return {
		Id: input?.id ?? 'sha256:newimage',
		RepoTags: input?.tags ?? ['kentcdodds/mediarss:main'],
		RepoDigests: input?.digests ?? [
			'kentcdodds/mediarss@sha256:remotedigest111',
		],
		Config: {
			Labels: {
				'org.opencontainers.image.revision': input?.revision ?? 'abc123new',
			},
			Env: ['SECRET=should-never-appear'],
			Cmd: input?.cmd === undefined ? ['node', 'index.js'] : input.cmd,
			Entrypoint:
				input?.entrypoint === undefined
					? ['/sbin/tini', '--']
					: input.entrypoint,
		},
	}
}

function createMockDocker(input?: {
	inspect?: DockerContainerInspect
	image?: DockerImageInspect
	remoteDigest?: string | null
	failHealthStart?: boolean
}) {
	const calls: Array<{ method: string; args: Array<unknown> }> = []
	let currentName = input?.inspect
		? input.inspect.Name.replace(/^\//, '')
		: 'mediarss'
	const containers = new Map<string, DockerContainerInspect>()
	const initial = input?.inspect ?? createInspect()
	containers.set(currentName, initial)
	const image = input?.image ?? createImage()
	let running = true

	const docker: NasDockerEngineClient = {
		async ping() {
			calls.push({ method: 'ping', args: [] })
		},
		async inspectContainer(nameOrId) {
			calls.push({ method: 'inspectContainer', args: [nameOrId] })
			const found = containers.get(nameOrId)
			if (!found) throw new Error(`No such container: ${nameOrId}`)
			return {
				...found,
				State: { ...found.State, Running: running },
			}
		},
		async inspectImage(nameOrId) {
			calls.push({ method: 'inspectImage', args: [nameOrId] })
			return image
		},
		async pullImage(repository, tag) {
			calls.push({ method: 'pullImage', args: [repository, tag] })
			if (tag === 'dev') {
				throw new Error('refusing to pull dev')
			}
		},
		async getDistributionDigest(imageRef) {
			calls.push({ method: 'getDistributionDigest', args: [imageRef] })
			return input?.remoteDigest === undefined
				? 'sha256:remoteDigest111'
				: input.remoteDigest
		},
		async renameContainer(nameOrId, newName) {
			calls.push({ method: 'renameContainer', args: [nameOrId, newName] })
			const found = containers.get(nameOrId)
			if (!found) throw new Error(`No such container: ${nameOrId}`)
			containers.delete(nameOrId)
			containers.set(newName, { ...found, Name: `/${newName}` })
			currentName = newName
		},
		async stopContainer(nameOrId) {
			calls.push({ method: 'stopContainer', args: [nameOrId] })
			running = false
		},
		async startContainer(nameOrId) {
			calls.push({ method: 'startContainer', args: [nameOrId] })
			if (input?.failHealthStart && nameOrId === 'mediarss') {
				running = true
				return
			}
			running = true
		},
		async removeContainer(nameOrId) {
			calls.push({ method: 'removeContainer', args: [nameOrId] })
			containers.delete(nameOrId)
		},
		async createContainer({ name, body }) {
			calls.push({ method: 'createContainer', args: [name, body] })
			containers.set(name, {
				...createInspect({ name, image: body.Image }),
				Config: {
					...createInspect().Config,
					Env: body.Env,
					Image: body.Image,
				},
				HostConfig: body.HostConfig ?? {},
				Image: body.Image,
				Name: `/${name}`,
			})
			currentName = name
			return { id: 'created-id' }
		},
		async listContainers() {
			calls.push({ method: 'listContainers', args: [] })
			return [...containers.entries()].map(([name, value]) => ({
				Id: value.Id,
				Names: [`/${name}`],
				Image: value.Image,
			}))
		},
	}

	return { docker, calls, containers }
}

test('allowlist rejects unknown services, digests, and forbidden tags', () => {
	expect(() => assertAllowlistedImageRef('kentcdodds/mediarss:dev')).toThrow(
		/not on the NAS container allowlist|forbidden/,
	)
	expect(() =>
		assertAllowlistedImageRef('kentcdodds/mediarss@sha256:abc'),
	).toThrow(/not on the NAS container allowlist/)
	expect(() => assertAllowlistedImageRef('evil/other:latest')).toThrow(
		/not on the NAS container allowlist/,
	)
	expect(allowlistedImageRef('mediarss')).toBe('kentcdodds/mediarss:main')
	expect(allowlistedImageRef('home-connector')).toBe(
		'kentcdodds/kody-home-connector:latest',
	)
})

test('dev tag can never be selected even when present on an image', () => {
	expect(() =>
		assertPulledImageMatchesAllowlist({
			service: 'mediarss',
			repoTags: ['kentcdodds/mediarss:main', 'kentcdodds/mediarss:dev'],
			repoDigests: ['kentcdodds/mediarss@sha256:abc'],
		}),
	).toThrow(/forbidden "dev" tag/)
})

test('preserved config plan redacts env values and cmd/entrypoint', () => {
	const plan = buildPreservedConfigPlan(
		createInspect(),
		'kentcdodds/mediarss:main',
	)
	expect(plan.envKeys).toEqual([
		'SECRET_TOKEN',
		'PORT',
		'HOME_CONNECTOR_SHARED_SECRET',
	])
	expect(plan.cmdPresent).toBe(true)
	expect(plan.entrypointPresent).toBe(true)
	expect(JSON.stringify(plan)).not.toContain('super-secret-value')
	expect(JSON.stringify(plan)).not.toContain('do-not-leak')
	expect(JSON.stringify(plan)).not.toContain('node')
	expect(extractEnvKeys(['A=1', 'B='])).toEqual(['A', 'B'])
})

test('create body preserves mounts/network/restart and uses allowlisted image', () => {
	const inspect = createInspect()
	inspect.Mounts = [
		{
			Type: 'bind',
			Source: '/volume1/media/audio/audiobooks',
			Destination: '/media/audiobooks',
			RW: false,
		},
		{
			Type: 'volume',
			Name: 'mediarss-config',
			Source: '/var/lib/docker/volumes/mediarss-config/_data',
			Destination: '/config',
			RW: true,
		},
	]
	const body = buildCreateBodyFromInspect(
		inspect,
		'kentcdodds/mediarss:main',
		createImage({
			tags: ['kentcdodds/mediarss:main'],
		}),
	)
	expect(body.Image).toBe('kentcdodds/mediarss:main')
	expect(body.HostConfig?.['NetworkMode']).toBe('host')
	expect(body.HostConfig?.['Binds']).toBeUndefined()
	expect(body.HostConfig?.['Mounts']).toEqual([
		{
			Type: 'bind',
			Source: '/volume1/media/audio/audiobooks',
			Target: '/media/audiobooks',
			ReadOnly: true,
			BindOptions: undefined,
		},
		{
			Type: 'volume',
			Source: 'mediarss-config',
			Target: '/config',
			ReadOnly: false,
		},
	])
	expect(body.Env?.[0]).toBe('SECRET_TOKEN=super-secret-value')
	// Cmd matches old image defaults → omitted so new image defaults apply.
	expect(body.Cmd).toBeUndefined()
})

test('dry run makes no mutating docker calls and works while gate is off', async () => {
	const dataPath = await mkdtemp(path.join(tmpdir(), 'nas-container-'))
	process.env.HOME_CONNECTOR_ID = 'default'
	process.env.HOME_CONNECTOR_SHARED_SECRET =
		'home-connector-secret-home-connector-secret'
	process.env.HOME_CONNECTOR_DATA_PATH = dataPath
	process.env.NAS_CONTAINER_UPDATES_ENABLED = 'false'
	process.env.MOCKS = 'true'
	const config = loadHomeConnectorConfig()
	const { docker, calls } = createMockDocker()
	const adapter = createNasContainerAdapter({
		config,
		dockerClientFactory: () => docker,
		fetchFn: async () =>
			new Response(JSON.stringify({ commitSha: 'abc123old' }), { status: 200 }),
	})

	const result = await adapter.updateContainer({
		service: 'mediarss',
		dryRun: true,
	})
	expect(result.status).toBe('dry_run')
	if (result.status !== 'dry_run') throw new Error('expected dry_run')
	expect(result.plan.imageRef).toBe('kentcdodds/mediarss:main')
	expect(result.plan.preservedConfig.envKeys).toContain('SECRET_TOKEN')
	expect(JSON.stringify(result)).not.toContain('super-secret-value')
	expect(calls.map((call) => call.method)).toEqual([
		'ping',
		'inspectContainer',
		'inspectImage',
		'getDistributionDigest',
	])
	expect(
		calls.some((call) =>
			[
				'pullImage',
				'renameContainer',
				'createContainer',
				'removeContainer',
			].includes(call.method),
		),
	).toBe(false)
})

test('gate off refuses writes', async () => {
	const dataPath = await mkdtemp(path.join(tmpdir(), 'nas-container-'))
	process.env.HOME_CONNECTOR_DATA_PATH = dataPath
	process.env.NAS_CONTAINER_UPDATES_ENABLED = 'false'
	process.env.MOCKS = 'true'
	process.env.HOME_CONNECTOR_SHARED_SECRET =
		'home-connector-secret-home-connector-secret'
	const config = loadHomeConnectorConfig()
	const { docker } = createMockDocker()
	const adapter = createNasContainerAdapter({
		config,
		dockerClientFactory: () => docker,
	})

	await expect(
		adapter.updateContainer({
			service: 'mediarss',
			acknowledgeHighRisk: true,
			reason: 'Deploy merged mediarss main after CI green.',
			confirmation: nasContainerUpdateConfirmation,
		}),
	).rejects.toThrow(nasContainerUpdatesDisabledMessage)
})

test('unknown service is rejected', async () => {
	const dataPath = await mkdtemp(path.join(tmpdir(), 'nas-container-'))
	process.env.HOME_CONNECTOR_DATA_PATH = dataPath
	process.env.NAS_CONTAINER_UPDATES_ENABLED = 'true'
	process.env.MOCKS = 'true'
	process.env.HOME_CONNECTOR_SHARED_SECRET =
		'home-connector-secret-home-connector-secret'
	const config = loadHomeConnectorConfig()
	const { docker } = createMockDocker()
	const adapter = createNasContainerAdapter({
		config,
		dockerClientFactory: () => docker,
	})

	await expect(
		adapter.updateContainer({
			service: 'evil-service',
			dryRun: true,
		}),
	).rejects.toThrow(/Unknown NAS container service/)
})

test('successful mediarss update preserves config and reports digests', async () => {
	const dataPath = await mkdtemp(path.join(tmpdir(), 'nas-container-'))
	process.env.HOME_CONNECTOR_DATA_PATH = dataPath
	process.env.NAS_CONTAINER_UPDATES_ENABLED = 'true'
	process.env.MOCKS = 'true'
	process.env.HOME_CONNECTOR_SHARED_SECRET =
		'home-connector-secret-home-connector-secret'
	const config = loadHomeConnectorConfig()
	const { docker, calls } = createMockDocker({
		remoteDigest: 'sha256:remoteDigest111',
	})
	let healthCalls = 0
	const adapter = createNasContainerAdapter({
		config,
		dockerClientFactory: () => docker,
		fetchFn: async () => {
			healthCalls += 1
			return new Response(JSON.stringify({ commitSha: 'abc123new' }), {
				status: 200,
			})
		},
	})

	const result = await adapter.updateContainer({
		service: 'mediarss',
		acknowledgeHighRisk: true,
		reason: 'Deploy merged mediarss main after CI green.',
		confirmation: nasContainerUpdateConfirmation,
	})
	expect(result.status).toBe('updated')
	if (result.status !== 'updated') throw new Error('expected updated')
	expect(result.imageRef).toBe('kentcdodds/mediarss:main')
	expect(result.newDigest).toBe('sha256:remotedigest111')
	expect(result.newCommit).toBe('abc123new')
	expect(calls.some((call) => call.method === 'pullImage')).toBe(true)
	expect(calls.some((call) => call.method === 'renameContainer')).toBe(true)
	expect(calls.some((call) => call.method === 'createContainer')).toBe(true)
	const createCall = calls.find((call) => call.method === 'createContainer')
	expect(createCall?.args[1]).toMatchObject({
		Image: 'kentcdodds/mediarss:main',
		HostConfig: {
			NetworkMode: 'host',
		},
	})
	expect(JSON.stringify(result)).not.toContain('super-secret-value')
	expect(healthCalls).toBeGreaterThan(0)
})

test('rollback on failed health restores previous container', async () => {
	const dataPath = await mkdtemp(path.join(tmpdir(), 'nas-container-'))
	process.env.HOME_CONNECTOR_DATA_PATH = dataPath
	process.env.NAS_CONTAINER_UPDATES_ENABLED = 'true'
	process.env.MOCKS = 'true'
	process.env.HOME_CONNECTOR_SHARED_SECRET =
		'home-connector-secret-home-connector-secret'
	const config = loadHomeConnectorConfig()
	config.nasContainerHealthTimeoutMs = 1500
	const { docker, calls, containers } = createMockDocker({
		failHealthStart: true,
	})
	const adapter = createNasContainerAdapter({
		config,
		dockerClientFactory: () => docker,
		fetchFn: async () => new Response('nope', { status: 503 }),
	})

	const result = await adapter.updateContainer({
		service: 'mediarss',
		acknowledgeHighRisk: true,
		reason: 'Deploy merged mediarss main after CI green.',
		confirmation: nasContainerUpdateConfirmation,
	})
	expect(result.status).toBe('rolled_back')
	if (result.status !== 'rolled_back') throw new Error('expected rolled_back')
	expect(result.error).toMatch(/health check failed/i)
	expect(containers.has('mediarss')).toBe(true)
	expect(
		calls.filter((call) => call.method === 'renameContainer').length,
	).toBeGreaterThanOrEqual(2)
})

test('self-update returns handed_off before recreate and writes status', async () => {
	const dataPath = await mkdtemp(path.join(tmpdir(), 'nas-container-'))
	process.env.HOME_CONNECTOR_DATA_PATH = dataPath
	process.env.NAS_CONTAINER_UPDATES_ENABLED = 'true'
	process.env.MOCKS = 'true'
	process.env.HOME_CONNECTOR_SHARED_SECRET =
		'home-connector-secret-home-connector-secret'
	const config = loadHomeConnectorConfig()
	const inspect = createInspect({
		name: 'kody-home-connector',
		binds: [
			'/volume1/docker/kody-home-connector:/data/home-connector',
			'/var/run/docker.sock:/var/run/docker.sock',
		],
		env: ['HOME_CONNECTOR_SHARED_SECRET=do-not-leak', 'PORT=4040'],
	})
	inspect.Config.Image = 'kentcdodds/kody-home-connector:latest'
	const { docker, calls } = createMockDocker({
		inspect,
		image: createImage({
			tags: ['kentcdodds/kody-home-connector:latest'],
			digests: ['kentcdodds/kody-home-connector@sha256:home123'],
			revision: 'deadbeef',
		}),
		remoteDigest: 'sha256:home123',
	})
	const adapter = createNasContainerAdapter({
		config,
		dockerClientFactory: () => docker,
		fetchFn: async () =>
			new Response(JSON.stringify({ metadata: { appCommitSha: 'deadbeef' } }), {
				status: 200,
			}),
	})

	const result = await adapter.updateContainer({
		service: 'home-connector',
		acknowledgeHighRisk: true,
		reason: 'Deploy merged home connector main after publish.',
		confirmation: nasContainerUpdateConfirmation,
	})
	expect(result.status).toBe('handed_off')
	if (result.status !== 'handed_off') throw new Error('expected handed_off')
	expect(result.operationId).toMatch(/^[a-z0-9]+$/i)
	expect(result.helperContainerName).toContain('kody-nas-update-helper-')
	expect(calls.some((call) => call.method === 'pullImage')).toBe(true)
	expect(calls.some((call) => call.method === 'createContainer')).toBe(true)
	expect(calls.some((call) => call.method === 'renameContainer')).toBe(false)
	const status = await adapter.getUpdateStatus(result.operationId)
	expect(status.operation?.status).toBe('handed_off')
	const raw = await readFile(
		path.join(dataPath, 'nas-container-updates', `${result.operationId}.json`),
		'utf8',
	)
	expect(raw).toContain('handed_off')
	expect(raw).not.toContain('do-not-leak')
})

test('checkContainerUpdate reports updateAvailable from digest compare', async () => {
	const dataPath = await mkdtemp(path.join(tmpdir(), 'nas-container-'))
	Object.assign(process.env, baseEnv(), {
		HOME_CONNECTOR_DATA_PATH: dataPath,
	})
	const config = loadHomeConnectorConfig()
	const { docker } = createMockDocker({
		remoteDigest: 'sha256:newer',
		image: createImage({
			digests: ['kentcdodds/mediarss@sha256:older'],
		}),
	})
	const adapter = createNasContainerAdapter({
		config,
		dockerClientFactory: () => docker,
		fetchFn: async () =>
			new Response(JSON.stringify({ commitSha: 'abc' }), { status: 200 }),
	})
	const result = await adapter.checkContainerUpdate('mediarss')
	expect(result.updateAvailable).toBe(true)
	expect(result.imageRef).toBe('kentcdodds/mediarss:main')
	expect(result.repoDigest).toBe('sha256:older')
	expect(result.remoteDigest).toBe('sha256:newer')
})
