import type { Op } from "../duet/types.js";
const invalid: Op<{x:number}> = {
  name: "invalid", description: "", input: {},
  // @ts-expect-error async handlers are rejected by the public contract
  handler: async ({doc}) => { doc.x++; },
};
void invalid;
