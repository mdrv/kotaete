import { readFile, writeFile } from 'fs/promises'

const runSrc = await readFile('src/cli/commands/run.ts', 'utf-8')
const sharedSrc = await readFile('src/cli/shared.ts', 'utf-8')

const extractMatch = runSrc.match(/async function sendRelayRequest[\s\S]*?\}\n/)?.[0]
if (extractMatch) {
	const newRun = runSrc.replace(extractMatch, "import { sendRelayRequest } from '../shared.ts'\n")
	const newShared = sharedSrc
		+ "\nimport { createConnection } from 'node:net'\nimport type { RelayRequest, RelayResponse } from '../daemon/protocol.ts'\n\nexport "
		+ extractMatch.replace(/payload:.*?,/, 'payload: RelayRequest,')
	await writeFile('src/cli/commands/run.ts', newRun)
	await writeFile('src/cli/shared.ts', newShared)
}
