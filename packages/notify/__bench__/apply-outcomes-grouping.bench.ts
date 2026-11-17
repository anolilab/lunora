import { bench, describe } from "vitest";

/*
 * The D1 subscription store's applyOutcomes groups a broadcast page's failures by
 * error text into one `UPDATE … WHERE id IN (…)` per group. During a provider
 * outage every recipient fails with the same text, so one group holds the page.
 *
 * old — `byError.set(key, [...(byError.get(key) ?? []), id])`: copies the
 * group on every failure, O(n²) in the page size.
 * new — push onto the existing group, O(n).
 */

const failed = Array.from({ length: 2000 }, (_, index) => {
    return { error: "503 upstream unavailable", id: `wp2_${String(index)}` };
});

describe("applyOutcomes: group failures by error (2000-row page, one error)", () => {
    bench("spread per failure (old)", () => {
        const byError = new Map<string | null, string[]>();

        for (const { error, id } of failed) {
            byError.set(error ?? null, [...(byError.get(error ?? null) ?? []), id]);
        }
    });

    bench("push onto group (new)", () => {
        const byError = new Map<string | null, string[]>();

        for (const { error, id } of failed) {
            const group = byError.get(error ?? null);

            if (group === undefined) {
                byError.set(error ?? null, [id]);
            } else {
                group.push(id);
            }
        }
    });
});
