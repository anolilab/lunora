/**
 * A Playwright test double for Lunora's browser wire protocol.
 *
 * An e2e suite for a Lunora app needs the app's data layer to behave — live
 * queries resolve, shapes replicate, mutations ack and echo a watermark — without
 * standing up a worker and a Durable Object per test. Doing that by hand means
 * reimplementing the protocol from the outside: `page.route` on `/_lunora/rpc`, a
 * `page.routeWebSocket` server that answers `subscribe` with `data` frames and
 * `shape_subscribe` with a `pokeStart`/`pokePart`/`pokeEnd` triple, per-client
 * watermark bookkeeping so optimistic overlays clear, and re-entrancy cleanup so a
 * stacked handler from a previous `page.reload()` doesn't keep an old row store
 * alive. Every adopter needs it, and every adopter gets the watermark bookkeeping
 * subtly wrong — which then looks like a bug in Lunora.
 *
 * So it ships here, and doubles as an executable spec of the protocol.
 *
 * ```ts
 * const lunora = await mockLunora(page, {
 *     rows: { nodes: [{ _id: "n1", text: "hello", userId: "u1" }] },
 *     shapes: { wholeOutline: { tables: ["nodes"] } },
 * });
 *
 * await page.goto("/");
 * await expect(page.getByText("hello")).toBeVisible();
 *
 * // Drive the server side from the test.
 * await lunora.insert("nodes", { _id: "n2", text: "world", userId: "u1" });
 * await expect(page.getByText("world")).toBeVisible();
 *
 * // Reproduce the failure modes that are otherwise impossible to hit on purpose.
 * lunora.suppressPokes();          // a dropped poke → the client's checkpoint fallback
 * lunora.failWrites("CONFLICT");   // a rejected mutation → rollback + error UI
 * ```
 *
 * `@playwright/test` is a peer dependency and is imported **type-only**, so this
 * module adds no runtime dependency for a project that never uses it.
 */

/** The Playwright surface this double drives — declared structurally so the import stays type-only. */
interface MockablePage {
    route: (url: string, handler: (route: MockRoute) => Promise<void> | void) => Promise<void>;
    routeWebSocket: (url: RegExp | string, handler: (ws: MockWebSocketRoute) => void) => Promise<void>;
    unroute: (url: string) => Promise<void>;
    unrouteAll?: () => Promise<void>;
}

/** The slice of Playwright's `Route` used to answer an RPC POST. */
interface MockRoute {
    fulfill: (response: { body?: string; contentType?: string; status?: number }) => Promise<void>;
    request: () => { headers: () => Record<string, string>; postData: () => null | string };
}

/** The slice of Playwright's `WebSocketRoute` used to serve frames. */
interface MockWebSocketRoute {
    onMessage: (handler: (message: string) => void) => void;
    send: (message: string) => void;
}

/** A replicated row. `_id` is the key the client indexes by. */
type MockRow = Record<string, unknown> & { _id: string };

/** How a mocked shape selects rows from the seeded store. */
interface MockShape {
    /** Tables whose rows this shape replicates. */
    tables: ReadonlyArray<string>;

    /**
     * Narrow the shape to rows matching every entry. Values are compared with
     * `===`, which covers the partition-selector case (`{ userId: "u1" }`).
     */
    where?: Record<string, unknown>;
}

/** Options for {@link mockLunora}. */
interface MockLunoraOptions {
    /**
     * Answers for non-mutator RPC calls, keyed by `namespace:fn`. A value may be a
     * function of the call's args. Unlisted paths resolve to `undefined` — enough for a
     * fire-and-forget mutation, and loud enough in a test that reads the result.
     */
    functions?: Record<string, unknown>;

    /** Base path the app talks to. Defaults to `/_lunora`. */
    path?: string;

    /** Seeded rows per table. */
    rows?: Record<string, ReadonlyArray<MockRow>>;

    /** Shapes the app subscribes to, keyed by `defineShape` export name. */
    shapes?: Record<string, MockShape>;
}

