import { readFile, writeFile } from 'fs/promises'

let runSrc = await readFile('src/cli/commands/run.ts', 'utf-8')
let sharedSrc = await readFile('src/cli/shared.ts', 'utf-8')

const extractStart = runSrc.indexOf('async function sendRelayRequest')
const extractEnd = runSrc.indexOf('export function createRunHandler')

const funcCode = runSrc.slice(extractStart, extractEnd)
runSrc = runSrc.slice(0, extractStart) + "import { sendRelayRequest } from '../shared.ts'\n" + runSrc.slice(extractEnd)

const imports =
	"import { createConnection } from 'node:net'\nimport type { RelayRequest, RelayResponse } from '../daemon/protocol.ts'\n\n"
sharedSrc = sharedSrc + '\n' + imports + 'export '
	+ funcCode.replace("payload: QuizRunPayload & { type: 'run-quiz' }", 'payload: RelayRequest')

await writeFile('src/cli/commands/run.ts', runSrc)
await writeFile('src/cli/shared.ts', sharedSrc)
