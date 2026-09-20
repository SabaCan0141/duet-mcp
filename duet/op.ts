import type { AppDef, Action, ActionBuilder, ActionMap } from "./types.js";
export function mergeActions<T extends ActionMap[]>(...maps: T): UnionToIntersection<T[number]> {
  const out: ActionMap = Object.create(null);
  for (const map of maps) for (const [name, op] of Object.entries(map)) {
    if (Object.hasOwn(out, name)) throw new Error(`duplicate action: ${name}`);
    if (name === "then") throw new Error("reserved name: then");
    out[name] = op;
  }
  return out as UnionToIntersection<T[number]>;
}
type UnionToIntersection<U> = (U extends unknown ? (x: U) => void : never) extends (x: infer I) => void ? I : never;
export function createAction<D extends object>(): ActionBuilder<D> {
  return ((value: unknown) => value) as ActionBuilder<D>;
}

export function defineApp<D extends object, O extends ActionMap>(definition: {
  id: string; version: string; port?: number; rootDir?: string; webDist?: string;
  initialDoc: () => D | Promise<D>;
  actions: O & Record<string, Action<NoInfer<D>>> & { [K in Extract<keyof O, keyof NoInfer<D> | "then">]: never };
  setup?: AppDef<NoInfer<D>>["setup"];
}): AppDef<D, O> {
  return { ...definition, actions: mergeActions(definition.actions) as O };
}
