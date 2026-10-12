/**
 * `@lunora/privacy/workflow`: the RPC layer a durable workflow needs. A workflow step has no
 * database handle, so it reaches the app's ports through one internal mutation. This module is
 * both ends of that hop. The internal mutation, which has `ctx.db`, takes `{ method, payload }`
 * and returns `dispatchPort(privacyConfig, localPorts(ctx), method, payload)`. The workflow's ports
 * are `remotePorts((call) => ctx.run(internal.privacy.privacyPort, call))`.
 *
 * Both ends read one codec per port method from {@link PORT_CODECS}: `encode` turns the call's
 * arguments into the wire tuple and `decode` turns the tuple back into the arguments the app's port
 * takes, both typed against the port method. A dataset crosses the wire by id and the erasure
 * disposition does not cross it at all: `decode` rebuilds both from the same config `definePrivacy`
 * reads. Values cross through the Lunora wire codec, so a `Date`, a `Set`, bytes and a `bigint`
 * arrive as they were sent.
 */
import { randomUUID } from "node:crypto";

import { LunoraError } from "@lunora/errors";

import { decodeWire, encodeWire } from "../../../shared/wire-codec";
import type { Dataset } from "./dataset";
import type { PrivacyConfig } from "./define";
import type { RowDisposition } from "./erasure";
import { dispositionForPresets } from "./erasure";
import type { PrivacyPorts } from "./ports";

/** The ports a workflow reaches over the wire. The clock and the id source stay on the caller's side. */
type RemotePort = Exclude<keyof PrivacyPorts, "newId" | "now">;

type PortOf<P extends RemotePort> = NonNullable<PrivacyPorts[P]>;

/** The widest function type, so `Parameters` applies to every port method. */
type AnyMethod = (...args: any[]) => unknown;

type ArgumentsOf<P extends RemotePort, M extends keyof PortOf<P>> = PortOf<P>[M] extends AnyMethod ? Parameters<PortOf<P>[M]> : never;

/**
 * The wire tuple of each data method. A dataset goes as its id, since its `files.prefix` function
 * cannot cross JSON, and `eraseBatch` sends no disposition. Every other method sends its arguments.
 */
interface DataWire {
    readonly collect: readonly [datasetId: string, subjectId: string];
    readonly eraseBatch: readonly [datasetId: string, subjectId: string, now: Date];
    readonly remaining: readonly [datasetId: string, subjectId: string];
}

type WireOf<P extends RemotePort, M extends keyof PortOf<P>> = P extends "data" ? (M extends keyof DataWire ? DataWire[M] : never) : ArgumentsOf<P, M>;

/** What `decode` reads on the dispatcher side: a dataset by id, and the disposition the presets give. */
interface DecodeContext {
    readonly dataset: (id: string) => Dataset;
    readonly disposition: () => RowDisposition;
}

/** One port method's two ends. Adding a parameter to the method fails `decode` until it supplies it. */
interface MethodCodec<A, W> {
    readonly decode: (wire: W, context: DecodeContext) => A;
    readonly encode: (args: A) => W;
}

type CodecTable = {
    readonly [P in RemotePort]-?: { readonly [M in keyof PortOf<P>]-?: MethodCodec<ArgumentsOf<P, M>, WireOf<P, M>> };
};

/** A method whose arguments cross the wire as they are. */
const asIs = <A>(): MethodCodec<A, A> => {
    return { decode: (wire) => wire, encode: (args) => args };
};

const PORT_CODECS: CodecTable = {
    archive: { purgeBatch: asIs() },
    data: {
        collect: {
            decode: ([datasetId, subjectId], context) => [context.dataset(datasetId), subjectId],
            encode: ([dataset, subjectId]) => [dataset.id, subjectId],
        },
        eraseBatch: {
            decode: ([datasetId, subjectId, now], context) => [context.dataset(datasetId), subjectId, now, context.disposition()],
            encode: ([dataset, subjectId, now]) => [dataset.id, subjectId, now],
        },
        remaining: {
            decode: ([datasetId, subjectId], context) => [context.dataset(datasetId), subjectId],
            encode: ([dataset, subjectId]) => [dataset.id, subjectId],
        },
    },
    files: { delete: asIs(), list: asIs(), put: asIs(), read: asIs(), signedUrl: asIs() },
    store: { addEvent: asIs(), claim: asIs(), findOpen: asIs(), get: asIs(), insert: asIs(), listForSubject: asIs(), listOpen: asIs(), update: asIs() },
    tombstones: { add: asIs(), keys: asIs() },
};

