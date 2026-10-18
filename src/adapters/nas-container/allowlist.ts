/**
 * Fixed code-level allowlist for NAS container updates.
 *
 * Only these services may be updated, and only to the hard-coded main-branch
 * image refs. Container *names* may be configured locally; image repository,
 * tag, registry, and digest are never taken from tool input or runtime config.
 */

export const nasContainerServiceIds = ['home-connector', 'mediarss'] as const

export type NasContainerServiceId = (typeof nasContainerServiceIds)[number]

export type NasContainerServiceDefinition = {
	readonly service: NasContainerServiceId
	readonly repository: string
	readonly tag: string
	readonly defaultContainerName: string
	readonly healthPort: number
	readonly healthPath: string
	readonly selfUpdate: boolean
}

/**
 * MAIN ONLY. `mediarss` uses the `main` tag (never `dev`). `home-connector`
 * uses `latest`, which Publish Home Connector only advances on default-branch
 * pushes.
 */
export const nasContainerAllowlist = {
	'home-connector': {
		service: 'home-connector',
		repository: 'kentcdodds/kody-home-connector',
		tag: 'latest',
		defaultContainerName: 'kody-home-connector',
		healthPort: 4040,
		healthPath: '/health',
		selfUpdate: true,
	},
	mediarss: {
		service: 'mediarss',
		repository: 'kentcdodds/mediarss',
		tag: 'main',
		defaultContainerName: 'mediarss',
		healthPort: 22050,
		healthPath: '/health',
		selfUpdate: false,
	},
} as const satisfies Record<
	NasContainerServiceId,
	NasContainerServiceDefinition
>

/** Tags that must never be selectable, even if Docker Hub has them. */
export const nasContainerForbiddenTags = [
	'dev',
	'develop',
	'development',
	'pr',
	'pull',
	'staging',
	'test',
] as const

export function isNasContainerServiceId(
	value: unknown,
): value is NasContainerServiceId {
	return (
		typeof value === 'string' &&
		(nasContainerServiceIds as ReadonlyArray<string>).includes(value)
	)
}

export function getNasContainerServiceDefinition(
	service: NasContainerServiceId,
): NasContainerServiceDefinition {
	return nasContainerAllowlist[service]
}

export function allowlistedImageRef(service: NasContainerServiceId): string {
	const definition = nasContainerAllowlist[service]
	return `${definition.repository}:${definition.tag}`
}

export function assertAllowlistedImageRef(imageRef: string): void {
	const trimmed = imageRef.trim()
	const allowed = nasContainerServiceIds.map((service) =>
		allowlistedImageRef(service),
	)
	if (!allowed.includes(trimmed)) {
		throw new Error(
			`Image ref "${trimmed}" is not on the NAS container allowlist. Allowed: ${allowed.join(', ')}.`,
		)
	}
	const tag = trimmed.split(':')[1] ?? ''
	if (
		(nasContainerForbiddenTags as ReadonlyArray<string>).includes(tag) ||
		tag.startsWith('sha-') ||
		/^v?\d+\.\d+/.test(tag)
	) {
		throw new Error(
			`Image tag "${tag}" is forbidden for NAS container updates (main-branch images only).`,
		)
	}
}
