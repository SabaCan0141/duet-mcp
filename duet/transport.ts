/** 読み取りの再接続と、結果不明の書き込みを区別する。 */
export class Reached extends Error {}
export class OutcomeUnknown extends Error {
  constructor() { super("操作の適用結果が不明。自動再送していない。最新の doc を取得して確認すること。"); }
}
export async function requestWithRecovery<T>(
  request: () => Promise<T>, recover: () => Promise<void>, method = "GET",
): Promise<T> {
  try { return await request(); }
  catch (err) {
    if (err instanceof Reached) throw err;
    if (method.toUpperCase() !== "GET") {
      // 所有者の回復は試すが、元の操作を再実行しない。
      await recover().catch(() => {});
      throw new OutcomeUnknown();
    }
    await recover();
    return request();
  }
}
