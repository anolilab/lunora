import { defineSchema, defineTable } from "@lunora/server";
import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import type { AdvisorNotifyCall } from "../src";
import { fromServerSchema } from "../src";
import notifySendOutsideAction from "../src/lints/static/notify-send-outside-action";

const schema = () =>
    fromServerSchema(
        defineSchema({
            devices: defineTable({ token: v.string() }),
        }),
    );

const run = (notifyCalls?: AdvisorNotifyCall[]) => notifySendOutsideAction.run({ notifyCalls, schema: schema() });

describe("notify_send_outside_action", () => {
    it("finds nothing when no send evidence is supplied (runtime caller)", () => {
        expect.assertions(1);

        expect(run()).toHaveLength(0);
    });

    it("flags ctx.push.broadcast() inside a mutation handler", () => {
        expect.assertions(2);

        const calls: AdvisorNotifyCall[] = [{ callee: "ctx.push.broadcast", exportName: "announce", file: "announce", kind: "mutation", line: 9 }];
        const findings = run(calls);

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({
            cacheKey: "notify_send_outside_action:announce:9:ctx.push.broadcast",
            categories: ["SCHEMA"],
            level: "WARN",
            metadata: { callee: "ctx.push.broadcast", exportName: "announce", file: "announce", kind: "mutation", line: 9 },
            name: "notify_send_outside_action",
        });
    });

    it("flags ctx.notify.send() inside a query handler", () => {
        expect.assertions(1);

        const calls: AdvisorNotifyCall[] = [{ callee: "ctx.notify.send", exportName: "listInbox", file: "inbox", kind: "query", line: 3 }];

        expect(run(calls)).toHaveLength(1);
    });

    it("names the hazard that actually applies to each kind, and claims no OCC retry", () => {
        expect.assertions(4);

        const [query] = run([{ callee: "ctx.notify.send", exportName: "listInbox", file: "inbox", kind: "query", line: 3 }]);
        const [mutation] = run([{ callee: "ctx.push.broadcast", exportName: "announce", file: "announce", kind: "mutation", line: 9 }]);

        // A query IS re-evaluated by a live subscription — that is the duplicate-send path.
        expect(query?.detail).toContain("live subscription re-runs this query");
        // A mutation is not re-run; the send just cannot be rolled back with the transaction.
        expect(mutation?.detail).toContain("transaction that can roll back");
        // There is no internal OCC retry loop on this runtime (see `nondeterministic_query_mutation`).
        expect(query?.detail).not.toContain("retr");
        expect(mutation?.detail).not.toContain("retried");
    });

    it("is clean for an action (the feeder omits action handlers)", () => {
        expect.assertions(1);

        expect(run([])).toHaveLength(0);
    });
});
