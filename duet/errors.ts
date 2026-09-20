export class DuetError extends Error {
  constructor(public readonly code: string, message = code, options?: ErrorOptions) { super(message, options); this.name = code; }
}
export const daemonChanged = () => new DuetError("DaemonChanged", "The daemon changed. The operation was not retried; prior effects may remain.");
export const abortError = () => new DuetError("AbortError", "The request was aborted.");
export function errorInfo(error: unknown): { code: string; message: string } {
  return { code: error instanceof DuetError ? error.code : "OperationError", message: error instanceof Error ? error.message : String(error) };
}
