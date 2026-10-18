import { type HomeConnectorConfig } from '../../config.ts'
import {
	assertAllowlistedImageRef,
	getNasContainerServiceDefinition,
	isNasContainerServiceId,
	type NasContainerServiceId,
} from './allowlist.ts'

export const nasContainerUpdateConfirmation =
	'I understand this will recreate a NAS container from its allowlisted main image and may briefly interrupt the service.'

export const nasContainerUpdatesDisabledMessage =
	'NAS container updates are disabled. Nothing was sent to the Docker Engine. Kent must enable them with nas_container_updates_set_config { enabled: true } (and can turn them off again afterward). dryRun still works while disabled.'

export function assertNasContainerUpdatesEnabled(config: HomeConnectorConfig) {
	if (config.nasContainerUpdatesEnabled !== true) {
		throw new Error(nasContainerUpdatesDisabledMessage)
	}
}

export function assertNasContainerWriteAllowed(input: {
	acknowledgeHighRisk?: boolean
	reason?: string
	confirmation?: string
}) {
	if (!input.acknowledgeHighRisk) {
		throw new Error(
			'acknowledgeHighRisk must be true for nas_update_container writes.',
		)
	}
	const reason = input.reason?.trim() ?? ''
	if (reason.length < 20) {
		throw new Error('reason must be at least 20 characters.')
	}
	if (input.confirmation !== nasContainerUpdateConfirmation) {
		throw new Error(
			`confirmation must exactly equal: ${nasContainerUpdateConfirmation}`,
		)
	}
}

export function resolveNasContainerService(
	service: unknown,
): NasContainerServiceId {
	if (!isNasContainerServiceId(service)) {
		throw new Error(
			`Unknown NAS container service "${String(service)}". Allowed: home-connector, mediarss.`,
		)
	}
	const definition = getNasContainerServiceDefinition(service)
	assertAllowlistedImageRef(`${definition.repository}:${definition.tag}`)
	return service
}

export function resolveContainerNameForService(
	config: HomeConnectorConfig,
	service: NasContainerServiceId,
): string {
	const definition = getNasContainerServiceDefinition(service)
	switch (service) {
		case 'home-connector':
			return (
				config.nasHomeConnectorContainerName?.trim() ||
				definition.defaultContainerName
			)
		case 'mediarss':
			return (
				config.nasMediarssContainerName?.trim() ||
				definition.defaultContainerName
			)
		default: {
			const _exhaustive: never = service
			return _exhaustive
		}
	}
}

export function assertPulledImageMatchesAllowlist(input: {
	service: NasContainerServiceId
	repoTags: Array<string> | null | undefined
	repoDigests: Array<string> | null | undefined
}) {
	const definition = getNasContainerServiceDefinition(input.service)
	const expectedTag = `${definition.repository}:${definition.tag}`
	const tags = input.repoTags ?? []
	const digests = input.repoDigests ?? []
	const tagMatch = tags.includes(expectedTag)
	const digestMatch = digests.some((digest) =>
		digest.startsWith(`${definition.repository}@`),
	)
	if (!tagMatch && !digestMatch) {
		throw new Error(
			`Pulled image does not match allowlisted ${expectedTag}. RepoTags=${JSON.stringify(tags)} RepoDigests=${JSON.stringify(digests.map((d) => d.split('@')[0] + '@***'))}.`,
		)
	}
	for (const tag of tags) {
		const tagName = tag.includes(':') ? tag.slice(tag.indexOf(':') + 1) : tag
		if (tagName === 'dev' || tag.endsWith(':dev')) {
			throw new Error(
				'Refusing to use an image that also carries the forbidden "dev" tag.',
			)
		}
	}
}
