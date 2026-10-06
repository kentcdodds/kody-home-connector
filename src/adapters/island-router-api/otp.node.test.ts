import { expect, test } from 'vitest'
import {
	computeIsland323Hotp,
	computeIsland323HotpCounter,
	computeIslandRouterHotpFromKey,
	islandStartupTokenKeyBytes,
} from './otp.ts'

test('RFC 4226 HOTP vectors with ASCII key bytes', () => {
	// RFC 4226 Appendix D: key = ASCII "12345678901234567890"
	const key = islandStartupTokenKeyBytes('12345678901234567890')
	expect(computeIslandRouterHotpFromKey({ key, counter: 0 })).toBe('755224')
	expect(computeIslandRouterHotpFromKey({ key, counter: 1 })).toBe('287082')
	expect(computeIslandRouterHotpFromKey({ key, counter: 2 })).toBe('359152')
	expect(computeIslandRouterHotpFromKey({ key, counter: 9 })).toBe('520489')
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

test('Island 3.2.3 token-bytes HOTP matches RFC 4226 at a fixed clock', () => {
	const token = '12345678901234567890'
	// nowMs=0, offset=0 → counter 0 → RFC vector 755224
	expect(
		computeIsland323Hotp({
			token,
			nowMs: 0,
			offset: 0,
		}),
	).toBe('755224')
	// nowMs=30_000, offset=0 → counter 1 → 287082
	expect(
		computeIsland323Hotp({
			token,
			nowMs: 30_000,
			offset: 0,
		}),
	).toBe('287082')
	// nowMs=0, offset=1 → counter 1 → 287082
	expect(
		computeIsland323Hotp({
			token,
			nowMs: 0,
			offset: 1,
		}),
	).toBe('287082')
})

test('Island 3.2.3 token key uses char codes, not UTF-8 multi-byte sequences', () => {
	const token = 'café'
	expect([...islandStartupTokenKeyBytes(token)]).toEqual([
		0x63, 0x61, 0x66, 0xe9,
	])
	expect([...islandStartupTokenKeyBytes(token)]).not.toEqual([
		...Buffer.from(token, 'utf8'),
	])
})
