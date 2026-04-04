import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { QuizEngine } from './src/quiz/engine.ts'
import { loadQuizBundle } from './src/quiz/loader.ts'

const d = join(tmpdir(), 'explain-test-' + Date.now())
await mkdir(d)
await writeFile(join(d, '01.md'), 'hint: ABC\n---\nans\n---\nthis is it!')
const b = await loadQuizBundle(d, { noSchedule: true })

let sender = {
	sendText: async (g, txt) => {
		console.log('SENT TEXT:\n' + txt + '\n')
		return { id: 'x' }
	},
	react: async () => {},
	sendImageWithCaption: async () => {
		return { id: 'y' }
	},
}

let engine = new QuizEngine(sender, { sleep: async () => {} })

await engine.run(b, [{ lid: 'l', pn: 'p', nickname: 'n', kananame: 'k', classgroup: 'c' }], 'g', { noCooldown: true })
// wait to trigger timeout
await new Promise(r => setTimeout(r, 100))
