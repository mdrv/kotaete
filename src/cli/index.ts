#!/usr/bin/env bun

import { helpPlugin, versionPlugin } from '@crustjs/plugins'
import packageJson from '../../package.json' with { type: 'json' }
import { daemonCmd } from './commands/daemon.ts'
import { quizCmd } from './commands/quiz.ts'
import { seasonCmd } from './commands/season.ts'
import { toolCmd } from './commands/tool.ts'
import { app } from './shared.ts'

await app
	.use(versionPlugin(packageJson.version ?? '0.0.0'))
	.use(helpPlugin())
	.command(daemonCmd)
	.command(quizCmd)
	.command(seasonCmd)
	.command(toolCmd)
	.execute()
