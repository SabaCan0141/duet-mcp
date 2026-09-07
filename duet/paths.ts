import path from "node:path";
import type { AppDef } from "./types.js";

/** パッケージの設置場所ではなく、アプリが指定したルートを使う。 */
export function rootFor(app: Pick<AppDef<unknown>, "rootDir">): string {
  if (app.rootDir !== undefined && !path.isAbsolute(app.rootDir)) {
    throw new Error("rootDir は絶対パスで指定してください。");
  }
  return app.rootDir ?? process.cwd();
}
export const dataDirFor = (app: Pick<AppDef<unknown>, "rootDir">): string => path.join(rootFor(app), "data");
