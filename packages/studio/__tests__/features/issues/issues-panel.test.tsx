import { LunoraProvider } from "@lunora/react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { IssuesPanel } from "../../../src/features/issues/issues-panel";
import type { ErrorIssue, ExplainIssueResult } from "../../../src/lib/admin";
import { ADMIN_FUNCTIONS } from "../../../src/lib/admin";
import type { MockClientHooks } from "../../mock-client";
import { createMockClient } from "../../mock-client";

const ISSUE = (overrides: Partial<ErrorIssue> = {}): ErrorIssue => {
    return {
        count: 3,
        culprit: "messages:send",
        firstSeen: 1_700_000_000_000,
        hash: "deadbeefcafe0001",
        lastSeen: 1_700_000_005_000,
        sampleMessage: "User 42 not found",
        status: "open",
        title: "User not found",
        ...overrides,
    };
};

/**
 * A mock whose `getIssues` returns `issues`, and whose triage RPCs resolve
 * successfully. All four triage writes go through `client.query` (matching the
 * queues panel), so the single `query` impl serves reads and writes alike.
 */
const createClient = (issues: ErrorIssue[]): MockClientHooks =>
    createMockClient({
        query: (reference): unknown => {
            if (reference === ADMIN_FUNCTIONS.getIssues) {
                return { issues };
            }

            // Triage writes echo an ok result; the test asserts the call, not the echo.
            return { state: {} };
        },
    });

const renderPanel = (mock: MockClientHooks) => (
    <LunoraProvider client={mock.asClient}>
        <IssuesPanel />
    </LunoraProvider>
);

