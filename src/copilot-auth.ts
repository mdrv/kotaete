/**
 * GitHub Copilot OAuth authentication for kotaete.
 *
 * Flow:
 *  1. Device flow → user opens browser URL, enters user_code → we get an OAuth token
 *  2. Exchange OAuth token for a short-lived Copilot session token (~30 min TTL)
 *  3. Auto-refresh session token before expiry; persist OAuth token to disk
 *
 * Storage: ~/.kotaete/copilot-token.json
 *   { oauthToken: string, sessionToken: string, sessionExpiresAt: number }
 */

import { getLogger } from './logger.ts'

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const log = getLogger(['kotaete', 'auth', 'copilot'])

// GitHub Copilot's known public OAuth app client ID (same as VS Code extension)
const COPILOT_CLIENT_ID = 'Iv1.b507a08c87ecfe98'
const SCOPE = 'read:user'

// Copilot session token refresh margin: refresh 5 min before expiry
const REFRESH_MARGIN_MS = 5 * 60 * 1000
// Copilot session tokens expire in ~30 min; we refresh at 25 min
const SESSION_TTL_MS = 30 * 60 * 1000

const TOKEN_PATH = join(homedir(), '.kotaete', 'copilot-token.json')

interface StoredTokens {
	oauthToken: string
	sessionToken: string
	sessionExpiresAt: number // Unix ms
}

interface DeviceCodeResponse {
	device_code: string
	user_code: string
	verification_uri: string
	expires_in: number
	interval: number
}

interface AccessTokenResponse {
	access_token?: string
	token_type?: string
	error?: string
	error_description?: string
}

interface SessionTokenResponse {
	token?: string
	expires_at?: number // Unix seconds
	error?: string
}

// ─── Persistence ──────────────────────────────────────────────────────────────

function loadStored(): StoredTokens | null {
	if (!existsSync(TOKEN_PATH)) return null
	try {
		return JSON.parse(readFileSync(TOKEN_PATH, 'utf-8')) as StoredTokens
	} catch {
		return null
	}
}

function saveStored(tokens: StoredTokens): void {
	const dir = join(homedir(), '.kotaete')
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
	writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2), { mode: 0o600 })
}

// ─── GitHub OAuth device flow ─────────────────────────────────────────────────

/**
 * Step 1: Start device flow — returns the device code and user-facing prompt.
 */
export async function startDeviceFlow(): Promise<DeviceCodeResponse> {
	const res = await fetch('https://github.com/login/device/code', {
		method: 'POST',
		headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
		body: JSON.stringify({ client_id: COPILOT_CLIENT_ID, scope: SCOPE }),
	})
	if (!res.ok) throw new Error(`Device flow init failed: ${res.status} ${await res.text()}`)
	return res.json() as Promise<DeviceCodeResponse>
}

/**
 * Step 2: Poll until user completes authorization. Returns the OAuth token.
 * Throws if the device code expires.
 */
export async function pollForOAuthToken(
	deviceCode: string,
	intervalSeconds: number,
	expiresInSeconds: number,
): Promise<string> {
	const deadline = Date.now() + expiresInSeconds * 1000
	const pollInterval = Math.max(intervalSeconds, 5) * 1000

	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, pollInterval))

		const res = await fetch('https://github.com/login/oauth/access_token', {
			method: 'POST',
			headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
			body: JSON.stringify({
				client_id: COPILOT_CLIENT_ID,
				device_code: deviceCode,
				grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
			}),
		})

		const data = (await res.json()) as AccessTokenResponse

		if (data.access_token) {
			log.info('OAuth token obtained successfully')
			return data.access_token
		}
		if (data.error === 'authorization_pending') continue
		if (data.error === 'slow_down') {
			await new Promise((r) => setTimeout(r, 5000))
			continue
		}
		throw new Error(`OAuth poll error: ${data.error} — ${data.error_description ?? ''}`)
	}

	throw new Error('Device code expired. Please run `kotaete auth copilot` again.')
}

/**
 * Step 3: Exchange OAuth token for a short-lived Copilot session token.
 */
async function fetchSessionToken(oauthToken: string): Promise<{ token: string; expiresAt: number }> {
	const res = await fetch('https://api.github.com/copilot_internal/v2/token', {
		headers: {
			Authorization: `token ${oauthToken}`,
			'Editor-Version': 'vscode/1.85.0',
			'Editor-Plugin-Version': 'copilot/1.155.0',
			'User-Agent': 'kotaete/1.0',
		},
	})

	if (!res.ok) {
		const text = await res.text()
		throw new Error(`Copilot session token fetch failed: ${res.status} ${text}`)
	}

	const data = (await res.json()) as SessionTokenResponse

	if (!data.token) throw new Error("Copilot session token response missing 'token' field")

	// expires_at is Unix seconds; convert to ms
	const expiresAt = data.expires_at
		? data.expires_at * 1000
		: Date.now() + SESSION_TTL_MS

	log.info(`Copilot session token refreshed, expires at ${new Date(expiresAt).toISOString()}`)
	return { token: data.token, expiresAt }
}

// ─── CopilotAuth singleton ─────────────────────────────────────────────────────

class CopilotAuth {
	private stored: StoredTokens | null = null
	private refreshPromise: Promise<string> | null = null

	/**
	 * Returns a valid session token, refreshing if necessary.
	 * Throws if no OAuth token is stored (user must run `kotaete auth copilot`).
	 */
	async getSessionToken(): Promise<string> {
		// Avoid concurrent refresh races
		if (this.refreshPromise) return this.refreshPromise

		const stored = this.stored ?? loadStored()
		this.stored = stored

		if (!stored) {
			throw new Error(
				'No Copilot OAuth token found. Run `kotaete auth copilot` to authenticate.',
			)
		}

		const needsRefresh = Date.now() >= stored.sessionExpiresAt - REFRESH_MARGIN_MS
		if (!needsRefresh) return stored.sessionToken

		// Refresh session token
		this.refreshPromise = this._refresh(stored.oauthToken).finally(() => {
			this.refreshPromise = null
		})
		return this.refreshPromise
	}

	private async _refresh(oauthToken: string): Promise<string> {
		log.debug('Refreshing Copilot session token')
		const { token, expiresAt } = await fetchSessionToken(oauthToken)
		this.stored = { ...this.stored!, sessionToken: token, sessionExpiresAt: expiresAt }
		saveStored(this.stored)
		return token
	}

	/**
	 * Stores a freshly obtained OAuth token and fetches the first session token.
	 * Called after a successful device flow.
	 */
	async saveOAuthToken(oauthToken: string): Promise<void> {
		const { token, expiresAt } = await fetchSessionToken(oauthToken)
		this.stored = { oauthToken, sessionToken: token, sessionExpiresAt: expiresAt }
		saveStored(this.stored)
		log.info(`Copilot auth saved to ${TOKEN_PATH}`)
	}

	/** True if an OAuth token is stored on disk (may still need session refresh). */
	isAuthenticated(): boolean {
		return !!(this.stored ?? loadStored())
	}
}

export const copilotAuth = new CopilotAuth()
