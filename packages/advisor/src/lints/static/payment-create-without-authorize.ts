import emit from "../../finding";
import type { Lint } from "../../types";

/**
 * Flags a `createPayment({...})` constructed without an `authorize` callback.
 *
 * The `authorize(referenceId)` hook is `@lunora/payment`'s access-control gate: it
 * runs before every charge/refund/subscription operation and decides whether the
 * current caller may act on that payment reference. `createPayment` requires it,
 * and throws `CONFIG_INVALID` at construction when it is missing, so a config
 * without it fails at startup and no mutation runs. This lint reports that
 * config statically, before it ships.
 *
 * The context accessor `ctx.payments` is authorization-scoped by default; this
 * lint targets the direct `createPayment(...)` factory. Runs only when the
 * codegen feeder supplies config-call evidence (`context.configCalls`); a runtime
 * caller flags nothing. Skips calls whose config wasn't a static object literal
 * (the key may be set on a config built elsewhere). One finding per unguarded call.
 */
const paymentCreateWithoutAuthorize: Lint = {
    categories: ["SECURITY"],
    description:
        "`createPayment({...})` is constructed without an `authorize` callback. The factory rejects that configuration at construction (`CONFIG_INVALID`), so every payment mutation on it is denied and the app fails at startup.",
    facing: "EXTERNAL",
    level: "ERROR",
    name: "payment_create_without_authorize",
    remediation:
        "Pass an `authorize(referenceId)` callback to `createPayment({...})` that verifies the current caller (via `ctx.auth`) owns the payment/subscription reference before the operation runs. Prefer the `ctx.payments` accessor, which is authorization-scoped by default.",
    run: (context) => {
        if (context.configCalls === undefined) {
            return [];
        }

        return context.configCalls
            .filter((call) => call.callee === "createPayment" && call.analyzable && !call.presentKeys.includes("authorize"))
            .map((call) =>
                emit(paymentCreateWithoutAuthorize, {
                    cacheKey: `payment_create_without_authorize:${call.file}:${call.line.toString()}`,
                    detail: `\`createPayment({...})\` in ${call.file}:${call.line.toString()} has no \`authorize\` callback, so the factory throws \`CONFIG_INVALID\` at construction and every payment mutation on it is denied. Add an \`authorize(referenceId)\` gate that checks \`ctx.auth\` ownership.`,
                    metadata: { callee: call.callee, file: call.file, line: call.line },
                }),
            );
    },
    source: "static",
    title: "createPayment without an authorize gate",
};

export default paymentCreateWithoutAuthorize;
