/**
 * Reconcile the `services[]` entries for the sibling Workers declared in
 * `lunora.config` `services` (plan 457), top level and in every `env.<name>`
 * block the app's wrangler config declares (`services` is non-inheritable).
 *
 * Lunora owns an entry it wrote, recorded in `package.json` `lunora.services`
 * (scope → binding names, like `lunora.queueTuning`): an owned entry follows
 * its declaration and goes when the declaration does. Every other entry is
 * hand-written and never touched — one that claims a declared service's
 * binding is reported, not overwritten.
 */
import { existsSync, writeFileSync } from "node:fs";

import type { ServiceBindingIR } from "@lunora/codegen";

import { applyModify } from "../jsonc-edit";
import join from "../path";
import type { Manifest } from "./lunora-manifest";
import { canonical, recordManifestKey } from "./lunora-manifest";
import { readWranglerJsonc } from "./wrangler-path";
import type { ReconcileStep, WranglerShape } from "./wrangler-shape";

/** The `package.json` `lunora` key holding the binding names this reconciler wrote, per scope. */
const SERVICES_RECORD = "services";

/** The top-level scope's key in the record; an env block's is `env.<name>.services`. */
const TOP_LEVEL_SCOPE = "services";

/**
 * The dev-only config the SvelteKit / Nuxt `wrangler dev` sidecar runs. Its
 * worker owns the `ShardDO` the actions run in, so its `services[]` needs the
 * same bindings; recorded under {@link DEV_CONFIG_SCOPE}.
 */
const DEV_CONFIG = "wrangler.dev.jsonc";

const DEV_CONFIG_SCOPE = "dev:services";

/** Scope (`services` / `env.<name>.services` / `dev:services`) → the binding names Lunora wrote there. */
type OwnedServices = Record<string, string[]>;

interface ServiceEntry {
    binding?: unknown;
    entrypoint?: unknown;
    service?: unknown;
}

type ServicesShape = WranglerShape & { services?: ReadonlyArray<ServiceEntry | null | undefined> };

/** The entry Lunora writes for `service` in `environment` (top level when `undefined`). */
const entryFor = (service: ServiceBindingIR, environment: string | undefined): Record<string, string> => {
    const worker = environment === undefined ? service.worker : (service.envWorkers[environment] ?? `${service.worker}-${environment}`);

    return { binding: service.binding, ...(service.entrypoint === undefined ? {} : { entrypoint: service.entrypoint }), service: worker };
};

const bindingOf = (entry: ServiceEntry | null | undefined): string => (typeof entry?.binding === "string" ? entry.binding : "");

/** One scope's `services[]` brought in line with the declarations. */
const reconcileScope = (
    text: string,
    path: ReadonlyArray<string>,
    current: ReadonlyArray<ServiceEntry | null | undefined>,
    declared: ReadonlyArray<ServiceBindingIR>,
    owned: ReadonlySet<string>,
    environment: string | undefined,
): ReconcileStep & { owned: string[] } => {
    const scope = path.join(".");
    const desired = new Map(declared.map((service) => [service.binding, entryFor(service, environment)]));
    const handWritten = current.filter((entry) => !owned.has(bindingOf(entry)));
    const handWrittenBindings = new Set(handWritten.map((entry) => bindingOf(entry)));
    const previous = new Map(current.filter((entry) => owned.has(bindingOf(entry))).map((entry) => [bindingOf(entry), entry]));
    // A hand-written entry wins over a declaration of the same binding.
    const ours = [...desired].filter(([binding]) => !handWrittenBindings.has(binding));
    const next = [...handWritten, ...ours.map(([, entry]) => entry)];
    const added = ours.filter(([binding]) => !previous.has(binding)).map(([binding, entry]) => `${scope}/${binding} → ${entry.service ?? ""}`);
    const updated = [
        ...ours
            .filter(([binding, entry]) => previous.has(binding) && canonical(previous.get(binding)) !== canonical(entry))
            .map(([binding]) => `${scope}/${binding}`),
        ...[...previous.keys()].filter((binding) => !desired.has(binding)).map((binding) => `${scope}/${binding} (removed)`),
    ];
    const warnings = handWritten
        .filter((entry) => desired.has(bindingOf(entry)) && canonical(entry) !== canonical(desired.get(bindingOf(entry))))
        .map(
            (entry) =>
                `${scope}: the hand-written "${bindingOf(entry)}" entry is left as is — remove it to let lunora.config \`services\` manage that binding.`,
        );
    const changed = added.length > 0 || updated.length > 0;
    // An emptied list goes rather than lingering as `[]`.
    const written = next.length === 0 ? undefined : next;

    return {
        added,
        owned: ours.map(([binding]) => binding).toSorted((a, b) => a.localeCompare(b)),
        text: changed ? applyModify(text, path, written) : text,
        updated,
        warnings,
    };
};

