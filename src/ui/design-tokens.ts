/**
 * Shared CSS custom properties for every server-rendered page the connector
 * serves (admin UI and the OAuth consent screen), so they read as one product.
 */
export const designTokensCss = `
	:root {
		color-scheme: light dark;
		--color-primary: #2563eb;
		--color-primary-hover: #1d4ed8;
		--color-primary-active: #1e40af;
		--color-on-primary: #ffffff;
		--color-primary-text: #1d4ed8;
		--color-background: #f8fafc;
		--color-surface: #ffffff;
		--color-surface-muted: #f1f5f9;
		--color-text: #0f172a;
		--color-text-muted: #64748b;
		--color-border: #cbd5e1;
		--color-success: #15803d;
		--color-success-surface: #dcfce7;
		--color-warning: #b45309;
		--color-warning-surface: #fef3c7;
		--color-danger: #dc2626;
		--color-danger-surface: #fee2e2;
		--font-family: system-ui, sans-serif;
		--font-family-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas,
			'Liberation Mono', 'Courier New', monospace;
		--font-size-xs: 0.75rem;
		--font-size-sm: 0.875rem;
		--font-size-base: 1rem;
		--font-size-lg: 1.25rem;
		--font-size-xl: 2rem;
		--font-size-2xl: 2.75rem;
		--font-weight-medium: 500;
		--font-weight-semibold: 600;
		--font-weight-bold: 700;
		--spacing-xs: 0.25rem;
		--spacing-sm: 0.5rem;
		--spacing-md: 1rem;
		--spacing-lg: 1.5rem;
		--spacing-xl: 2rem;
		--spacing-2xl: 3rem;
		--radius-sm: 0.25rem;
		--radius-md: 0.5rem;
		--radius-lg: 0.75rem;
		--radius-xl: 1rem;
		--radius-full: 999px;
		--shadow-sm: 0 1px 2px 0 rgb(15 23 42 / 0.06);
		--shadow-md: 0 18px 40px -24px rgb(15 23 42 / 0.35);
	}

	@media (prefers-color-scheme: dark) {
		:root {
			--color-primary: #60a5fa;
			--color-primary-hover: #93c5fd;
			--color-primary-active: #bfdbfe;
			--color-on-primary: #0f172a;
			--color-primary-text: #93c5fd;
			--color-background: #020617;
			--color-surface: #0f172a;
			--color-surface-muted: #111c31;
			--color-text: #f8fafc;
			--color-text-muted: #94a3b8;
			--color-border: #23304a;
			--color-success: #4ade80;
			--color-success-surface: rgb(34 197 94 / 0.12);
			--color-warning: #fbbf24;
			--color-warning-surface: rgb(251 191 36 / 0.12);
			--color-danger: #f87171;
			--color-danger-surface: rgb(248 113 113 / 0.12);
			--shadow-sm: 0 1px 2px 0 rgb(2 6 23 / 0.45);
			--shadow-md: 0 18px 40px -24px rgb(2 6 23 / 0.9);
		}
	}
`
