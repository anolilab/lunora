import { callSiteLabel, isReachableSite } from "../../call-site-scope";
import emit from "../../finding";
import type { Lint } from "../../types";
import type { AdvisorUnboundedLoop } from "../../unbounded-loops";
import { callSiteFields, callSiteWhere } from "../helpers";

/** How the finding names each loop form. */
const LOOP_TEXT: Readonly<Record<AdvisorUnboundedLoop["kind"], string>> = {
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
 * Inside a Durable Object such a loop never yields the isolate: a request, a
 * scheduled run or a queue consumer that enters it holds the object and its
 * storage forever, and every `ctx.db` read or write in the body is billed on
 * each turn.
 *
 * `ERROR`, because the feeder (codegen's `discoverUnboundedLoops`) records only
 * a loop whose own syntax proves it cannot exit; what counts as an exit is
 * defined there. A loop in a helper no export reaches is dead code and stays
 * quiet; module scope runs at import, so it does not.
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

        // Line-free, so a dismissal survives the code moving; `runAdvisor`'s
        // `dedupeCacheKeys` keeps two loops of one kind in one function apart.
        return context.unboundedLoops
            .filter((loop) => loop.scope.kind === "module" || isReachableSite(loop.scope))
            .map((loop) =>
                emit(unboundedLoop, {
                    cacheKey: `unbounded_loop:${loop.file}:${callSiteLabel(loop.scope)}:${loop.kind}`,
                    detail: `${LOOP_TEXT[loop.kind]} in ${callSiteWhere(loop)} has no \`break\`, \`return\` or \`throw\` that can leave it — once entered it never ends, and every storage call in its body is billed on every turn.`,
                    metadata: { ...callSiteFields(loop), loop: loop.kind },
                }),
            );
    },
    source: "static",
    title: "Infinite loop with no exit",
};

export default unboundedLoop;
