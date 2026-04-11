/**
 * Example ping plugin for NIPBANG Kotaete.
 *
 * Responds to "!ping" (or custom prefix) messages with "pong".
 *
 * Usage:
 *   kotaete plugin enable ./examples/ping-plugin.ts --arg prefix=!
 *   kotaete plugin disable ping
 *   kotaete plugin list
 */
import { definePlugin } from '../src/plugin/index.ts'

export default definePlugin({
	name: 'ping',
	version: '1.0.0',
	description: 'Responds to {prefix}ping with pong',

	async setup(ctx, args) {
		const prefix = args.prefix ?? '!'

		ctx.log.info(`ping plugin loaded (prefix: "${prefix}")`)

		return {
			async onIncomingMessage({ message }) {
				if (message.text.trim() === `${prefix}ping`) {
					await ctx.sendText(message.groupId, 'pong', {
						quotedKey: message.key,
						linkPreview: false,
					})
				}
			},

			onWaConnected({ provider }) {
				ctx.log.info(`WhatsApp connected via ${provider}`)
			},

			teardown(reason) {
				ctx.log.info(`ping plugin tearing down (reason: ${reason})`)
			},
		}
	},
})
