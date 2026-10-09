/**
 * Real `wrangler deploy --dry-run --outdir out` output (wrangler 4.147) for a
 * Worker whose Durable Object alarm always re-arms (`src/index.ts:7`) and which
 * imports a dependency with an exitless loop (`node_modules/dep/index.js`).
 * Shared by the scan's attribution tests and the build box's wiring test.
 */

/**
 * `//# sourceMappingURL=`, assembled: written literally at the start of a line
 * in this file, Vite would try to load the map it names for the test itself.
 */
export const MAP_COMMENT = ["//", "# sourceMappingURL="].join("");

/** `wrangler deploy --dry-run --outdir out` for `src/index.ts` + `node_modules/dep/index.js`, verbatim. */
export const WRANGLER_BUNDLE = `var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.ts
import { DurableObject } from "cloudflare:workers";

// node_modules/dep/index.js
function spin() {
  while (true) {
    globalThis.x = 1;
  }
}
__name(spin, "spin");

// src/index.ts
var Counter = class extends DurableObject {
  static {
    __name(this, "Counter");
  }
  async alarm() {
    await this.ctx.storage.put("n", 1);
    await this.ctx.storage.setAlarm(Date.now() + 1e3);
  }
};
var index_default = {
  async fetch() {
    spin();
    return new Response("ok");
  }
};
export {
  Counter,
  index_default as default
};
${MAP_COMMENT}index.js.map
`;

/** Its sourcemap, verbatim — including the `sourceRoot: "out"` that must be ignored. */
export const WRANGLER_MAP = {
    mappings:
        ";;;;AAAA,SAAS,qBAAqB;;;ACAvB,SAAS,OAAO;AACnB,SAAO,MAAM;AACT,eAAW,IAAI;AAAA,EACnB;AACJ;AAJgB;;;ADGT,IAAM,UAAN,cAAsB,cAAc;AAAA,EAH3C,OAG2C;AAAA;AAAA;AAAA,EACvC,MAAM,QAAQ;AACV,UAAM,KAAK,IAAI,QAAQ,IAAI,KAAK,CAAC;AACjC,UAAM,KAAK,IAAI,QAAQ,SAAS,KAAK,IAAI,IAAI,GAAI;AAAA,EACrD;AACJ;AAEA,IAAO,gBAAQ;AAAA,EACX,MAAM,QAAQ;AACV,SAAK;AACL,WAAO,IAAI,SAAS,IAAI;AAAA,EAC5B;AACJ;",
    names: [],
    sourceRoot: "out",
    sources: ["../src/index.ts", "../node_modules/dep/index.js"],
    version: 3,
};
