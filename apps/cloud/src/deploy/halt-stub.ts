/**
 * The stub release an emergency stop converges a tenant onto (`./halt.ts`).
 *
 * A stopped tenant's code must stop running — chiefly a Durable Object alarm
 * that keeps re-arming itself — while its data stays exactly where it is. On
 * both Cloudflare targets a converge DELETES the data of a Durable Object
 * class the new script stops binding (`TARGETS[target].dropsUnboundClasses`:
 * Alchemy emits `deleted_classes` for it). So the stub is generated from the
 * manifests of what may be on the Worker and binds every Durable Object and
 * Workflow class they bind, under the same binding and class names and storage
 * flag — and nothing else: no assets, no secrets, no crons, no queue consumers.
 * The project stack is additive (`containers/provision/program.mjs`), so a
 * resource the stub stops binding is kept, and a resume binds it again.
 *
 * The stub's code is ours, never the tenant's:
 *
 * - `fetch` answers 503 with `{"error":"project halted: &lt;reason>"}` — on the
 *   Worker and on every Durable Object class.
 * - `alarm()` PARKS the alarm: it re-arms it {@link PARK_ALARM_MS} out instead
 *   of running anything. A Durable Object alarm that runs without setting a new
 *   one is gone, and with it the tenant's schedule; parked, the tenant's own
 *   `alarm()` runs again within {@link PARK_ALARM_MS} of a resume. The price is
 *   one alarm invocation and one storage write per parked object per period.
 *   A failed re-arm throws on purpose: Cloudflare retries a throwing alarm, so
 *   the park gets another chance, where a swallowed failure would drop it.
 * - Workflow classes are exported so the class keeps its registration; an
 *   instance that runs while halted fails with the same message.
 * - No `scheduled` or `queue` handler: on `cloudflare-workers` the stub release
 *   carries no crons and binds no consumer, so Alchemy removes them from the
 *   Worker; a resume restores them.
 *
 * Tenant strings never reach the source as code: class names are checked
 * against the same grammar the provision box enforces and only ever appear as
 * export aliases of classes named here (`export { HaltedClass0 as Name }`), so
 * a class named `Response` cannot shadow a global the stub itself uses, and the
 * reason travels as a JSON string literal.
 */
import type { BindingRequirement, DeployManifest } from "../provision-contract";

/** How far out a parked alarm is re-armed: the most a resumed tenant waits for its own alarm to run again. */
export const PARK_ALARM_MS = 60 * 60 * 1000;

/** A class-backed binding the stub must keep: these are the ones whose data a converge can delete. */
type ClassType = "durable_object" | "workflow";

const CLASS_TYPES: ReadonlySet<BindingRequirement["type"]> = new Set<ClassType>(["durable_object", "workflow"]);

/**
 * The class-name grammar `containers/provision/plan.mjs` enforces (`CLASS_NAME`)
 * — a release whose class does not match never converged, so a stub is never
 * generated for one.
 */
const CLASS_NAME = /^[A-Za-z_$][\w$]{0,127}$/u;

/** `env` binding names, as the provision box enforces them (`BINDING_NAME`). */
const BINDING_NAME = /^[A-Za-z_]\w{0,63}$/u;

/** Why a stub cannot be generated, or would not keep every class — always before anything converges. */
export class HaltStubError extends Error {}

/** One class the Worker binds, as the stub must keep it. */
export interface BoundClass {
    binding: string;
    className: string;
    sqlite?: boolean;
    type: ClassType;
}

const isClassRequirement = (requirement: BindingRequirement): requirement is BindingRequirement & { type: ClassType } => CLASS_TYPES.has(requirement.type);