/** The handle {@link mockLunora} returns — drive the server side from the test. */
interface MockLunora {
    /** Stop answering `/_lunora/*`. Also called implicitly by a later `mockLunora` on the same page. */
    dispose: () => Promise<void>;

    /** Reject every subsequent mutation/mutator call with `code`. Pass `false` to stop. */
    failWrites: (code: false | string) => void;

    /** Insert (or replace) a row and poke every shape that now matches it. */
    insert: (table: string, row: MockRow) => Promise<void>;

    /** Patch a row and poke the shapes replicating it. */
    patch: (table: string, id: string, patch: Record<string, unknown>) => Promise<void>;

    /** Delete a row and poke the shapes replicating it. */
    remove: (table: string, id: string) => Promise<void>;

    /** Re-send every subscribed shape's full rowset — what a reconnect would do. */
    resync: () => Promise<void>;

    /** Current server-side rows for `table`. */
    rows: (table: string) => MockRow[];

    /**
     * Stop sending pokes while still accepting writes — the dropped-poke failure
     * mode. Writes still ack and advance the watermark, so this exercises the
     * client's checkpoint fallback rather than a dead connection. Pass `false` to
     * resume (which does NOT replay the missed pokes; call `resync()` for that).
     */
    suppressPokes: (suppressed?: boolean) => void;

    /** Highest `clientSeq` acked, per client id — the watermark the client is gating overlays on. */
    watermarks: () => Record<string, number>;
}

/** The row-level operations a poke can carry. */
type MockRowOpKind = "delete" | "insert" | "update";

/** One row-level change inside a poke part — the wire's `RowOp`. */
interface MockRowOp {
    key: string;
    op: MockRowOpKind;
    table: string;
    value?: Record<string, unknown>;
}

/** One shape's slice of a poke. */
interface MockPokePart {
    ops: MockRowOp[];
    shapeId: string;
}

/** A live shape subscription on the mocked socket. */
interface LiveShape {
    id: string;
    name: string;
    send: (message: string) => void;
}

/** A live query subscription on the mocked socket. */
interface LiveQuery {
    functionPath: string;
    id: string;
    send: (message: string) => void;
}

const matchesWhere = (row: MockRow, where: Record<string, unknown> | undefined): boolean => {
    if (!where) {
        return true;
    }

    return Object.entries(where).every(([field, value]) => row[field] === value);
};

/**
 * Install the double on `page`. Returns a handle for driving the server side.
 *
 * Idempotent per page: calling it again disposes the previous installation first.
 * That matters more than it sounds — a stacked `routeWebSocket` handler from before
 * a `page.reload()` keeps serving from its own closed-over row store, so the app
 * silently reads stale data and the test fails somewhere unrelated.
 */
