/**
 * The recording `ctx.topics` the `lunoraTest` harness hands mutation and action
 * contexts. Built by `@lunora/queue`'s own `createTopicContext`, so a publish is
 * validated as in production (batch cap, delay ceiling, reserved key, unknown
 * topic name), and recorded through the same recorder as `ctx.queues`, so bodies
 * are wire-encoded and size-checked the same way.
 *
 * Each topic is wired to a single recording subscription: a publish is recorded
 * once per message, however many subscriptions the app declares, and no
 * subscription handler runs.
 */
import type { QueueContentType, Topics } from "@lunora/queue";
import { createTopicContext } from "@lunora/queue";

import { stubProxy, unavailable } from "./context-fakes";
import { createRecorder } from "./fake-queues";

/** One message a handler published through `ctx.topics.<name>`, as a subscriber decodes it. */
interface PublishedTopicMessage {
    body: unknown;
    contentType?: QueueContentType;
    delaySeconds?: number;
    /** The `lunora/queues.ts` topic export name the message was published to. */
    topic: string;
}

/**
 * Inspect what handlers published. Like queue sends, a publish is not
 * transactional, so one made by a mutation that then threw stays recorded.
 */
interface FakeTopicControls {
    /** Forget every recorded message. */
    clear: () => void;
    /** Recorded messages in publish order, optionally only those published to `topic`; an undeclared `topic` throws. */
    published: (topic?: string) => PublishedTopicMessage[];
}

/** `ctx.topics`: codegen adds it to mutation and action contexts when `lunora/queues.ts` declares topics. */
interface TopicSurface {
    topics: Topics;
}

const OPTION = "topics: [...]";

/**
 * The recording `ctx.topics` for `names`; without the option, a stub that throws
 * naming it — and a `published()` that throws too, so a handler swallowing the
 * stub's error cannot make "nothing was published" pass vacuously.
 */
const createFakeTopics = (names: ReadonlyArray<string> | undefined): { controls: FakeTopicControls; surfaces: TopicSurface } => {
    if (names === undefined) {
        return {
            controls: { clear: () => unavailable("topics", OPTION), published: () => unavailable("topics", OPTION) },
            surfaces: { topics: stubProxy("topics", OPTION) as Topics },
        };
    }

    const recorder = createRecorder(names);
    // The recorder's bindings are keyed by topic name, so each topic's one subscription binds by that name.
    const topics = createTopicContext(
        recorder.bindings,
        names.map((name) => {
            return { exportName: name, subscriptions: [{ binding: name, exportName: name }] };
        }),
    );

    return {
        controls: {
            clear: recorder.clear,
            published: (topic) =>
                recorder.read(topic, "harness.topics.published", "topic").map(({ destination, ...message }) => {
                    return { ...message, topic: destination };
                }),
        },
        surfaces: { topics },
    };
};

export type { FakeTopicControls, PublishedTopicMessage, TopicSurface };
export { createFakeTopics };
