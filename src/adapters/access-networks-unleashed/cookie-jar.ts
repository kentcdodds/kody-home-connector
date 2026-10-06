/**
 * Minimal cookie jar for Unleashed session hops. Keeps every name=value the
 * server sets (including names like `-ejs-session-`) and rebuilds a Cookie
 * request header. Attribute flags (HttpOnly, Secure, Path, …) are ignored.
 */
export class AccessNetworksUnleashedCookieJar {
	#cookies = new Map<string, string>()

	absorb(headers: Headers) {
		const setCookie =
			typeof headers.getSetCookie === 'function'
				? headers.getSetCookie()
				: headers.get('set-cookie')
					? [headers.get('set-cookie') ?? '']
					: []
		for (const cookieHeader of setCookie) {
			const [pair] = cookieHeader.split(';')
			const separator = pair.indexOf('=')
			if (separator <= 0) continue
			const name = pair.slice(0, separator).trim()
			const value = pair.slice(separator + 1).trim()
			if (!name) continue
			this.#cookies.set(name, value)
		}
	}

	headerValue() {
		if (this.#cookies.size === 0) return null
		return [...this.#cookies.entries()]
			.map(([name, value]) => `${name}=${value}`)
			.join('; ')
	}

	clear() {
		this.#cookies.clear()
	}

	get size() {
		return this.#cookies.size
	}
}
