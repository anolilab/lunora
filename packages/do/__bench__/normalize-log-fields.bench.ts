import { bench, describe } from "vitest";

import { normalizeLogFields } from "../../../shared/log-fields";

/**
 * `normalizeLogFields` is the single most-reused function on the observability
 * critical path: it runs once per `ctx.metrics.*` call (over the metric
 * attributes) AND once per `ctx.log.*` call (over the structured fields). Every
 * call allocates a fresh object and coerces each value, so its per-call cost is
 * multiplied by every metric and log line an app emits — and, for a notify
 * broadcast, by every recipient.
 *
 * These readings price the common shapes so an optimization (e.g. a primitive-
 * only fast path) can be judged against real numbers rather than a guess. The
 * `flat-3-primitives` case is exactly what `notify.send` emits
 * (`{ channel, provider, status }`).
 */
const flat3 = { channel: "push", provider: "web-push", status: "accepted" };
const flat8 = { a: "1", b: 2, c: true, d: "4", e: 5, f: false, g: "7", h: 8 };
const nested = { detail: { code: 410, reason: "gone" }, list: [1, 2, 3], status: "gone" };
const bound = { deployment: "prod", region: "iad" };

describe("normalizeLogFields", () => {
    bench("flat 3 primitives (the notify.send attribute shape)", () => {
        normalizeLogFields(flat3);
    });

    bench("flat 8 primitives", () => {
        normalizeLogFields(flat8);
    });

    bench("nested object + array values (JSON-encode path)", () => {
        normalizeLogFields(nested);
    });

    bench("per-call merged over bound fields (.with())", () => {
        normalizeLogFields(flat3, bound);
    });

    bench("empty bag (early-return fast path)", () => {
        normalizeLogFields(undefined);
    });
});
