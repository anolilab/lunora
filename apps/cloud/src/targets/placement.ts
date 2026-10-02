/**
 * Where a project's releases are converged — read from the database per
 * project, never from the process (plan 458 G3).
 *
 * The rule:
 *
 * 1. The TARGET is the project's (`projects.target`); a project that predates
 *    targets is `cloudflare-wfp`.
 * 2. A target placed in a CELL (`TARGETS[target].placedOn === "cell"`) puts its
 *    tenant in its organization's cell (`organizations.cellId` → `cells.name`):
 *    one Cloudflare account, one dispatch namespace, one control-plane
 *    deployment. `LUNORA_CELL` names the cell THIS control plane runs in and
 *    nothing else — it no longer decides where a release lands. A project whose
 *    organization is placed on another cell is refused, loudly: converging it
 *    here would put it in the wrong account, behind the wrong dispatcher, where
 *    nothing routes to it.
 * 3. Any other target places its tenant on a HOST row its organization owns,
 *    which the project names in its one placement column
 *    (`projects.placementRef`): a box it enrolled (`placedOn: "box"`, the
 *    `boxes` table) or a Cloudflare account it connected (`placedOn:
 *    "account"`, `cloudflareAccounts`). {@link PLACEMENT_HOSTS} says, per
 *    `placedOn`, which table the reference names and how to read it; nothing
 *    above this module branches on the kind of host.
 * 4. A box ignores the cell. A connected account is still converged by its
 *    organization's cell — that cell's provision box holds the convergence state
 *    (MULTIPLATFORM.md §5.3), and its sweeps read the account's usage — so
 *    rule 2's cell check applies to it too.
 *
 * The fleet-wide sweeps place a DEPLOYMENT rather than a project — its project
 * may be gone — through {@link placementOfDeployment}, off the host its own
 * `deployments.placementRef` names (copied from the project when the row is
 * created).
 */
import { LunoraError } from "@lunora/server";

import { lookupAccount } from "../cloudflare-accounts/store";
import type { AccountTargetId, BoxTargetId, CellTargetId, TargetDescriptor, TargetId } from "../provision-contract";
import { storedTarget, TARGET_IDS, TARGETS } from "../provision-contract";

/** Where a target puts its projects (`TargetDescriptor.placedOn`). */
export type PlacedOn = TargetDescriptor["placedOn"];

/** The kinds of placement that name a host row in `placementRef`. */
export type HostedOn = Exclude<PlacedOn, "cell">;

/** The box a box-placed project converges on: its id (the session it is reached through) and its DNS label. */
export interface BoxHost {
    id: string;
    slug: string;
}

/**
 * A connected Cloudflare account as a placement reads it: the row id (what the
 * driver unseals the token by), the account's own id, and its `workers.dev`
 * subdomain. Never the token.
 */
export interface AccountHost {
    accountId: string;
    id: string;
    workersSubdomain: string;
}

/** The host each kind of placement names. */
export interface HostOf {
    account: AccountHost;
    box: BoxHost;
}

/** Any host. */
export type Host = HostOf[HostedOn];

/** The tables a `placementRef` points into. */
export type HostTable = "boxes" | "cloudflareAccounts";

/** Read one row by id, pinned to `table` — a reference into another table answers `null`. */
export type RowReader = (table: HostTable, id: string) => Promise<unknown>;

/**
 * The per-table by-id reads a function's `ctx.db` offers (`ctx.db.boxes.get`).
 * Method syntax on purpose: those take a branded id, and only a method
 * signature's bivariant parameter lets them stand in for one taking `string`.
 */
interface ByIdTable {
    // eslint-disable-next-line @typescript-eslint/method-signature-style -- bivariant: `ctx.db.<table>.get` takes a branded id
    get(id: string): Promise<unknown>;
}

/** A {@link RowReader} over a function's `ctx.db`, through its table-pinned `get`. */
export const rowReaderOf =
    (tables: Record<HostTable, ByIdTable>): RowReader =>
    async (table, id) =>
        tables[table].get(id);

/** A {@link RowReader} over the control-plane store (`ControlPlaneStore.get(id, table)`). */
export const storeRowReader =
    (database: { get: (id: string, table?: string) => Promise<unknown> }): RowReader =>
    async (table, id) =>
        database.get(id, table);

/** A host row as a placement reads it. */
export interface HostRow<H> {
    host: H;
    /** The organization that owns it: a placement may only name its own organization's. */
    organizationId: string;
    /** Whether the host takes no converge any more (a revoked box). A connected account never is: disconnecting deletes it. */
    revoked: boolean;
}

/** What every layer above knows about one kind of host. */
export interface PlacementHost<H extends Host> {
    /** What became of a tenant whose host row `ref` is gone, for a teardown that may release its alias. */
    gone: (ref: string) => string;
    /** How messages and the studio name the kind. */
    label: string;
    /** Read host `ref` from this kind's own table, or `null` when there is none (deleted, or a reference into another table). */
    lookup: (read: RowReader, ref: string) => Promise<HostRow<H> | null>;

