import type { KotaetePluginDefinition } from './types.ts'

/**
 * Define a kotaete plugin. Mirrors the `defineConfig()` pattern used for quiz configs.
 *
 * @example
 * ```ts
 * import { definePlugin } from '@mdrv/kotaete'
 *
 * export default definePlugin({
 *   name: 'ping',
 *   async setup(ctx, args) {
 *     return {
 *       async onIncomingMessage({ message }) {
 *         if (message.text.trim() === `${args.prefix ?? '!'}ping`) {
 *           await ctx.sendText(message.groupId, 'pong')
 *         }
 *       },
 *     }
 *   },
 * })
 * ```
 */
export function definePlugin<const TSchema extends import('zod').ZodTypeAny | undefined = undefined>(
	plugin: KotaetePluginDefinition<TSchema>,
): KotaetePluginDefinition<TSchema> {
	return plugin
}
