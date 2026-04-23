import { getDb } from '$lib/server/surreal'
import { RecordId } from 'surrealdb'
import type { QuizSession } from '$lib/server/types'
import { json } from '@sveltejs/kit'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp']

const CONTENT_TYPES: Record<string, string> = {
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.png': 'image/png',
	'.webp': 'image/webp',
}

function padNo(no: number | string): string {
	return String(no).padStart(2, '0')
}

async function tryFile(path: string): Promise<Uint8Array | null> {
	try {
		const s = await stat(path)
		if (s.isFile()) return new Uint8Array(await readFile(path))
	} catch {
		// not found
	}
	return null
}

async function findImage(
	quizDir: string,
	questionNo: string,
): Promise<{ data: Uint8Array; contentType: string } | null> {
	const padded = padNo(questionNo)

	for (const ext of IMAGE_EXTENSIONS) {
		let result = await tryFile(join(quizDir, `${padded}-ok${ext}`))
		if (result) return { data: result, contentType: CONTENT_TYPES[ext]! }

		result = await tryFile(join(quizDir, `${questionNo}-ok${ext}`))
		if (result) return { data: result, contentType: CONTENT_TYPES[ext]! }

		result = await tryFile(join(quizDir, `${padded}${ext}`))
		if (result) return { data: result, contentType: CONTENT_TYPES[ext]! }

		result = await tryFile(join(quizDir, `${questionNo}${ext}`))
		if (result) return { data: result, contentType: CONTENT_TYPES[ext]! }
	}

	return null
}

/** Extract record key from potentially full RecordId string like 'quiz_session:xxx' */
function extractKey(id: string): string {
	const idx = id.indexOf(':')
	return idx >= 0 ? id.slice(idx + 1) : id
}

export async function GET({ params }: { params: { sessionId: string; questionNo: string } }) {
	const { sessionId, questionNo } = params
	const key = extractKey(sessionId)

	try {
		const db = await getDb()
		const sid = new RecordId('quiz_session', key)

		const [sessions] = await db.query(
			'SELECT * FROM quiz_session WHERE id = $sid',
			{ sid },
		).collect<[QuizSession[]]>()
		const session = sessions[0]
		if (!session) {
			return json({ error: 'Session not found' }, { status: 400 })
		}

		if (!session.quiz_dir) {
			return json({ error: 'No quiz directory configured' }, { status: 400 })
		}

		const image = await findImage(session.quiz_dir, questionNo)
		if (!image) {
			return json({ error: 'Image not found' }, { status: 404 })
		}

		return new Response(image.data.buffer as ArrayBuffer, {
			headers: {
				'Content-Type': image.contentType,
				'Cache-Control': 'public, max-age=3600',
			},
		})
	} catch (e) {
		console.error('Failed to serve image:', e)
		return json({ error: 'Internal server error' }, { status: 500 })
	}
}
