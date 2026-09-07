// Example for movable lists. Keep drafts in a Map outside the columns.
import { useEffect, useState, useSyncExternalStore } from "react";
import { refreshDoc, type Observed, useDoc } from "duet-mcp/react";
import { EditSession } from "duet-mcp/react";

type CardsDoc = { cards: { id: string; column: string; title: string }[] };
export function CardEditingExample() {
  const snap = useDoc<CardsDoc>();
  const [editors] = useState(() => new Map<string, EditSession<string>>());
  if (!snap) return null;
  // Keep deleted cards visible while editing so their drafts can be recovered.
  const ids = [...new Set([...snap.doc.cards.map(c => c.id), ...editors.keys()])];
  return <>{["todo", "done", "deleted"].map(column => <section key={column}>
    <h2>{column}</h2>
    {ids.filter(id => (snap.doc.cards.find(c => c.id === id)?.column ?? "deleted") === column).map(id => {
      let editor = editors.get(id);
      if (!editor) { editor = new EditSession<string>(); editors.set(id, editor); }
      return <CardEditor key={id} id={id} snap={snap} editor={editor} />;
    })}
  </section>)}</>;
}
function CardEditor({id,snap,editor}:{id:string;snap:Observed<CardsDoc>;editor:EditSession<string>}) {
  const state=useSyncExternalStore(editor.subscribe,editor.getSnapshot,editor.getSnapshot);
  const [confirmed, setConfirmed] = useState(false);
  useEffect(() => { setConfirmed(false); }, [state.error]);
  const card=snap.doc.cards.find(c=>c.id===id);
  const value=state.active ? state.value! : card?.title ?? "";
  const blocked=!!state.error || !!(state.result && "conflict" in state.result);
  return <div>
    <input aria-label={id} value={value} disabled={state.pending} onChange={e=>{
      if(!state.active)editor.begin(snap,card?.title??"");
      editor.setValue(e.target.value);
    }}/>
    <button disabled={!card || !state.active || state.pending || blocked}
      onClick={()=>{void editor.run("rename_card",{cardId:id,title:value}).catch(()=>{});}}>Save</button>
    <button disabled={!state.active || state.pending} onClick={editor.cancel}>Cancel</button>
    {!card && <span>This card was deleted. You can still copy your draft.</span>}
    {blocked && <section>
      <p>{state.error ?? "The document changed while you were editing."}</p>
      <p>Current: {card?.title ?? "(deleted)"} / Draft: {value}</p>
      <button onClick={() => { void refreshDoc().then(() => setConfirmed(true)); }}>Refresh current values</button>
      <button disabled={!card || state.pending || (!!state.error && !confirmed)} onClick={() => {
        editor.restart(snap, value);
        void editor.run("rename_card", { cardId: id, title: value }).catch(() => {});
      }}>Review and apply draft</button>
    </section>}
  </div>;
}
