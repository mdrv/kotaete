import { resolve } from 'node:path'

export function expandHome(pathLike: string): string {
	if (!pathLike.startsWith('~')) return resolve(pathLike)
	const home = process.env.HOME
	if (!home) return resolve(pathLike)
	if (pathLike === '~') return home
	if (pathLike.startsWith('~/')) return resolve(home, pathLike.slice(2))
	return resolve(pathLike)
}
