import emit from "../../finding";
import type { Lint } from "../../types";

/**
 * Flags a `ctx.mail`/`ctx.email` `send`/`queue` call whose recipient field
 * (to/cc/bcc) is derived from the handler's `args` with no server-side
 * scoping.
 *
 * A recipient derived straight from request input turns the deployment into
 * an open relay / spam amplifier — any caller can direct mail to an arbitrary
 * address just by supplying it as an argument. The fix is to derive
 * recipients from server-trusted state (e.g. the authenticated user's own
 * record via `ctx.auth`), never straight from `args`; if user-chosen
 * recipients are a genuine product requirement, gate the path behind
 * authentication and rate limiting rather than leaving it open to any caller.
 *
 * Runs only when the codegen feeder supplies mail recipient-access evidence
 * (`context.mailRecipientAccesses`); a runtime caller flags nothing. One
 * finding per offending `ctx.mail`/`ctx.email` call — not per recipient field.
 */
const mailRecipientFromRequestInput: Lint = {
    categories: ["SECURITY"],
    description:
        "A `ctx.mail`/`ctx.email` `send`/`queue` call sets a recipient field (to/cc/bcc) from the handler's `args` with no server-side scoping. Sending to an address taken straight from request input turns the deployment into an open relay / spam amplifier.",
    facing: "EXTERNAL",
    level: "WARN",
    name: "mail_recipient_from_request_input",
    remediation:
        "Derive recipients from server-trusted state (e.g. the authenticated user's own record via `ctx.auth`), never straight from `args`. If user-chosen recipients are intended, gate the path behind authentication and rate limiting.",
    run: (context) => {
        if (context.mailRecipientAccesses === undefined) {
            return [];
        }

        return context.mailRecipientAccesses.map((access) =>
            emit(mailRecipientFromRequestInput, {
                cacheKey: `mail_recipient_from_request_input:${access.file}:${access.line.toString()}`,
                detail: `\`ctx.mail.${access.method}\` in \`${access.exportName}\` (${access.file}:${access.line.toString()}) sets a recipient field (to/cc/bcc) derived from \`args\` with no server-side scoping — any caller can direct mail to an arbitrary address (open relay / spam amplifier). Derive the recipient from server-trusted state instead (e.g. \`ctx.auth.user.email\`).`,
                metadata: { exportName: access.exportName, file: access.file, line: access.line, method: access.method },
            }),
        );
    },
    source: "static",
    title: "Mail recipient derived from request input",
};

export default mailRecipientFromRequestInput;
