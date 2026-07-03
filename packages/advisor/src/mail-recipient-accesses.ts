/**
 * One `ctx.mail`/`ctx.email` `send`/`queue` call whose recipient field
 * (`to`/`cc`/`bcc`) is derived from the handler's `args` with no server-side
 * scoping — the input the `mail_recipient_from_request_input` lint consumes. A
 * recipient taken straight from request input turns the deployment into an
 * open relay / spam amplifier: any caller can direct mail to an arbitrary
 * address. A fixed literal recipient, or one scoped by a server-trusted
 * `ctx.*` value (e.g. `ctx.auth.user.email`), is not recorded; only an
 * arg-derived, unscoped recipient reaches here. Produced by the codegen
 * feeder; runtime callers don't supply it, so the lint finds nothing there.
 */
export interface AdvisorMailRecipientAccess {
    /** The exported binding name of the procedure performing the `ctx.mail`/`ctx.email` call. */
    exportName: string;
    /** Source file relative to the lunora dir, no extension. */
    file: string;
    /** 1-based line of the `ctx.mail`/`ctx.email` call, or `0` when unknown. */
    line: number;
    /** The mailer method invoked: `send` / `queue`. */
    method: string;
}
