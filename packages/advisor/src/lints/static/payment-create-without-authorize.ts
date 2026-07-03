import emit from "../../finding";
import type { Lint } from "../../types";

/**
 * Flags a `createPayment({...})` constructed without an `authorize` callback.
 *
 * The `authorize(referenceId)` hook is `@lunora/payment`'s access-control gate: it
 * runs before every charge/refund/subscription operation and decides whether the
 * current caller may act on that payment reference. Omit it and the guard is
 * effectively open — any caller who can reach a reference id (often a
 * client-supplied string) can drive money movement against someone else's
 * payment, a broken-access-control (IDOR) escalation on the most sensitive
 * surface an app has.
 *
 * The context accessor `ctx.payments` is authorization-scoped by default; this
 * lint targets the direct `createPayment(...)` factory, where the gate is
 * opt-in. Runs only when the codegen feeder supplies config-call evidence
 * (`context.configCalls`); a runtime caller flags nothing. Skips calls whose
 * config wasn't a static object literal (the key may be set on a config built
 * elsewhere). One finding per unguarded call.
 */
const paymentCreateWithoutAuthorize: Lint = {
    categories: ["SECURITY"],
    description:
        "`createPayment({...})` was constructed without an `authorize` callback, so its access-control gate never runs — any caller that reaches a payment reference id can drive a charge, refund, or subscription change against it (a broken-access-control / IDOR risk on money movement).",
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
                    detail: `\`createPayment({...})\` in ${call.file}:${call.line.toString()} has no \`authorize\` callback — its access-control gate never runs, so any caller reaching the payment reference can move money against it. Add an \`authorize(referenceId)\` gate that checks \`ctx.auth\` ownership before the operation.`,
                    metadata: { callee: call.callee, file: call.file, line: call.line },
                }),
            );
    },
    source: "static",
    title: "createPayment without an authorize gate",
};

export default paymentCreateWithoutAuthorize;
