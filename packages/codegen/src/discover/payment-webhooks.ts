import type { CallExpression, ObjectLiteralExpression, Project } from "ts-morph";
import { Node } from "ts-morph";

import type { PaymentWebhookIR } from "../ir";
import { collectCallRows, findObjectProperty, staticNumberValue } from "./ast";
import { callSiteScopeOf } from "./attribution";
import { calleeName } from "./callee";

/**
 * Payment-adapter factories that accept a `webhookToleranceSeconds` replay
 * window (`createStripeAdapter` / `createPolarAdapter` / `createAutumnAdapter` /
 * `createDodoPaymentsAdapter`). Matched by callee name (`import`-agnostic,
 * matching the other config feeders), so an aliased import or a namespace access
 * still resolves. `createPayment` is excluded — its options carry no tolerance
 * knob.
 */
const WEBHOOK_ADAPTER_CALLEES = new Set(["createAutumnAdapter", "createDodoPaymentsAdapter", "createPolarAdapter", "createStripeAdapter"]);

/** The statically-known `webhookToleranceSeconds` value from an adapter's options object literal, or `undefined` when absent or not statically known. */
const toleranceFromOptions = (objectLiteral: ObjectLiteralExpression): number | undefined => {
    const property = findObjectProperty(objectLiteral, "webhookToleranceSeconds");

    return property && Node.isPropertyAssignment(property) ? staticNumberValue(property.getInitializer()) : undefined;
};

/** The IR row for a payment-adapter construction, tagged with the statically-known webhook replay tolerance (when the option is a numeric literal), or `undefined`. */
const paymentWebhookInCall = (call: CallExpression, relativePath: string): PaymentWebhookIR | undefined => {
    const callee = calleeName(call.getExpression());

    if (callee === undefined || !WEBHOOK_ADAPTER_CALLEES.has(callee)) {
        return undefined;
    }

    const [argument] = call.getArguments();
    const toleranceSeconds = argument && Node.isObjectLiteralExpression(argument) ? toleranceFromOptions(argument) : undefined;

    return {
        callee: callee as PaymentWebhookIR["callee"],
        scope: callSiteScopeOf(call),
        file: relativePath,
        line: call.getStartLineNumber(),
        ...(toleranceSeconds === undefined ? {} : { toleranceSeconds }),
    };
};

/**
 * Discover payment webhook-adapter constructions (`createStripeAdapter` /
 * `createPolarAdapter`) in `lunora/` — the payment-webhook wide-tolerance lint's
 * input. The adapters verify a webhook's signed timestamp against a
 * `webhookToleranceSeconds` replay window (default 300s — Stripe's and the
 * Standard Webhooks spec's recommendation). An implausibly wide window (hours /
 * days) leaves the endpoint accepting stale, replayable signed payloads long
 * after capture, defeating the timestamp check.
 *
 * Each row carries the `webhookToleranceSeconds` value when the source states it
 * (a literal or arithmetic over literals); an env-sourced or referenced value is
 * left `undefined` and never flagged. The lint fires only above a conservative ceiling
 * so a normal skew tolerance is never a finding.
 */
const discoverPaymentWebhooks = (project: Project, lunoraDirectory: string): PaymentWebhookIR[] =>
    collectCallRows(project, lunoraDirectory, paymentWebhookInCall);

export default discoverPaymentWebhooks;
