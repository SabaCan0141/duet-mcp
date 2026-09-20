export function portFor(appId: string, port?: number): number {
  const raw = typeof process === "undefined" ? undefined : process.env?.DUET_PORT;
  const selected = port ?? (raw ? Number(raw) : undefined);
  if (selected !== undefined) {
    if (!Number.isInteger(selected) || selected < 1 || selected > 65535) throw new Error("port must be an integer from 1 to 65535");
    return selected;
  }
  let h = 2166136261;
  for (let i = 0; i < appId.length; i++) { h ^= appId.charCodeAt(i); h = Math.imul(h, 16777619); }
  return 8000 + ((h >>> 0) % 1000);
}
export const baseUrlFor = (id: string, port?: number): string => `http://127.0.0.1:${portFor(id, port)}`;
