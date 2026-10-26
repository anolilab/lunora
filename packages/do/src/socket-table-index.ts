import type { KeyRange, SocketAttachment } from "@lunora/shard-engine";

import { ADMIN_WILDCARD } from "./admin-readers";
import { setsIntersect } from "./admin-rpc-args";

/** Per-subscription memo used to suppress no-op pushes. */
interface SubscriptionMemo {
    clientWatermark?: number;
    cursor?: number;
    epoch?: string;

    /**
     * `ShardDO.writeGeneration` captured before the run that produced this
     * baseline started reading. A later push carrying a LOWER generation read
     * state older than this baseline and is dropped instead of sent.
     */
    generation: number;

    lastJson: string;

    /**
     * Index slices this subscription's reads were provably confined to, keyed
     * by table. A table present here was read ONLY through the listed ranges,
     * so a write landing outside all of them cannot change the result. A table
     * in {@link SubscriptionMemo.tables} but absent here was read in some
     * unnarrowable way (a scan, a search, a join) and always re-runs.
     */
    ranges?: Map<string, KeyRange[]>;
    /** A later unrelated write cannot settle past a value the socket never received. */
    retryData?: boolean;
    tables: Set<string>;
}

/** A socket's table index entry; `tables` stays unset until a refresh visit proves every subscription on it skippable by table. */
interface SocketTables {
    tables?: Set<string>;
}

/**
 * The subscription memos of every socket, and the per-socket table index the
 * write-flush fan-out filters on, kept in one owner so a memo write cannot skip
 * the index.
 *
 * A memo is the last pushed result per `(socket, subId)`: it lets a flush skip
 * re-running a query whose tables were untouched and suppress a push whose result
 * is unchanged. The index is, per socket, the union of its memos' `tables`, so a
 * write visits (and reads the attachment of) only the sockets that could care.
 * An index entry carries `tables` only when a refresh visit found every
 * subscription on the socket holding a memo that can be skipped by table (no
 * admin wildcard, no `retryData`); a socket with no entry, or an entry without
 * `tables`, is always visited — a fresh socket after hibernation, one with a
 * just-subscribed (unmemoized) query, one mid-visit. Over-covering only costs a
 * visit; the index must never under-cover, which is why every memo write here
 * widens it.
 *
 * Also records the sockets a shape poke found holding no shapes, the shape
 * fan-out's counterpart filter.
 *
 * In memory only: nothing here survives hibernation, which is safe — a cold memo
 * forces one re-run and at most one redundant push, and a cold socket is visited.
 */
class SocketTableIndex {
    private readonly memos = new WeakMap<object, Map<string, SubscriptionMemo>>();

    private readonly index = new WeakMap<object, SocketTables>();

    private readonly shapeFree = new WeakSet<object>();

    public memo(socket: object, subId: string): SubscriptionMemo | undefined {
        return this.memos.get(socket)?.get(subId);
    }

    public socketMemos(socket: object): ReadonlyMap<string, SubscriptionMemo> | undefined {
        return this.memos.get(socket);
    }

    public setMemo(socket: object, subId: string, memo: SubscriptionMemo): void {
        let memos = this.memos.get(socket);

        if (!memos) {
            memos = new Map();
            this.memos.set(socket, memos);
        }

        memos.set(subId, memo);
        this.widen(socket, memo.tables);
    }

    /** Replace a held memo's dependency set in place. */
    public retable(socket: object, subId: string, tables: Set<string>): void {
        const memo = this.memo(socket, subId);

        if (memo !== undefined) {
            memo.tables = tables;
        }

        this.widen(socket, tables);
    }

    /** Drop one memo. The index keeps the memo's tables: over-covering is safe. */
    public forgetMemo(socket: object, subId: string): void {
        this.memos.get(socket)?.delete(subId);
    }

    /** Drop the memo of a (re)subscribed query and unindex the socket: the new subscription has no memo until a visit records one. */
    public resubscribed(socket: object, subId: string): void {
        this.forgetMemo(socket, subId);
        this.index.delete(socket);
    }

    public forgetSocket(socket: object): void {
        this.memos.delete(socket);
        this.index.delete(socket);
    }

    /** Whether a flush touching `changed` can affect `socket`'s subscriptions. An unindexed socket always may. */
    public mayCare(socket: object, changed: Set<string>): boolean {
        const tables = this.index.get(socket)?.tables;

        return tables === undefined || setsIntersect(tables, changed);
    }

    /**
     * Claim `socket`'s index entry for a refresh visit, returning the call that
     * ends the visit by indexing the socket from its memos over `subs`. Claim it
     * before the visit's first await: a `subscribe` landing mid-visit drops the
     * claim, and ending the visit then leaves the socket unindexed.
     */
    public beginVisit(socket: object): (subs: SocketAttachment["subs"]) => void {
        const claim: SocketTables = {};

        this.index.set(socket, claim);

        return (subs) => {
            claim.tables = this.memoTableUnion(socket, subs);
        };
    }

    public isShapeFree(socket: object): boolean {
        return this.shapeFree.has(socket);
    }

    public markShapeFree(socket: object): void {
        this.shapeFree.add(socket);
    }

    /** A shape was registered on `socket`, so the shape fan-out must visit it again. */
    public markHoldsShapes(socket: object): void {
        this.shapeFree.delete(socket);
    }

    /**
     * The union of `subs`' memo tables, or `undefined` when any subscription
     * lacks a memo or holds one that must re-run on every flush (admin wildcard,
     * `retryData`).
     */
    private memoTableUnion(socket: object, subs: SocketAttachment["subs"]): Set<string> | undefined {
        const memos = this.memos.get(socket);
        const union = new Set<string>();

        for (const subId of Object.keys(subs)) {
            if (!subs[subId]?.functionPath) {
                continue;
            }

            const memo = memos?.get(subId);

            if (memo === undefined || memo.retryData || memo.tables.has(ADMIN_WILDCARD)) {
                return undefined;
            }

            for (const table of memo.tables) {
                union.add(table);
            }
        }

        return union;
    }

    /** Fold a memo's freshly recorded `tables` into an indexed socket's union, so the index never under-covers it. */
    private widen(socket: object, tables: Set<string>): void {
        const entry = this.index.get(socket);

        if (entry?.tables === undefined) {
            return;
        }

        if (tables.has(ADMIN_WILDCARD)) {
            this.index.delete(socket);

            return;
        }

        for (const table of tables) {
            entry.tables.add(table);
        }
    }
}

export type { SubscriptionMemo };
export { SocketTableIndex };
