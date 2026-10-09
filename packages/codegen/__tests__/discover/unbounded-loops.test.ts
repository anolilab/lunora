import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverUnboundedLoops from "../../src/discover/unbounded-loops";

/** An export whose handler never comes back from a bare `while (true)` loop. */
const LOOP_WHILE = `
import { mutation } from "@lunora/server";

export const drain = mutation({
    args: {},
    handler: async (ctx) => {
        while (true) {
            const row = await ctx.db.select("jobs").first();
            void row;
        }
    },
});
`;

/** An export whose handler spins in a condition-less `for (;;)` loop. */
const LOOP_FOR = `
import { query } from "@lunora/server";

export const poll = query({
    args: {},
    handler: async (ctx) => {
        for (;;) {
            await ctx.scheduler.runAfter(1000, poll);
        }
    },
});
`;

/** An export whose handler spins in a `for (; true;)` loop — the explicit head. */
const LOOP_FOR_TRUE = `
import { query } from "@lunora/server";

export const keepAlive = query({
    args: {},
    handler: async (ctx) => {
        for (; true;) {
            await ctx.scheduler.runAfter(1000, keepAlive);
        }
    },
});
`;

/** An export whose handler spins in a `do { … } while (true)` loop. */
const LOOP_DO = `
import { action } from "@lunora/server";

export const retry = action({
    args: {},
    handler: async (ctx) => {
        do {
            await ctx.scheduler.runAfter(1000, retry);
        } while (true);
    },
});
`;

/** A parenthesised `while ((true))` — unbounded, one layer of parens deeper. */
const LOOP_PARENS = `
import { action } from "@lunora/server";

export const pump = action({
    args: {},
    handler: async (ctx) => {
        while ((true)) {
            await ctx.scheduler.runAfter(1000, pump);
        }
    },
});
`;

/** A loop a `break` can leave — bounded, nothing to report. */
const LOOP_BREAK = `
import { action } from "@lunora/server";

export const watch = action({
    args: {},
    handler: async () => {
        let done = false;
        while (true) {
            if (done) {
                break;
            }
        }
    },
});
`;

/** A labeled `break` from a nested loop — `break outer` leaves both loops. */
const LOOP_LABELED = `
import { action } from "@lunora/server";

export const scan = action({
    args: {},
    handler: async () => {
        let found = false;
        outer: while (true) {
            for (;;) {
                if (found) {
                    break outer;
                }
            }
        }
    },
});
`;

/** A `return` that leaves the handler — and the loop with it. */
const LOOP_RETURN = `
import { action } from "@lunora/server";

export const bail = action({
    args: {},
    handler: async () => {
        while (true) {
            if (Date.now() > 1) {
                return;
            }
        }
    },
});
`;

/** A `throw` that leaves the handler — and the loop with it. */
const LOOP_THROW = `
import { action } from "@lunora/server";

export const fail = action({
    args: {},
    handler: async () => {
        while (true) {
            throw new Error("no");
        }
    },
});
`;

/** A `return` inside a nested callback leaves only the callback — the loop turns. */
const LOOP_CALLBACK_RETURN = `
import { action } from "@lunora/server";

export const tick = action({
    args: {},
    handler: async () => {
        const stop = () => {
            return;
        };
        while (true) {
            void stop;
        }
    },
});
`;

/** A condition that may become false — not a literal-infinite loop. */
const LOOP_COUNTED = `
import { mutation } from "@lunora/server";

export const drainOne = mutation({
    args: {},
    handler: async () => {
        let left = 10;
        while (left > 0) {
            left -= 1;
        }
    },
});
`;

/** A module-scope `while (true)` — the worker hangs at import time. */
const LOOP_MODULE = `
while (true) {
    const never = 1;
    void never;
}
`;

/** A loop inside a top-level helper — attributed to the helper, not a caller. */
const LOOP_HELPER = `
import { action } from "@lunora/server";

const pumpForever = () => {
    while (true) {
        void 1;
    }
};

export const start = action({
    args: {},
    handler: async () => {
        pumpForever();
    },
});
`;

