import { LunoraProvider } from "@lunora/react";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { KvBrowser } from "../../../src/features/kv/kv-browser";
import type { MockClientHooks } from "../../mock-client";
import { createMockClient } from "../../mock-client";

// A fresh seed per test so put/delete mutations don't leak across cases.
const makeSeed = (): Record<string, Record<string, { expiration?: number; metadata?: unknown; value: string }>> => {
    return {
        CACHE: {
            "session:abc": { metadata: { region: "us" }, value: '{"user":1}' },
            "session:def": { expiration: 4_102_444_800, value: "plain" },
        },
    };
};

const renderBrowser = (mock: MockClientHooks): ReactElement => (
    <LunoraProvider client={mock.asClient}>
        <KvBrowser />
    </LunoraProvider>
);

const isDisabled = (testId: string): boolean => screen.getByTestId<HTMLButtonElement>(testId).disabled;

describe("kvBrowser", () => {
    let mock: MockClientHooks;

    beforeEach(() => {
        mock = createMockClient({ kvNamespaces: [{ binding: "CACHE" }], kvSeed: makeSeed() });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("auto-selects the first namespace and lists its keys", async () => {
        expect.assertions(1);

        render(renderBrowser(mock));

        await screen.findByTestId("kv-key-row-session:abc");

        expect(screen.getByTestId("kv-key-row-session:def")).toBeDefined();
    });

    it("creates a key through the new-key form and reloads the list", async () => {
        expect.assertions(1);

        render(renderBrowser(mock));

        fireEvent.click(await screen.findByTestId("kv-new-key-btn"));

        fireEvent.change(screen.getByTestId("kv-create-name"), { target: { value: "flag:beta" } });
        fireEvent.change(screen.getByTestId("kv-create-value"), { target: { value: "on" } });
        fireEvent.change(screen.getByTestId("kv-create-ttl"), { target: { value: "3600" } });
        fireEvent.click(screen.getByTestId("kv-create-submit"));

        // The reloaded list surfaces the freshly-created key.
        await screen.findByTestId("kv-key-row-flag:beta");

        expect(mock.putKvValue).toHaveBeenCalledWith(expect.objectContaining({ expirationTtl: 3600, key: "flag:beta", namespace: "CACHE", value: "on" }));
    });

    it("saves an edited TTL as expirationTtl", async () => {
        expect.assertions(2);

        render(renderBrowser(mock));

        fireEvent.click(await screen.findByTestId("kv-key-row-session:abc"));

        // The value textarea only mounts once the value has loaded.
        const editor = await screen.findByTestId<HTMLTextAreaElement>("kv-value-editor");

        expect(editor.value).toBe('{"user":1}');

        fireEvent.change(screen.getByTestId("kv-ttl-input"), { target: { value: "120" } });
        fireEvent.click(screen.getByTestId("kv-save-btn"));

        expect(mock.putKvValue).toHaveBeenCalledWith(
            expect.objectContaining({ expiration: undefined, expirationTtl: 120, key: "session:abc", namespace: "CACHE" }),
        );
    });

    it("preserves the existing absolute expiration when no fresh TTL is entered", async () => {
        expect.assertions(1);

        render(renderBrowser(mock));

        fireEvent.click(await screen.findByTestId("kv-key-row-session:def"));
        await screen.findByTestId("kv-value-editor");

        fireEvent.click(screen.getByTestId("kv-save-btn"));

        expect(mock.putKvValue).toHaveBeenCalledWith(
            expect.objectContaining({ expiration: 4_102_444_800, expirationTtl: undefined, key: "session:def", namespace: "CACHE" }),
        );
    });

    it("pretty-prints a JSON value with the Format button", async () => {
        expect.assertions(1);

        render(renderBrowser(mock));

        fireEvent.click(await screen.findByTestId("kv-key-row-session:abc"));

        const editor = await screen.findByTestId<HTMLTextAreaElement>("kv-value-editor");

        fireEvent.click(await screen.findByTestId("kv-format-btn"));

        expect(editor.value).toBe('{\n  "user": 1\n}');
    });

    it("pretty-prints metadata JSON with its Format button", async () => {
        expect.assertions(1);

        render(renderBrowser(mock));

        fireEvent.click(await screen.findByTestId("kv-key-row-session:abc"));

        const meta = await screen.findByTestId<HTMLTextAreaElement>("kv-metadata-editor");

        fireEvent.change(meta, { target: { value: '{"a":1}' } });
        fireEvent.click(screen.getByTestId("kv-metadata-editor-format"));

        expect(meta.value).toBe('{\n  "a": 1\n}');
    });

    it("blocks saving when metadata is not valid JSON", async () => {
        expect.assertions(1);

        render(renderBrowser(mock));

        fireEvent.click(await screen.findByTestId("kv-key-row-session:abc"));

        fireEvent.change(await screen.findByTestId("kv-metadata-editor"), { target: { value: "{not json" } });

        expect(isDisabled("kv-save-btn")).toBe(true);
    });

    it("bulk-deletes every selected key", async () => {
        expect.assertions(2);

        render(renderBrowser(mock));

        fireEvent.click(await screen.findByTestId("kv-select-all"));
        fireEvent.click(screen.getByTestId("kv-bulk-delete-btn"));

        expect(mock.deleteKvKey).toHaveBeenCalledTimes(2);
        expect(mock.deleteKvKey).toHaveBeenCalledWith(expect.objectContaining({ key: "session:abc", namespace: "CACHE" }));
    });

    it("surfaces an error and keeps failed keys when a bulk delete partially fails", async () => {
        expect.assertions(2);

        // First delete (session:abc, sorted first) rejects; session:def still deletes.
        mock.deleteKvKey.mockRejectedValueOnce(new Error("nope"));

        render(renderBrowser(mock));

        fireEvent.click(await screen.findByTestId("kv-select-all"));
        fireEvent.click(screen.getByTestId("kv-bulk-delete-btn"));

        await screen.findByTestId("kv-bulk-error");

        // The failed key's row survives; the successful one is pruned.
        expect(screen.getByTestId("kv-key-row-session:abc")).toBeDefined();
        expect(screen.queryByTestId("kv-key-row-session:def")).toBeNull();
    });

    it("blocks saving when the TTL is below Cloudflare's 60-second minimum", async () => {
        expect.assertions(1);

        render(renderBrowser(mock));

        fireEvent.click(await screen.findByTestId("kv-key-row-session:abc"));
        fireEvent.change(await screen.findByTestId("kv-ttl-input"), { target: { value: "30" } });

        expect(isDisabled("kv-save-btn")).toBe(true);
    });

    it("opens the value editor in a side sheet when a key row is clicked", async () => {
        expect.assertions(1);

        render(renderBrowser(mock));

        fireEvent.click(await screen.findByTestId("kv-key-row-session:abc"));

        // The editor renders inside the side sheet.
        await expect(screen.findByTestId("kv-editor-sheet")).resolves.toBeDefined();
    });

    it("opens the create form in a side sheet from the New key button", async () => {
        expect.assertions(1);

        render(renderBrowser(mock));

        fireEvent.click(await screen.findByTestId("kv-new-key-btn"));

        await expect(screen.findByTestId("kv-create-sheet")).resolves.toBeDefined();
    });

    it("re-lists rather than blanking the table when Filter is clicked with an unchanged prefix", async () => {
        expect.assertions(2);

        render(renderBrowser(mock));

        await screen.findByTestId("kv-key-row-session:abc");

        // The very first click applies the prefix the list already ran with. The
        // applied prefix is unchanged, so nothing re-keys the load — but the click
        // still clears the rendered page, and the list must come back.
        fireEvent.click(screen.getByTestId("kv-filter-btn"));

        await expect(screen.findByTestId("kv-key-row-session:abc")).resolves.toBeDefined();
        expect(screen.getByTestId("kv-key-table")).toBeDefined();
    });

    it("shows an empty state when no namespaces are configured", async () => {
        expect.assertions(1);

        render(renderBrowser(createMockClient({ kvNamespaces: [] })));

        await expect(screen.findByTestId("kv-empty")).resolves.toBeDefined();
    });
});
