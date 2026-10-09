import { callSiteLabel, isReachableSite } from "../../call-site-scope";
import emit from "../../finding";
import type { Lint } from "../../types";
import { callSiteFields, callSiteWhere } from "../helpers";

/** How the finding names each loop form. */
const LOOP_TEXT: Readonly<Record<"do" | "for" | "while", string>> = {
    do: "`do { … } while (true)`",
    for: "`for (;;)`",
    while: "`while (true)`",
};

/**
 * Flags a literal-infinite loop — `while (true)`, `for (;;)` / `for (; true;)`,
 * `do { … } while (true)` — that has no statically reachable way out: no
 * `break` bound to it, no `return`/`throw` leaving its function, no `yield`
 * suspending it.
 *
 * Inside a Durable Object such a loop never yields the isolate: a request, an
 * alarm or a queue consumer that enters it holds the object and its storage
 * forever, and every `ctx.db` read or write in the body is billed on each turn.
 * That is how a single alarm handler racks up trillions of storage operations.
 *
 * `ERROR`, because the feeder only records a loop it can prove cannot exit by
 * its own syntax: a condition other than a literal `true` is never recorded
 * (it may be bounded by state the walk cannot read), and an exit the walk can
 * see — even one behind a guard — clears the loop. A loop in a helper no export
 * reaches is dead code and stays quiet; module scope runs at import, so it does
 * not.
 *
 * Runs only when the codegen feeder supplied loop evidence
 * (`context.unboundedLoops` present); a runtime caller flags nothing.
 */
const unboundedLoop: Lint = {
    categories: ["PERFORMANCE"],
    description:
        "A literal-infinite loop (`while (true)`, `for (;;)`, `do … while (true)`) has no `break`, `return` or `throw` that can leave it. Once entered it never ends: inside a Durable Object it holds the object forever, and every storage read or write in its body is billed on every turn.",
    facing: "EXTERNAL",
    level: "ERROR",
    name: "unbounded_loop",
    remediation:
        "Give the loop an exit: loop on a real condition (`while (cursor !== null)`), `break` when the work runs out, or cap it with an iteration budget. For recurring work, do one batch per invocation and re-arm with `ctx.scheduler.runAfter(…)` behind a guard that stops when nothing is left.",
    run: (context) => {
        if (context.unboundedLoops === undefined) {
            return [];
        }

        const occurrences = new Map<string, number>();

        return context.unboundedLoops
            .filter((loop) => loop.scope.kind === "module" || isReachableSite(loop.scope))
            .map((loop) => {
                // Line-free, so a dismissal survives the code moving; the
                // occurrence suffix keeps two loops in one function apart.
                const baseKey = `unbounded_loop:${loop.file}:${callSiteLabel(loop.scope)}:${loop.kind}`;
                const occurrence = (occurrences.get(baseKey) ?? 0) + 1;

                occurrences.set(baseKey, occurrence);

                return emit(unboundedLoop, {
                    cacheKey: occurrence > 1 ? `${baseKey}:${occurrence.toString()}` : baseKey,
                    detail: `${LOOP_TEXT[loop.kind]} in ${callSiteWhere(loop)} has no \`break\`, \`return\` or \`throw\` that can leave it — once entered it never ends, and every storage call in its body is billed on every turn.`,
                    metadata: { ...callSiteFields(loop), loop: loop.kind },
                });
            });
    },
    source: "static",
    title: "Infinite loop with no exit",
};

export default unboundedLoop;
