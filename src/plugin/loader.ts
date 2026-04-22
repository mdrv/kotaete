import { resolve } from 'node:path'
import type { KotaetePluginDefinition, PluginModule } from './types.ts'

/**
 * Dynamically import a plugin module from the given source path.
 * Returns the plugin definition (default export).
 *
 * Uses cache-busting query parameter to support hot-reloading.
 *
 * Note: uses filesystem paths (not file:// URLs) so that bare module
 * specifiers inside plugins (e.g. '@mdrv/id') resolve correctly via
 * the project's node_modules.
 */
export async function loadPlugin(
	sourcePath: string,
	opts?: { reload?: boolean },
): Promise<KotaetePluginDefinition> {
	const absPath = resolve(sourcePath)

	const specifier = opts?.reload
		? `${absPath}?_t=${Date.now()}`
		: absPath

	const mod = await import(specifier) as PluginModule

	if (!mod.default || typeof mod.default !== 'object') {
		throw new Error(
			`plugin "${sourcePath}" does not export a valid default export. Use definePlugin().`,
		)
	}

	const def = mod.default
	if (!def.name || typeof def.name !== 'string') {
		throw new Error(`plugin "${sourcePath}" must have a non-empty "name" property`)
	}

	return def
}
