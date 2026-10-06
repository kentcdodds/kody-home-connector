import { createHmac } from 'node:crypto'
import { expect, test } from 'vitest'
import {
	computeIsland323Hotp,
	computeIsland323HotpCounter,
	computeIslandRouterHotpFromKey,
	encodeBase32,
	island323HotpKeyFromToken,
	islandStartupTokenCodeUnitBytes,
} from './otp.ts'

test('RFC 4648 base32 encode matches standard vectors and pads', () => {
	expect(encodeBase32(Buffer.from(''))).toBe('')
	expect(encodeBase32(Buffer.from('f'))).toBe('MY======')
	expect(encodeBase32(Buffer.from('fo'))).toBe('MZXQ====')
	expect(encodeBase32(Buffer.from('foo'))).toBe('MZXW6===')
	expect(encodeBase32(Buffer.from('foob'))).toBe('MZXW6YQ=')
	expect(encodeBase32(Buffer.from('fooba'))).toBe('MZXW6YTB')
	expect(encodeBase32(Buffer.from('foobar'))).toBe('MZXW6YTBOI======')
	// RFC 4226 ASCII key → classic test secret (padding not needed at 20 bytes)
	expect(encodeBase32(Buffer.from('12345678901234567890'))).toBe(
		'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
	)
})

test('Island 3.2.3 counter adds offset blocks before dividing', () => {
	// unixSeconds=1000, offset=2 → floor((1000 + 60) / 30) = 35
	expect(
		computeIsland323HotpCounter({
			nowMs: 1_000_000,
			offset: 2,
		}),
	).toBe(35)
	expect(
		computeIsland323HotpCounter({
			nowMs: 0,
			offset: 0,
		}),
	).toBe(0)
})

test('Island 3.2.3 HOTP key is utf8(base32(codeUnits(token))), not raw token bytes', () => {
	const token = '12345678901234567890'
	const codeUnits = islandStartupTokenCodeUnitBytes(token)
	expect([...codeUnits]).toEqual([...Buffer.from(token, 'ascii')])
	const secretStr = encodeBase32(codeUnits)
	expect(secretStr).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')
	const key = island323HotpKeyFromToken(token)
	expect([...key]).toEqual([...Buffer.from(secretStr, 'utf8')])
	// Must not use raw code-unit bytes as the HMAC key (the #70 mistake).
	expect([...key]).not.toEqual([...codeUnits])
})

test('Island 3.2.3 token code units use low 8 bits, not UTF-8 multi-byte sequences', () => {
	const token = 'café'
	expect([...islandStartupTokenCodeUnitBytes(token)]).toEqual([
		0x63, 0x61, 0x66, 0xe9,
	])
	expect([...islandStartupTokenCodeUnitBytes(token)]).not.toEqual([
		...Buffer.from(token, 'utf8'),
	])
})

/**
 * Independent HOTP reference: HMAC-SHA1 over 8-byte BE counter, dynamic
 * truncation, % 10^6, left-padded — matching Flutter `vG` / `cwA`.
 */
function independentHotp(key: Buffer, counter: number) {
	const counterBuffer = Buffer.alloc(8)
	counterBuffer.writeBigUInt64BE(BigInt(counter))
	const digest = createHmac('sha1', key).update(counterBuffer).digest()
	const offset = digest[digest.length - 1]! & 0x0f
	const code =
		(((digest[offset]! & 0x7f) << 24) |
			((digest[offset + 1]! & 0xff) << 16) |
			((digest[offset + 2]! & 0xff) << 8) |
			(digest[offset + 3]! & 0xff)) %
		1_000_000
	return code.toString().padStart(6, '0')
}

test('Island 3.2.3 HOTP matches independent utf8(base32(codeUnits)) reference', () => {
	const token = 'island-token-fixture-01'
	const offset = 2
	const nowMs = 1_700_000_000_000
	const codeUnits = islandStartupTokenCodeUnitBytes(token)
	const secretStr = encodeBase32(codeUnits)
	const key = Buffer.from(secretStr, 'utf8')
	const counter = Math.floor((Math.floor(nowMs / 1000) + offset * 30) / 30)
	const expected = independentHotp(key, counter)

	expect(
		computeIsland323Hotp({
			token,
			nowMs,
			offset,
		}),
	).toBe(expected)
	expect(
		computeIslandRouterHotpFromKey({
			key: island323HotpKeyFromToken(token),
			counter,
		}),
	).toBe(expected)
	// Fixed known vector for the classic ASCII token at counter 0 / 1.
	expect(
		computeIsland323Hotp({
			token: '12345678901234567890',
			nowMs: 0,
			offset: 0,
		}),
	).toBe('312805')
	expect(
		computeIsland323Hotp({
			token: '12345678901234567890',
			nowMs: 30_000,
			offset: 0,
		}),
	).toBe('372946')
	expect(
		computeIsland323Hotp({
			token: '12345678901234567890',
			nowMs: 0,
			offset: 1,
		}),
	).toBe('372946')
})
