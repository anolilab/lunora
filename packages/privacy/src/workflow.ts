/**
 * `@lunora/privacy/workflow`: the RPC layer a durable workflow needs. A workflow step has no
 * database handle, so it reaches the app's ports through one internal mutation. This module is
 * both ends of that hop. The internal mutation, which has `ctx.db`, takes `{ method, payload }`
 * and returns `dispatchPort(privacyConfig, localPorts(ctx), method, payload)`. The workflow's ports
 * are `remotePorts((call) => ctx.run(internal.privacy.privacyPort, call))`.
 *
 * Both ends derive from {@link PORT_METHODS}, so a port method cannot be reachable on one side
 * and missing on the other. A dataset crosses the wire by id and the erasure disposition does not
 * cross it at all: the dispatcher rebuilds both from the same config `definePrivacy` reads.
 */
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import { LunoraError } from "@lunora/errors";

import type { Dataset } from "./dataset";
import { dispositionFor } from "./erasure";
import type { PrivacyPreset } from "./rules";
import { retentionRulesOf } from "./rules";
import type { PrivacyPorts } from "./run";

/** The ports a workflow reaches over the wire. The clock and the id source stay on the caller's side. */
type RemotePort = Exclude<keyof PrivacyPorts, "newId" | "now">;

/**
 * Every port method the wire carries, by port. Typed against {@link PrivacyPorts}: a port method
 * missing here, or listed here but absent from the port, fails to compile.
 */
/** One `true` per method of every remote port: the compiler refuses a missing or an extra method. */
type PortMethodTable = { readonly [P in RemotePort]-?: { readonly [M in keyof NonNullable<PrivacyPorts[P]>]-?: true } };

const PORT_METHODS: PortMethodTable = {
    archive: { purgeBatch: true },
    data: { collect: true, eraseBatch: true, remaining: true },
    files: { delete: true, list: true, put: true, read: true, signedUrl: true },
    store: { addEvent: true, findOpen: true, get: true, insert: true, listForSubject: true, listOpen: true, update: true },
    tombstones: { add: true, keys: true },
};

/** A port method's wire name: the port and the method, as `"data.collect"`. */
type PortMethod = { [P in RemotePort]: `${P}.${keyof PortMethodTable[P] & string}` }[RemotePort];

const isRemotePort = (name: string): name is RemotePort => Object.hasOwn(PORT_METHODS, name);

/** Every wire name, in table order. */
const portMethods = (): ReadonlyArray<PortMethod> =>
    Object.entries(PORT_METHODS).flatMap(([port, methods]) => Object.keys(methods).map((method) => `${port}.${method}` as PortMethod));

/** Split a wire name into its port and method, or refuse one the table does not list. */
const parseMethod = (name: string): { readonly method: string; readonly port: RemotePort } => {
    const [port = "", method = "", ...rest] = name.split(".");

    if (rest.length > 0 || !isRemotePort(port) || !Object.hasOwn(PORT_METHODS[port], method)) {
        throw new LunoraError("BAD_REQUEST", `Unknown privacy port call "${name}".`);
    }

    return { method, port };
};

/** The tags the codec writes. A plain object whose only key is a tag is escaped, so data never reads as one. */
const TAGS = ["$bytes", "$date", "$object", "$set", "$undefined"] as const;

const looksTagged = (value: object): boolean => {
    const keys = Object.keys(value);

    return keys.length === 1 && (TAGS as ReadonlyArray<string>).includes(keys[0] ?? "");
};

const toWire = (value: unknown): unknown => {
    if (value === undefined) {
        return { $undefined: true };
    }

    if (value instanceof Date) {
        return { $date: value.toISOString() };
    }

    if (value instanceof Set) {
        return { $set: [...value].map((item) => toWire(item)) };
    }

    if (value instanceof Uint8Array) {
        return { $bytes: Buffer.from(value).toString("base64") };
    }

    if (Array.isArray(value)) {
        return value.map((item) => toWire(item));
    }

    if (value !== null && typeof value === "object") {
        const encoded = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toWire(item)]));

        return looksTagged(value) ? { $object: encoded } : encoded;
    }

    return value;
};

const fromWire = (value: unknown): unknown => {
    if (Array.isArray(value)) {
        return value.map((item) => fromWire(item));
    }

    if (value === null || typeof value !== "object") {
        return value;
    }

    const entries = Object.entries(value);
    const [tag, inner] = entries.length === 1 ? (entries[0] ?? []) : [];

    switch (tag) {
        case "$bytes": {
            return new Uint8Array(Buffer.from(String(inner), "base64"));
        }
        case "$date": {
            return new Date(String(inner));
        }
        case "$object": {
            return Object.fromEntries(Object.entries(inner as object).map(([key, item]) => [key, fromWire(item)]));
        }
        case "$set": {
            return new Set(Array.isArray(inner) ? inner.map((item) => fromWire(item)) : []);
        }
        case "$undefined": {
            return undefined;
        }
        default: {
            return Object.fromEntries(entries.map(([key, item]) => [key, fromWire(item)]));
        }
    }
};

