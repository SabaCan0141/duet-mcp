import { useLayoutEffect, useState, useSyncExternalStore } from "react";
import { ClientStore } from "./client-store.js";
import { EditSession } from "./edit.js";
import type { AppDef, ClientDoc } from "./types.js";
import type { ConnectionOptions } from "./transport.js";
export function createClient<A extends AppDef>(options: ConnectionOptions = {}) {
  const store = new ClientStore(options);
  function useDoc(): ClientDoc<A> | null {
    const doc = useSyncExternalStore(store.subscribe, store.getSnapshot, () => null) as ClientDoc<A> | null;
    const meta = store.getMeta();
    useLayoutEffect(() => {
      if (meta) { document.documentElement.dataset.duetOwner = meta.ownerId; document.documentElement.dataset.duetSeq = String(meta.seq); document.documentElement.dataset.duetRevision = meta.revision; }
    }, [meta]);
    return doc;
  }
  return { useDoc, getDoc: (): Promise<ClientDoc<A>> => store.getDoc(), getObserverID: store.getObserverID, disposeObserver: store.disposeObserver };
}
export function useEdit<T>() {
  const [session] = useState(() => new EditSession<T>());
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  return { ...state, begin: session.begin, setValue: session.setValue, cancel: session.cancel, submit: session.submit };
}
export { EditSession } from "./edit.js";
export type { ClientDoc } from "./types.js";
