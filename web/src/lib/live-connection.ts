export function connectLive(
	onEvent: (table: string, action: string, record: Record<string, unknown>) => void,
	onOpen?: () => void,
): () => void {
	let reconnectDelay = 1000
	let ws: WebSocket | null = null
	let alive = true

	function connect() {
		const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
		const url = `${protocol}//${location.host}/api/ws`
		ws = new WebSocket(url)

		ws.onopen = () => {
			reconnectDelay = 1000
			onOpen?.()
		}

		ws.onmessage = (event) => {
			try {
				const msg = JSON.parse(event.data as string)
				if (msg.type === 'live') {
					onEvent(msg.table, msg.action, msg.record)
				}
			} catch {
				// ignore non-JSON or malformed messages
			}
		}

		ws.onclose = () => {
			if (!alive) return
			setTimeout(connect, reconnectDelay)
			reconnectDelay = Math.min(reconnectDelay * 2, 30_000)
		}

		ws.onerror = () => {
			ws?.close()
		}
	}

	connect()

	return () => {
		alive = false
		ws?.close()
	}
}

/** Send a message to the WebSocket server (for future chat etc.) */
export function sendWsMessage(ws: WebSocket | null, type: string, payload: unknown) {
	if (ws && ws.readyState === ws.OPEN) {
		ws.send(JSON.stringify({ type, payload }))
	}
}
