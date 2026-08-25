/**
 * Assemble a `@lunora/platform/conformance` `ConformanceHost` from the Rivet
 * adapters in this package, so `defineHostContractSuite` runs the shared TCK
 * against this host exactly as it does against the `node:sqlite` reference
 * host, `@lunora/platform-node`, and (via `@lunora/do`'s workerd project)
 * Cloudflare.
 *
 * This is test-only wiring, not the package's public composition root — see
 * `createRivetPlatform` for the shape an app actually consumes. The one thing
 * it adds over that root is the action wiring an actor definition would
 * otherwise write by hand: the alarm and scheduler handlers are registered on
 * the double so Rivet's "a schedule invokes an action" model is exercised
 * end-to-end rather than short-circuited to a callback.
 */

import type { ConformanceHost } from "@lunora/platform/conformance";
import { pollJobDispatched, waitPastTarget } from "@lunora/platform/conformance";

import type { RivetWebSocketLike } from "../rivet-context";
import { createRivetShardKvStore } from "../rivet-kv-store";
import { createRivetSchedulerHost, RIVET_SCHEDULER_ACTION } from "../rivet-scheduler-host";
import { createRivetShardDirectory } from "../rivet-shard-directory";
import { createRivetShardHost, RIVET_ALARM_ACTION } from "../rivet-shard-host";
import { openRivetShardState } from "../rivet-shard-state";
import { createRivetSocketHost } from "../rivet-socket-host";
import type { RivetActorDouble } from "./rivet-actor-double";
import { createRivetActorDouble } from "./rivet-actor-double";
import { createRivetNamespaceDouble } from "./rivet-namespace-double";

/**
 * Build a fresh, isolated Rivet host for one TCK run.
 *
 * Async, unlike the Node and reference factories, because the working copy has
 * to be hydrated from the (empty) snapshot before anything can read it —
 * `ConformanceHostFactory` allows a promise for exactly this case.
 */
export const createRivetConformanceHost = async (): Promise<ConformanceHost> => {
    const actor: RivetActorDouble = createRivetActorDouble();
    const state = await openRivetShardState(actor);

    const { deliverAlarm, host: shard } = createRivetShardHost(actor, state);
    const { restoreSocket, simulateRecycle, socket } = createRivetSocketHost(state);
    const { kv, ready: kvReady } = createRivetShardKvStore(actor.db);

    /**
     * Frames each raw socket was handed.
     *
     * The suite's "accepts a socket and can send/close" leg only asserts
     * delivery where the host makes frames observable — and without a
     * `createSocket` it accepts a plain `{}`, which this host's `asTransport`
     * correctly refuses, so `send` becomes a no-op and a host that dropped
     * every frame would pass. Supplying a real transport with a recording
     * `send` turns that skipped branch into an assertion.
     */
    const transports: { frames: string[]; raw: RivetWebSocketLike }[] = [];

    /**
     * Job ids this host actually delivered.
     *
     * The TCK's "dispatches a scheduled job at least once" leg exists because a
     * host can expire a timer without ever invoking its delivery path.
     * Recording ids from a real `onDispatch` is what lets the suite tell
     * delivery apart from expiry — and it is the evidence for declaring
     * `deadLetter` at all, since that member is the at-least-once claim.
     */
    const dispatched = new Set<string>();
    const { deliverScheduledJob, parkJob, scheduler } = createRivetSchedulerHost(actor, {
        onDispatch: (_functionPath, _args, job) => {
            dispatched.add(job.id);
        },
    });

    await kvReady;

    // The action wiring a real actor definition carries. Registering it here
    // rather than calling the deliver* functions directly is the point: a
    // schedule armed by the adapter has to come back through Rivet's
    // action-by-name indirection, so a mismatch between the constant the
    // adapter arms with and the constant the actor handles would fail the TCK
    // rather than pass it.
    actor.actions.set(RIVET_ALARM_ACTION, async () => deliverAlarm());
    actor.actions.set(RIVET_SCHEDULER_ACTION, async (id) => deliverScheduledJob(id as string));

    return {
        awaitAlarmFired: async (target) => waitPastTarget(target),
        awaitJobDispatched: async (id) => pollJobDispatched(scheduler, dispatched, id),
        cleanup: () => {
            state.close();
            actor.cleanup();
        },
        createSocket: () => {
            const record: { frames: string[]; raw: RivetWebSocketLike } = {
                frames: [],
                raw: {
                    close: () => {
                        // Nothing to tear down: the recording is the transport.
                    },
                    send: (data) => {
                        // Text only: the suite's delivery leg sends a string,
                        // and stringifying a buffer would record
                        // "[object Object]" as if it were a frame.
                        record.frames.push(typeof data === "string" ? data : "<binary>");
                    },
                },
            };

            transports.push(record);

            return record.raw;
        },
        directory: createRivetShardDirectory(createRivetNamespaceDouble()),
        kv,
        readFrames: (handle) => transports.find((record) => socket.handleFor(record.raw) === handle)?.frames ?? [],
        restoreSocket,
        scheduler,
        shard,
        simulateDeadLetter: parkJob,
        simulateRecycle,
        socket,
    };
};

export type { RivetActionHandler, RivetActorDouble, RivetActorDoubleOptions, RivetDoubleCronJob } from "./rivet-actor-double";
export { createRivetActorDouble } from "./rivet-actor-double";
export type { RivetNamespaceDouble } from "./rivet-namespace-double";
export { createRivetNamespaceDouble } from "./rivet-namespace-double";
