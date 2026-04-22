import { initLogger } from '../../logger.ts'
import { app } from '../shared.ts'

const authCopilot = app
	.sub('copilot')
	.meta({ description: 'Authenticate with GitHub Copilot via OAuth device flow' })
	.run(async ({ flags }) => {
		await initLogger(flags.debug ? 'debug' : 'info')

		const { startDeviceFlow, pollForOAuthToken, copilotAuth } = await import('../../copilot-auth.ts')

		if (copilotAuth.isAuthenticated()) {
			console.log('✓ Already authenticated with GitHub Copilot.')
			console.log('  To re-authenticate, delete ~/.kotaete/copilot-token.json and run again.')
			return
		}

		console.log('\nAuthenticating with GitHub Copilot...\n')

		const deviceCode = await startDeviceFlow()

		console.log('Open this URL in your browser:')
		console.log(`\n  ${deviceCode.verification_uri}\n`)
		console.log(`Then enter this code: ${deviceCode.user_code}\n`)
		console.log('Waiting for authorization...')

		const oauthToken = await pollForOAuthToken(
			deviceCode.device_code,
			deviceCode.interval,
			deviceCode.expires_in,
		)

		await copilotAuth.saveOAuthToken(oauthToken)

		console.log('\n✓ Authenticated successfully!')
		console.log('  Session token saved to ~/.kotaete/copilot-token.json')
		console.log('  Kotaete will auto-refresh the session token every ~25 minutes.\n')
	})

export const authCmd = app
	.sub('auth')
	.meta({ description: 'Authentication commands' })
	.command(authCopilot)
