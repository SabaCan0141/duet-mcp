import { defineApp, createAction, mergeActions } from "../duet/index.js";
import { awaitChange, observerOps } from "../duet/assets.js";
import type { ClientDoc } from "../duet/types.js";
import { z } from "zod";
type Doc = { text: string; count: number; mode: "a" | "b" };
const action = createAction<Doc>();
const more = { reset: action({ description: "reset", handler: ({ doc }) => { doc.update(s => { s.count = 0; }); } }) };
const app = defineApp({ id: "types", version: "1", initialDoc: async (): Promise<Doc> => ({text: "", count: 0, mode: "a"}),
  actions: {
    ...more,
    set_text: action({ description: "set", input: z.string(), handler: ({doc}, text) => {
      doc.update(s => { s.text = text; });
      // @ts-expect-error async update is forbidden
      doc.update(async s => { s.text = text; });
      // @ts-expect-error doc uses the type supplied to createAction
      doc.update(s => { s.text = 1; });
      // @ts-expect-error unknown state fields are forbidden
      doc.update(s => { s.missing = true; });
      return { length: text.length };
    } }),
    size: action({description: "size", input: z.string().transform(s => s.length), handler: async (_ctx, length) => length + 1}),
    read: action({description: "read", handler: ({doc}) => doc.get().text}),
    await_change: awaitChange(),
    ...observerOps(),
  },
});
function types(doc: ClientDoc<typeof app>) {
  const a: Promise<{length: number}> = doc.set_text("hi");
  const b: Promise<number> = doc.size("123");
  const c: Promise<string> = doc.read();
  const d: Promise<void> = doc.reset();
  const e: Promise<string> = doc.get_observer_id();
  const f: Promise<{readonly text: string; readonly count: number; readonly mode: "a" | "b"}> = doc.await_change({oid: "id"});
  // @ts-expect-error scalar input
  doc.set_text({text: "hi"});
  // @ts-expect-error transform uses input type
  doc.size(12);
  // @ts-expect-error readonly snapshot
  doc.text = "bad";
  // @ts-expect-error unknown operation
  doc.missing();
  // @ts-expect-error state-derived result must not become any
  const wrongRead: Promise<number> = doc.read();
  // @ts-expect-error built-in action preserves the document result type
  const wrongWait: Promise<number> = doc.await_change({oid: "id"});
  void [a,b,c,d,e,f];
}
void types;

// @ts-expect-error state and operation names cannot collide
defineApp({id:"collision",version:"1",initialDoc:()=>({same:1}),actions: {same:createAction<{same:number}>()({description:"",handler:()=>{}})}});

function invalidDefinitions() {
  const incompatible = createAction<{text: number}>();
  // @ts-expect-error action document type must match initialDoc
  defineApp({id:"mismatch",version:"1",initialDoc:()=>({text:""}),actions:{set:incompatible({description:"",handler:({doc})=>doc.get().text})}});
  // @ts-expect-error built-in action names cannot collide with state fields
  defineApp({id:"asset-collision",version:"1",initialDoc:()=>({await_change:0}),actions:{await_change:awaitChange()}});
  // @ts-expect-error then is reserved for Promise interoperability
  defineApp({id:"reserved",version:"1",initialDoc:()=>({}),actions:{then:awaitChange()}});
  // @ts-expect-error the old separate assets field is no longer supported
  defineApp({id:"old-assets",version:"1",initialDoc:()=>({}),actions:{},assets:{await_change:awaitChange()}});
}
void invalidDefinitions;

const merged = defineApp({id:"merged",version:"1",initialDoc:():Doc=>({text:"",count:0,mode:"a"}),actions:mergeActions(more,{await_change:awaitChange()})});
function mergedTypes(doc: ClientDoc<typeof merged>) {
  const result: Promise<void> = doc.reset();
  const snapshot: Promise<Readonly<Doc>> = doc.await_change({oid:"id"});
  // @ts-expect-error merged actions retain their return types
  const wrong: Promise<number> = doc.reset();
  void [result,snapshot,wrong];
}
void mergedTypes;
