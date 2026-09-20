import { useEdit } from "duet-mcp/react";
export function EditActions<T>({edit, submit, current}: {edit: ReturnType<typeof useEdit<T>>; submit: (value: T) => Promise<unknown>; current: string}) {
  return <div className="mt-4 space-y-3">
    <div className="flex items-center gap-2">
      <button className="primary" disabled={!edit.active || edit.pending} onClick={()=>{void edit.submit(submit).catch(()=>{});}}>Apply</button>
      <button className="secondary" disabled={!edit.active || edit.pending} onClick={edit.cancel}>Cancel</button>
      <span className="text-xs text-slate-400" role="status">{edit.pending ? "Saving…" : edit.active ? "Unsaved changes" : "Saved"}</span>
    </div>
    {edit.error && <section className="space-y-3 rounded-xl bg-amber-50 p-3 text-xs"><p role="alert">{edit.error}</p><p>Current: {current}</p><p>Draft: {JSON.stringify(edit.value)}</p></section>}
  </div>;
}
