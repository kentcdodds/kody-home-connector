import { type NasContainerServiceId } from './allowlist.ts'

export type NasDockerEngineClient = {
	ping(): Promise<void>
	inspectContainer(nameOrId: string): Promise<DockerContainerInspect>
	inspectImage(nameOrId: string): Promise<DockerImageInspect>
	pullImage(repository: string, tag: string): Promise<void>
	getDistributionDigest(imageRef: string): Promise<string | null>
	renameContainer(nameOrId: string, newName: string): Promise<void>
	stopContainer(nameOrId: string, timeoutSeconds?: number): Promise<void>
	startContainer(nameOrId: string): Promise<void>
	removeContainer(
		nameOrId: string,
		options?: { force?: boolean },
	): Promise<void>
	createContainer(input: {
		name: string
		body: DockerContainerCreateBody
	}): Promise<{ id: string }>
	listContainers(options?: {
		all?: boolean
		filters?: Record<string, Array<string>>
	}): Promise<Array<DockerContainerSummary>>
}

export type DockerContainerSummary = {
	Id: string
	Names?: Array<string>
	Image?: string
	ImageID?: string
	State?: string
	Status?: string
	Created?: number
	Labels?: Record<string, string>
}

export type DockerContainerInspect = {
	Id: string
	Name: string
	Created: string
	State: {
		Status: string
		Running: boolean
		Health?: {
			Status?: string
		}
	}
	Image: string
	Config: {
		Hostname?: string
		Domainname?: string
		User?: string
		AttachStdin?: boolean
		AttachStdout?: boolean
		AttachStderr?: boolean
		ExposedPorts?: Record<string, object>
		Tty?: boolean
		OpenStdin?: boolean
		StdinOnce?: boolean
		Env?: Array<string>
		Cmd?: Array<string> | null
		Healthcheck?: Record<string, unknown>
		ArgsEscaped?: boolean
		Image?: string
		Volumes?: Record<string, object>
		WorkingDir?: string
		Entrypoint?: Array<string> | string | null
		Labels?: Record<string, string>
		StopSignal?: string
		StopTimeout?: number
	}
	HostConfig: Record<string, unknown>
	NetworkSettings?: {
		Networks?: Record<string, unknown>
		Ports?: Record<string, unknown>
	}
}

export type DockerImageInspect = {
	Id: string
	RepoTags?: Array<string> | null
	RepoDigests?: Array<string> | null
	Created?: string
	Config?: {
		Labels?: Record<string, string> | null
		Env?: Array<string> | null
	}
	RootFS?: {
		Layers?: Array<string>
	}
}

export type DockerContainerCreateBody = {
	Hostname?: string
	Domainname?: string
	User?: string
	AttachStdin?: boolean
	AttachStdout?: boolean
	AttachStderr?: boolean
	ExposedPorts?: Record<string, object>
	Tty?: boolean
	OpenStdin?: boolean
	StdinOnce?: boolean
	Env?: Array<string>
	Cmd?: Array<string> | null
	Healthcheck?: Record<string, unknown>
	ArgsEscaped?: boolean
	Image: string
	Volumes?: Record<string, object>
	WorkingDir?: string
	Entrypoint?: Array<string> | string | null
	Labels?: Record<string, string>
	StopSignal?: string
	StopTimeout?: number
	HostConfig?: Record<string, unknown>
	NetworkingConfig?: {
		EndpointsConfig?: Record<string, unknown>
	}
}

export type NasContainerUpdateOperationStatus =
	| 'pending'
	| 'handed_off'
	| 'pulling'
	| 'recreating'
	| 'waiting_for_health'
	| 'succeeded'
	| 'rolled_back'
	| 'failed'

export type NasContainerUpdateOperation = {
	operationId: string
	service: NasContainerServiceId
	status: NasContainerUpdateOperationStatus
	createdAt: string
	updatedAt: string
	containerName: string
	imageRef: string
	dryRun?: boolean
	oldImageId?: string | null
	newImageId?: string | null
	oldDigest?: string | null
	newDigest?: string | null
	oldCommit?: string | null
	newCommit?: string | null
	previousContainerName?: string | null
	helperContainerName?: string | null
	error?: string | null
	message?: string | null
}

export type NasContainerCheckResult = {
	service: NasContainerServiceId
	containerName: string
	imageRef: string
	running: boolean
	containerId: string | null
	imageId: string | null
	repoDigest: string | null
	createdAt: string | null
	runningCommit: string | null
	ociRevision: string | null
	remoteDigest: string | null
	updateAvailable: boolean
	dockerSocketConfigured: boolean
}

export type NasContainerPreservedConfigPlan = {
	name: string
	image: string
	networkMode: unknown
	restartPolicy: unknown
	binds: unknown
	portBindings: unknown
	privileged: unknown
	extraHosts: unknown
	labels: Record<string, string>
	/** Env *keys* only — values are never returned. */
	envKeys: Array<string>
	cmd: Array<string> | null
	entrypoint: Array<string> | string | null
	workingDir: string | null
}

export type NasContainerUpdatePlan = {
	service: NasContainerServiceId
	containerName: string
	imageRef: string
	currentImageId: string | null
	currentDigest: string | null
	currentCommit: string | null
	targetDigest: string | null
	targetCommit: string | null
	updateAvailable: boolean
	preservedConfig: NasContainerPreservedConfigPlan
	steps: Array<string>
}

export type NasContainerUpdateResult =
	| {
			status: 'dry_run'
			plan: NasContainerUpdatePlan
	  }
	| {
			status: 'updated'
			service: NasContainerServiceId
			containerName: string
			imageRef: string
			oldImageId: string | null
			newImageId: string | null
			oldDigest: string | null
			newDigest: string | null
			oldCommit: string | null
			newCommit: string | null
			previousContainerName: string | null
			operationId: string
	  }
	| {
			status: 'handed_off'
			service: NasContainerServiceId
			operationId: string
			helperContainerName: string
			message: string
	  }
	| {
			status: 'rolled_back'
			service: NasContainerServiceId
			containerName: string
			operationId: string
			error: string
			previousContainerName: string | null
	  }
