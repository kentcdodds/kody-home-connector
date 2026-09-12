import { html, type SafeHtml } from 'remix/html-template'
import { designTokensCss } from '../ui/design-tokens.ts'
import { accessTokenTtlSeconds, refreshTokenTtlSeconds } from './store.ts'

export type AuthorizePageClient = {
	name: string
	clientId: string
	redirectUri: string
}

export type AuthorizePageInput = {
	client: AuthorizePageClient
	homeHost: string
	query: string
	error?: string
}

export type AuthorizeErrorPageInput = {
	homeHost: string
	message: string
}

const styles = `
	${designTokensCss}

	*,
	*::before,
	*::after {
		box-sizing: border-box;
	}

	html {
		background: var(--color-background);
	}

	body {
		margin: 0;
		min-height: 100vh;
		min-height: 100dvh;
		display: grid;
		place-items: center;
		padding: var(--spacing-lg);
		font-family: var(--font-family);
		font-size: var(--font-size-base);
		line-height: 1.5;
		color: var(--color-text);
		background:
			radial-gradient(circle at top left, rgb(37 99 235 / 0.1), transparent 32%),
			radial-gradient(circle at bottom right, rgb(37 99 235 / 0.06), transparent 30%),
			var(--color-background);
		-webkit-text-size-adjust: 100%;
	}

	h1,
	h2,
	p,
	ul,
	dl,
	dd {
		margin: 0;
	}

	code {
		font-family: var(--font-family-mono);
		font-size: 0.9em;
		overflow-wrap: anywhere;
	}

	.consent-card {
		width: min(100%, 34rem);
		display: grid;
		gap: var(--spacing-lg);
		padding: clamp(1.5rem, 4vw, 2.25rem);
		border: 1px solid color-mix(in srgb, var(--color-primary) 18%, var(--color-border));
		border-radius: var(--radius-xl);
		background: color-mix(in srgb, var(--color-surface) 94%, transparent);
		box-shadow: var(--shadow-md);
	}

	.consent-brand {
		display: flex;
		align-items: center;
		gap: var(--spacing-sm);
		color: var(--color-text-muted);
		font-size: var(--font-size-sm);
	}

	.consent-brand-mark {
		display: inline-grid;
		place-items: center;
		flex: none;
		width: 2.25rem;
		height: 2.25rem;
		border-radius: var(--radius-lg);
		color: var(--color-primary-text);
		background: color-mix(in srgb, var(--color-primary) 12%, var(--color-surface));
		border: 1px solid color-mix(in srgb, var(--color-primary) 30%, transparent);
	}

	.consent-brand-mark svg {
		width: 1.25rem;
		height: 1.25rem;
	}

	.consent-brand-name {
		display: block;
		color: var(--color-text);
		font-weight: var(--font-weight-semibold);
	}

	.consent-header {
		display: grid;
		gap: var(--spacing-md);
	}

	.consent-title {
		font-size: clamp(1.5rem, 2vw + 1rem, var(--font-size-xl));
		font-weight: var(--font-weight-bold);
		line-height: 1.2;
		letter-spacing: -0.01em;
		overflow-wrap: anywhere;
	}

	.consent-lead {
		color: var(--color-text-muted);
	}

	.consent-alert {
		display: flex;
		gap: var(--spacing-sm);
		align-items: flex-start;
		padding: var(--spacing-md);
		border-radius: var(--radius-lg);
		border: 1px solid color-mix(in srgb, var(--color-danger) 45%, var(--color-border));
		background: color-mix(in srgb, var(--color-danger-surface) 70%, var(--color-surface));
		color: var(--color-text);
		font-size: var(--font-size-sm);
	}

	.consent-alert strong {
		color: var(--color-danger);
	}

	.consent-section {
		display: grid;
		gap: var(--spacing-sm);
	}

	.consent-section-title {
		font-size: var(--font-size-xs);
		font-weight: var(--font-weight-bold);
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--color-text-muted);
	}

	.consent-details {
		display: grid;
		gap: var(--spacing-xs) var(--spacing-md);
		grid-template-columns: max-content minmax(0, 1fr);
		padding: var(--spacing-md);
		border-radius: var(--radius-lg);
		border: 1px solid color-mix(in srgb, var(--color-border) 80%, transparent);
		background: color-mix(in srgb, var(--color-surface-muted) 70%, transparent);
		font-size: var(--font-size-sm);
	}

	.consent-details dt {
		color: var(--color-text-muted);
	}

	.consent-details dd {
		min-width: 0;
		overflow-wrap: anywhere;
	}

	.consent-permissions {
		list-style: none;
		padding: 0;
		display: grid;
		gap: var(--spacing-sm);
	}

	.consent-permissions li {
		position: relative;
		padding-left: 1.5rem;
		overflow-wrap: anywhere;
	}

	.consent-permissions li::before {
		content: '';
		position: absolute;
		left: 0.25rem;
		top: 0.6em;
		width: 0.5rem;
		height: 0.5rem;
		border-radius: var(--radius-full);
		background: var(--color-primary);
	}

	.consent-permissions li[data-tone='neutral']::before {
		background: var(--color-text-muted);
	}

	.consent-actions {
		display: flex;
		flex-wrap: wrap;
		flex-direction: row-reverse;
		gap: var(--spacing-sm);
		margin: 0;
		padding-top: var(--spacing-sm);
		border-top: 1px solid color-mix(in srgb, var(--color-border) 80%, transparent);
	}

	.consent-actions button {
		appearance: none;
		flex: 1 1 10rem;
		min-height: 2.75rem;
		padding: 0.625rem 1.25rem;
		border-radius: var(--radius-md);
		border: 1px solid transparent;
		font: inherit;
		font-weight: var(--font-weight-semibold);
		cursor: pointer;
		transition:
			background-color 0.15s ease,
			border-color 0.15s ease,
			color 0.15s ease;
	}

	.consent-actions button:focus-visible,
	.consent-footer a:focus-visible {
		outline: 3px solid color-mix(in srgb, var(--color-primary) 55%, transparent);
		outline-offset: 2px;
	}

	.consent-button-primary {
		background: var(--color-primary);
		border-color: var(--color-primary);
		color: var(--color-on-primary);
	}

	.consent-button-primary:hover {
		background: var(--color-primary-hover);
		border-color: var(--color-primary-hover);
	}

	.consent-button-primary:active {
		background: var(--color-primary-active);
		border-color: var(--color-primary-active);
	}

	.consent-button-secondary {
		background: transparent;
		border-color: color-mix(in srgb, var(--color-text-muted) 45%, var(--color-border));
		color: var(--color-text);
	}

	.consent-button-secondary:hover {
		background: color-mix(in srgb, var(--color-surface-muted) 90%, transparent);
		border-color: color-mix(in srgb, var(--color-text-muted) 60%, var(--color-border));
	}

	.consent-footer {
		color: var(--color-text-muted);
		font-size: var(--font-size-xs);
	}

	.consent-footer a {
		color: inherit;
	}

	@media (max-width: 480px) {
		body {
			padding: var(--spacing-md);
			align-items: start;
		}

		.consent-details {
			grid-template-columns: minmax(0, 1fr);
			gap: var(--spacing-xs);
		}

		.consent-details dt:not(:first-child) {
			margin-top: var(--spacing-sm);
		}

		.consent-actions {
			flex-direction: column;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.consent-actions button {
			transition: none;
		}
	}
`

