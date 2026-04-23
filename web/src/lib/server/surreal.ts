import { Surreal } from 'surrealdb'

const {
	SURREAL_ENDPOINT = 'http://localhost:596/rpc',
	SURREAL_USERNAME = 'ua',
	SURREAL_PASSWORD = 'japan8',
	SURREAL_NAMESPACE = 'medrivia',
	SURREAL_DATABASE = 'nipbang_kotaete',
} = process.env

let db: Surreal | null = null
let connecting: Promise<Surreal> | null = null

export async function getDb(): Promise<Surreal> {
	if (db) return db
	if (connecting) return connecting

	connecting = (async () => {
		const instance = new Surreal()
		await instance.connect(SURREAL_ENDPOINT)
		await instance.signin({
			username: SURREAL_USERNAME,
			password: SURREAL_PASSWORD,
		})
		await instance.use({
			namespace: SURREAL_NAMESPACE,
			database: SURREAL_DATABASE,
		})
		db = instance
		return instance
	})()

	return connecting
}
