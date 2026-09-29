/**
 * Reconciling `queues.producers[]` / `queues.consumers[]` from `lunora/queues.ts`,
 * including the consumer tuning Lunora owns (recorded in the manifest so a hand
 * edit is not overwritten).
 */

import { findNodeAtLocation, parseTree } from "jsonc-parser";

import type { InferredQueue } from "../infer-bindings";
import { applyModify } from "../jsonc-edit";
import type { Manifest } from "./lunora-manifest";
import { recordManifestKey } from "./lunora-manifest";
import type { QueueConsumerEntry, QueuesShape, ReconcileStep, WranglerShape } from "./wrangler-shape";

/** Each `defineQueue` tuning option and the `queues.consumers[]` key wrangler spells it as. */
const CONSUMER_TUNING_KEYS = [
    ["maxBatchSize", "max_batch_size"],
    ["maxBatchTimeout", "max_batch_timeout"],
    ["maxRetries", "max_retries"],
    ["deadLetterQueue", "dead_letter_queue"],
    ["retryDelay", "retry_delay"],
] as const satisfies ReadonlyArray<readonly [keyof InferredQueue["tuning"], keyof QueueConsumerEntry]>;

/**
 * The `queues.consumers[]` fields `defineQueue` declares for `queue`, in
 * wrangler's spelling. Only the options the export actually sets appear, so a
 * field it leaves unset is never written — and never overwritten.
 */
const declaredConsumerTuning = (queue: InferredQueue): Partial<QueueConsumerEntry> =>
    Object.fromEntries(CONSUMER_TUNING_KEYS.filter(([option]) => queue.tuning[option] !== undefined).map(([option, key]) => [key, queue.tuning[option]]));

/**
 * The consumer tuning fields `defineQueue` declared on reconcile's last pass,
 * keyed by the consumer's `queue` name. A hand-set value that equalled the
 * declared one is recorded like any other, so dropping the option removes it:
 * removing the option is taken as the intent. Recorded per scope — `"queues"` for the top level,
 * `"env.<name>.queues"` for an environment block — in the project's
 * `package.json` under `lunora.queueTuning`, the same place and for the same
 * reasons as `lunora.crons` (see `reconcile-crons.ts`).
 */
type OwnedTuning = Record<string, Partial<QueueConsumerEntry>>;

/** The `package.json` key {@link OwnedTuning} is recorded under. */
const QUEUE_TUNING_RECORD = "queueTuning";

/** What may follow a property on its own line: its comma, then a `//` comment. */
const REST_OF_LINE = /^[\t ]*(?:,[\t ]*)?(?:\/\/[^\n\r]*)?\r?\n/u;

/** The comma, and any spaces before it, that follows a property's value. */
const TRAILING_COMMA = /^[\t ]*,/u;

/**
 * Delete the property at `path`. A property on a line of its own goes with
 * the whole line, trailing `//` comment included; left to `jsonc-parser`, that
 * comment stays behind and ends up describing the property above it. Any other
 * layout falls back to `jsonc-parser`'s structural removal.
 */
const removeProperty = (text: string, path: ReadonlyArray<number | string>): string => {
    const tree = parseTree(text);
    const property = tree === undefined ? undefined : findNodeAtLocation(tree, [...path])?.parent;

    if (property?.type === "property") {
        const end = property.offset + property.length;
        const lineStart = text.lastIndexOf("\n", property.offset - 1) + 1;
        const rest = REST_OF_LINE.exec(text.slice(end));

        if (rest !== null && text.slice(lineStart, property.offset).trim() === "") {
            const siblings = property.parent?.children ?? [];
            const index = siblings.indexOf(property);
            const previous = index === siblings.length - 1 && index > 0 ? siblings[index - 1] : undefined;
            // Removing the last property leaves the one before it trailing a comma.
            const comma = previous === undefined ? undefined : (TRAILING_COMMA.exec(text.slice(previous.offset + previous.length)) ?? undefined);
            const head =
                comma === undefined || previous === undefined
                    ? text.slice(0, lineStart)
                    : text.slice(0, previous.offset + previous.length) + text.slice(previous.offset + previous.length + comma[0].length, lineStart);

            return head + text.slice(end + rest[0].length);
        }
    }

    return applyModify(text, path, undefined);
};