    /**
     * The key of the converge budget a placement on this host spends
     * (`src/deploy/pacing.ts`). A box's own id; a connected account's
     * CLOUDFLARE id, so two organizations that connected the same account share
     * its limit, as Cloudflare counts it.
     */
    paceKey: (host: H) => string;

    /**
     * Whether a tenant's `resourceRef` is qualified by its host
     * ({@link resourceRefOf}): a connected account's usage readback reads the
     * whole account, so a script may only be attributed to a deployment placed
     * in THAT account.
     */
    qualifiesResourceRef: boolean;
    /** The refusal for choosing — or deploying to — a revoked host. */
    revokedRefusal: (host: H) => string;
    /** What happens to a tenant on a revoked host, for a teardown that may release its alias. */
    revokedRemains: (host: H) => string;
}

interface BoxRow {
    _id: string;
    organizationId: string;
    slug: string;
    status: string;
}

/** Every kind of host, keyed by `placedOn` — the one place "box or account" is decided. */
export const PLACEMENT_HOSTS: { readonly [P in HostedOn]: PlacementHost<HostOf[P]> } = {
    account: {
        gone: () => "its Cloudflare account is no longer connected; the Worker and its data stay in that account",
        label: "connected Cloudflare account",
        lookup: async (read, ref) => {
            const row = await lookupAccount(async (id) => read("cloudflareAccounts", id), ref);

            return row === null
                ? null
                : {
                      host: { accountId: row.accountId, id: row._id, workersSubdomain: row.workersSubdomain },
                      organizationId: row.organizationId,
                      revoked: false,
                  };
        },
        paceKey: (host) => host.accountId,
        qualifiesResourceRef: true,
        revokedRefusal: (host) => `Cloudflare account ${host.accountId} is not usable; connect it again and choose it in the project's settings`,
        revokedRemains: (host) => `Cloudflare account ${host.accountId} is not usable; the Worker and its data stay in that account`,
    },
    box: {
        gone: (ref) => `box ${ref} no longer exists; nothing to stop`,
        label: "box",
        lookup: async (read, ref) => {
            const row = (await read("boxes", ref)) as BoxRow | null;

            return row === null ? null : { host: { id: row._id, slug: row.slug }, organizationId: row.organizationId, revoked: row.status === "revoked" };
        },
        paceKey: (host) => host.id,
        qualifiesResourceRef: false,
        revokedRefusal: (host) => `box "${host.slug}" is revoked; enrol the machine again and choose the new box`,
        // Nothing CAN be reached on a revoked box: it is cut off, and its data is the customer's bucket to keep or delete.
        revokedRemains: (host) => `box "${host.slug}" is revoked; its fleet and data stay on the machine`,
    },
};

/** `target`'s kind of placement. */
export const placedOnOf = (target: TargetId): PlacedOn => TARGETS[target].placedOn;

/** Whether `target` is placed in its organization's cell, naming no host. */
export const isCellPlaced = (target: TargetId): target is CellTargetId => placedOnOf(target) === "cell";

/** `PLACEMENT_HOSTS[placedOn]`, typed to its own host. */
export const hostEntryOf = <P extends HostedOn>(placedOn: P): PlacementHost<HostOf[P]> => PLACEMENT_HOSTS[placedOn];

/** The targets whose projects name a host. */
export type HostedTargetId = Exclude<TargetId, CellTargetId>;

/** The kind of host a project of `target` names. */
export const hostsOf = (target: HostedTargetId): PlacementHost<Host> => hostEntryOf(TARGETS[target].placedOn);

/** Where a release converges: in this control plane's cell, or on the host its project names. */
export type Placement = { host: AccountHost; target: AccountTargetId } | { host: BoxHost; target: BoxTargetId } | { target: CellTargetId };

/**
 * The placement of `target` on `host`. `host` was read through
 * `hostsOf(target)`, so it IS that target's kind of host; TypeScript cannot
 * follow that correlation through the descriptor table, so this is the one
 * place it is asserted.
 */
const hostedPlacement = (target: HostedTargetId, host: Host): Placement => ({ host, target }) as Placement;

/**
 * The tenant's handle on its target (`deployments.resourceRef`): its alias —
 * which is its script name — qualified by its host where the host's usage
 * readback reads more than this tenant ({@link PlacementHost.qualifiesResourceRef}).
 * Written by `deployments.create` and matched by the `cloudflare-workers` usage
 * readback, so both encode it here.
 */
export const resourceRefOf = (placement: { placementRef?: null | string; target: TargetId }, alias: string): string => {
    const { placementRef, target } = placement;

    return placementRef != null && !isCellPlaced(target) && hostsOf(target).qualifiesResourceRef ? `${placementRef}/${alias}` : alias;
};

