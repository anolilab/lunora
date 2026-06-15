/**
 * `@cirrus/mail/inbound` — inbound Email Routing support.
 *
 * Wire a Cloudflare Email Worker entry to route received mail into a Cirrus
 * mutation/action:
 *
 * ```ts
 * import { createInboundEmailHandler, parseInboundEmail, dispatchToCirrusFunction } from "@cirrus/mail/inbound";
 *
 * export const email = createInboundEmailHandler({
 *     parse: parseInboundEmail,
 *     dispatch: dispatchToCirrusFunction({ shard: env.SHARD, functionPath: "inbound:onEmail" }),
 * });
 * ```
 */
export type {
    DispatchToCirrusFunctionOptions,
    ForwardableEmailMessageLike,
    InboundDispatch,
    InboundDispatchContext,
    InboundEmailHandler,
    InboundEmailHandlerOptions,
    RpcEnvelope,
} from "./handler";
export { createInboundEmailHandler, dispatchToCirrusFunction } from "./handler";
export type { InboundAttachment, InboundEmail, RawInboundEmail } from "./parse";
export { parseInboundEmail } from "./parse";
export type { ShardNamespaceLike, ShardStubLike } from "./shard";
