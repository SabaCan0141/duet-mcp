import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * 画像などの実体を置く場所。id は不変で、内容は上書きされない。
 * doc には id だけを持たせ、GUI からは /blob/<id> で参照する。
 * ディスク上の追記のみなので、daemon 以外のプロセスからも読める。
 */
const EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "application/json": ".json",
  "application/zip": ".zip",
  "text/plain": ".txt",
};

const MIME: Record<string, string> = Object.fromEntries(
  Object.entries(EXT).map(([mime, ext]) => [ext, mime]),
);

export type BlobMeta = { id: string; mime: string; size: number };

export class BlobStore {
  private readonly dir: string;

  constructor(appId: string, dataDir: string) {
    this.dir = path.join(dataDir, `${appId}-blobs`);
  }

  private resolve(id: string): string | null {
    // id は自分で採番した uuid + 拡張子のみ。外から来た文字列を信用しない。
    if (!/^[0-9a-f-]{36}\.[a-z0-9+]{2,5}$/.test(id)) return null;
    const file = path.join(this.dir, id);
    return fs.existsSync(file) ? file : null;
  }

  put(bytes: Uint8Array, rawMime: string): BlobMeta {
    // "application/json; charset=utf-8" のような値がそのまま来る。
    // 正規化しないと put の mime と get の mime が食い違う。
    const mime = rawMime.split(";")[0]!.trim();
    fs.mkdirSync(this.dir, { recursive: true });
    const id = `${crypto.randomUUID()}${EXT[mime] ?? ".bin"}`;
    const file = path.join(this.dir, id);
    fs.writeFileSync(file, bytes);
    try { fs.writeFileSync(`${file}.meta.json`, JSON.stringify({ mime })); }
    catch (error) { fs.unlinkSync(file); throw error; }
    return { id, mime, size: bytes.byteLength };
  }

  get(id: string): { bytes: Buffer; mime: string } | null {
    const file = this.resolve(id);
    if (!file) return null;
    return {
      bytes: fs.readFileSync(file),
      mime: this.mime(file),
    };
  }

  private mime(file: string): string {
    const metadata = `${file}.meta.json`;
    if (fs.existsSync(metadata)) {
      const value = JSON.parse(fs.readFileSync(metadata, "utf8")) as { mime?: unknown };
      if (typeof value.mime !== "string") throw new Error(`Invalid blob metadata: ${path.basename(file)}`);
      return value.mime;
    }
    // Existing blobs without metadata retain their extension-based MIME type.
    return MIME[path.extname(file)] ?? "application/octet-stream";
  }

  list(): BlobMeta[] {
    if (!fs.existsSync(this.dir)) return [];
    return fs.readdirSync(this.dir).filter(id => /^[0-9a-f-]{36}\.[a-z0-9+]{2,5}$/.test(id)).map(id => ({
      id,
      mime: this.mime(path.join(this.dir, id)),
      size: fs.statSync(path.join(this.dir, id)).size,
    }));
  }
}