/**
 * Write a value as JSON text that keeps a `Date`, a `Set`, a `Uint8Array` and `undefined`. Plain JSON
 * turns `undefined` into `null` inside an argument list, which a validator then refuses.
 */
const encodeWire = (value: unknown): string => JSON.stringify(toWire(value));

/** Read text {@link encodeWire} wrote. */
const decodeWire = (text: string): unknown => fromWire(JSON.parse(text));

/** The part of the `definePrivacy` config the dispatcher reads: the datasets and the presets. */
interface DispatchConfig {
    readonly datasets: ReadonlyArray<Dataset>;
    readonly presets?: ReadonlyArray<PrivacyPreset>;
}

/** Call a method on a port object by name. The name was checked against {@link PORT_METHODS}. */
const callPort = async (target: object, method: string, args: ReadonlyArray<unknown>): Promise<unknown> => {
    const run: unknown = Reflect.get(target, method);

    if (typeof run !== "function") {
        throw new LunoraError("INTERNAL", `The privacy port has no method "${method}".`);
    }

    return Reflect.apply(run, target, args) as Promise<unknown>;
};

/**
 * Run one port call on the server side of the hop: decode the arguments, call the app's own port,
 * and encode the result. A data call names its dataset by id, which is looked up in `config`, and an
 * `eraseBatch` gets the disposition the presets' retention rules give.
 */
const dispatchPort = async (config: DispatchConfig, ports: PrivacyPorts, method: string, payload: string): Promise<string> => {
    const call = parseMethod(method);
    const decoded = decodeWire(payload);

    if (!Array.isArray(decoded)) {
        throw new LunoraError("BAD_REQUEST", `The privacy port call "${method}" needs an argument list.`);
    }

    const args: ReadonlyArray<unknown> = decoded;

    const target = ports[call.port];

    if (target === undefined) {
        throw new LunoraError("BAD_REQUEST", `The privacy port "${call.port}" is not bound for this call.`);
    }

    let values: ReadonlyArray<unknown> = args;

    if (call.port === "data") {
        const [datasetId, ...rest] = args;
        const dataset = config.datasets.find((candidate) => candidate.id === datasetId);

        if (dataset === undefined) {
            throw new LunoraError("BAD_REQUEST", `No privacy dataset with id "${String(datasetId)}".`);
        }

        values = call.method === "eraseBatch" ? [dataset, ...rest.slice(0, 2), dispositionFor(retentionRulesOf(config.presets ?? []))] : [dataset, ...rest];
    }

    return encodeWire(await callPort(target, call.method, values));
};

/** Send one encoded port call across the hop and resolve to the encoded result text. */
type PortTransport = (call: { readonly method: string; readonly payload: string }) => Promise<unknown>;

/**
 * The arguments a call sends. A dataset goes as its id, since its `files.prefix` function cannot cross
 * JSON, and `eraseBatch` sends no disposition: the dispatcher rebuilds it.
 */
const wireArguments = (port: RemotePort, method: string, args: ReadonlyArray<unknown>): ReadonlyArray<unknown> => {
    if (port !== "data") {
        return args;
    }

    const [dataset, ...rest] = args as [Dataset, ...unknown[]];

    return method === "eraseBatch" ? [dataset.id, ...rest.slice(0, 2)] : [dataset.id, ...rest];
};

/**
 * The ports for a workflow step: every method is one call through `send`, which the app points at
 * its internal port mutation, so each read and write runs in a database transaction. The result is
 * a plain object, so an app may spread it and replace a port it reaches another way. The clock and
 * the id source run locally.
 */
const remotePorts = (send: PortTransport): Required<PrivacyPorts> => {
    const call = async (port: RemotePort, method: string, args: ReadonlyArray<unknown>): Promise<unknown> => {
        const name = `${port}.${method}`;
        const text = await send({ method: name, payload: encodeWire(wireArguments(port, method, args)) });

        if (typeof text !== "string") {
            throw new LunoraError("INTERNAL", `The privacy port call "${name}" returned no result.`);
        }

        return decodeWire(text);
    };

    const ports = Object.fromEntries(
        Object.entries(PORT_METHODS).map(([port, methods]) => [
            port,
            Object.fromEntries(Object.keys(methods).map((method) => [method, async (...args: unknown[]) => call(port as RemotePort, method, args)])),
        ]),
    );

    // Built from PORT_METHODS, which the compiler checks against every port method, so the shape is
    // complete; only the per-method signatures are asserted here, and the wire codec carries them.
    return {
        ...(ports as unknown as Pick<Required<PrivacyPorts>, RemotePort>),
        newId: () => randomUUID(),
        now: () => new Date(),
    };
};

export { decodeWire, type DispatchConfig, dispatchPort, encodeWire, PORT_METHODS, type PortMethod, portMethods, type PortTransport, remotePorts };