const homeMark = html.raw`<svg
	viewBox="0 0 24 24"
	fill="none"
	stroke="currentColor"
	stroke-width="1.8"
	stroke-linecap="round"
	stroke-linejoin="round"
	aria-hidden="true"
	focusable="false"
>
	<path d="M3 11.5 12 4l9 7.5" />
	<path d="M5.5 10v9a1 1 0 0 0 1 1H10v-5h4v5h3.5a1 1 0 0 0 1-1v-9" />
</svg>`

function formatTtl(seconds: number) {
	const hours = Math.round(seconds / 3600)
	if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'}`
	const days = Math.round(hours / 24)
	return `${days} ${days === 1 ? 'day' : 'days'}`
}

function describeReturnTarget(redirectUri: string) {
	try {
		return new URL(redirectUri).host
	} catch {
		return redirectUri
	}
}

function renderDocument(input: {
	title: string
	homeHost: string
	body: SafeHtml
	footer: SafeHtml
}) {
	return html`<!doctype html>
		<html lang="en">
			<head>
				<meta charset="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<meta name="robots" content="noindex" />
				<title>${input.title}</title>
				<style>
					${html.raw`${styles}`}
				</style>
			</head>
			<body>
				<main class="consent-card" aria-labelledby="consent-title">
					<div class="consent-brand">
						<span class="consent-brand-mark">${homeMark}</span>
						<span>
							<span class="consent-brand-name">Kody Home</span>
							<span>${input.homeHost}</span>
						</span>
					</div>
					${input.body}
					<footer class="consent-footer">${input.footer}</footer>
				</main>
			</body>
		</html>`
}

