// The slice of the Workers types the brain's import code uses, for tests that run it on Node (node:sqlite).
declare interface SqlStorageCursor {
	toArray(): Record<string, unknown>[];
	one(): Record<string, unknown>;
}
declare interface SqlStorage {
	exec(query: string, ...bindings: unknown[]): SqlStorageCursor;
}
declare interface DurableObjectStorage {
	readonly sql: SqlStorage;
	transactionSync<T>(fn: () => T): T;
}
