import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadQuizBundle } from './src/quiz/loader.ts'

const d = join(tmpdir(), 'explain-test-' + Date.now())
await mkdir(d)
await writeFile(join(d, '01.md'), 'hint: 123\n---\nans\n---\nthis is it!')
const b = await loadQuizBundle(d, { noSchedule: true })
console.log(b.questions[0].explanation)