describe("issuesPanel", () => {
    it("renders an Issue with its status badge, culprit, and count", async () => {
        expect.assertions(3);

        render(renderPanel(createClient([ISSUE()])));

        const row = await screen.findByTestId("issues-row-deadbeefcafe0001");

        expect(row.textContent).toContain("User not found");
        expect(row.textContent).toContain("messages:send");
        expect(screen.getByTestId("issues-status-deadbeefcafe0001").textContent).toBe("open");
    });

    it("resolves an Issue via the resolveIssue RPC with its hash", async () => {
        expect.assertions(1);

        const mock = createClient([ISSUE()]);

        render(renderPanel(mock));

        const button = await screen.findByTestId("issues-resolve-deadbeefcafe0001");

        fireEvent.click(button);

        await waitFor(() => {
            expect(mock.query).toHaveBeenCalledWith(
                expect.objectContaining({ __lunoraRef: ADMIN_FUNCTIONS.resolveIssue }),
                { hash: "deadbeefcafe0001" },
                expect.anything(),
            );
        });
    });

    it("ignores an Issue via the ignoreIssue RPC", async () => {
        expect.assertions(1);

        const mock = createClient([ISSUE()]);

        render(renderPanel(mock));

        fireEvent.click(await screen.findByTestId("issues-ignore-deadbeefcafe0001"));

        await waitFor(() => {
            expect(mock.query).toHaveBeenCalledWith(
                expect.objectContaining({ __lunoraRef: ADMIN_FUNCTIONS.ignoreIssue }),
                { hash: "deadbeefcafe0001" },
                expect.anything(),
            );
        });
    });

    it("shows Reopen (not Resolve) for a resolved Issue and reopens via assignIssue", async () => {
        expect.assertions(2);

        const mock = createClient([ISSUE({ assignee: "alice", status: "resolved" })]);

        render(renderPanel(mock));

        await screen.findByTestId("issues-row-deadbeefcafe0001");

        // Resolved → no Resolve button, a Reopen button instead.
        expect(screen.queryByTestId("issues-resolve-deadbeefcafe0001")).toBeNull();

        fireEvent.click(screen.getByTestId("issues-reopen-deadbeefcafe0001"));

        await waitFor(() => {
            expect(mock.query).toHaveBeenCalledWith(
                expect.objectContaining({ __lunoraRef: ADMIN_FUNCTIONS.assignIssue }),
                { assignee: "alice", hash: "deadbeefcafe0001" },
                expect.anything(),
            );
        });
    });

    it("assigns an Issue from the inline input on Enter, and unassigns on an empty commit", async () => {
        expect.assertions(2);

        const mock = createClient([ISSUE()]);

        render(renderPanel(mock));

        const input = await screen.findByTestId("issues-assignee-deadbeefcafe0001");

        fireEvent.change(input, { target: { value: "bob" } });
        fireEvent.keyDown(input, { key: "Enter" });

        await waitFor(() => {
            expect(mock.query).toHaveBeenCalledWith(
                expect.objectContaining({ __lunoraRef: ADMIN_FUNCTIONS.assignIssue }),
                { assignee: "bob", hash: "deadbeefcafe0001" },
                expect.anything(),
            );
        });

        fireEvent.change(input, { target: { value: "   " } });
        fireEvent.keyDown(input, { key: "Enter" });

        // A blank commit sends an explicit null (unassign).
        await waitFor(() => {
            expect(mock.query).toHaveBeenCalledWith(
                expect.objectContaining({ __lunoraRef: ADMIN_FUNCTIONS.assignIssue }),
                { assignee: null, hash: "deadbeefcafe0001" },
                expect.anything(),
            );
        });
    });

    it("filters by status through the getIssues `status` arg", async () => {
        expect.assertions(1);

        const mock = createClient([ISSUE()]);

        render(renderPanel(mock));

        fireEvent.click(await screen.findByTestId("issues-filter-resolved"));

        await waitFor(() => {
            expect(mock.query).toHaveBeenCalledWith(
                expect.objectContaining({ __lunoraRef: ADMIN_FUNCTIONS.getIssues }),
                { status: "resolved" },
                expect.anything(),
            );
        });
    });

    it("tracks busy state per row so overlapping triage writes do not cross-clear", async () => {
        expect.assertions(4);

        const HASH_A = "deadbeefcafe0001";
        const HASH_B = "deadbeefcafe0002";

        // Each triage write hangs until we release it by hash — so two writes can be
        // in flight at once and we can complete one while the other is still pending.
        const releasers = new Map<string, () => void>();
        const mock = createMockClient({
            query: (reference, args): unknown => {
                if (reference === ADMIN_FUNCTIONS.getIssues) {
                    return { issues: [ISSUE({ hash: HASH_A, title: "Alpha" }), ISSUE({ hash: HASH_B, title: "Beta" })] };
                }

                const { hash } = args as { hash: string };

                return new Promise<{ state: Record<string, never> }>((resolve) => {
                    releasers.set(hash, () => {
                        resolve({ state: {} });
                    });
                });
            },
        });

        render(renderPanel(mock));

        const resolveDisabled = (hash: string): boolean => screen.getByTestId(`issues-resolve-${hash}`).hasAttribute("disabled");

        // Kick off both triage writes; both rows go busy independently.
        fireEvent.click(await screen.findByTestId(`issues-resolve-${HASH_A}`));
        fireEvent.click(screen.getByTestId(`issues-resolve-${HASH_B}`));

        // Wait (without an `expect`, so retries don't inflate the assertion count) for
        // row A to register as busy, then assert both rows are busy.
        await waitFor(() => {
            if (!resolveDisabled(HASH_A)) {
                throw new Error("row A not busy yet");
            }
        });

        expect(resolveDisabled(HASH_A)).toBe(true);
        expect(resolveDisabled(HASH_B)).toBe(true);

        // Complete only row A's write. Row A re-enables; row B must stay busy — the
        // first completion must not clear the second's busy flag.
        releasers.get(HASH_A)?.();

        await waitFor(() => {
            if (resolveDisabled(HASH_A)) {
                throw new Error("row A still busy");
            }
        });

        expect(resolveDisabled(HASH_A)).toBe(false);
        expect(resolveDisabled(HASH_B)).toBe(true);
    });

    it("renders the empty state when the shard has no grouped errors", async () => {
        expect.assertions(1);

        render(renderPanel(createClient([])));

        await waitFor(() => {
            expect(screen.getByTestId("issues-empty")).toBeDefined();
        });
    });
});

// `Error 1101` grounds to a curated Cloudflare platform-error solution in
// `@lunora/errors`, so the client-side "Suggested fix" always renders offline.
const GROUNDED_MESSAGE = "Error 1101: Worker threw exception";