/** What {@link retuneConsumers} did to one scope's consumers. */
interface ConsumerRetune {
    /** Every consumer entry as it stands after the retune, in its original order. */
    entries: QueueConsumerEntry[];
    /** The fields this pass wrote, to record for the next one. */
    owned: OwnedTuning;
    text: string;
    updated: string[];
    warnings: string[];
}

/**
 * Bring each existing consumer in `consumers` (found at `path` in the file) in
 * line with the `defineQueue` export `match` returns for it.
 *
 * A field the export declares is written when it differs. A field the export
 * no longer declares is removed only when `owned` shows it was declared and it
 * still holds that value: without the record, "declared" and "set by hand"
 * look the same, and deleting the second is the failure to avoid. When a
 * trailing `//` comment shares the field's line, it goes with the field.
 * A recorded field whose value has changed since was edited by hand, so it is
 * kept and named in a warning. `omit` lists fields never written in this scope.
 *
 * Each field is written at its own path, never by rewriting the block: a
 * hand-tuned consumer is exactly the one that carries comments, and a
 * whole-node write drops every comment inside it.
 */
const retuneConsumers = (
    text: string,
    consumers: ReadonlyArray<QueueConsumerEntry>,
    path: ReadonlyArray<string>,
    match: (entry: QueueConsumerEntry) => InferredQueue | undefined,
    owned: OwnedTuning,
    omit: ReadonlySet<string> = new Set(),
): ConsumerRetune => {
    const label = path.join(".");
    const nextOwned: OwnedTuning = {};
    const updated: string[] = [];
    const warnings: string[] = [];
    let nextText = text;

    const entries = consumers.map((entry, index) => {
        const queue = match(entry);

        if (queue === undefined || entry.queue === undefined) {
            return entry;
        }

        const declared = Object.fromEntries(Object.entries(declaredConsumerTuning(queue)).filter(([key]) => !omit.has(key)));
        const previous = Object.entries(owned[entry.queue] ?? {}).filter(([key]) => !Object.hasOwn(declared, key));
        const drifted = Object.entries(declared).filter(([key, value]) => entry[key as keyof QueueConsumerEntry] !== value);
        const removed = previous.filter(([key, value]) => entry[key as keyof QueueConsumerEntry] === value).map(([key]) => key);
        const next: QueueConsumerEntry = Object.fromEntries(Object.entries({ ...entry, ...declared }).filter(([key]) => !removed.includes(key)));

        for (const [key, value] of drifted) {
            nextText = applyModify(nextText, [...path, index, key], value);
        }

        for (const key of removed) {
            nextText = removeProperty(nextText, [...path, index, key]);
        }

        for (const [key, value] of previous) {
            const current = entry[key as keyof QueueConsumerEntry];

            if (current !== undefined && current !== value) {
                warnings.push(
                    `${label}/${entry.queue}: ${key} is no longer declared by defineQueue, but it was changed by hand to ${JSON.stringify(current)} from the declared ${JSON.stringify(value)}, so it was kept. Delete it from wrangler.jsonc if it should go.`,
                );
            }
        }

        if (drifted.length > 0 || removed.length > 0) {
            updated.push(`${label}/${entry.queue} (${[...drifted.map(([key]) => key), ...removed.map((key) => `removed ${key}`)].join(", ")})`);
        }

        if (Object.keys(declared).length > 0) {
            nextOwned[entry.queue] = declared;
        }

        return next;
    });

    return { entries, owned: nextOwned, text: nextText, updated, warnings };
};

/** A {@link ReconcileStep} that also hands back the consumer fields it now owns. */
interface QueueStep extends ReconcileStep {
    owned: OwnedTuning;
    warnings: string[];
}

