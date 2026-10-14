import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// The jurisdiction union ("eu" | "fedramp" | "us") is declared independently in
// several packages on purpose — the mail, container, scheduler and server
// packages stay structurally decoupled from runtime rather than taking a
// dependency on it just for a three-member string union. (Within container the
// union lives in a single shared `jurisdiction.ts` that client + report-lifecycle
// both import, so only that one file is checked here.) The cost of that
// decoupling is silent drift: if Cloudflare adds a jurisdiction and one copy is
// updated but not the rest, the type would diverge with no compile error.
//
// This test pins every copy to the same literal so a divergence fails loudly.
// Runtime's exported definition is the canonical source of truth.
const CANONICAL = '"eu" | "fedramp" | "us"';

// Each copy, relative to this test file (packages/runtime/__tests__/).
const DECLARATIONS: { file: string; relative: string }[] = [
    { file: "runtime", relative: "../src/resolve-shard.ts" },
    { file: "scheduler", relative: "../../scheduler/src/types.ts" },
    { file: "server", relative: "../../server/src/types.ts" },
    { file: "mail", relative: "../../mail/src/inbound/shard.ts" },
    { file: "container", relative: "../../container/src/jurisdiction.ts" },
];

const extractUnion = (source: string): string | undefined => {
    const match = /type DurableObjectJurisdiction = ([^;]+);/u.exec(source);

    return match?.[1]?.trim();
};

describe("durableObjectJurisdiction union consistency", () => {
    it.each(DECLARATIONS)("$file declares the canonical union", ({ relative }) => {
        expect.assertions(1);

        const source = readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

        expect(extractUnion(source)).toBe(CANONICAL);
    });
});
