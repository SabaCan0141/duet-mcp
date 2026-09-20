export const PROTOCOL = 7;
export type Snapshot<D = any> = { ownerId: string; revision: string; seq: number; doc: D };
export type Checkpoint<D = any> = Snapshot<D> & {
  protocol: number; appId: string; appVersion: string; checkpointSeq: number;
  observers: Array<{ id: string; revision: string | null }>;
};
export type Hello = { id: string; version: string; protocol: number; ownerId: string; ready: boolean; url: string };
export type Envelope<T> = { ok: true; result?: T; ownerId: string } | { ok: false; error: { code: string; message: string }; ownerId?: string };
