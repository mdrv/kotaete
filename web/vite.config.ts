import { sveltekit } from '@sveltejs/kit/vite'
import type { PluginOption } from 'vite'
import { defineConfig } from 'vite'
import { KotaeteWsServer } from './src/lib/server/ws-handler'

function wsPlugin(): PluginOption {
	const wsServer = new KotaeteWsServer()

	return {
		name: 'kotaete-ws',

		configureServer(server) {
			if (server.httpServer) {
				wsServer.attachUpgrade(server.httpServer)
			}
		},

		configurePreviewServer(server) {
			if (server.httpServer) {
				wsServer.attachUpgrade(server.httpServer)
			}
		},
	}
}

export default defineConfig({
	plugins: [sveltekit(), wsPlugin()],
	server: {
		allowedHosts: ['nipbang.id', 'kotaete.nipbang.id'],
	},
})
