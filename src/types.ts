export type NMember = {
	mid: string
	kananame: string
	nickname: string
	classgroup: string
	lid: string
	pn?: string
}

export type QuizQuestion = {
	number: number
	text: string
	answers: ReadonlyArray<string>
	kanjiAnswers?: ReadonlyArray<string>
	extraPts?: number
	answerExtraPts?: ReadonlyMap<string, number>
	extraHint?: string
	explanation: string
	imagePath: string | null
	isSpecialStage: boolean
}

export type QuizRound = {
	emoji: string
	startAt: Date
	questions: ReadonlyArray<QuizQuestion>
}

export type QuizMessageTemplates = {
	introHeader: string
	introRoundLine: string
	godStageAnnouncement: string
	nextRoundNotice: string
	questionFooter: string
	cooldownWarning: string
	questionCooldown: string
	questionWarning: string
	timeout: string
	winner: string
	winnerPerfect: string
	romajiTease: string
	explanation: string
	explanationSpecial: string
	breakHeader: string
	finalHeader: string
	finalRow: string
	finalEmpty: string
	finalFooterDefault: string
	intro?: string
	outro?: string
}

export type QuizBundle = {
	directory: string
	sources?: ReadonlyArray<string>
	introAt: Date
	startAt: Date
	rounds: ReadonlyArray<QuizRound>
	introNote: string | null
	outroNote: string | null
	messageTemplates: Partial<QuizMessageTemplates>
	questions: ReadonlyArray<QuizQuestion>
	groupId?: string | null
	members?: ReadonlyArray<NMember> | null
	membersFile?: string | null
	season?: SeasonConfig | null
}

export type ConfigQuestionImage = {
	credit: string
	jp: string
	romaji: string
	god?: boolean
}

export type ConfigAnswerEntry = string | string[] | { text: string | string[]; extraPts?: number }

export type ConfigQuestionAnswers = {
	kana?: ConfigAnswerEntry
	romaji?: ConfigAnswerEntry
	kanji?: ConfigAnswerEntry
}

export type ConfigQuestion = {
	no: number
	hint: string
	answers: ConfigQuestionAnswers
	extraHint?: string
	explanation?: string
	image?: ConfigQuestionImage
}

export type QuizImageTemplateConfig = {
	default?: string
	god?: string
}

export type QuizScheduleConfig = {
	intro: Date | null
	start: Date | null
	rounds: ReadonlyArray<{
		emoji: string
		start: Date
		questionRange: readonly [number, number]
		godStage: number | null
	}>
	messages: Partial<QuizMessageTemplates>
	questions: ReadonlyArray<ConfigQuestion>
	groupId: string | null
	members: ReadonlyArray<NMember> | string | null
	imageTemplates: QuizImageTemplateConfig
	season?: SeasonConfig | null
}

export type QuizScheduleConfigInput = {
	intro?: Date | string | number
	start?: Date | string | number
	rounds?: ReadonlyArray<{
		emoji?: string
		start: Date | string | number
		questionRange: readonly [number, number]
		godStage?: number | null
	}>
	messages?: Partial<QuizMessageTemplates>
	questions?: ReadonlyArray<ConfigQuestion>
	groupId?: string
	members?: ReadonlyArray<NMember> | string
	imageTemplates?: QuizImageTemplateConfig
	templates?: QuizImageTemplateConfig
	template?: string
	templateGod?: string
	season?: SeasonConfig
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
	senderLid: string | null
	text: string
	key: MessageKeyLike
}

export type SeasonConfig = {
	start?: boolean
	end?: boolean
	caption?: string
	scoreboardTemplate?: string
}

export type QuizRunPayload = {
	sources: ReadonlyArray<string>
	quizDir?: string
	groupId?: string
	membersFile?: string
	noCooldown?: boolean
	noSchedule?: boolean
	noGeneration?: boolean
	saveSvg?: boolean
	season?: SeasonConfig
}
