import { useState } from "react";
import { refreshDoc, useEdit, type Observed } from "duet-mcp/react";
import type { Doc } from "../doc";

export function EditActions<T>({ edit, snap, name, args, current }: {
  edit: ReturnType<typeof useEdit<T>>; snap: Observed<Doc>; name: string;
  args: (value: T) => Record<string, unknown>; current: string;
}) {
  const [confirmedError, setConfirmedError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState("");
  const conflict = !!edit.result && "conflict" in edit.result;
  const rejected = edit.result && "rejected" in edit.result ? edit.result.rejected : null;
  const send = () => { setConfirmedError(null); void edit.run(name, args(edit.value!)).catch(() => {}); };
  return <div className="mt-4 space-y-3">
    <div className="flex items-center gap-2">
      <button className="primary" disabled={!edit.active || edit.pending || conflict || !!edit.error} onClick={send}>Apply</button>
      <button className="secondary" disabled={!edit.active || edit.pending} onClick={edit.cancel}>Cancel</button>
      <span className="text-xs text-slate-400" role="status">{edit.pending ? "Saving…" : edit.active ? "Unsaved changes" : "Saved"}</span>
    </div>
    {rejected && <p role="alert" className="text-xs text-rose-600">{rejected}</p>}
    {(conflict || edit.error) && <section className="space-y-3 rounded-xl bg-amber-50 p-3 text-xs" aria-label="Review changes">
      <p role="alert">{edit.error ?? "The document changed while you were editing. Review the current values and your draft."}</p>
      <p className="break-words">Current: {current}</p>
      <p className="break-words">Draft: {JSON.stringify(edit.value)}</p>
      <button className="secondary" onClick={() => { void refreshDoc().then(() => {setConfirmedError(edit.error);setRefreshError("");}).catch(e => setRefreshError(String(e))); }}>Refresh current values</button>
      {refreshError && <p role="alert">{refreshError}</p>}
      <button className="primary" disabled={edit.pending || (!!edit.error && confirmedError !== edit.error)} onClick={() => { edit.restart(snap, edit.value!); send(); }}>Review and apply draft</button>
    </section>}
  </div>;
}
