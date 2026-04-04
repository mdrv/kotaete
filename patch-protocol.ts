import { readFile, writeFile } from 'fs/promises'

const file = await readFile('src/daemon/protocol.ts', 'utf-8')

const newReq = `
export const relayStopSeasonRequestSchema = z.object({
	type: z.literal('season-stop'),
	groupId: z.string().min(1),
	noScoreboard: z.boolean().optional(),
})
`

let res = file.replace('export const relayLookupRequestSchema', newReq + '\nexport const relayLookupRequestSchema')
res = res.replace('	relayLookupRequestSchema,', '	relayStopSeasonRequestSchema,\n	relayLookupRequestSchema,')
res = res.replace(
	'export type RelayLookupRequest',
	'export type RelayStopSeasonRequest = z.infer<typeof relayStopSeasonRequestSchema>\nexport type RelayLookupRequest',
)

await writeFile('src/daemon/protocol.ts', res)
