import type { Node as TsNode, ObjectLiteralExpression, Project, SourceFile } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { enclosingExportName } from "./argument-taint";
import { listLunoraSourceFiles, lunoraRelativePath } from "./discover-functions";
import type { PaymentWebhookIR } from "./ir";

/**
 * Payment-adapter factories that accept a `webhookToleranceSeconds` replay
 * window (`createStripeAdapter` / `createPolarAdapter`). Matched by callee name
 * (`import`-agnostic, matching the other config feeders), so an aliased import
 * or a namespace access still resolves. `createPayment` is excluded — its
 * options carry no tolerance knob.
 */
const WEBHOOK_ADAPTER_CALLEES = new Set(["createPolarAdapter", "createStripeAdapter"]);

/** The simple callee name of a call expression — a bare identifier (`createStripeAdapter`) or a member access (`payment.createStripeAdapter` → `createStripeAdapter`). */
const calleeName = (expression: TsNode): string | undefined => {
    if (Node.isIdentifier(expression)) {
        return expression.getText();
    }

    if (Node.isPropertyAccessExpression(expression)) {
        return expression.getName();
    }

    return undefined;
};

/** A node's numeric literal value (`300`), or `undefined` when it isn't a plain numeric literal (`60 * 60`, an identifier, an env read — not statically knowable, so never flagged). */
const numericLiteralValue = (node: TsNode | undefined): number | undefined => (node && Node.isNumericLiteral(node) ? Number(node.getText()) : undefined);

/** The statically-known `webhookToleranceSeconds` numeric literal from an adapter's options object literal, or `undefined` when absent / not a literal. */
const toleranceFromOptions = (objectLiteral: ObjectLiteralExpression): number | undefined => {
    const property = objectLiteral.getProperty("webhookToleranceSeconds");

    return property && Node.isPropertyAssignment(property) ? numericLiteralValue(property.getInitializer()) : undefined;
};

/** Every payment-adapter construction in one source file, tagged with the statically-known webhook replay tolerance (when the option is a numeric literal). */
const paymentWebhooksInSourceFile = (sourceFile: SourceFile, relativePath: string): PaymentWebhookIR[] => {
    const rows: PaymentWebhookIR[] = [];

    for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const callee = calleeName(call.getExpression());

        if (callee === undefined || !WEBHOOK_ADAPTER_CALLEES.has(callee)) {
            continue;
        }

        const [argument] = call.getArguments();
        const toleranceSeconds = argument && Node.isObjectLiteralExpression(argument) ? toleranceFromOptions(argument) : undefined;

        rows.push({
            callee: callee as PaymentWebhookIR["callee"],
            exportName: enclosingExportName(call),
            file: relativePath,
            line: call.getStartLineNumber(),
            ...(toleranceSeconds === undefined ? {} : { toleranceSeconds }),
        });
    }

    return rows;
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
 * Each row carries the statically-known `webhookToleranceSeconds` literal (when
 * present and a plain numeric literal); a computed / env-sourced value is left
 * `undefined` and never flagged. The lint fires only above a conservative ceiling
 * so a normal skew tolerance is never a finding.
 */
const discoverPaymentWebhooks = (project: Project, lunoraDirectory: string): PaymentWebhookIR[] => {
    const rows: PaymentWebhookIR[] = [];

    for (const filePath of listLunoraSourceFiles(lunoraDirectory)) {
        const sourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);

        rows.push(...paymentWebhooksInSourceFile(sourceFile, lunoraRelativePath(lunoraDirectory, filePath)));
    }

    return rows;
};

export default discoverPaymentWebhooks;
