export function connectLive(
	onEvent: (table: string, action: string, record: Record<string, unknown>) => void,
	onOpen?: () => void,
): () => void {
	let reconnectDelay = 1000
	let es: EventSource | null = null

	function connect() {
		es = new EventSource('/api/live')

		es.addEventListener('quiz_event', (e) => {
			const data = JSON.parse(e.data)
			onEvent('quiz_event', data.action, data.record)
		})

		es.addEventListener('live_score', (e) => {
			const data = JSON.parse(e.data)
			onEvent('live_score', data.action, data.record)
		})

		es.addEventListener('live_member_state', (e) => {
			const data = JSON.parse(e.data)
			onEvent('live_member_state', data.action, data.record)
		})

		es.addEventListener('quiz_session', (e) => {
			const data = JSON.parse(e.data)
			onEvent('quiz_session', data.action, data.record)
		})

		es.addEventListener('season_score', (e) => {
			const data = JSON.parse(e.data)
			onEvent('season_score', data.action, data.record)
		})

		es.onopen = () => {
			reconnectDelay = 1000
			onOpen?.()
		}

		es.onerror = () => {
			es?.close()
			setTimeout(connect, reconnectDelay)
			reconnectDelay = Math.min(reconnectDelay * 2, 30_000)
		}
	}

	connect()

	return () => {
		es?.close()
	}
}
