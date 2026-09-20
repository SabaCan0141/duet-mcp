import { ClientStore } from "./client-store.js";
import type { AppDef, ClientDoc } from "./types.js";
import type { ConnectionOptions } from "./transport.js";
export function createClient<A extends AppDef>(options: ConnectionOptions) {
  const store = new ClientStore(options);
  return { getDoc: (): Promise<ClientDoc<A>> => store.getDoc(), getObserverID: store.getObserverID, disposeObserver: store.disposeObserver };
}
