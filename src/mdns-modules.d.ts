declare module 'dns-equal' {
	export default function dnsEqual(left: string, right: string): boolean
}

declare module 'multicast-dns-service-types' {
	const serviceTypes: {
		stringify(service: string, protocol: string): string
	}
	export default serviceTypes
}
