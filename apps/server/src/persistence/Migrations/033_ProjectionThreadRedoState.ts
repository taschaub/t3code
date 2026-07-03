import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

/**
 * Adds redo_json to projection_threads.
 *
 * Stores the serialized OrchestrationThreadRedoState stash captured when a
 * thread is reverted, so redo survives server restarts. NULL means there is
 * nothing to redo.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  if (!columns.some((column) => column.name === "redo_json")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN redo_json TEXT
    `;
  }
});
