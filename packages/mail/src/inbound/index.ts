/**
 * `@lunora/mail/inbound` — inbound Email Routing support.
 *
 * Wire a Cloudflare Email Worker entry to route received mail into a Lunora
 * mutation/action:
 *
 * ```ts
 * import { createInboundEmailHandler, parseInboundEmail, dispatchToLunoraFunction } from "@lunora/mail/inbound";
 *
 * export const email = createInboundEmailHandler({
 *     parse: parseInboundEmail,
 *     dispatch: dispatchToLunoraFunction({ shard: env.SHARD, functionPath: "inbound:onEmail" }),
 * });
 * ```
 */
export type {
    DispatchToLunoraFunctionOptions,
    ForwardableEmailMessageLike,
    InboundDispatch,
    InboundDispatchContext,
    InboundEmailHandler,
    InboundEmailHandlerOptions,
    RpcEnvelope,
} from "./handler";
export { createInboundEmailHandler, dispatchToLunoraFunction } from "./handler";
export type { InboundAttachment, InboundEmail, RawInboundEmail } from "./parse";
export { parseInboundEmail } from "./parse";
export type { ShardNamespaceLike, ShardStubLike } from "./shard";