/** Every Durable Object and Workflow class a manifest binds, keyed `type:binding`. */
export const boundClasses = (manifest: DeployManifest): Map<string, BoundClass> => {
    const classes = new Map<string, BoundClass>();

    for (const requirement of manifest.bindings) {
        if (!isClassRequirement(requirement)) {
            continue;
        }

        if (requirement.className === undefined) {
            throw new HaltStubError(`binding ${requirement.binding} (${requirement.type}) names no class`);
        }

        classes.set(`${requirement.type}:${requirement.binding}`, {
            binding: requirement.binding,
            className: requirement.className,
            ...(requirement.sqlite === undefined ? {} : { sqlite: requirement.sqlite }),
            type: requirement.type,
        });
    }

    return classes;
};

const describeClass = (bound: BoundClass): string => {
    if (bound.type === "workflow") {
        return `${bound.binding} → ${bound.className} (workflow)`;
    }

    return `${bound.binding} → ${bound.className} (${bound.sqlite === true ? "sqlite" : "kv"} storage)`;
};

const sameClass = (a: BoundClass, b: BoundClass): boolean => a.className === b.className && a.type === b.type && a.sqlite === b.sqlite;

/**
 * The classes a stub must bind: the union of every manifest that may be on the
 * Worker. Two manifests that bind one name to different classes, or one class
 * under different storage, cannot both be kept, so the stub is refused.
 */
const unionOfClasses = (manifests: ReadonlyArray<DeployManifest>): Map<string, BoundClass> => {
    const union = new Map<string, BoundClass>();

    for (const manifest of manifests) {
        for (const [key, bound] of boundClasses(manifest)) {
            const known = union.get(key);

            if (known !== undefined && !sameClass(known, bound)) {
                throw new HaltStubError(`binding ${bound.binding} is ${describeClass(known)} in one release and ${describeClass(bound)} in another`);
            }

            union.set(key, bound);
        }
    }

    return union;
};

/**
 * Refuse a stub that does not bind exactly the classes of every manifest that
 * may be on the Worker — same binding names, class names and storage flags —
 * or that would stop binding a class any of them binds (the converge deletes
 * that class's data). `dropped` is `droppedDurableObjectClasses`
 * (`./release.ts`), the check a rollback already runs, passed in so this
 * module stays free of the release wiring.
 * @throws {HaltStubError} naming every class that differs.
 */
export const assertStubKeepsClasses = (
    stub: DeployManifest,
    onWorker: ReadonlyArray<DeployManifest>,
    dropped: (previous: DeployManifest, next: DeployManifest) => string[],
): void => {
    if (onWorker.length === 0) {
        throw new HaltStubError("no release is known to be on the Worker, so the classes a stub must keep are unknown");
    }

    const expected = unionOfClasses(onWorker);
    const actual = boundClasses(stub);
    const differences: string[] = [];

    for (const [key, bound] of expected) {
        const kept = actual.get(key);

        if (kept === undefined) {
            differences.push(`missing ${describeClass(bound)}`);
        } else if (!sameClass(kept, bound)) {
            differences.push(`${describeClass(kept)} instead of ${describeClass(bound)}`);
        }
    }

    for (const [key, bound] of actual) {
        if (!expected.has(key)) {
            differences.push(`unexpected ${describeClass(bound)}`);
        }
    }

    const deleted = onWorker.flatMap((manifest) => dropped(manifest, stub));

    if (deleted.length > 0) {
        differences.push(`would delete the data of ${[...new Set(deleted)].join(", ")}`);
    }

    if (differences.length > 0) {
        throw new HaltStubError(`the stub does not keep the Worker's classes: ${differences.join("; ")}`);
    }
};

/** A generated stub release. */
export interface HaltStub {
    /** The stub module, as the bytes the driver uploads. */
    bundle: ArrayBuffer;
    /** Every class binding of the Worker, and nothing else. */
    manifest: DeployManifest;
    /** The stub module's source (the same bytes as `bundle`). */
    source: string;
}

/** The 503 body every request to a halted tenant gets. */
export const haltedBody = (reason: string): string => JSON.stringify({ error: `project halted: ${reason}` });

