import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StudioApp } from "../../src/app/app";
import { createAdminWsTokenProvider } from "../../src/lib/ws-token-provider";

vi.mock(import("../../src/lib/ws-token-provider"), () => {
    return {
        createAdminWsTokenProvider: vi.fn<typeof createAdminWsTokenProvider>(() => {
            return { getToken: async (): Promise<string> => "sub-token", invalidate: (): void => {} };
        }),
    };
});

describe("studioApp credentials", () => {
    afterEach(() => {
        sessionStorage.clear();
        vi.mocked(createAdminWsTokenProvider).mockClear();
    });

    it("builds the first post-login client with the token, not 300 ms later", () => {
        expect.assertions(2);

        render(<StudioApp baseUrl="https://app.example" />);

        fireEvent.change(screen.getByTestId("lunora-studio-login-token"), { target: { value: "s3cret" } });
        fireEvent.click(screen.getByTestId("lunora-studio-login-submit"));

        // The gate opens on the RAW token, so the client the shell mounts against
        // must carry the credential on that same render. Asserted with no elapsed
        // time on purpose: a debounce window here is a row of 401s across every
        // panel that mounts inside it.
        expect(createAdminWsTokenProvider).toHaveBeenCalledWith(expect.objectContaining({ adminToken: "s3cret" }));
        expect(screen.queryByTestId("lunora-studio-login-token")).toBeNull();
    });
});
