import {
	createCipheriv,
	createDecipheriv,
	createHash,
	randomBytes,
} from 'node:crypto'
import {
	type KasaClient,
	type KasaClientCredentials,
	type KasaSysInfo,
} from './types.ts'

type KlapHashVersion = 1 | 2

type KlapSession = {
	localSeed: Buffer
	remoteSeed: Buffer
	authHash: Buffer
	sequence: number
	sessionCookie: string
	expiresAt: number
	authLabel: string
	hashVersion: KlapHashVersion
}

type KlapCandidate = {
	label: string
	username: string
	password: string
}

type KlapClientInput = {
	host: string
	port?: number
	credentials: KasaClientCredentials
	timeoutMs?: number
	fetchImpl?: typeof fetch
	localSeedFactory?: () => Buffer
	now?: () => number
	hashVersion?: KlapHashVersion
}

const oneDayMs = 24 * 60 * 60 * 1000
const sessionExpireBufferMs = 20 * 60 * 1000

const defaultCredentials: Array<KlapCandidate> = [
	{
		label: 'KASA default',
		username: 'kasa@tp-link.net',
		password: 'kasaSetup',
	},
	{
		label: 'KASACAMERA default',
		username: 'admin',
		password: '21232f297a57a5a743894a0e4a801fc3',
	},
	{ label: 'TAPO default', username: 'test@tp-link.net', password: 'test' },
	{ label: 'TAPOCAMERA default', username: 'admin', password: 'admin' },
	{
		label: 'TAPOCAMERA_LV3 default',
		username: 'admin',
		password: 'TPL075526460603',
	},
]

function hash(algorithm: 'md5' | 'sha1' | 'sha256', payload: Buffer | string) {
	return createHash(algorithm).update(payload).digest()
}

function concat(...buffers: Array<Buffer | string>) {
	return Buffer.concat(
		buffers.map((buffer) =>
			typeof buffer === 'string' ? Buffer.from(buffer, 'utf8') : buffer,
		),
	)
}

function signedInt32ToBuffer(value: number) {
	const buffer = Buffer.alloc(4)
	buffer.writeInt32BE(value, 0)
	return buffer
}

function signedInt32FromBuffer(buffer: Buffer) {
	return buffer.readInt32BE(0)
}

function normalizeLocalSeed(value: Buffer) {
	if (value.length !== 16) {
		throw new Error('KLAP local seed must be exactly 16 bytes.')
	}
	return value
}

function getSetCookieValues(headers: Headers) {
	const getSetCookie = (
		headers as Headers & { getSetCookie?: () => Array<string> }
	).getSetCookie
	if (typeof getSetCookie === 'function') return getSetCookie.call(headers)
	const raw = headers.get('set-cookie')
	return raw ? [raw] : []
}

function getCookieValue(headers: Headers, name: string) {
	for (const cookie of getSetCookieValues(headers)) {
		for (const part of cookie.split(/,(?=[^;,]+=)/)) {
			const [pair] = part.split(';')
			const [cookieName, ...valueParts] = (pair ?? '').split('=')
			if (cookieName?.trim() === name) return valueParts.join('=').trim()
		}
	}
	return null
}

function getTimeoutMs(headers: Headers) {
	const timeout = getCookieValue(headers, 'TIMEOUT')
	if (!timeout) return oneDayMs
	const seconds = Number.parseInt(timeout, 10)
	return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : oneDayMs
}

function isSessionExpired(session: KlapSession | null, now: number) {
	return !session || session.expiresAt <= now
}

export function generateKlapAuthHash(
	credentials: KasaClientCredentials,
	hashVersion: KlapHashVersion = 1,
) {
	if (hashVersion === 1) {
		return hash(
			'md5',
			concat(
				hash('md5', credentials.username),
				hash('md5', credentials.password),
			),
		)
	}
	return hash(
		'sha256',
		concat(
			hash('sha1', credentials.username),
			hash('sha1', credentials.password),
		),
	)
}

export function generateKlapHandshake1Hash(input: {
	localSeed: Buffer
	remoteSeed: Buffer
	authHash: Buffer
	hashVersion?: KlapHashVersion
}) {
	if ((input.hashVersion ?? 1) === 2) {
		return hash(
			'sha256',
			concat(input.localSeed, input.remoteSeed, input.authHash),
		)
	}
	return hash('sha256', concat(input.localSeed, input.authHash))
}

export function generateKlapHandshake2Hash(input: {
	localSeed: Buffer
	remoteSeed: Buffer
	authHash: Buffer
	hashVersion?: KlapHashVersion
}) {
	if ((input.hashVersion ?? 1) === 2) {
		return hash(
			'sha256',
			concat(input.remoteSeed, input.localSeed, input.authHash),
		)
	}
	return hash('sha256', concat(input.remoteSeed, input.authHash))
}

export function deriveKlapKey(input: {
	localSeed: Buffer
	remoteSeed: Buffer
	authHash: Buffer
}) {
	return hash(
		'sha256',
		concat('lsk', input.localSeed, input.remoteSeed, input.authHash),
	).subarray(0, 16)
}