/**
 * Add any missing `queues.producers[]` (matched by binding) and
 * `queues.consumers[]` (matched by queue name) from the declared `defineQueue`
 * exports, and bring an EXISTING consumer's tuning in line with its export
 * ({@link retuneConsumers}). Every queue gets a producer; push queues add a
 * worker consumer, pull queues add a `type: "http_pull"` consumer. Like
 * workflows, queues are NOT Durable Objects — this writes only the `queues`
 * block.
 *
 * The tuning update is what makes a later `defineQueue` edit deploy at all. A
 * consumer is written once, the first time its queue is seen; add-only, a
 * `deadLetterQueue` or `maxRetries` added afterwards never reached wrangler, so
 * the broker kept dropping exhausted messages the code said were
 * dead-lettered. A field the export leaves unset is untouched unless `owned`
 * records that `defineQueue` declared it, which is what lets an option REMOVED from
 * `defineQueue` be taken back out.
 *
 * Add-only for ENTRIES: a producer or consumer no `defineQueue` export declares
 * is left in place and reported by `orphanedEntryWarnings` (`reconcile-warnings.ts`) instead — see
 * there for why removal needs ownership this file does not record for entries.
 * Pure.
 */
const reconcileQueues = (text: string, parsed: WranglerShape, queues: ReadonlyArray<InferredQueue>, owned: OwnedTuning): QueueStep => {
    const existing = parsed.queues ?? {};
    const existingProducers = existing.producers ?? [];
    const existingConsumers = existing.consumers ?? [];

    const haveProducer = new Set(existingProducers.map((entry) => entry.binding));
    const haveConsumer = new Set(existingConsumers.map((entry) => entry.queue));

    const missingProducers = queues.filter((queue) => !haveProducer.has(queue.bindingName));
    const missingConsumers = queues.filter((queue) => !haveConsumer.has(queue.name));

    const retune = retuneConsumers(text, existingConsumers, ["queues", "consumers"], (entry) => queues.find((queue) => queue.name === entry.queue), owned);
    let nextText = retune.text;
    const nextOwned = { ...retune.owned };

    if (missingProducers.length > 0 || missingConsumers.length > 0) {
        const nextProducers = [
            ...existingProducers,
            ...missingProducers.map((queue) => {
                return { binding: queue.bindingName, queue: queue.name };
            }),
        ];
        // An append rewrites the whole block, so the existing consumers it carries
        // must already hold the retune applied above.
        const nextConsumers = [
            ...retune.entries,
            ...missingConsumers.map((queue) => {
                return { queue: queue.name, ...(queue.mode === "pull" ? { type: "http_pull" } : {}), ...declaredConsumerTuning(queue) };
            }),
        ];

        for (const queue of missingConsumers) {
            const declared = declaredConsumerTuning(queue);

            if (Object.keys(declared).length > 0) {
                nextOwned[queue.name] = declared;
            }
        }

        nextText = applyModify(nextText, ["queues"], { consumers: nextConsumers, producers: nextProducers });
    }

    return {
        added: [
            ...missingProducers.map((queue) => `queues.producers/${queue.bindingName}`),
            ...missingConsumers.map((queue) => `queues.consumers/${queue.name}`),
        ],
        owned: nextOwned,
        text: nextText,
        updated: retune.updated,
        warnings: retune.warnings,
    };
};

/**
 * Retune the consumers an `env.<environment>` block already declares, for a
 * `--env` deploy.
 *
 * Every other step writes the top level only, because an environment block
 * names its own resources (a different database id, different queue names) and
 * provisioning one would mean guessing them. Retuning is different: it changes
 * numbers on entries the user already wrote, and the numbers are the same in
 * every environment. So this updates, and never adds, a producer or consumer.
 *
 * An env consumer is matched to its `defineQueue` export through the block's
 * own producer (`queues.producers[]` binding → queue name), since its queue name
 * usually carries an environment suffix; failing that, by the declared name.
 * `dead_letter_queue` is never written here: it is a queue NAME, and the
 * declared one is the top level's. When the export declares one and the env
 * consumer has none, that is warned instead.
 */
