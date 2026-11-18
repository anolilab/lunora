import { useQuery } from "@lunora/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { api } from "../lunora/_generated/api";
import { NotificationsSection } from "../src/client/NotificationsSection";
import type { OrgId } from "../src/client/types";

// Automocked: every hook returns undefined, which is the first render before any query has answered.
vi.mock(import("@lunora/react"));

// AsyncList reads the router location for its error line; there is no router outside the app.
vi.mock(import("../src/client/tabs"), () => {
    return { useScreen: () => "notifications" };
});

describe("the notifications page", () => {
    it("asks for recent deliveries on first render, before the channel list has answered", () => {
        expect.hasAssertions();

        const organizationId = "org_1" as OrgId;

        renderToStaticMarkup(<NotificationsSection organizationId={organizationId} />);

        expect(vi.mocked(useQuery)).toHaveBeenCalledWith(api.notifications.deliveries, { organizationId });
    });
});