export function deriveKlapIv(input: {
	localSeed: Buffer
	remoteSeed: Buffer
	authHash: Buffer
}) {
	const iv = hash(
		'sha256',
		concat('iv', input.localSeed, input.remoteSeed, input.authHash),
	)
	return {
		prefix: iv.subarray(0, 12),
		sequence: signedInt32FromBuffer(iv.subarray(28, 32)),
	}
}

function deriveKlapSignatureSeed(input: {
	localSeed: Buffer
	remoteSeed: Buffer
	authHash: Buffer
}) {
	return hash(
		'sha256',
		concat('ldk', input.localSeed, input.remoteSeed, input.authHash),
	).subarray(0, 28)
}

export function encryptKlapPayload(input: {
	localSeed: Buffer
	remoteSeed: Buffer
	authHash: Buffer
	sequence: number
	payload: Buffer | string
}) {
	const key = deriveKlapKey(input)
	const iv = deriveKlapIv(input)
	const sequenceBuffer = signedInt32ToBuffer(input.sequence)
	const cipher = createCipheriv(
		'aes-128-cbc',
		key,
		concat(iv.prefix, sequenceBuffer),
	)
	const plaintext =
		typeof input.payload === 'string'
			? Buffer.from(input.payload, 'utf8')
			: input.payload
	const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
	const signature = hash(
		'sha256',
		concat(deriveKlapSignatureSeed(input), sequenceBuffer, ciphertext),
	)
	return concat(signature, ciphertext)
}

export function decryptKlapPayload(input: {
	localSeed: Buffer
	remoteSeed: Buffer
	authHash: Buffer
	sequence: number
	payload: Buffer
}) {
	const key = deriveKlapKey(input)
	const iv = deriveKlapIv(input)
	const decipher = createDecipheriv(
		'aes-128-cbc',
		key,
		concat(iv.prefix, signedInt32ToBuffer(input.sequence)),
	)
	const ciphertext = input.payload.subarray(32)
	const plaintext = Buffer.concat([
		decipher.update(ciphertext),
		decipher.final(),
	])
	return plaintext.toString('utf8')
}

function getRelayStateFromSysinfo(sysinfo: KasaSysInfo) {
	const relay = sysinfo.relay_state
	return relay === true || relay === 1
		? 'on'
		: relay === false || relay === 0
			? 'off'
			: 'unknown'
}

export function kasaRelayStateFromSysinfo(sysinfo: KasaSysInfo) {
	return getRelayStateFromSysinfo(sysinfo)
}

export class KasaKlapClient implements KasaClient {
	#host: string
	#port: number
	#credentials: KasaClientCredentials
	#timeoutMs: number
	#fetchImpl: typeof fetch
	#localSeedFactory: () => Buffer
	#now: () => number
	#hashVersion: KlapHashVersion
	#session: KlapSession | null = null

	constructor(input: KlapClientInput) {
		this.#host = input.host
		this.#port = input.port ?? 80
		this.#credentials = input.credentials
		this.#timeoutMs = input.timeoutMs ?? 8_000
		this.#fetchImpl = input.fetchImpl ?? fetch
		this.#localSeedFactory = input.localSeedFactory ?? (() => randomBytes(16))
		this.#now = input.now ?? (() => Date.now())
		this.#hashVersion = input.hashVersion ?? 1
	}

	get authLabel() {
		return this.#session?.authLabel ?? null
	}

	reset() {
		this.#session = null
	}

