import type { Checkpoint } from "./protocol.js";
import type { HistoryEntry } from "./state.js";
import { DuetError } from "./errors.js";
export type ReplicaDelta = Omit<Checkpoint, "doc" | "revision" | "history"> & {
  revisions: string[]; head: number; entries: HistoryEntry[];
};
/** Called only when SSE actually enqueues a message, so coalescing cannot lose entries. */
export function replicaSender(checkpoint: () => Checkpoint): () => Checkpoint | ReplicaDelta {
  let previous: Set<string> | undefined;
  return () => {
    const cp = checkpoint();
    const revisions = cp.history.entries.map(entry => entry.revision);
    const before = previous;
    previous = new Set(revisions);
    if (!before) return cp;
    const { doc, revision, history, ...meta } = cp;
    return { ...meta, revisions, head: history.head, entries: history.entries.filter(entry => !before.has(entry.revision)) };
  };
}
export function restoreReplica(value: any, previous?: Checkpoint): Checkpoint {
  if (value?.history) return value;
  const invalid = () => { throw new DuetError("InvalidCheckpoint"); };
  if (!previous || !value || value.ownerId !== previous.ownerId || !Array.isArray(value.revisions) || !Array.isArray(value.entries)) return invalid();
  const entries = new Map(previous.history.entries.map(entry => [entry.revision, entry]));
  const added = new Set<string>();
  for (const entry of value.entries) {
    if (!entry || typeof entry.revision !== "string" || added.has(entry.revision) || !value.revisions.includes(entry.revision)) return invalid();
    added.add(entry.revision); entries.set(entry.revision, entry);
  }
  const ordered = value.revisions.map((revision: string) => entries.get(revision) ?? invalid());
  const head = ordered[value.head];
  if (!head) return invalid();
  const { revisions, entries: newEntries, head: headIndex, ...meta } = value;
  return { ...meta, doc: head.doc, revision: head.revision, history: { entries: ordered, head: headIndex } };
}