/** A codec once its method is chosen at run time by name. */
type ErasedCodec = MethodCodec<ReadonlyArray<unknown>, ReadonlyArray<unknown>>;

const isRemotePort = (name: string): name is RemotePort => Object.hasOwn(PORT_CODECS, name);

/** The codec of a wire name such as `"data.collect"`, or a refusal for a name the table does not list. */
const codecOf = (name: string): { readonly codec: ErasedCodec; readonly method: string; readonly port: RemotePort } => {
    const [port = "", method = "", ...rest] = name.split(".");

    if (rest.length > 0 || !isRemotePort(port) || !Object.hasOwn(PORT_CODECS[port], method)) {
        throw new LunoraError("BAD_REQUEST", `Unknown privacy port call "${name}".`);
    }

    // The table is typed per method; a name read at run time can only reach it erased.
    const codec = (PORT_CODECS[port] as unknown as Readonly<Record<string, ErasedCodec>>)[method] as ErasedCodec;

    return { codec, method, port };
};

const toText = (value: unknown): string => JSON.stringify(encodeWire(value));

const fromText = (text: string): unknown => decodeWire(JSON.parse(text));

/** Call a method on a port object by name. The name was checked against {@link PORT_CODECS}. */
const callPort = async (target: object, method: string, args: ReadonlyArray<unknown>): Promise<unknown> => {
    const run: unknown = Reflect.get(target, method);

    if (typeof run !== "function") {
        throw new LunoraError("INTERNAL", `The privacy port has no method "${method}".`);
    }

    return Reflect.apply(run, target, args) as Promise<unknown>;
};

/**
 * Run one port call on the server side of the hop: decode the arguments, call the app's own port,
 * and encode the result. `config` is the `definePrivacy` config, or any object with its datasets and
 * presets: a data call's dataset is looked up there by id, and an `eraseBatch` gets the disposition
 * the presets' retention rules give.
 */
const dispatchPort = async (
    config: Pick<PrivacyConfig<never>, "datasets" | "presets">,
    ports: PrivacyPorts,
    method: string,
    payload: string,
): Promise<string> => {
    const call = codecOf(method);
    const wire = fromText(payload);

    if (!Array.isArray(wire)) {
        throw new LunoraError("BAD_REQUEST", `The privacy port call "${method}" needs an argument list.`);
    }

    const target = ports[call.port];

    if (target === undefined) {
        throw new LunoraError("BAD_REQUEST", `The privacy port "${call.port}" is not bound for this call.`);
    }

    const context: DecodeContext = {
        dataset: (id) => {
            const dataset = config.datasets.find((candidate) => candidate.id === id);

            if (dataset === undefined) {
                throw new LunoraError("BAD_REQUEST", `No privacy dataset with id "${id}".`);
            }

            return dataset;
        },
        disposition: () => dispositionForPresets(config.presets ?? []),
    };

    return toText(await callPort(target, call.method, call.codec.decode(wire, context)));
};

/** Send one encoded port call across the hop and resolve to the encoded result text. */
type PortTransport = (call: { readonly method: string; readonly payload: string }) => Promise<unknown>;

/**
 * The ports for a workflow step: every method is one call through `send`, which the app points at
 * its internal port mutation, so each read and write runs in a database transaction. The result is
 * a plain object, so an app may spread it and replace a port it reaches another way. The clock and
 * the id source run locally.
 */
const remotePorts = (send: PortTransport): Required<PrivacyPorts> => {
    const call = async (name: string, args: ReadonlyArray<unknown>): Promise<unknown> => {
        const { codec } = codecOf(name);
        const text = await send({ method: name, payload: toText(codec.encode(args)) });

        if (typeof text !== "string") {
            throw new LunoraError("INTERNAL", `The privacy port call "${name}" returned no result.`);
        }

        return fromText(text);
    };

    const ports = Object.fromEntries(
        Object.entries(PORT_CODECS).map(([port, methods]) => [
            port,
            Object.fromEntries(Object.keys(methods).map((method) => [method, async (...args: unknown[]) => call(`${port}.${method}`, args)])),
        ]),
    );

    // Built from PORT_CODECS, which the compiler checks against every port method, so the shape is
    // complete; only the per-method signatures are asserted here, and each method's codec carries them.
    return {
        ...(ports as unknown as Pick<Required<PrivacyPorts>, RemotePort>),
        newId: () => randomUUID(),
        now: () => new Date(),
    };
};

export { dispatchPort, type PortTransport, remotePorts };