	async #post(path: string, body: Buffer, cookie?: string, seq?: number) {
		const url = new URL(
			`http://${this.#host}:${String(this.#port)}/app/${path}`,
		)
		if (seq != null) url.searchParams.set('seq', String(seq))
		const controller = new AbortController()
		const timeout = setTimeout(() => controller.abort(), this.#timeoutMs)
		try {
			return await this.#fetchImpl(url, {
				method: 'POST',
				body,
				headers: {
					'Content-Type': 'application/octet-stream',
					...(cookie ? { Cookie: `TP_SESSIONID=${cookie}` } : {}),
				},
				signal: controller.signal,
			})
		} catch (error) {
			if (error instanceof Error && error.name === 'AbortError') {
				throw new Error(`Kasa KLAP request timed out for ${this.#host}.`)
			}
			throw error
		} finally {
			clearTimeout(timeout)
		}
	}

	#getAuthCandidates(): Array<KlapCandidate> {
		const candidates: Array<KlapCandidate> = [
			{
				label: 'configured TP-Link account credentials',
				username: this.#credentials.username,
				password: this.#credentials.password,
			},
			...defaultCredentials,
			{ label: 'blank credentials', username: '', password: '' },
		]
		const seen = new Set<string>()
		return candidates.filter((candidate) => {
			const key = `${candidate.username}\0${candidate.password}`
			if (seen.has(key)) return false
			seen.add(key)
			return true
		})
	}

	async #performHandshake() {
		const localSeed = normalizeLocalSeed(this.#localSeedFactory())
		const handshake1 = await this.#post('handshake1', localSeed)
		if (handshake1.status !== 200) {
			throw new Error(
				`Kasa plug ${this.#host} responded with ${handshake1.status} to KLAP handshake1.`,
			)
		}
		const handshake1Payload = Buffer.from(await handshake1.arrayBuffer())
		if (handshake1Payload.length !== 48) {
			throw new Error(
				`Kasa plug ${this.#host} returned an unexpected KLAP handshake1 payload.`,
			)
		}
		const sessionCookie = getCookieValue(handshake1.headers, 'TP_SESSIONID')
		if (!sessionCookie) {
			throw new Error(
				`Kasa plug ${this.#host} did not return a TP_SESSIONID cookie during KLAP handshake1.`,
			)
		}
		const remoteSeed = handshake1Payload.subarray(0, 16)
		const serverHash = handshake1Payload.subarray(16)
		let matchedAuthHash: Buffer | null = null
		let matchedLabel = ''
		for (const candidate of this.#getAuthCandidates()) {
			const authHash = generateKlapAuthHash(candidate, this.#hashVersion)
			const expected = generateKlapHandshake1Hash({
				localSeed,
				remoteSeed,
				authHash,
				hashVersion: this.#hashVersion,
			})
			const promptDocumentedFallback =
				this.#hashVersion === 1
					? hash('sha256', concat(remoteSeed, authHash))
					: null
			if (
				expected.equals(serverHash) ||
				Boolean(promptDocumentedFallback?.equals(serverHash))
			) {
				matchedAuthHash = authHash
				matchedLabel = candidate.label
				break
			}
		}
		if (!matchedAuthHash) {
			throw new Error(
				`Kasa plug ${this.#host} rejected the configured TP-Link credentials. Check that KASA_USERNAME and KASA_PASSWORD are correct and case-sensitive.`,
			)
		}
		const handshake2Payload = generateKlapHandshake2Hash({
			localSeed,
			remoteSeed,
			authHash: matchedAuthHash,
			hashVersion: this.#hashVersion,
		})
		const handshake2 = await this.#post(
			'handshake2',
			handshake2Payload,
			sessionCookie,
		)
		if (handshake2.status !== 200) {
			throw new Error(
				`Kasa plug ${this.#host} responded with ${handshake2.status} to KLAP handshake2.`,
			)
		}
		const iv = deriveKlapIv({
			localSeed,
			remoteSeed,
			authHash: matchedAuthHash,
		})
		this.#session = {
			localSeed,
			remoteSeed,
			authHash: matchedAuthHash,
			sequence: iv.sequence,
			sessionCookie,
			expiresAt:
				this.#now() +
				Math.max(
					1_000,
					getTimeoutMs(handshake1.headers) - sessionExpireBufferMs,
				),
			authLabel: matchedLabel,
			hashVersion: this.#hashVersion,
		}
	}

	async #ensureSession() {
		if (isSessionExpired(this.#session, this.#now())) {
			await this.#performHandshake()
		}
		if (!this.#session)
			throw new Error('Kasa KLAP session was not established.')
		return this.#session
	}

	async request<T extends Record<string, unknown>>(
		payload: Record<string, unknown>,
	): Promise<T> {
		const session = await this.#ensureSession()
		const sequence = session.sequence + 1
		const requestJson = JSON.stringify(payload)
		const encrypted = encryptKlapPayload({
			localSeed: session.localSeed,
			remoteSeed: session.remoteSeed,
			authHash: session.authHash,
			sequence,
			payload: requestJson,
		})
		let response: Response
		try {
			response = await this.#post(
				'request',
				encrypted,
				session.sessionCookie,
				sequence,
			)
		} catch (error) {
			this.reset()
			throw error
		}
		if (response.status === 403) {
			this.reset()
			throw new Error(
				`Kasa plug ${this.#host} returned a KLAP security error; the session will be re-established on retry.`,
			)
		}
		if (response.status !== 200) {
			this.reset()
			throw new Error(
				`Kasa plug ${this.#host} responded with ${response.status} to KLAP request.`,
			)
		}
		const encryptedResponse = Buffer.from(await response.arrayBuffer())
		const decrypted = decryptKlapPayload({
			localSeed: session.localSeed,
			remoteSeed: session.remoteSeed,
			authHash: session.authHash,
			sequence,
			payload: encryptedResponse,
		})
		session.sequence = sequence
		return JSON.parse(decrypted) as T
	}

	async getSysInfo() {
		const response = await this.request<{
			system?: { get_sysinfo?: KasaSysInfo }
			result?: { system?: { get_sysinfo?: KasaSysInfo } }
		}>({
			system: {
				get_sysinfo: {},
			},
		})
		const sysinfo =
			response.system?.get_sysinfo ?? response.result?.system?.get_sysinfo
		if (!sysinfo || typeof sysinfo !== 'object') {
			throw new Error(
				`Kasa plug ${this.#host} did not return system.get_sysinfo.`,
			)
		}
		return sysinfo
	}

	async setRelayState(state: boolean) {
		return await this.request({
			system: {
				set_relay_state: {
					state: state ? 1 : 0,
				},
			},
		})
	}
}

export function createKasaKlapClient(input: KlapClientInput) {
	return new KasaKlapClient(input)
}
