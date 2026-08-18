import { createHash, timingSafeEqual } from 'node:crypto'

export function verifyS256CodeChallenge(input: {
	codeVerifier: string
	codeChallenge: string
}) {
	const digest = createHash('sha256').update(input.codeVerifier).digest()
	const computed = digest.toString('base64url')
	const expected = Buffer.from(input.codeChallenge)
	const actual = Buffer.from(computed)
	return expected.length === actual.length && timingSafeEqual(expected, actual)
}
