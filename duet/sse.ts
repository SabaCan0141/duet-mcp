/** Consume SSE without EventSource so Node and browsers share cancellation and validation. */
export async function consumeEvents(response: Response, onData: (value: any) => void, signal?: AbortSignal, onActivity?: () => void): Promise<void> {
  if (!response.ok || !response.body) throw new Error(`event stream: HTTP ${response.status}`);
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    while (!signal?.aborted) {
      const part = await reader.read(); if (part.done) break;
      onActivity?.(); buffer += decoder.decode(part.value, { stream: true }).replace(/\r/g, "");
      let end: number;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const data = block.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
        if (data) onData(JSON.parse(data));
      }
    }
  } finally { signal?.removeEventListener("abort", abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
/** Keep at most one queued event plus the latest pending snapshot per connection. */
export function eventResponse(subscribe: (wake: () => void) => () => void, snapshot: () => unknown, signal: AbortSignal): Response {
  const encoder = new TextEncoder(); let dirty = true, heartbeat = false, closed = false;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let unsubscribe = () => {}; let timer: ReturnType<typeof setInterval>;
  const flush = () => {
    if (closed || !controller || (controller.desiredSize ?? 0) <= 0) return;
    try {
      if (dirty) { dirty = false; controller.enqueue(encoder.encode(`data: ${JSON.stringify(snapshot())}\n\n`)); }
      else if (heartbeat) { heartbeat = false; controller.enqueue(encoder.encode(": heartbeat\n\n")); }
    } catch { close(); }
  };
  const close = () => {
    if (closed) return; closed = true; unsubscribe(); clearInterval(timer); signal.removeEventListener("abort", close);
    try { controller.close(); } catch { /* already cancelled */ }
  };
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c; unsubscribe = subscribe(() => { dirty = true; flush(); });
      timer = setInterval(() => { heartbeat = true; flush(); }, 1000);
      signal.addEventListener("abort", close, { once: true });
      if (signal.aborted) close(); else flush();
    }, pull() { flush(); }, cancel() { close(); },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no" } });
}