let workdir: string;
let project: Project;

describe("discoverUnboundedLoops", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-loops-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
        project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("records a bare while loop inside an exported handler", () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "lunora", "jobs.ts"), LOOP_WHILE, "utf8");

        const rows = discoverUnboundedLoops(project, join(workdir, "lunora"));

        expect(rows).toStrictEqual([{ file: "jobs", kind: "while", line: 7, scope: { kind: "export", name: "drain" } }]);
    });

    it("records `for (;;)` and `for (; true;)` as for loops", () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "lunora", "poll.ts"), LOOP_FOR, "utf8");
        writeFileSync(join(workdir, "lunora", "keepalive.ts"), LOOP_FOR_TRUE, "utf8");

        const rows = discoverUnboundedLoops(project, join(workdir, "lunora"));

        expect(rows.map((row) => row.kind).toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["for", "for"]);
    });

    it("records a `do { … } while (true)` loop", () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "lunora", "retry.ts"), LOOP_DO, "utf8");

        const rows = discoverUnboundedLoops(project, join(workdir, "lunora"));

        expect(rows).toMatchObject([{ file: "retry", kind: "do", scope: { kind: "export", name: "retry" } }]);
    });

    it("unwraps parentheses around the condition", () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "lunora", "pump.ts"), LOOP_PARENS, "utf8");

        const rows = discoverUnboundedLoops(project, join(workdir, "lunora"));

        expect(rows).toHaveLength(1);
    });

    it("records a module-scope loop as module scope", () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "lunora", "hang.ts"), LOOP_MODULE, "utf8");

        const rows = discoverUnboundedLoops(project, join(workdir, "lunora"));

        expect(rows).toMatchObject([{ file: "hang", kind: "while", scope: { kind: "module" } }]);
    });

    it("attributes a loop in a top-level helper to the helper", () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "lunora", "pump.ts"), LOOP_HELPER, "utf8");

        const rows = discoverUnboundedLoops(project, join(workdir, "lunora"));

        expect(rows).toMatchObject([{ file: "pump", kind: "while", scope: { kind: "helper", name: "pumpForever" } }]);
    });

    it("records nothing when a break can leave the loop", () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "lunora", "watch.ts"), LOOP_BREAK, "utf8");
        writeFileSync(join(workdir, "lunora", "scan.ts"), LOOP_LABELED, "utf8");

        expect(discoverUnboundedLoops(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("records nothing when a return or throw leaves the handler", () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "lunora", "bail.ts"), LOOP_RETURN, "utf8");
        writeFileSync(join(workdir, "lunora", "fail.ts"), LOOP_THROW, "utf8");

        expect(discoverUnboundedLoops(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("records the loop when the only return hides in a nested callback", () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "lunora", "tick.ts"), LOOP_CALLBACK_RETURN, "utf8");

        const rows = discoverUnboundedLoops(project, join(workdir, "lunora"));

        expect(rows).toMatchObject([{ file: "tick", kind: "while", scope: { kind: "export", name: "tick" } }]);
    });

    it("records nothing for a condition that may become false", () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "lunora", "drain.ts"), LOOP_COUNTED, "utf8");

        expect(discoverUnboundedLoops(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("records nothing for a generator that yields from the loop", () => {
        expect.assertions(1);

        writeFileSync(
            join(workdir, "lunora", "ids.ts"),
            `
function* sequence() {
    let next = 0;

    while (true) {
        yield next++;
    }
}

export const first = () => sequence().next().value;
`,
            "utf8",
        );

        expect(discoverUnboundedLoops(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("records the loop when only a nested generator yields", () => {
        expect.assertions(1);

        writeFileSync(
            join(workdir, "lunora", "spin.ts"),
            `
export const spin = () => {
    while (true) {
        const inner = function* () {
            yield 1;
        };

        void inner;
    }
};
`,
            "utf8",
        );

        expect(discoverUnboundedLoops(project, join(workdir, "lunora"))).toMatchObject([{ file: "spin", kind: "while" }]);
    });
});
