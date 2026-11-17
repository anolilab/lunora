import { LunoraError } from "@lunora/errors";
import type { SqlExec, SubscriptionIdentity } from "@lunora/shard-engine";
import { RELAY_SIGNATURE_HEADER, siblingSecretOf, signSiblingBody } from "@lunora/shard-engine";

/** Opaque authority scope and its monotonic revision. No access policy is stored on the shard. */
interface DeliveryPermit {
    readonly epoch: number;
    /** Opaque authority key, at most 256 UTF-8 bytes to bound persisted socket metadata. */
    readonly scope: string;
}

interface DeliveryAuthorizationRequest {
    /** True only for a reserved admin RPC with a validated bearer. */
    readonly admin: boolean;
    readonly args: Record<string, unknown>;
    readonly functionPath: string;
    readonly identity: SubscriptionIdentity;
    readonly shardKey: string | undefined;
    /** Trusted server dispatch at the native binding; always false for subscriptions. */
    readonly system: boolean;
    readonly transport: "subscription" | "rpc";
}

/**
 * Resolve against current authority, including before receipt/cache replay.
 * The application commits policy and pending invalidation together, denies new
 * permits immediately, and retries installDeliveryFence before acknowledging
 * revocation. It owns affected scopes; the shard stores no grant or topology copy.
 */
type DeliveryAuthorization = (request: DeliveryAuthorizationRequest) => Promise<DeliveryPermit | undefined>;

const validDeliveryPermit = (value: unknown): value is DeliveryPermit => {
    if (typeof value !== "object" || value === null) {
        return false;
    }

    const permit = value as Partial<DeliveryPermit>;

    return (
        typeof permit.scope === "string" &&
        permit.scope.length > 0 &&
        new TextEncoder().encode(permit.scope).byteLength <= 256 &&
        Number.isSafeInteger(permit.epoch) &&
        (permit.epoch ?? -1) >= 0
    );
};

/** SQL uses the host's synchronous storage and output durability gate, including after hibernation. */
class DeliveryFence {
    private initialized = false;

    public constructor(private readonly sql: () => SqlExec) {}

    public install(permit: DeliveryPermit): void {
        if (!validDeliveryPermit(permit)) {
            throw new TypeError("invalid delivery fence");
        }

        this.storage().exec(
            "INSERT INTO __lunora_delivery_fence(scope, epoch) VALUES (?, ?) ON CONFLICT(scope) DO UPDATE SET epoch = MAX(epoch, excluded.epoch)",
            permit.scope,
            permit.epoch,
        );
    }

    public recordReceipt(identity: string, mutationId: string, permit: DeliveryPermit | undefined, timestamp: number): void {
        if (!validDeliveryPermit(permit)) {
            throw new LunoraError("DELIVERY_RECEIPT_FENCED", "Receipt has no delivery authority");
        }
        this.storage().exec(
            "INSERT INTO __lunora_delivery_receipt(identity, mutation_id, scope, epoch, ts) VALUES (?, ?, ?, ?, ?) ON CONFLICT(identity, mutation_id) DO UPDATE SET scope = excluded.scope, epoch = excluded.epoch, ts = excluded.ts",
            identity,
            mutationId,
            permit.scope,
            permit.epoch,
            timestamp,
        );
    }

    public assertReceipt(identity: string, mutationId: string, permit: DeliveryPermit | undefined): void {
        const original = this.storage()
            .exec<{ epoch: number; scope: string }>(
                "SELECT scope, epoch FROM __lunora_delivery_receipt WHERE identity = ? AND mutation_id = ?",
                identity,
                mutationId,
            )
            .toArray()[0];
        if (!validDeliveryPermit(permit) || original?.scope !== permit.scope || original.epoch !== permit.epoch) {
            throw new LunoraError("DELIVERY_RECEIPT_FENCED", "Committed receipt belongs to a different delivery authority epoch");
        }
    }

    public trimReceipts(before: number): void {
        this.storage().exec("DELETE FROM __lunora_delivery_receipt WHERE ts < ?", before);
    }

    public allows(permit: DeliveryPermit | undefined): boolean {
        if (!validDeliveryPermit(permit)) {
            return false;
        }

        const row = this.storage().exec<{ epoch: number }>("SELECT epoch FROM __lunora_delivery_fence WHERE scope = ?", permit.scope).toArray()[0];

        return row === undefined || permit.epoch >= row.epoch;
    }

    private storage(): SqlExec {
        const sql = this.sql();

        if (!this.initialized) {
            sql.exec("CREATE TABLE IF NOT EXISTS __lunora_delivery_fence (scope TEXT PRIMARY KEY, epoch INTEGER NOT NULL)");
            sql.exec(
                "CREATE TABLE IF NOT EXISTS __lunora_delivery_receipt (identity TEXT NOT NULL, mutation_id TEXT NOT NULL, scope TEXT NOT NULL, epoch INTEGER NOT NULL, ts REAL NOT NULL, PRIMARY KEY (identity, mutation_id))",
            );
            this.initialized = true;
        }

        return sql;
    }
}

/** Install through a private namespace binding. Acknowledgement covers this shard's durable local fence. */
const installDeliveryFence = async (
    target: { fetch: (url: string, init?: RequestInit) => Promise<Response> },
    options: { env: unknown; fence: DeliveryPermit; shardKey: string | undefined },
): Promise<void> => {
    const secret = siblingSecretOf(options.env);
    if (secret === undefined || !validDeliveryPermit(options.fence)) {
        throw new TypeError("delivery fence requires a valid marker and LUNORA_RELAY_SECRET");
    }
    const body = JSON.stringify({ type: "delivery-fence", shardKey: options.shardKey, fence: options.fence });
    const response = await target.fetch("https://shard.internal/_lunora/delivery-fence", {
        method: "POST",
        body,
        headers: { [RELAY_SIGNATURE_HEADER]: await signSiblingBody(secret, body) },
    });
    if (response.status !== 204) {
        throw new Error(`delivery fence was not acknowledged (${String(response.status)})`);
    }
};

export { DeliveryFence, installDeliveryFence, validDeliveryPermit };
export type { DeliveryAuthorization, DeliveryAuthorizationRequest, DeliveryPermit };
