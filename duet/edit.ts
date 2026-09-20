export type EditState<T> = { active: boolean; value: T | undefined; pending: boolean; error: string | null };
export class EditSession<T> {
  private state: EditState<T> = { active: false, value: undefined, pending: false, error: null };
  private listeners = new Set<() => void>();
  getSnapshot = (): EditState<T> => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private emit(patch: Partial<EditState<T>>): void { this.state = {...this.state, ...patch}; for (const listener of this.listeners) listener(); }
  private editable(): void { if (this.state.pending) throw new Error("An edit is being submitted"); }
  begin = (value: T): void => { this.editable(); this.emit({ active: true, value: structuredClone(value), error: null }); };
  setValue = (value: T): void => { this.editable(); this.emit({active: true, value, error: null}); };
  cancel = (): void => { this.editable(); this.emit({active: false, value: undefined, error: null}); };
  submit = async <R>(callback: (value: T) => R | Promise<R>): Promise<R> => {
    this.editable();
    if (!this.state.active) throw new Error("No active edit to submit");
    // begin/setValue establish the value synchronously, even before React renders.
    const value = this.state.value as T;
    this.emit({pending: true, error: null});
    try { const result = await callback(value); this.emit({active: false, value: undefined}); return result; }
    catch (error) { this.emit({error: error instanceof Error ? error.message : String(error)}); throw error; }
    finally { this.emit({pending: false}); }
  };
}
