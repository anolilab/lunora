import type { CallExpression, Node as TsNode, Project } from "ts-morph";
import { Node } from "ts-morph";

import { enclosingExportName, isArgumentDerived, isScopedByContext } from "./argument-taint";
import { collectCallRows } from "./discover-ast";
import type { MailRecipientAccessIR } from "./ir";

/** The mailer methods whose first argument is an options object carrying recipient fields. */
const MAIL_METHODS = new Set(["queue", "send"]);

/** The recipient properties this feeder inspects on the options object literal. */
const RECIPIENT_FIELDS = new Set(["bcc", "cc", "to"]);

/**
 * The `ctx.mail`/`ctx.email` `<method>` invoked by `node`, or `undefined` when
 * `node` is not a mailer send/queue call. Matched by shape (a property access
 * whose name is `send`/`queue` and whose receiver text is exactly `ctx.mail` or
 * `ctx.email`) — the same `import`-agnostic, fail-closed convention the other
 * feeders use, so a re-export or alias still resolves.
 */
const mailRecipientMethod = (node: TsNode): string | undefined => {
    if (!Node.isPropertyAccessExpression(node)) {
        return undefined;
    }

    const method = node.getName();

    if (!MAIL_METHODS.has(method)) {
        return undefined;
    }

    const receiver = node.getExpression().getText();

    return receiver === "ctx.mail" || receiver === "ctx.email" ? method : undefined;
};

/**
 * True when the options object literal `argument` carries a `to`/`cc`/`bcc`
 * recipient property whose value is derived from the handler's `args` with no
 * server-side scoping — inspecting both `to: <expr>` assignments and `{ to }`
 * shorthand (which references a same-named binding, followed one `const` hop).
 * Only a direct object-literal argument is inspected; a non-literal
 * (spread/variable) options argument is skipped, fail-closed.
 */
const hasUnscopedArgumentDerivedRecipient = (argument: TsNode): boolean => {
    if (!Node.isObjectLiteralExpression(argument)) {
        return false;
    }

    return argument.getProperties().some((property) => {
        // `{ to }` shorthand — the value IS the same-named binding (`property.getNameNode()`).
        if (Node.isShorthandPropertyAssignment(property)) {
            const value = property.getNameNode();

            return RECIPIENT_FIELDS.has(property.getName()) && isArgumentDerived(value) && !isScopedByContext(value);
        }

        if (!Node.isPropertyAssignment(property) || !RECIPIENT_FIELDS.has(property.getName())) {
            return false;
        }

        const value = property.getInitializer();

        return value !== undefined && isArgumentDerived(value) && !isScopedByContext(value);
    });
};

/** The IR row for a `ctx.mail.<method>({ to/cc/bcc, … })` call with an arg-derived, unscoped recipient, or `undefined`. */
const mailAccessInCall = (call: CallExpression, relativePath: string): MailRecipientAccessIR | undefined => {
    const method = mailRecipientMethod(call.getExpression());

    if (method === undefined) {
        return undefined;
    }

    const options = call.getArguments()[0];

    if (!options || !hasUnscopedArgumentDerivedRecipient(options)) {
        return undefined;
    }

    return { exportName: enclosingExportName(call), file: relativePath, line: call.getStartLineNumber(), method };
};

/**
 * Discover `ctx.mail`/`ctx.email` `send`/`queue` calls in `lunora/` whose
 * `to`/`cc`/`bcc` recipient is derived from the handler's `args` with no
 * server-side scoping — the `mail_recipient_from_request_input` lint input. A
 * recipient taken straight from request input turns the deployment into an open
 * relay / spam amplifier: any caller can direct mail to an arbitrary address. A
 * fixed literal recipient, or one scoped by a server-trusted `ctx.*` value (e.g.
 * `ctx.auth.user.email`), is not recorded; only an arg-derived, unscoped
 * recipient (directly, or through one local `const` hop) reaches here. Only a
 * direct object-literal first argument is inspected, and one finding is
 * produced per call — not per recipient property.
 */
const discoverMailRecipientAccesses = (project: Project, lunoraDirectory: string): MailRecipientAccessIR[] =>
    collectCallRows(project, lunoraDirectory, mailAccessInCall);

export default discoverMailRecipientAccesses;
