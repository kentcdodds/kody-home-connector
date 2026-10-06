import { createHmac } from 'node:crypto'

const base32Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function decodeBase32(value: string) {
	const normalized = value.toUpperCase().replaceAll(/\s|=/g, '')
	if (normalized.length === 0) {
		throw new Error('Invalid base32 secret.')
	}
	let bits = 0
	let bitCount = 0
	const bytes: Array<number> = []
	for (const character of normalized) {
		const index = base32Alphabet.indexOf(character)
		if (index === -1) {
			throw new Error('Invalid base32 secret.')
		}
		bits = (bits << 5) | index
		bitCount += 5
		while (bitCount >= 8) {
			bytes.push((bits >> (bitCount - 8)) & 0xff)
			bitCount -= 8
		}
	}
	return Buffer.from(bytes)
}

/**
 * Island 3.2.3 uses the startup `token` string's character codes as the HOTP
 * key (the Flutter UI base32-encodes then decodes those codes, which
 * round-trips to the same bytes). For ASCII/latin1 tokens this matches UTF-8.
 */
export function islandStartupTokenKeyBytes(token: string) {
	return Buffer.from(token, 'utf8')
}

/**
 * Island 3.2.3 counter: floor((floor(unixSeconds) + offset*30) / 30).
 * `offset` is in 30-second blocks and is added before dividing.
 */
export function computeIsland323HotpCounter(input: {
	nowMs: number
	offset: number
}) {
	const unixSeconds = Math.floor(input.nowMs / 1000)
	return Math.floor((unixSeconds + input.offset * 30) / 30)
}

export function computeIslandRouterHotpFromKey(input: {
	key: Buffer | Uint8Array
	counter: number
}) {
	if (!Number.isSafeInteger(input.counter) || input.counter < 0) {
		throw new Error('HOTP counter must be a non-negative safe integer.')
	}
	if (input.key.byteLength === 0) {
		throw new Error('HOTP key must not be empty.')
	}
	const counterBuffer = Buffer.alloc(8)
	counterBuffer.writeBigUInt64BE(BigInt(input.counter))
	const digest = createHmac('sha1', input.key).update(counterBuffer).digest()
	const offset = digest[digest.length - 1]! & 0x0f
	const code =
		(((digest[offset]! & 0x7f) << 24) |
			((digest[offset + 1]! & 0xff) << 16) |
			((digest[offset + 2]! & 0xff) << 8) |
			(digest[offset + 3]! & 0xff)) %
		1_000_000
	return code.toString().padStart(6, '0')
}

export function computeIslandRouterHotp(input: {
	secret: string
	counter: number
}) {
	return computeIslandRouterHotpFromKey({
		key: decodeBase32(input.secret),
		counter: input.counter,
	})
}

export function computeIsland323Hotp(input: {
	token: string
	nowMs: number
	offset: number
}) {
	return computeIslandRouterHotpFromKey({
		key: islandStartupTokenKeyBytes(input.token),
		counter: computeIsland323HotpCounter({
			nowMs: input.nowMs,
			offset: input.offset,
		}),
	})
}