export function renderAuthorizePage(input: AuthorizePageInput) {
	const returnTarget = describeReturnTarget(input.client.redirectUri)
	const alert = input.error
		? html`<div class="consent-alert" role="alert">
				<p><strong>Something went wrong.</strong> ${input.error}</p>
			</div>`
		: ''
	const body = html`<header class="consent-header">
			<h1 class="consent-title" id="consent-title">
				Allow ${input.client.name} to control your home?
			</h1>
			<p class="consent-lead">
				${input.client.name} wants to connect to
				<strong>home</strong>, the Kody Home connector running on your local
				network. It turns the lights, TVs, speakers, thermostats, and other
				devices in your house into tools an assistant can use.
			</p>
		</header>
		${alert}
		<section class="consent-section" aria-labelledby="consent-requester">
			<h2 class="consent-section-title" id="consent-requester">
				Who is asking
			</h2>
			<dl class="consent-details">
				<dt>App</dt>
				<dd>${input.client.name}</dd>
				<dt>Client ID</dt>
				<dd><code>${input.client.clientId}</code></dd>
				<dt>Returns to</dt>
				<dd><code>${returnTarget}</code></dd>
			</dl>
		</section>
		<section class="consent-section" aria-labelledby="consent-access">
			<h2 class="consent-section-title" id="consent-access">
				What approving allows
			</h2>
			<ul class="consent-permissions">
				<li>
					Call every home-automation tool this connector exposes, on your
					behalf, until you revoke access.
				</li>
				<li>
					Stay connected without asking again: access tokens last
					${formatTtl(accessTokenTtlSeconds)} and refresh for up to
					${formatTtl(refreshTokenTtlSeconds)} at a time.
				</li>
				<li data-tone="neutral">
					Does not grant access to the local admin dashboard or let the app
					change connector settings.
				</li>
			</ul>
		</section>
		<form method="post" action="/authorize" class="consent-actions">
			<input type="hidden" name="query" value="${input.query}" />
			<button
				type="submit"
				name="intent"
				value="approve"
				class="consent-button-primary"
			>
				Approve
			</button>
			<button
				type="submit"
				name="intent"
				value="deny"
				class="consent-button-secondary"
			>
				Deny
			</button>
		</form>`
	const footer = html`<p>
		Only approve if you started this connection from ${input.client.name}
		yourself. This page is protected by Cloudflare Access on the public
		hostname; the LAN origin is trusted.
	</p>`
	return String(
		renderDocument({
			title: `Allow ${input.client.name}? · Kody Home`,
			homeHost: input.homeHost,
			body,
			footer,
		}),
	)
}

export function renderAuthorizeErrorPage(input: AuthorizeErrorPageInput) {
	const body = html`<header class="consent-header">
			<h1 class="consent-title" id="consent-title">
				This authorization request can’t continue
			</h1>
			<p class="consent-lead">
				Nothing was approved. Go back to the app that sent you here and start
				the connection again.
			</p>
		</header>
		<div class="consent-alert" role="alert">
			<p><strong>Request rejected.</strong> ${input.message}</p>
		</div>`
	const footer = html`<p>
		Kody Home only accepts HTTPS Client ID Metadata Document clients with a
		registered redirect URI and PKCE.
	</p>`
	return String(
		renderDocument({
			title: 'Authorization request rejected · Kody Home',
			homeHost: input.homeHost,
			body,
			footer,
		}),
	)
}
