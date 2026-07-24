/**
 * W3C trace-context handling for the Lunora runtime: extract the inbound
 * `traceparent`/`tracestate`, decide whether to trust it, mint this dispatch's
 * span, and propagate the result to the next hop.
 *
 * Built on the zero-dependency `parseTraceparent`/`buildTraceparent` in
 * `shared/otlp.ts` — the same encoder `@lunora/do` and `@lunora/container` use —
 * so all three tiers agree on what a valid `traceparent` is. An OTel SDK
 * propagator would be a fourth opinion (notably a stricter one: it rejects the
 * forward-compatible `>= 4`-field headers the spec requires future versions to
 * tolerate) for two string operations, and would put a Node-oriented package in a
 * Workers bundle.
 *
 * **Trust.** The inbound `traceparent` is attacker-controlled on any
 * public-facing Worker, and the trace id it carries would otherwise steer both
 * the head-sampling verdict and which trace this request's spans and logs land
 * in. Continuation is therefore opt-in ({@link DispatchTraceOptions.trustInbound})
 * and head sampling is keyed on a server-minted id whenever the upstream is not
 * trusted. See {@link beginDispatchTrace}.
 */
import { buildTraceparent, otlpRandomHex, parseTraceparent } from "../../../shared/otlp";
import type { TraceSamplingConfig, TraceSamplingDecision } from "../../../shared/sampling";
import { resolveTraceSampling } from "../../../shared/sampling";

/** The W3C `sampled` flag — bit 0 of the trace-flags octet. */
const SAMPLED_FLAG = 1;

/** Trace flags with `sampled` clear. */
const UNSAMPLED_FLAG = 0;

/**
 * W3C caps `tracestate` at 32 list members, and states the total SHOULD stay
 * within 512 characters. We enforce both as hard limits because this header is
 * echoed onward from client input.
 */
const MAX_TRACE_STATE_MEMBERS = 32;

/** Hard cap on the `tracestate` header we are willing to re-emit. */
const MAX_TRACE_STATE_LENGTH = 512;

/** `key=value`, per the W3C `tracestate` list-member grammar (incl. the `@` tenant form). */
const TRACE_STATE_MEMBER = /^[a-z][\d_a-z*/-]{0,255}(?:@[a-z][\d_a-z*/-]{0,13})?=[\u0020-\u002B\u002D-\u003C\u003E-\u007E]{1,256}$/;

/** The upstream trace context carried by a well-formed inbound `traceparent`. */
interface UpstreamTraceContext {
    /** The upstream span this request is a child of. */
    parentSpanId: string;
    /** The upstream's head-sampling verdict (trace-flags bit 0). */
    sampled: boolean;
    /** The trace this request joins. */
    traceId: string;
    /** Vendor `tracestate`, already validated; absent when missing or malformed. */
    traceState?: string;
}

/** This dispatch's own span, plus everything needed to propagate it. */
interface DispatchTraceContext {
    /** Upstream span id, when a trusted `traceparent` supplied one. */
    parentSpanId?: string;
    /** The authoritative sampled verdict for this trace — what goes on the wire AND on the span. */
    sampled: boolean;
    /** This dispatch's span id (always server-minted). */
    spanId: string;
    /** The `sampled` verdict above as the numeric trace-flags octet, for the OTLP span's `flags`. */
    traceFlags: number;
    /** The trace this dispatch belongs to. */
    traceId: string;
    /** Vendor `tracestate` to carry onward, when the upstream was trusted. */
    traceState?: string;
}

/** How {@link beginDispatchTrace} treats the inbound trace context. */
interface DispatchTraceOptions {
    /** Head-sampling configuration; `undefined` keeps every trace. */
    sampling?: TraceSamplingConfig;

    /**
     * When `true`, a well-formed inbound `traceparent` continues its trace: this
     * dispatch adopts the upstream trace id, parents under its span, and carries
     * its `tracestate` onward. Default `false` — see the module doc.
     */
    trustInbound?: boolean;
}

/**
 * Validate a `tracestate` header before we agree to echo it downstream. Returns
 * the header unchanged when every list member matches the W3C grammar and the
 * whole thing is within the size limits, else `undefined`.
 *
 * Re-emitting this verbatim is what makes validation load-bearing: without it a
 * client could push arbitrary bytes (header smuggling, unbounded length) through
 * the worker into every downstream hop and into the collector.
 */
