export type NMember = {
	mid: string
	kananame: string
	nickname: string
	classgroup: string
	number: string
}

export type QuizQuestion = {
	number: number
	text: string
	answers: ReadonlyArray<string>
	explanation: string
	imagePath: string | null
	isSpecialStage: boolean
}

export type QuizBundle = {
	directory: string
	introAt: Date
	startAt: Date
	introNote: string | null
	outroNote: string | null
	questions: ReadonlyArray<QuizQuestion>
}

export type QuizScheduleConfig = {
	intro: Date
	start: Date
}

export type MessageKeyLike = {
	remoteJid?: string | null
	participant?: string | null
	id?: string | null
	fromMe?: boolean | null
}

export type IncomingGroupMessage = {
	groupId: string
	senderRawJid: string
	senderNumber: string | null
	text: string
	key: MessageKeyLike
}

export type QuizRunPayload = {
	groupId: string
	quizDir: string
	membersFile: string
	disableCooldown?: boolean
}
