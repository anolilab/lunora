import fc from "fast-check";
import { describe, expect, it } from "vitest";

import createMailer from "../src/create-mailer";
import type { SentMailStore } from "../src/queue";
import { consumeQueuedSend } from "../src/queue";
import { isRetryableMailError, MailSendError } from "../src/send-error";
import type { MailTransport } from "../src/types";

/**
 * Model-based checks over random Cloudflare Queues delivery histories. Each step
 * delivers one live message to the consumer and fixes what the provider does if
 * it is asked to send. The consumer acks or retries exactly as the documented
 * recipe does; an `okAckLost` step is a send the provider accepted whose ack
 * never landed, so the queue delivers the message again. `unknown` is a timeout
 * through a provider that cannot dedupe (acked); `unknownDeduped` is a timeout
 * through one that dedupes on the key, as Resend does (retried): the provider
 * delivered it, and drops a later send under the same key. Time comes from the
 * history and drives the store's TTL.
 *
 * Not generated: a crash between the provider accepting the send and the key
 * being recorded. That window is documented as open, and no consumer can close it.
 */

const KEYS = ["a", "b", "c"] as const;
const TTL_SECONDS = 86_400;

type Outcome = "ok" | "okAckLost" | "permanent" | "retryable" | "unknown" | "unknownDeduped";

interface Step {
    advance: number;
    message: number;
    outcome: Outcome;
}

const stepArbitrary: fc.Arbitrary<Step> = fc.record({
    // Bounded so a whole history stays inside the TTL: past it, a resend is the documented behaviour.
    advance: fc.integer({ max: 600, min: 0 }),
    message: fc.integer({ max: KEYS.length - 1, min: 0 }),
    outcome: fc.constantFrom<Outcome>("ok", "okAckLost", "permanent", "retryable", "unknown", "unknownDeduped"),
});

const historyArbitrary = fc.array(stepArbitrary, { maxLength: 60 });

/** A KV-shaped store whose entries expire on the history's clock. */
const expiringStore = (now: () => number): SentMailStore => {
    const entries = new Map<string, { expiresAt: number; value: string }>();

    return {
        get: async (key) => {
            const entry = entries.get(key);

            return entry !== undefined && entry.expiresAt > now() ? entry.value : null;
        },
        put: async (key, value, options) => {
            entries.set(key, { expiresAt: now() + options.expirationTtl, value });
        },
    };
};

interface Replay {
    /** Per key: how many times the provider accepted (or, for `unknown`, may have accepted) the message. */
    delivered: Map<string, number>;
    /** Whether every step's per-key delivery count stayed at most one. */
    neverDoubled: boolean;
}

const replay = async (steps: ReadonlyArray<Step>): Promise<Replay> => {
    let now = 0;
    let outcome: Outcome = "ok";
    const delivered = new Map<string, number>();
    // Keys the provider holds under its own idempotency dedupe: only a timeout through a deduping provider puts one here.
    const providerDeduped = new Set<string>();
    const acked = new Set<string>();
    const store = expiringStore(() => now);
    let neverDoubled = true;

    const transport: MailTransport = {
        send: async (_payload, options) => {
            const key = options?.idempotencyKey ?? "";

            if (outcome === "retryable") {
                throw new MailSendError({ retryable: true });
            }

            if (outcome === "permanent") {
                throw new MailSendError({ retryable: false });
            }

            // The provider drops a repeat of a key it accepted under its dedupe and answers with the original.
            if (!providerDeduped.has(key)) {
                // An outcome-unknown send is counted as delivered: the worst case for duplicates.
                delivered.set(key, (delivered.get(key) ?? 0) + 1);
            }

            if (outcome === "unknown") {
                throw new MailSendError({ outcomeUnknown: true, retryable: false });
            }

            if (outcome === "unknownDeduped") {
                providerDeduped.add(key);

                // Reported the way a real transport reports it; `send()` makes it retryable.
                throw new MailSendError({ outcomeUnknown: true, retryable: false });
            }

            return { id: `id-${key}` };
        },
    };
    const mailer = createMailer({ from: "noreply@x.test", transport });

    for (const step of steps) {
        now += step.advance;

        const key = KEYS[step.message] ?? "a";

        // An acked message is gone from the queue; only live ones are delivered.
        if (acked.has(key)) {
            continue;
        }

        outcome = step.outcome;
        // Which provider this delivery reaches: only one that dedupes on the key may have its timeout retried.
        transport.dedupesOnIdempotencyKey = outcome === "unknownDeduped";

        try {
            // eslint-disable-next-line no-await-in-loop -- deliveries are sequential by construction: each depends on the store the last one left
            await consumeQueuedSend(mailer, { idempotencyKey: key, subject: "Hi", to: "a@x.test" }, { sent: store, sentTtlSeconds: TTL_SECONDS });

            if (outcome !== "okAckLost") {
                acked.add(key);
            }
        } catch (error) {
            // The documented recipe: redeliver whatever is retryable, ack the rest.
            if (!isRetryableMailError(error)) {
                acked.add(key);
            }
        }

        if ((delivered.get(key) ?? 0) > 1) {
            neverDoubled = false;
        }
    }

    return { delivered, neverDoubled };
};

describe("consumeQueuedSend dedupe properties", () => {
    it("never sends one idempotency key twice across any redelivery history", async () => {
        expect.assertions(1);

        const property = fc.asyncProperty(historyArbitrary, async (steps) => {
            const { neverDoubled } = await replay(steps);

            return neverDoubled;
        });

        await expect(fc.check(property)).resolves.toMatchObject({ failed: false });
    });

    it("lets no failed attempt block a later one: a message whose first settling answer is ok was sent exactly once", async () => {
        expect.assertions(1);

        const property = fc.asyncProperty(historyArbitrary, async (steps) => {
            const { delivered } = await replay(steps);
            const settled = new Set<string>();

            // Mirror the queue: the first ok, permanent or unknown answer settles the message.
            for (const step of steps) {
                const key = KEYS[step.message] ?? "a";

                if (settled.has(key)) {
                    continue;
                }

                if (step.outcome === "ok" || step.outcome === "okAckLost") {
                    if ((delivered.get(key) ?? 0) !== 1) {
                        return false;
                    }

                    settled.add(key);
                } else if (step.outcome !== "retryable" && step.outcome !== "unknownDeduped") {
                    settled.add(key);
                }
            }

            return true;
        });

        await expect(fc.check(property)).resolves.toMatchObject({ failed: false });
    });
});
