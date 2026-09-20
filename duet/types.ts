import type { z } from "zod";
import type { ObserverStore } from "./observers.js";
export type { Json } from "./json.js";
export type ReadonlyDeep<T> = T extends object ? { readonly [K in keyof T]: ReadonlyDeep<T[K]> } : T;
export type DocAccess<D> = {
  get(): ReadonlyDeep<D>;
  update<R>(change: (draft: D) => R & (R extends PromiseLike<unknown> ? never : unknown)): void;
};
export type Context<D> = {
  doc: DocAccess<D>; observers: Pick<ObserverStore, "getObserverID" | "dispose" | "observe" | "isCurrent" | "waitChange">; signal: AbortSignal; actor: string;
  url: string; snapshot(): import("./protocol.js").Snapshot<D>;
};
export type Action<D = any, S extends z.ZodTypeAny | undefined = any, R = any> = {
  description: string; input?: S;
  handler: (ctx: Context<D>, input: S extends z.ZodTypeAny ? z.output<S> : undefined) => R;
  /** Optional MCP presentation adapter, used by media assets. */
  content?: (result: Awaited<R>) => any[];
};
export type ActionBuilder<D> = {
  <S extends z.ZodTypeAny, R>(action: { description: string; input: S; handler: (ctx: Context<D>, input: z.output<S>) => R }): Action<D, S, R>;
  <R>(action: { description: string; input?: undefined; handler: (ctx: Context<D>) => R }): Action<D, undefined, R>;
};
export type ActionMap = Record<string, Action>;
export type AppDef<D = any, O extends ActionMap = ActionMap> = {
  id: string; version: string; port?: number; rootDir?: string; webDist?: string;
  initialDoc: () => D | Promise<D>; actions: O;
  setup?: (ctx: Context<D>) => void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>;
};
export type AppDoc<A> = A extends AppDef<infer D, any> ? D : never;
export type Methods<O, D> = { [K in keyof O]: O[K] extends { readonly returnsDoc: true }
  ? (input: { oid: string; timeoutMs?: number }) => Promise<ReadonlyDeep<D>>
  : O[K] extends Action<any, infer S, infer R>
    ? S extends z.ZodTypeAny ? (input: z.input<S>) => Promise<Awaited<R>> : () => Promise<Awaited<R>>
    : never };
export type ClientDoc<A extends AppDef> = ReadonlyDeep<AppDoc<A>> & Methods<A["actions"], AppDoc<A>>;
