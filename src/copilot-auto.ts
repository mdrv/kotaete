/**
 * GitHub Copilot auto model selection.
 *
 * Protocol (reverse-engineered from VS Code Copilot Chat extension):
 *
 * 1. POST /models/session — creates auto-mode session, returns
 *    available_models, session_token, expires_at
 *
 * 2. POST /models/session/intent — per-turn routing, sends prompt text
 *    and available models. Returns candidate_models ranked by suitability.
 *
 * 3. The selected model's chat/completions request also receives the
 *    Copilot-Session-Token header for billing discount tracking.
 *
 * Refs:
 *  - https://github.com/fastdrumr/opencode/commit/f4c9980a96b28f36cfe12daa7d2027191840e6df
 *  - https://github.com/anomalyco/opencode/issues/20235
 */

import { getLogger } from './logger.ts'

const log = getLogger(['kotaete', 'copilot-auto'])

const SESSION_REFRESH_BUFFER_MS = 5 * 60 * 1000

interface AutoSession {
	availableModels: string[]
	sessionToken: string
	expiresAt: number // Unix ms
}

export interface ResolvedModel {
	model: string
	sessionToken: string
}

class CopilotAutoModel {
	private session: AutoSession | null = null
	private lastModelId: string | null = null
	private turnNumber = 0
	private refreshPromise: Promise<AutoSession> | null = null

	private isExpired(): boolean {
		if (!this.session) return true
		return Date.now() >= this.session.expiresAt - SESSION_REFRESH_BUFFER_MS
	}

	async ensureSession(bearerToken: string): Promise<AutoSession> {
		if (this.session && !this.isExpired()) return this.session
		if (this.refreshPromise) return this.refreshPromise

		this.refreshPromise = this._createSession(bearerToken).finally(() => {
			this.refreshPromise = null
		})

		return this.refreshPromise
	}

	private async _createSession(bearerToken: string): Promise<AutoSession> {
		const url = 'https://api.githubcopilot.com/models/session'
		log.info('creating auto model session')

		const response = await fetch(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${bearerToken}`,
				'Copilot-Integration-Id': 'vscode-chat',
			},
			body: JSON.stringify({
				auto_mode: { model_hints: ['auto'] },
			}),
		})

		if (!response.ok) {
			const text = await response.text()
			throw new Error(`Auto model session failed: ${response.status} ${text}`)
		}

		const data = (await response.json()) as {
			available_models: string[]
			session_token: string
			expires_at: number
		}

		log.info('auto model session created', {
			availableModels: data.available_models,
			expiresAt: new Date(data.expires_at * 1000).toISOString(),
		})

		this.session = {
			availableModels: data.available_models,
			sessionToken: data.session_token,
			expiresAt: data.expires_at * 1000,
		}

		return this.session
	}

	async resolveModel(bearerToken: string, prompt: string): Promise<ResolvedModel> {
		const session = await this.ensureSession(bearerToken)

		// Short prompt — use fallback
		if (!prompt || prompt.length < 10) {
			const fallback = this.selectFallback(session)
			return { model: fallback, sessionToken: session.sessionToken }
		}

		this.turnNumber++

		try {
			const url = 'https://api.githubcopilot.com/models/session/intent'
			const response = await fetch(url, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${bearerToken}`,
					'Copilot-Integration-Id': 'vscode-chat',
					'Copilot-Session-Token': session.sessionToken,
				},
				body: JSON.stringify({
					prompt: prompt.slice(0, 4096),
					available_models: session.availableModels,
					turn_number: this.turnNumber,
					previous_model: this.lastModelId,
					prompt_char_count: prompt.length,
					reference_count: 0,
				}),
			})

			if (response.ok) {
				const data = (await response.json()) as {
					candidate_models: string[]
					predicted_label?: string
					confidence?: number
				}

				if (data.candidate_models?.length) {
					const selected = data.candidate_models[0]!
					log.info('auto model selected', {
						model: selected,
						confidence: data.confidence,
						turn: this.turnNumber,
					})
					this.lastModelId = selected
					return { model: selected, sessionToken: session.sessionToken }
				}
			}

			log.warn('auto model intent failed, using fallback', { status: response.status })
		} catch (err) {
			log.warn('auto model intent error, using fallback', { error: err })
		}

		const fallback = this.selectFallback(session)
		return { model: fallback, sessionToken: session.sessionToken }
	}

	private selectFallback(session: AutoSession): string {
		if (this.lastModelId) {
			const lastProvider = this.lastModelId.split('-')[0]!
			const sameProvider = session.availableModels.find((m) => m.startsWith(lastProvider))
			if (sameProvider) return sameProvider
		}
		return session.availableModels[0]!
	}
}

export const copilotAutoModel = new CopilotAutoModel()