const sanitizeTraceState = (header: null | string | undefined): string | undefined => {
    if (header === null || header === undefined) {
        return undefined;
    }

    const trimmed = header.trim();

    if (trimmed.length === 0 || trimmed.length > MAX_TRACE_STATE_LENGTH) {
        return undefined;
    }

    const members = trimmed.split(",");

    if (members.length > MAX_TRACE_STATE_MEMBERS) {
        return undefined;
    }

    for (const member of members) {
        if (!TRACE_STATE_MEMBER.test(member.trim())) {
            return undefined;
        }
    }

    return trimmed;
};

/**
 * Read the inbound W3C trace context, or `undefined` when there is no
 * `traceparent` or it is malformed. This only *parses* — whether the result is
 * trusted is {@link beginDispatchTrace}'s decision.
 */
const extractTraceContext = (request: Request): UpstreamTraceContext | undefined => {
    const parsed = parseTraceparent(request.headers.get("traceparent"));

    if (parsed === undefined) {
        return undefined;
    }

    const traceState = sanitizeTraceState(request.headers.get("tracestate"));

    return {
        parentSpanId: parsed.parentSpanId,
        sampled: parsed.sampled,
        traceId: parsed.traceId,
        ...(traceState === undefined ? {} : { traceState }),
    };
};

/**
 * Open this dispatch's trace: resolve the upstream context under the trust
 * policy, mint the span, and settle the sampling verdict **once** so the span's
 * `flags`, the propagated `traceparent`, and the export gate can never disagree.
 *
 * Reports `ignoredUpstream` when a well-formed inbound trace was dropped for lack
 * of trust, so the caller can surface that rather than leave a silently broken
 * waterfall.
 *
 * The head decision is keyed on the trace id only when the upstream is trusted.
 * Untrusted, it keys on the freshly-minted span id: `shared/sampling` maps an id
 * deterministically onto `[0, 1)`, so a client that could choose the id could
 * choose its own verdict — sending `00-ffffffff…` to drop itself out of every
 * trace, or `00-000000…` to force capture and inflate the operator's ingest
 * bill. Keying on a server-minted value closes that while leaving the
 * whole-trace invariant intact, because downstream hops read the verdict off the
 * propagated `traceparent` rather than re-deriving it.
 */
const beginDispatchTrace = (
    request: Request,
    options: DispatchTraceOptions = {},
): { decision: TraceSamplingDecision; ignoredUpstream: boolean; trace: DispatchTraceContext } => {
    const upstream = extractTraceContext(request);
    const trusted = options.trustInbound === true ? upstream : undefined;
    const spanId = otlpRandomHex(8);
    const traceId = trusted?.traceId ?? otlpRandomHex(16);

    const decision = resolveTraceSampling(options.sampling, trusted === undefined ? spanId : traceId);

    // A trusted upstream that already sampled the trace out keeps it out: the
    // trace is kept or dropped whole, and we are a child of that decision.
    const sampled = decision.isTraced && (trusted === undefined || trusted.sampled);

    return {
        decision,
        // A parseable upstream trace existed, and we chose not to join it.
        ignoredUpstream: upstream !== undefined && trusted === undefined,
        trace: {
            sampled,
            spanId,
            traceFlags: sampled ? SAMPLED_FLAG : UNSAMPLED_FLAG,
            traceId,
            ...(trusted?.parentSpanId === undefined ? {} : { parentSpanId: trusted.parentSpanId }),
            ...(trusted?.traceState === undefined ? {} : { traceState: trusted.traceState }),
        },
    };
};

/**
 * Write this dispatch's trace context into an outgoing header bag, mutating it in
 * place. Emits `tracestate` only when one survived validation, matching the spec:
 * an empty `tracestate` is not a valid header.
 */
const injectTraceContext = (trace: DispatchTraceContext, headers: Record<string, string>): void => {
    // eslint-disable-next-line no-param-reassign -- documented in-place mutation of the caller's outgoing header bag, matching the W3C propagator shape callers already expect.
    headers.traceparent = buildTraceparent(trace.traceId, trace.spanId, trace.sampled);

    if (trace.traceState !== undefined) {
        // eslint-disable-next-line no-param-reassign -- see above.
        headers.tracestate = trace.traceState;
    }
};

/** True when the trace flags indicate the trace is sampled (W3C bit 0). */
// eslint-disable-next-line no-bitwise -- W3C trace flags are a bit field; masking is the correct operation.
const isSampled = (traceFlags: number): boolean => (traceFlags & SAMPLED_FLAG) !== 0;

export type { DispatchTraceContext, DispatchTraceOptions, UpstreamTraceContext };
export { beginDispatchTrace, extractTraceContext, injectTraceContext, isSampled, SAMPLED_FLAG, sanitizeTraceState, UNSAMPLED_FLAG };