/**
 * Parse a stored `target` column like `storedTarget`, refusing a value no target answers to.
 * @throws {LunoraError} `CONFLICT` for an unknown target.
 */
export const targetOf = (stored: null | string | undefined): TargetId => {
    const target = storedTarget(stored);

    if (target === undefined) {
        throw new LunoraError("CONFLICT", `unknown deploy target "${String(stored)}" — known targets: ${TARGET_IDS.join(", ")}`);
    }

    return target;
};

/** A project's placement as stored (`internal.projects.placement`). */
export interface StoredPlacement {
    /** The name of the cell the project's organization is placed on. */
    cellName?: null | string;
    /** The host `projects.placementRef` names, when it names one of its organization's that exists. */
    host?: Host | null;
    /** Whether that host is revoked. */
    hostRevoked?: boolean;
    target?: null | string;
}

/**
 * Resolve a stored placement against the cell this control plane serves.
 * @throws {LunoraError} `CONFLICT` for an unknown target, a project its organization's cell does not let this control plane converge (on another cell, or on no registered cell), or a hosted project without a usable host.
 */
export const resolvePlacement = (stored: StoredPlacement, thisCell: string): Placement => {
    const target = targetOf(stored.target);

    // Everything but a box is converged by its organization's cell (rule 4).
    if (placedOnOf(target) !== "box") {
        if (stored.cellName == null) {
            throw new LunoraError("CONFLICT", "this project's organization is not placed on a registered cell, so no control plane may deploy it");
        }

        if (stored.cellName !== thisCell) {
            throw new LunoraError(
                "CONFLICT",
                `this project's organization is placed on cell "${stored.cellName}", but this control plane serves cell "${thisCell}" — deploy through that cell's control plane`,
            );
        }
    }

    if (isCellPlaced(target)) {
        return { target };
    }

    const hosts = hostsOf(target);

    if (stored.host == null) {
        throw new LunoraError("CONFLICT", `this project deploys to ${target} but names no ${hosts.label}; choose one in its settings`);
    }

    if (stored.hostRevoked === true) {
        throw new LunoraError("CONFLICT", hosts.revokedRefusal(stored.host));
    }

    return hostedPlacement(target, stored.host);
};

/**
 * The host a project of `target` may name: `ref` must be a row of the
 * target's host table, of `organizationId`, and usable. A cell-placed target
 * names none.
 * @throws {LunoraError} `BAD_REQUEST` for a missing or superfluous reference, `NOT_FOUND` for another organization's (or no) host, `CONFLICT` for a revoked one.
 */
export const assertPlacementRef = async (read: RowReader, organizationId: string, target: TargetId, ref: string | undefined): Promise<void> => {
    if (isCellPlaced(target)) {
        if (ref !== undefined) {
            throw new LunoraError("BAD_REQUEST", `a ${target} project is placed in its organization's cell and names no host (placementRef)`);
        }

        return;
    }

    const hosts = hostsOf(target);

    if (ref === undefined) {
        throw new LunoraError("BAD_REQUEST", `a ${target} project needs a ${hosts.label} (placementRef)`);
    }

    const row = await hosts.lookup(read, ref);

    if (row?.organizationId !== organizationId) {
        throw new LunoraError("NOT_FOUND", `${hosts.label} not found in this organization`);
    }

    if (row.revoked) {
        throw new LunoraError("CONFLICT", hosts.revokedRefusal(row.host));
    }
};

/**
 * Where a deployment's tenant lives, or why it lives nowhere this control plane
 * can reach. `settled` says whether that is final — the tenant is beyond reach
 * for good, so a teardown may release its alias — or may change, in which case
 * the alias must stay claimed and the row pending.
 */
export type DeploymentPlacement = { placement: Placement } | { settled: boolean; unplaced: string };

/** Place one deployment for a fleet-wide sweep, off the host its own row names (`deployments.placementRef`). */
export const placementOfDeployment = async (deployment: { placementRef?: null | string; target: TargetId }, read: RowReader): Promise<DeploymentPlacement> => {
    const { placementRef, target } = deployment;

    if (isCellPlaced(target)) {
        return { placement: { target } };
    }

    const hosts = hostsOf(target);

    // A hosted row is always written with its host (`deployments.create` copies
    // it from the project, whose target requires one). One without could still
    // have a tenant on a host nobody can name — releasing its alias would let
    // another project land on it.
    if (placementRef == null) {
        return { settled: false, unplaced: `names no ${hosts.label}; its tenant cannot be reached, so the alias stays claimed` };
    }

    // Removing a host is refused while a deployment on it is pending, so a
    // missing row means its organization was erased with it.
    const row = await hosts.lookup(read, placementRef);

    if (row === null) {
        return { settled: true, unplaced: hosts.gone(placementRef) };
    }

    if (row.revoked) {
        return { settled: true, unplaced: hosts.revokedRemains(row.host) };
    }

    return { placement: hostedPlacement(target, row.host) };
};