/**
 * A mock whose `getIssues` returns one issue and whose `explainIssue` echoes the
 * supplied result. Any other `query` is a harmless stub — the explainer flow
 * never triages, so the triage RPCs are never hit here.
 */
const createExplainClient = (
    explain: ExplainIssueResult,
    issue: ErrorIssue = ISSUE({ sampleMessage: GROUNDED_MESSAGE, title: "Worker threw exception" }),
): MockClientHooks =>
    createMockClient({
        query: (reference): unknown => {
            if (reference === ADMIN_FUNCTIONS.getIssues) {
                return { issues: [issue] };
            }

            if (reference === ADMIN_FUNCTIONS.explainIssue) {
                return explain;
            }

            return { state: {} };
        },
    });

/** Pull the `explainIssue` invocation's args off the mocked `query`, or `undefined` if it never fired. */
const explainArgs = (mock: MockClientHooks): unknown =>
    mock.query.mock.calls.find(([reference]) => (reference as { __lunoraRef: string }).__lunoraRef === ADMIN_FUNCTIONS.explainIssue)?.[1];

describe("issuesPanel explainer", () => {
    it("expands a row to the offline grounded fix from the error catalog", async () => {
        expect.assertions(2);

        const mock = createExplainClient({ degraded: false, explanation: "unused", model: "test" });

        render(renderPanel(mock));

        const toggle = await screen.findByTestId("issues-toggle-deadbeefcafe0001");

        // Collapsed: no detail row yet.
        expect(screen.queryByTestId("issues-detail-deadbeefcafe0001")).toBeNull();

        fireEvent.click(toggle);

        // Expanded: the grounded hint renders with no AI call.
        expect(screen.getByTestId("issues-hint-deadbeefcafe0001")).toBeDefined();
    });

    it("invokes explainIssue with the issue facts and renders the AI explanation", async () => {
        expect.assertions(3);

        const mock = createExplainClient({
            degraded: false,
            explanation: "This error means the Worker script threw before responding.",
            groundedId: "cloudflare-error-1101",
            model: "@cf/meta/llama-3.1-8b-instruct",
        });

        render(renderPanel(mock));

        fireEvent.click(await screen.findByTestId("issues-toggle-deadbeefcafe0001"));
        fireEvent.click(screen.getByTestId("issues-explain-deadbeefcafe0001"));

        const explanation = await screen.findByTestId("issues-explanation-deadbeefcafe0001");

        expect(explanation.textContent).toContain("threw before responding");
        // The action is grounded with the issue's own message + context.
        expect(explainArgs(mock)).toMatchObject({ culprit: "messages:send", sampleMessage: GROUNDED_MESSAGE, title: "Worker threw exception" });
        // No degraded note when the model returned text.
        expect(screen.queryByTestId("issues-degraded-deadbeefcafe0001")).toBeNull();
    });

    it("degrades to the grounded fix when no AI binding is configured", async () => {
        expect.assertions(2);

        const mock = createExplainClient({ degraded: true, groundedId: "cloudflare-error-1101", hint: "…", reason: "no-ai-binding" });

        render(renderPanel(mock));

        fireEvent.click(await screen.findByTestId("issues-toggle-deadbeefcafe0001"));
        fireEvent.click(screen.getByTestId("issues-explain-deadbeefcafe0001"));

        await waitFor(() => {
            expect(screen.getByTestId("issues-degraded-deadbeefcafe0001")).toBeDefined();
        });

        // A degraded result never renders a fabricated explanation.
        expect(screen.queryByTestId("issues-explanation-deadbeefcafe0001")).toBeNull();
    });

    it("shows a no-known-fix note for an unrecognised error message", async () => {
        expect.assertions(1);

        const unknown = ISSUE({ hash: "deadbeefcafe0009", sampleMessage: "totally novel failure with no catalog match" });
        const mock = createExplainClient({ degraded: false, explanation: "unused", model: "test" }, unknown);

        render(renderPanel(mock));

        fireEvent.click(await screen.findByTestId("issues-toggle-deadbeefcafe0009"));

        expect(screen.getByTestId("issues-hint-empty-deadbeefcafe0009")).toBeDefined();
    });
});
