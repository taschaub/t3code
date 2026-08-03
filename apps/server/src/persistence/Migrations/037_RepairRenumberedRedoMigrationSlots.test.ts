import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

// Each case needs its own database: the migration ledger is the thing under
// test, so a client shared across cases would carry migration 37 over.
const withDatabase = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(NodeSqliteClient.layerMemory()));

const projectionThreadColumns = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  return new Set(columns.map((column) => column.name));
});

describe("037_RepairRenumberedRedoMigrationSlots", () => {
  it.effect("adds the columns of the upstream migrations the redo slots shadowed", () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        // Reproduce a database from the branch's earlier numbering: the redo
        // migration ran as ids 33 and 35, so upstream's 033 and 035 are
        // recorded as applied without their columns ever being added.
        yield* runMigrations({ toMigrationInclusive: 32 });
        yield* sql`
          ALTER TABLE projection_threads
          ADD COLUMN redo_json TEXT
        `;
        const appliedAt = yield* DateTime.now;
        const appliedAtIso = DateTime.formatIso(appliedAt);
        yield* sql`
          INSERT INTO effect_sql_migrations (migration_id, name, created_at)
          VALUES (33, 'ProjectionThreadRedoState', ${appliedAtIso}),
                 (35, 'ProjectionThreadRedoState', ${appliedAtIso})
        `;

        const columnsBefore = yield* projectionThreadColumns;
        assert.isFalse(columnsBefore.has("title_regeneration_request_id"));

        yield* runMigrations();

        const columns = yield* projectionThreadColumns;
        assert.ok(columns.has("settled_override"));
        assert.ok(columns.has("settled_at"));
        assert.ok(columns.has("title_regeneration_request_id"));
        assert.ok(columns.has("title_regeneration_started_at"));
      }),
    ),
  );

  it.effect("leaves a database that applied the upstream migrations untouched", () =>
    withDatabase(
      Effect.gen(function* () {
        yield* runMigrations({ toMigrationInclusive: 36 });
        const columnsBefore = yield* projectionThreadColumns;

        const executed = yield* runMigrations();

        assert.deepEqual(
          executed.map(([id]) => id),
          [37],
        );
        assert.deepEqual(yield* projectionThreadColumns, columnsBefore);
      }),
    ),
  );
});