const checkClass = (bound: BoundClass): void => {
    if (!CLASS_NAME.test(bound.className) || bound.className === "default") {
        throw new HaltStubError(`class name ${JSON.stringify(bound.className)} of binding ${bound.binding} is not one a Worker can export`);
    }

    if (!BINDING_NAME.test(bound.binding)) {
        throw new HaltStubError(`binding name ${JSON.stringify(bound.binding)} is not valid`);
    }
};

/** The stub module for `classes`, answering `reason`. */
const stubSource = (classes: ReadonlyArray<BoundClass>, reason: string): string => {
    // One class per exported name, so two bindings of one class still export it once.
    const exported = new Map<string, ClassType>();

    for (const bound of classes) {
        exported.set(bound.className, bound.type);
    }

    const names = [...exported].toSorted(([a], [b]) => a.localeCompare(b));
    const hasWorkflow = names.some(([, type]) => type === "workflow");
    const lines = [
        `import { DurableObject${hasWorkflow ? ", WorkflowEntrypoint" : ""} } from "cloudflare:workers";`,
        "",
        "// Generated by Lunora Cloud's emergency stop. This project is halted; none of its own code runs.",
        `const PARK_ALARM_MS = ${String(PARK_ALARM_MS)};`,
        `const HALTED_BODY = ${JSON.stringify(haltedBody(reason))};`,
        "",
        "const halted = () =>",
        '    new Response(HALTED_BODY, { headers: { "cache-control": "no-store", "content-type": "application/json", "retry-after": "3600" }, status: 503 });',
        "",
        "class HaltedObject extends DurableObject {",
        "    fetch() {",
        "        return halted();",
        "    }",
        "",
        "    // Park the alarm rather than run it: re-armed, so the project's own alarm runs again after a resume.",
        "    // A failed re-arm throws, and Cloudflare retries the alarm.",
        "    async alarm() {",
        "        await this.ctx.storage.setAlarm(Date.now() + PARK_ALARM_MS);",
        "    }",
        "}",
        ...(hasWorkflow
            ? [
                  "",
                  "class HaltedWorkflow extends WorkflowEntrypoint {",
                  "    async run() {",
                  "        throw new Error(JSON.parse(HALTED_BODY).error);",
                  "    }",
                  "}",
              ]
            : []),
        "",
        ...names.map(([, type], index) => `class HaltedClass${String(index)} extends ${type === "workflow" ? "HaltedWorkflow" : "HaltedObject"} {}`),
        ...(names.length > 0 ? ["", `export { ${names.map(([name], index) => `HaltedClass${String(index)} as ${name}`).join(", ")} };`] : []),
        "",
        "export default { fetch: () => halted() };",
        "",
    ];

    return lines.join("\n");
};

/**
 * Generate the stub release for a Worker that may be running any of
 * `onWorker` (newest first: its compatibility settings are the stub's). The
 * stub binds exactly their classes ({@link assertStubKeepsClasses} is the
 * caller's to run before converging it).
 * @throws {HaltStubError} when the manifests disagree on a class, or name one a Worker cannot export.
 */
export const buildHaltStub = (onWorker: ReadonlyArray<DeployManifest>, reason: string): HaltStub => {
    if (onWorker.length === 0) {
        throw new HaltStubError("no release is known to be on the Worker, so the classes a stub must keep are unknown");
    }

    const [newest] = onWorker;
    const classes = [...unionOfClasses(onWorker).values()];

    for (const bound of classes) {
        checkClass(bound);
    }

    const source = stubSource(classes, reason);

    return {
        bundle: new TextEncoder().encode(source).buffer,
        manifest: {
            bindings: classes.map((bound): BindingRequirement => {
                return {
                    binding: bound.binding,
                    className: bound.className,
                    ...(bound.sqlite === undefined ? {} : { sqlite: bound.sqlite }),
                    type: bound.type,
                };
            }),
            ...(newest.compatibilityDate === undefined ? {} : { compatibilityDate: newest.compatibilityDate }),
            ...(newest.compatibilityFlags === undefined ? {} : { compatibilityFlags: [...newest.compatibilityFlags] }),
        },
        source,
    };
};
