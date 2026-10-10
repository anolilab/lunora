import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BoxDetail } from "../src/client/BoxDetail";
import type { BoxView } from "../src/client/boxes";
import { pickBox, UNCOLLECTED_TELEMETRY } from "../src/client/boxes";

/**
 * The Boxes detail panel, rendered without a DOM: it shows only fields the control
 * plane really has, names `memMb` for what it is (available memory, not used), and
 * says plainly that host metrics are not collected instead of charting anything.
 */
/** A key/value row labelled as bare or used memory — the mislabel this panel fixed. */
const MEMORY_MISLABEL = /<dt[^>]*>\s*memory(?: used)?\s*<\/dt>/iu;
/** Any version annotation: only a positive outdated finding may produce one. */
const VERSION_ANNOTATION = /<span[^>]*>outdated<\/span>/u;

const box = (overrides: Partial<BoxView> = {}): BoxView => {
    return {
        _id: "box_1" as BoxView["_id"],
        createdAt: 1,
        name: "fsn1",
        organizationId: "org_1" as BoxView["organizationId"],
        outdated: false,
        publicKey: "k",
        singleTrust: false,
        slug: "babc",
        status: "online",
        ...overrides,
    };
};

const render = (view: BoxView): string =>
    renderToStaticMarkup(
        <BoxDetail
            box={view}
            diagnose={false}
            domain="boxes.example"
            manage={false}
            onDiagnose={() => undefined}
            onRename={() => undefined}
            onRevoke={() => undefined}
            projects={["web"]}
        />,
    );

describe("the box detail panel", () => {
    it("labels the memory reading as available memory, never as memory used", () => {
        expect.hasAssertions();

        const html = render(box({ resources: { diskFreeMb: 10_240, memMb: 2048 } }));

        expect(html).toContain("memory available");
        expect(html).toContain("2.0 GB");
        expect(html).toContain("disk free (data dir)");
        // No key/value row presents the reading as used (or bare) memory. The phrase
        // may still appear in the empty state's list of metrics that are NOT collected.
        expect(html).not.toMatch(MEMORY_MISLABEL);
    });

    it("renders the empty state naming every metric the agent does not collect", () => {
        expect.hasAssertions();

        const html = render(box());

        expect(html).toContain("No host metrics yet");

        for (const metric of UNCOLLECTED_TELEMETRY) {
            expect(html).toContain(metric);
        }

        // No chart is drawn for data that does not exist.
        expect(html).not.toContain('<svg class="recharts');
        expect(html).not.toContain("<polyline");
    });

    it("marks celld outdated only when the finding is positive", () => {
        expect.hasAssertions();

        const versions = { caddy: "2.8.4", celld: "0.6.0", hostd: "0.2.0" };

        expect(render(box({ outdated: true, versions }))).toMatch(VERSION_ANNOTATION);
        // `false` can also mean no release is known, so it must not read as "latest".
        expect(render(box({ outdated: false, versions }))).not.toMatch(VERSION_ANNOTATION);
    });

    it("shows the box's own hostname and its addresses", () => {
        expect.hasAssertions();

        const html = render(box({ ipv4: "203.0.113.7", ipv6: "2001:db8::7" }));

        expect(html).toContain("babc.boxes.example");
        expect(html).toContain("203.0.113.7");
        expect(html).toContain("2001:db8::7");
    });
});

describe(pickBox, () => {
    it("keeps the picked box, else falls back to the first one not revoked", () => {
        expect.hasAssertions();

        const revoked = box({ _id: "box_r" as BoxView["_id"], status: "revoked" });
        const live = box({ _id: "box_l" as BoxView["_id"] });

        expect(pickBox([revoked, live], "box_r")?._id).toBe("box_r");
        expect(pickBox([revoked, live], null)?._id).toBe("box_l");
        expect(pickBox([revoked, live], "gone")?._id).toBe("box_l");
        expect(pickBox([revoked], null)?._id).toBe("box_r");
        expect(pickBox([], null)).toBeUndefined();
    });
});
