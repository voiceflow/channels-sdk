// Where a relay keeps its connections: one record each, with everything
// secret sealed (`seal.ts`) and the management token kept only as a hash. A
// record holds what routing needs in the clear (its project, environment and
// channels), and nothing a person could sign in or post with.
//
// Every change raises `revision`, and a write names the revision it read: two
// writers can't both win, and an instance that cached a connection's bot
// knows from the revision that it changed.
import type { Sealed } from './seal.js';

export interface ConnectionRecord {
  id: string;
  /** The Voiceflow project the connection's key was checked against when it was made. It never changes. */
  projectID: string;
  /** The project's workspace, as Voiceflow reported it. */
  workspaceID: string;
  /** The environment alias or ID the agent's turns run in. */
  environment: string;
  /** The channel slugs it answers on. */
  channels: string[];
  /** Turned off by the relay's operator: it answers nothing, and keeps its record. */
  disabled: boolean;
  /** SHA-256 of the management token, hex. The token itself is shown once, and kept nowhere. */
  tokenHash: string;
  /** The Voiceflow API key, the connection's pass key and each channel's credentials. */
  sealed: Sealed;
  /** Raised by one with every change. */
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectionStore {
  get(id: string): Promise<ConnectionRecord | null>;
  /** Adds a record. Throws when its ID is taken. */
  create(record: ConnectionRecord): Promise<void>;
  /** Replaces a record whole, if it is still at `revision`. `false` when it isn't, or is gone. */
  update(record: ConnectionRecord, revision: number): Promise<boolean>;
  delete(id: string): Promise<void>;
  /** Every record, in ID order. */
  list(): AsyncIterable<ConnectionRecord>;
}

/** A store in this process's memory: for tests and for trying the relay out. Everything in it goes when the process stops. */
export function memoryConnectionStore(): ConnectionStore & { records: Map<string, ConnectionRecord> } {
  const records = new Map<string, ConnectionRecord>();
  return {
    records,
    async get(id) {
      const record = records.get(id);
      return record ? structuredClone(record) : null;
    },
    async create(record) {
      if (records.has(record.id)) throw new Error(`Connection ${record.id} exists.`);
      records.set(record.id, structuredClone(record));
    },
    async update(record, revision) {
      if (records.get(record.id)?.revision !== revision) return false;
      records.set(record.id, structuredClone(record));
      return true;
    },
    async delete(id) {
      records.delete(id);
    },
    async *list() {
      for (const id of [...records.keys()].sort()) {
        const record = records.get(id);
        if (record) yield structuredClone(record);
      }
    },
  };
}
