import { useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore } from "react";
import { ClientStore, type Observed } from "./client-store.js";
import { EditSession } from "./edit.js";
export type { Observed } from "./client-store.js";
export type { Snapshot, RunResult, Revision, Change } from "./protocol.js";

const store = new ClientStore();
export const refreshDoc = store.refresh;
export function touch(): void { void fetch("/api/touch", { method: "POST" }).catch(() => {}); }
export const blobUrl = (id: string): string => `/blob/${id}`;
export async function uploadBlob(file: Blob): Promise<{ id: string; mime: string; size: number }> {
  const res = await fetch("/api/blob", {
    method: "POST", headers: { "content-type": file.type || "application/octet-stream" }, body: file,
  });
  if (!res.ok) throw new Error(`uploadBlob: HTTP ${res.status}`);
  return res.json();
}

// useDoc が複数でも活動リスナは一組だけ。
let activityUsers = 0;
let lastTouch = 0;
const onActivity = () => {
  if (Date.now() - lastTouch < 1000) return;
  lastTouch = Date.now();
  touch();
};
export function useDoc<Doc>(): Observed<Doc> | null {
  const raw = useSyncExternalStore(store.subscribe, store.getSnapshot, () => null) as Observed<Doc> | null;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    if (activityUsers++ === 0) {
      window.addEventListener("pointerdown", onActivity, { capture: true, passive: true });
      window.addEventListener("keydown", onActivity, { capture: true, passive: true });
    }
    return () => {
      clearInterval(timer);
      if (--activityUsers === 0) {
        window.removeEventListener("pointerdown", onActivity, true);
        window.removeEventListener("keydown", onActivity, true);
      }
    };
  }, []);
  // 受信時ではなく、この snapshot を描いた DOM の commit 後に進める。
  useLayoutEffect(() => {
    if (raw) document.documentElement.dataset.duetRevision = raw.revision;
  }, [raw]);
  return useMemo(() => raw && ({
    ...raw,
    activity: Object.fromEntries(Object.entries(raw.activity).map(([who, ms]) =>
      [who, ms + Math.max(0, now - store.receivedAt)])),
  }), [raw, now]);
}

export function useEdit<Value>() {
  const [session] = useState(() => new EditSession<Value>());
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  return { ...state, begin: session.begin, restart: session.restart, setValue: session.setValue,
    cancel: session.cancel, run: session.run };
}

export { EditSession } from "./edit.js";
