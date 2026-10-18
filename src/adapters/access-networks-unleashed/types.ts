export type AccessNetworksUnleashedDiscoveredController = {
	controllerId: string
	name: string
	host: string
	loginUrl: string
	lastSeenAt: string | null
	rawDiscovery: Record<string, unknown> | null
}

export type AccessNetworksUnleashedPersistedController =
	AccessNetworksUnleashedDiscoveredController & {
		adopted: boolean
		username: string | null
		password: string | null
		lastAuthenticatedAt: string | null
		lastAuthError: string | null
	}

export type AccessNetworksUnleashedPublicController =
	AccessNetworksUnleashedDiscoveredController & {
		adopted: boolean
		hasStoredCredentials: boolean
		lastAuthenticatedAt: string | null
		lastAuthError: string | null
	}

export type AccessNetworksUnleashedProbeDiagnostic = {
	host: string
	url: string
	matched: boolean
	status: number | null
	location: string | null
	matchReason: 'redirect' | 'login-page' | null
	error: string | null
	bodySnippet: string | null
}

export type AccessNetworksUnleashedSubnetProbeSummary = {
	cidrs: Array<string>
	hostsProbed: number
	controllerMatches: number
}

export type AccessNetworksUnleashedDiscoveryDiagnostics = {
	protocol: 'subnet'
	discoveryUrl: string
	scannedAt: string
	probes: Array<AccessNetworksUnleashedProbeDiagnostic>
	subnetProbe: AccessNetworksUnleashedSubnetProbeSummary
}

export type AccessNetworksUnleashedDiscoveryResult = {
	controllers: Array<AccessNetworksUnleashedDiscoveredController>
	diagnostics: AccessNetworksUnleashedDiscoveryDiagnostics
}

export type AccessNetworksUnleashedConfigStatus = {
	configured: boolean
	adoptedControllerId: string | null
	host: string | null
	hasAdoptedController: boolean
	hasStoredCredentials: boolean
	allowInsecureTls: boolean
	missingRequirements: Array<'controller' | 'credentials'>
	lastAuthenticatedAt: string | null
	lastAuthError: string | null
}

export type AccessNetworksUnleashedAjaxAction =
	| 'getstat'
	| 'getconf'
	| 'setconf'
	| 'docmd'
	/**
	 * Object-level config actions used by the Unleashed/ZoneDirector admin UI
	 * (and aioruckus / ruckus-go / the CommScope Postman collection):
	 * `addobj` creates a new object (controller assigns the id), `updobj`
	 * updates the object named by its `id`, `delobj` deletes by `id`.
	 * Typed WLAN tools prefer these; the raw request tool also accepts them
	 * (with the same id / no-id guards on wlansvc-list).
	 */
	| 'addobj'
	| 'updobj'
	| 'delobj'

export type AccessNetworksUnleashedRequestInput = {
	action: AccessNetworksUnleashedAjaxAction
	comp: string
	xmlBody: string
	updater?: string
	/**
	 * Optional ajax-request `caller` attribute. aioruckus sets `caller="SCI"`
	 * for VAP / WLAN-group stats; when omitted, getstat vap bodies default to SCI.
	 */
	caller?: string
	allowInsecureTls?: boolean
	/**
	 * getconf only: send `DECRYPT_X="true"` so the controller includes WPA /
	 * SAE passphrases (plaintext plus the `x-` obfuscated twin). Internal to
	 * WLAN write snapshots so rollback can restore secrets; never exposed on
	 * the raw request tool and never returned through tool output.
	 */
	decryptSecrets?: boolean
}

export type AccessNetworksUnleashedRequestResult = {
	action: AccessNetworksUnleashedAjaxAction
	comp: string
	updater: string
	xml: string
	parsed: unknown
}

export type AccessNetworksUnleashedClient = {
	request(
		input: AccessNetworksUnleashedRequestInput,
	): Promise<AccessNetworksUnleashedRequestResult>
}