const mockLunora = async (page: MockablePage, options: MockLunoraOptions = {}): Promise<MockLunora> => {
    const basePath = options.path ?? "/_lunora";
    const RPC_PATH = `${basePath}/rpc`;
    const RPC_BATCH_PATH = `${basePath}/rpc-batch`;
    const shapes = options.shapes ?? {};
    const functions = options.functions ?? {};

    // Server-side row store, keyed table → id → row.
    const store = new Map<string, Map<string, MockRow>>();

    for (const [table, rows] of Object.entries(options.rows ?? {})) {
        store.set(table, new Map(rows.map((row) => [row._id, { ...row }])));
    }

    // Per-client watermarks (`x-lunora-client-id` → highest acked `clientSeq`).
    const watermarks = new Map<string, number>();
    const liveShapes = new Map<string, LiveShape>();
    const liveQueries = new Map<string, LiveQuery>();

    let checkpoint = 0;
    let pokeCounter = 0;
    let suppressed = false;
    let failCode: false | string = false;
    let disposed = false;
    /** Shape names warned about once, so a reconnect loop doesn't spam the test log. */
    const warnedUnknownShapes = new Set<string>();

    /**
     * Remove this double's HTTP routes.
     *
     * Playwright matches `unroute` against the pattern the handler was REGISTERED
     * with, so a glob like `${basePath}/**` removes nothing — the handlers below are
     * registered on the exact `/rpc` and `/rpc-batch` paths. `routeWebSocket` has no
     * unroute API at all, so a socket handler from a previous installation stays
     * stacked; the `disposed` guard is what stops it answering.
     */
    const unrouteHttp = async (): Promise<void> => {
        await page.unroute(RPC_PATH);
        await page.unroute(RPC_BATCH_PATH);
    };

    // A previous installation on this page would otherwise keep answering from its
    // own closed-over store — Playwright stacks route handlers newest-first.
    await unrouteHttp();

    const tableRows = (table: string): Map<string, MockRow> => {
        const existing = store.get(table);

        if (existing) {
            return existing;
        }

        const created = new Map<string, MockRow>();

        store.set(table, created);

        return created;
    };

    /** Rows a shape currently replicates, across its tables. */
    const shapeRows = (name: string): { row: MockRow; table: string }[] => {
        const shape = shapes[name];

        if (!shape) {
            return [];
        }

        const out: { row: MockRow; table: string }[] = [];

        for (const table of shape.tables) {
            for (const row of tableRows(table).values()) {
                if (matchesWhere(row, shape.where)) {
                    out.push({ row, table });
                }
            }
        }

        return out;
    };

    /** Highest watermark across clients — what a poke/settled frame echoes. */
    const highestWatermark = (): number => Math.max(0, ...watermarks.values());

    /**
     * Send one poke carrying `parts` to the shapes that own them. The frame triple
     * (`pokeStart` → `pokePart`* → `pokeEnd`) is the protocol: the client buffers
     * parts and commits them atomically at `pokeEnd`, so sending a part without its
     * closing frame leaves the client's view unchanged — which is exactly how a
     * real dropped poke behaves.
     */
    const sendPoke = (parts: MockPokePart[]): void => {
        if (suppressed || parts.length === 0) {
            return;
        }

        pokeCounter += 1;
        checkpoint += 1;

        const pokeId = `poke_${String(pokeCounter)}`;
        const lastMutationId = highestWatermark();

        for (const { shapeId } of parts) {
            const shape = liveShapes.get(shapeId);

            if (!shape) {
                continue;
            }

            shape.send(JSON.stringify({ baseCheckpoint: checkpoint - 1, pokeId, type: "pokeStart" }));
        }

        for (const { ops, shapeId } of parts) {
            const shape = liveShapes.get(shapeId);

            if (!shape) {
                continue;
            }

            shape.send(JSON.stringify({ lastMutationId, pokeId, rowsPatch: ops, shapeId, type: "pokePart" }));
        }

        for (const { shapeId } of parts) {
            const shape = liveShapes.get(shapeId);

            if (!shape) {
                continue;
            }

            shape.send(JSON.stringify({ checkpoint, pokeId, type: "pokeEnd" }));
        }
    };

    /** Poke every live shape that replicates `table` with one row op. */
    const pokeRowOp = (table: string, op: MockRowOpKind, key: string, value?: MockRow): void => {
        const parts: MockPokePart[] = [];

        for (const live of liveShapes.values()) {
            const shape = shapes[live.name];

            if (!shape?.tables.includes(table)) {
                continue;
            }

            // A row that no longer matches the shape's `where` leaves it — send a
            // delete rather than an update the client would wrongly keep.
            const effectiveOp: MockRowOpKind = op !== "delete" && value !== undefined && !matchesWhere(value, shape.where) ? "delete" : op;

            parts.push({
                ops: [{ key, op: effectiveOp, table, ...(effectiveOp === "delete" ? {} : { value }) }],
                shapeId: live.id,
            });
        }

        sendPoke(parts);
    };

    /** Re-send a shape's whole rowset as an insert poke — the cold-subscribe / reconnect seed. */
    const seedShape = (live: LiveShape): void => {
        const ops = shapeRows(live.name).map(({ row, table }) => {
            return { key: row._id, op: "insert" as const, table, value: row };
        });

        sendPoke([{ ops, shapeId: live.id }]);
    };

    /** Notify every live query that the data changed (queries re-fetch over RPC). */
    const pokeQueries = (): void => {
        // Honour `suppressed` here too. A test that suppresses pokes to exercise the
        // checkpoint fallback would otherwise still see its query subscriptions
        // invalidated — only half the failure mode reproduced.
        if (suppressed) {
            return;
        }

        const lastMutationId = highestWatermark();

        for (const live of liveQueries.values()) {
            live.send(JSON.stringify({ cursor: checkpoint, id: live.id, lastMutationId, type: "settled" }));
        }
    };

    /** Answers both the single-call and the coalesced batch RPC path. */
    const rpcHandler = async (route: MockRoute): Promise<void> => {
        const request = route.request();
        const raw = request.postData();
        let body: { args?: Record<string, unknown>; functionPath?: string } = {};

        if (typeof raw === "string") {
            try {
                body = JSON.parse(raw) as typeof body;
            } catch {
                // Fulfil rather than throw: an unhandled throw in a route handler leaves
                // the request unanswered, so the test hangs on a network timeout instead
                // of seeing the problem. The socket handler already guards this way.
                await route.fulfill({
                    body: JSON.stringify({ error: { code: "BAD_REQUEST", message: "mockLunora: unparseable RPC body" } }),
                    contentType: "application/json",
                    status: 400,
                });

                return;
            }
        }

        const functionPath = body.functionPath ?? "";

        // A custom-mutator push carries `x-lunora-client-id` + a monotonic
        // `x-lunora-client-seq`. Advancing this client's watermark and echoing it
        // back is the bookkeeping that lets an optimistic overlay clear — get it
        // wrong and rows sit in a pending state forever, which reads as a Lunora bug
        // rather than a mock bug. This is the reason this file exists.
        const headers = request.headers();
        const clientId = headers["x-lunora-client-id"] ?? "";
        const clientSeq = Number.parseInt(headers["x-lunora-client-seq"] ?? "", 10);
        const isMutatorPush = clientId !== "" && Number.isFinite(clientSeq);

        // Gated on `isMutatorPush`, not on "any RPC": the contract is that `failWrites`
        // fails WRITES. Failing reads too would collapse the data a rollback-UI test is
        // asserting against, masking the behaviour under test.
        if (failCode !== false && isMutatorPush) {
            // A failed write must NOT advance the watermark — the DO only advances on
            // a write it actually applied, and a mock that advances anyway hides the
            // client's reissue path.
            await route.fulfill({
                body: JSON.stringify({ error: { code: failCode, message: `mockLunora: writes are failing with ${failCode}` } }),
                contentType: "application/json",
                status: 400,
            });

            return;
        }

        if (isMutatorPush) {
            watermarks.set(clientId, Math.max(watermarks.get(clientId) ?? 0, clientSeq));
        }

        const answer = functions[functionPath];
        const result = typeof answer === "function" ? (answer as (args: Record<string, unknown>) => unknown)(body.args ?? {}) : answer;

        await route.fulfill({
            body: JSON.stringify({
                commitCursor: checkpoint,
                lastMutationId: isMutatorPush ? (watermarks.get(clientId) ?? 0) : highestWatermark(),
                result,
            }),
            contentType: "application/json",
            status: 200,
        });
    };

    await page.route(RPC_PATH, rpcHandler);
    // `client.mutation(...)` can also reach the coalesced batch transport through
    // offline replay (`replayBatched`), which POSTs to `/rpc-batch`. Without this route
    // a replayed queued write falls through to the real origin.
    await page.route(RPC_BATCH_PATH, rpcHandler);

    await page.routeWebSocket(`${basePath}/ws`, (ws) => {
        const send = (message: string): void => {
            if (!disposed) {
                ws.send(message);
            }
        };

        ws.onMessage((raw) => {
            let message: {
                id?: string;
                query?: { functionPath?: string };
                shape?: { name?: string };
                type?: string;
            };

            try {
                message = JSON.parse(raw) as typeof message;
            } catch {
                return;
            }

            const id = message.id ?? "";

            switch (message.type) {
                case "shape_subscribe": {
                    const name = message.shape?.name ?? "";
                    const live: LiveShape = { id, name, send };

                    // A shape the test never declared replicates nothing and is never
                    // poked, so the assertion fails far from the cause (usually a typo in
                    // `shapes`). Say so once, loudly — the same stance the missing-carrier
                    // warning in `@lunora/db` takes.
                    if (shapes[name] === undefined && !warnedUnknownShapes.has(name)) {
                        warnedUnknownShapes.add(name);

                        // eslint-disable-next-line no-console
                        console.warn(
                            `[mockLunora] the app subscribed to shape "${name}", which is not in \`shapes\` — it will replicate nothing and never poke. ` +
                                `Declared: ${Object.keys(shapes).length === 0 ? "(none)" : Object.keys(shapes).join(", ")}.`,
                        );
                    }

                    liveShapes.set(id, live);
                    send(JSON.stringify({ id, type: "ack" }));
                    seedShape(live);

                    return;
                }

                case "shape_unsubscribe": {
                    liveShapes.delete(id);

                    return;
                }

                case "subscribe": {
                    liveQueries.set(id, { functionPath: message.query?.functionPath ?? "", id, send });
                    send(JSON.stringify({ id, type: "ack" }));

                    const answer = functions[message.query?.functionPath ?? ""];
                    const data = typeof answer === "function" ? (answer as (args: Record<string, unknown>) => unknown)({}) : (answer ?? []);

                    send(JSON.stringify({ cursor: checkpoint, data, id, type: "data" }));

                    return;
                }

                case "unsubscribe": {
                    liveQueries.delete(id);

                    break;
                }

                default: {
                    break;
                }
            }
        });
    });

    return {
        dispose: async () => {
            disposed = true;
            liveShapes.clear();
            liveQueries.clear();
            await unrouteHttp();
        },

        failWrites: (code) => {
            failCode = code;
        },

        // eslint-disable-next-line @typescript-eslint/require-await -- async for a uniform await-able driver API; poking is synchronous
        insert: async (table, row) => {
            tableRows(table).set(row._id, { ...row });
            pokeRowOp(table, "insert", row._id, { ...row });
            pokeQueries();
        },

        // eslint-disable-next-line @typescript-eslint/require-await -- see `insert`
        patch: async (table, id, patch) => {
            const rows = tableRows(table);
            const existing = rows.get(id);

            if (!existing) {
                throw new Error(`mockLunora.patch: no row "${id}" in table "${table}"`);
            }

            const merged = { ...existing, ...patch, _id: id };

            rows.set(id, merged);
            pokeRowOp(table, "update", id, merged);
            pokeQueries();
        },

        // eslint-disable-next-line @typescript-eslint/require-await -- see `insert`
        remove: async (table, id) => {
            tableRows(table).delete(id);
            pokeRowOp(table, "delete", id);
            pokeQueries();
        },

        // eslint-disable-next-line @typescript-eslint/require-await -- see `insert`
        resync: async () => {
            for (const live of liveShapes.values()) {
                seedShape(live);
            }

            pokeQueries();
        },

        // Copies: a returned row is a read, so mutating it must not silently rewrite
        // server state behind the poke protocol.
        rows: (table) =>
            [...tableRows(table).values()].map((row) => {
                return { ...row };
            }),

        suppressPokes: (value = true) => {
            suppressed = value;
        },

        watermarks: () => Object.fromEntries(watermarks),
    };
};

export type { MockablePage, MockLunora, MockLunoraOptions, MockRoute, MockRow, MockShape, MockWebSocketRoute };
export { mockLunora };