/** The recorded ownership, or `{}` (owning nothing) when it is absent or not a map of scope → binding names. */
const readOwnedServices = (manifest: Manifest | undefined): OwnedServices => {
    const recorded = manifest?.lunora?.[SERVICES_RECORD];

    if (typeof recorded !== "object" || recorded === null || Array.isArray(recorded)) {
        return {};
    }

    return Object.fromEntries(
        Object.entries(recorded).filter((scope): scope is [string, string[]] => Array.isArray(scope[1]) && scope[1].every((name) => typeof name === "string")),
    );
};

/** The top-level service bindings Lunora wrote — the ones that run locally beside the app in dev. */
const ownedServiceBindings = (manifest: Manifest | undefined): ReadonlySet<string> => new Set(readOwnedServices(manifest)[TOP_LEVEL_SCOPE]);

/**
 * Bring the top-level and every `env.<name>` `services[]` in line with
 * `declared`. Returns the step plus the ownership to record once the config is
 * written (see {@link recordOwnedServices}).
 */
const reconcileServices = (
    text: string,
    parsed: ServicesShape,
    declared: ReadonlyArray<ServiceBindingIR>,
    recorded: OwnedServices,
): ReconcileStep & { owned: OwnedServices } => {
    const scopes: { current: ReadonlyArray<ServiceEntry | null | undefined>; environment?: string; path: string[] }[] = [
        { current: parsed.services ?? [], path: [TOP_LEVEL_SCOPE] },
        ...Object.entries(parsed.env ?? {}).map(([environment, block]) => {
            return { current: (block as ServicesShape | undefined)?.services ?? [], environment, path: ["env", environment, "services"] };
        }),
    ];
    const step: ReconcileStep & { owned: OwnedServices } = { added: [], owned: {}, text, updated: [], warnings: [] };

    for (const { current, environment, path } of scopes) {
        const key = path.join(".");
        const result = reconcileScope(step.text, path, current, declared, new Set(recorded[key]), environment);

        step.text = result.text;
        step.added.push(...result.added);
        step.updated?.push(...(result.updated ?? []));
        step.warnings?.push(...(result.warnings ?? []));

        if (result.owned.length > 0) {
            step.owned[key] = result.owned;
        }
    }

    return step;
};

/**
 * Bring the top-level `services[]` of the project's {@link DEV_CONFIG}, when it
 * has one, in line with `declared`, writing the file itself. Returns the labels
 * and the ownership to merge into the record (empty when there is no such file).
 */
const reconcileDevConfigServices = (
    projectRoot: string,
    declared: ReadonlyArray<ServiceBindingIR>,
    recorded: OwnedServices,
): Pick<ReconcileStep, "added" | "updated" | "warnings"> & { owned: OwnedServices } => {
    const path = join(projectRoot, DEV_CONFIG);
    const { parsed, text } = existsSync(path) ? readWranglerJsonc<ServicesShape>(path) : { parsed: undefined, text: "" };

    if (parsed === undefined) {
        return { added: [], owned: {}, updated: [], warnings: [] };
    }

    const step = reconcileScope(text, ["services"], parsed.services ?? [], declared, new Set(recorded[DEV_CONFIG_SCOPE]), undefined);

    if (step.text !== text) {
        writeFileSync(path, step.text, "utf8");
    }

    const label = (entry: string): string => `${DEV_CONFIG} ${entry}`;

    return {
        added: step.added.map((entry) => label(entry)),
        owned: step.owned.length > 0 ? { [DEV_CONFIG_SCOPE]: step.owned } : {},
        updated: (step.updated ?? []).map((entry) => label(entry)),
        warnings: (step.warnings ?? []).map((entry) => label(entry)),
    };
};

/** Record `owned`, dropping the key once nothing is owned. */
const recordOwnedServices = (manifest: Manifest, owned: OwnedServices): void => {
    recordManifestKey(manifest, SERVICES_RECORD, Object.keys(owned).length === 0 ? undefined : owned);
};

export type { OwnedServices };
export { ownedServiceBindings, readOwnedServices, reconcileDevConfigServices, reconcileServices, recordOwnedServices };
