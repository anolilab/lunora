/**
 * The stub release an emergency stop converges a tenant onto (`./halt.ts`).
 *
 * A stopped tenant's code must stop running — chiefly a Durable Object alarm
 * that keeps re-arming itself — while its data stays exactly where it is. On
 * both Cloudflare targets a converge DELETES the data of a Durable Object
 * class the new script stops binding (`TARGETS[target].dropsUnboundClasses`:
 * Alchemy emits `deleted_classes` for it). So the stub binds every Durable
 * Object and Workflow class that may be on the Worker — the classes recorded
 * for the alias's Worker (`./worker-classes.ts`), keyed by class name, under
 * their own binding names where those are free — and nothing else: no assets,
 * no secrets, no crons, no queue consumers.
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

/** The class-backed binding types: the ones whose data a converge can delete. */
const CLASS_TYPES: ReadonlySet<string> = new Set(["durable_object", "workflow"]);

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

/**
 * One class a Worker binds. Data lives per CLASS, not per binding: the
 * binding is only the `env` name the class is reached by. `sqlite` is the
 * manifest's flag, kept for display — the provision box never sends it, and a
 * class keeps the storage it was created with whatever a later release says.
 */
export interface BoundClass {
    binding: string;
    className: string;
    sqlite?: boolean;
    type: string;
}

/** Every Durable Object and Workflow class a manifest binds, in manifest order. */
export const classesOf = (manifest: DeployManifest): BoundClass[] =>
    manifest.bindings.flatMap((requirement) => {
        if (!CLASS_TYPES.has(requirement.type)) {
            return [];
        }

        if (requirement.className === undefined) {
            throw new HaltStubError(`binding ${requirement.binding} (${requirement.type}) names no class`);
        }

        return [
            {
                binding: requirement.binding,
                className: requirement.className,
                ...(requirement.sqlite === undefined ? {} : { sqlite: requirement.sqlite }),
                type: requirement.type,
            },
        ];
    });

/**
 * The union of several class sets, keyed by CLASS name — the first list's
 * entry wins, so the classes on the Worker keep their binding names. A class
 * whose binding name another class already took is bound under a name of its
 * own (`HALTED_CLASS_&lt;n>`): two releases that bound one name to different
 * classes, or one class under different names, can never make a stub impossible.
 */
export const mergeClasses = (lists: ReadonlyArray<ReadonlyArray<BoundClass>>): BoundClass[] => {
    const byClass = new Map<string, BoundClass>();
    const bindings = new Set<string>();

    for (const bound of lists.flat()) {
        if (byClass.has(bound.className)) {
            continue;
        }

        let { binding } = bound;
        let index = 0;

        while (bindings.has(binding)) {
            binding = `HALTED_CLASS_${String(index)}`;
            index += 1;
        }

        bindings.add(binding);
        byClass.set(bound.className, { ...bound, binding });
    }

    return [...byClass.values()];
};

/** The classes a target can provision at all: a class of a type it refuses never existed on it. */
export const provisionableClasses = (classes: ReadonlyArray<BoundClass>, supports: (type: string) => boolean): BoundClass[] =>
    classes.filter((bound) => supports(bound.type));

const classKey = (bound: Pick<BoundClass, "className" | "type">): string => `${bound.type}:${bound.className}`;

/** A manifest binding exactly `classes`. */
const manifestOf = (classes: ReadonlyArray<BoundClass>): DeployManifest => {
    return {
        bindings: classes.map((bound): BindingRequirement => {
            return {
                binding: bound.binding,
                className: bound.className,
                ...(bound.sqlite === undefined ? {} : { sqlite: bound.sqlite }),
                type: bound.type as BindingRequirement["type"],
            };
        }),
    };
};

/**
 * Refuse a stub that does not bind exactly `expected` — the classes that may
 * be on the Worker, by class name and type — or that would stop binding one
 * of them (the converge deletes that class's data). `dropped` is
 * `droppedDurableObjectClasses` (`./release.ts`), the check a rollback runs,
 * passed in so this module stays free of the release wiring.
 * @throws {HaltStubError} naming every class that differs.
 */
export const assertStubKeepsClasses = (
    stub: DeployManifest,
    expected: ReadonlyArray<BoundClass>,
    dropped: (previous: DeployManifest, next: DeployManifest) => string[],
): void => {
    const want = new Set(expected.map((bound) => classKey(bound)));
    const have = new Set(classesOf(stub).map((bound) => classKey(bound)));
    const differences = [
        ...[...want].filter((key) => !have.has(key)).map((key) => `missing ${key}`),
        ...[...have].filter((key) => !want.has(key)).map((key) => `unexpected ${key}`),
    ];
    const deleted = dropped(manifestOf(expected), stub);

    if (deleted.length > 0) {
        differences.push(`would delete the data of ${deleted.join(", ")}`);
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
    const exported = new Map<string, string>();

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
 * Generate the stub release binding exactly `classes` — merged
 * ({@link mergeClasses}) and filtered to what the target provisions by the
 * caller — with the Worker's compatibility settings. The caller runs
 * {@link assertStubKeepsClasses} before converging it.
 * @throws {HaltStubError} when a class or binding name is not one a Worker can export.
 */
export const buildHaltStub = (
    classes: ReadonlyArray<BoundClass>,
    options: { compatibilityDate?: string; compatibilityFlags?: ReadonlyArray<string>; reason: string },
): HaltStub => {
    for (const bound of classes) {
        checkClass(bound);
    }

    const source = stubSource(classes, options.reason);

    return {
        bundle: new TextEncoder().encode(source).buffer,
        manifest: {
            ...manifestOf(classes),
            ...(options.compatibilityDate === undefined ? {} : { compatibilityDate: options.compatibilityDate }),
            ...(options.compatibilityFlags === undefined ? {} : { compatibilityFlags: [...options.compatibilityFlags] }),
        },
        source,
    };
};
