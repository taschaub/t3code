import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Re-applies the upstream migrations whose ids the local redo migration
 * consumed while it was renumbered from 33 to 35 to 36.
 *
 * The migrator records applied migrations by id, so a database that ran the
 * redo migration as id 33 or 35 has those ids marked done and will never
 * execute upstream's 033_ProjectionThreadsSettled or
 * 035_ProjectionThreadTitleRegeneration. The server queries the columns from
 * both, so such a database fails every listThreads query ("no such column:
 * title_regeneration_request_id") and the backend exits before a window opens.
 *
 * Each check is idempotent, so databases that applied the upstream migrations
 * normally are left untouched.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  const hasColumn = (name: string) => columns.some((column) => column.name === name);

  if (!hasColumn("settled_override")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN settled_override TEXT
    `;
  }

  if (!hasColumn("settled_at")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN settled_at TEXT
    `;
  }

  if (!hasColumn("title_regeneration_request_id")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN title_regeneration_request_id TEXT
    `;
  }

  if (!hasColumn("title_regeneration_started_at")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN title_regeneration_started_at TEXT
    `;
  }
});
