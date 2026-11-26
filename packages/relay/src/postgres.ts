// Connections in Postgres: one row each, in a table of the relay's own. The
// store takes any client with `pg`'s `query(text, values)`: a `pg` Pool, or
// PGlite in tests. Table names are unqualified, as Chat SDK's Postgres state
// adapter's are: give the relay's database role a default `search_path` to
// keep its tables in a schema of their own (Supabase's transaction pooler
// drops a search_path set per connection, and keeps a role's).
//
// JSON goes in as text, cast to jsonb, so every driver sends it the same way.
import type { ConnectionRecord, ConnectionStore } from './store.js';

/** As much of a Postgres client as the store uses: `pg`'s Pool and Client have it, and so does PGlite. */
export interface SqlClient {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

export const CONNECTIONS_TABLE = 'channels_relay_connections';

/** The store's tables, as statements to run in order from your migrations, as the role that owns the schema. */
export const connectionStoreStatements: readonly string[] = [
  `create table if not exists ${CONNECTIONS_TABLE} (
    id text primary key,
    project_id text not null,
    workspace_id text not null,
    environment text not null,
    channels jsonb not null,
    disabled boolean not null default false,
    token_hash text not null,
    sealed jsonb not null,
    revision integer not null,
    created_at timestamptz not null,
    updated_at timestamptz not null
  )`,
  `create index if not exists ${CONNECTIONS_TABLE}_workspace on ${CONNECTIONS_TABLE} (workspace_id)`,
];

const COLUMNS = 'id, project_id, workspace_id, environment, channels, disabled, token_hash, sealed, revision, created_at, updated_at';
const PAGE = 500;

const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString());
const json = (value: unknown) => (typeof value === 'string' ? JSON.parse(value) : value);

function fromRow(row: Record<string, unknown>): ConnectionRecord {
  return {
    id: String(row.id),
    projectID: String(row.project_id),
    workspaceID: String(row.workspace_id),
    environment: String(row.environment),
    channels: json(row.channels) as string[],
    disabled: row.disabled === true,
    tokenHash: String(row.token_hash),
    sealed: json(row.sealed) as ConnectionRecord['sealed'],
    revision: Number(row.revision),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

const values = (r: ConnectionRecord) => [
  r.id,
  r.projectID,
  r.workspaceID,
  r.environment,
  JSON.stringify(r.channels),
  r.disabled,
  r.tokenHash,
  JSON.stringify(r.sealed),
  r.revision,
  r.createdAt,
  r.updatedAt,
];

/** Connections in Postgres. Run `connectionStoreStatements` first: the store never creates or changes a table. */
export function postgresConnectionStore(client: SqlClient): ConnectionStore {
  return {
    async get(id) {
      const { rows } = await client.query(`select ${COLUMNS} from ${CONNECTIONS_TABLE} where id = $1`, [id]);
      return rows[0] ? fromRow(rows[0]) : null;
    },
    async create(record) {
      await client.query(
        `insert into ${CONNECTIONS_TABLE} (${COLUMNS}) values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::jsonb, $9, $10::timestamptz, $11::timestamptz)`,
        values(record),
      );
    },
    async update(record, revision) {
      const { rows } = await client.query(
        `update ${CONNECTIONS_TABLE} set project_id = $2, workspace_id = $3, environment = $4, channels = $5::jsonb, disabled = $6,
           token_hash = $7, sealed = $8::jsonb, revision = $9, created_at = $10::timestamptz, updated_at = $11::timestamptz
         where id = $1 and revision = $12 returning id`,
        [...values(record), revision],
      );
      return rows.length === 1;
    },
    async delete(id) {
      await client.query(`delete from ${CONNECTIONS_TABLE} where id = $1`, [id]);
    },
    async *list() {
      let after = '';
      for (;;) {
        const { rows } = await client.query(`select ${COLUMNS} from ${CONNECTIONS_TABLE} where id > $1 order by id limit ${PAGE}`, [after]);
        for (const row of rows) yield fromRow(row);
        if (rows.length < PAGE) return;
        after = String(rows[rows.length - 1].id);
      }
    },
  };
}