const reconcileEnvQueues = (text: string, parsed: WranglerShape, queues: ReadonlyArray<InferredQueue>, environment: string, owned: OwnedTuning): QueueStep => {
    const block = parsed.env?.[environment] as { queues?: QueuesShape } | undefined;
    const consumers = block?.queues?.consumers ?? [];
    const producers = block?.queues?.producers ?? [];
    // By the block's own producer first. The name is a fallback only for a
    // queue whose binding the block does not map: once it maps the binding to
    // another queue, a consumer that happens to carry the declared name is not
    // that queue's.
    const match = (entry: QueueConsumerEntry): InferredQueue | undefined => {
        const binding = producers.find((producer) => producer.queue === entry.queue)?.binding;

        if (binding !== undefined) {
            return queues.find((queue) => queue.bindingName === binding);
        }

        return queues.find((queue) => queue.name === entry.queue && !producers.some((producer) => producer.binding === queue.bindingName));
    };
    const retune = retuneConsumers(text, consumers, ["env", environment, "queues", "consumers"], match, owned, new Set(["dead_letter_queue"]));
    const unmatched = consumers
        .filter((entry) => entry.queue !== undefined && match(entry) === undefined)
        .map(
            (entry) =>
                `env.${environment}.queues.consumers/${String(entry.queue)}: no defineQueue export matches it — this block declares no producer mapping one of their bindings to "${String(entry.queue)}", and no export is named that — so it was not retuned. A consumer for a queue another worker produces is skipped the same way.`,
        );
    const missingDeadLetter = consumers.flatMap((entry) => {
        const declared = match(entry)?.tuning.deadLetterQueue;

        return declared === undefined || entry.dead_letter_queue !== undefined
            ? []
            : [
                  `env.${environment}.queues.consumers/${String(entry.queue)}: defineQueue declares deadLetterQueue "${declared}", but this consumer has no dead_letter_queue, so its exhausted messages are dropped. Queue names differ per environment, so reconcile does not write it here; add it by hand.`,
              ];
    });

    return { added: [], owned: retune.owned, text: retune.text, updated: retune.updated, warnings: [...retune.warnings, ...missingDeadLetter, ...unmatched] };
};

/**
 * The {@link OwnedTuning} record, by scope, from `package.json`; `{}` when none
 * is recorded, appending to `warnings` when one IS there but cannot be used.
 * Degrading to "reconcile owns nothing" is the safe direction: it can only
 * leave a removed option deployed, never delete one set by hand.
 */
const readOwnedTuning = (manifest: Manifest | undefined, warnings: string[]): Record<string, OwnedTuning> => {
    if (manifest?.lunoraIsForeign === true) {
        warnings.push(
            `${manifest.path}: \`lunora\` is not an object, so the queue tuning ownership record cannot be read or written — an option removed from defineQueue stays deployed.`,
        );

        return {};
    }

    const recorded = manifest?.lunora?.[QUEUE_TUNING_RECORD];
    const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

    if (recorded === undefined) {
        return {};
    }

    if (!isObject(recorded) || !Object.values(recorded).every((scope) => isObject(scope) && Object.values(scope).every((fields) => isObject(fields)))) {
        warnings.push(
            `${manifest?.path ?? "package.json"}: \`lunora.${QUEUE_TUNING_RECORD}\` is not a map of scope → queue → fields, so it is ignored — an option removed from defineQueue stays deployed until the next pass records it again.`,
        );

        return {};
    }

    return recorded as Record<string, OwnedTuning>;
};

/** Record `owned` for each scope in `scopes`, dropping a scope left empty and the whole record once nothing is owned. */
const recordOwnedTuning = (manifest: Manifest, recorded: Record<string, OwnedTuning>, scopes: Record<string, OwnedTuning>): void => {
    const next = Object.fromEntries(Object.entries({ ...recorded, ...scopes }).filter(([, owned]) => Object.keys(owned).length > 0));

    recordManifestKey(manifest, QUEUE_TUNING_RECORD, Object.keys(next).length === 0 ? undefined : next);
};

export type { OwnedTuning };
export { readOwnedTuning, reconcileEnvQueues, reconcileQueues, recordOwnedTuning };
