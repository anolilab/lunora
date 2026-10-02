import { describe, expect, it } from "vitest";

import type { BoxView } from "../src/client/boxes";
import { assessTargetDraft, assignableBoxes, BOX_STATUS, boxHostname, canManage, describeEnrolError, formatMegabytes, roleOf } from "../src/client/boxes";
import { formatRelativeTime } from "../src/client/format";

/**
 * The Boxes tab's decisions (plan 458 W9), tested without a DOM: how each box
 * state reads, who sees the controls, which boxes a project may be placed on and
 * how the enrol refusal is worded. The components only render these.
 */
const box = (overrides: Partial<BoxView>): BoxView => {
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

describe("box status chips", () => {
    it.each([
        ["pending", "warning"],
        ["online", "success"],
        ["offline", "danger"],
        ["revoked", "neutral"],
    ] as const)("renders %s with the %s tone and an explanation", (status, tone) => {
        expect(BOX_STATUS[status].tone).toBe(tone);
        expect(BOX_STATUS[status].label).toBe(status);
        expect(BOX_STATUS[status].description.length).toBeGreaterThan(0);
    });

    it("tells an operator a revoked box can only come back as a new one", () => {
        expect(BOX_STATUS.revoked.description).toMatch(/enrolling again as a new box/u);
    });
});

describe(boxHostname, () => {
    it("puts the slug under the configured apex", () => {
        expect(boxHostname("bslug", "boxes.example")).toBe("bslug.boxes.example");
    });
});

describe(canManage, () => {
    it("lets owners and admins manage, and nobody else", () => {
        expect(canManage("owner")).toBe(true);
        expect(canManage("admin")).toBe(true);
        expect(canManage("member")).toBe(false);
        expect(canManage("viewer")).toBe(false);
    });

    it("keeps the controls off while the role is still unknown", () => {
        expect(canManage(undefined)).toBe(false);
    });
});

describe(roleOf, () => {
    const members = [
        { role: "owner" as const, userId: "u1" },
        { role: "viewer" as const, userId: "u2" },
    ];

    it("finds the caller's role in the roster", () => {
        expect(roleOf(members, "u2")).toBe("viewer");
    });

    it("answers undefined while the roster loads, or for someone not on it", () => {
        expect(roleOf(undefined, "u1")).toBeUndefined();
        expect(roleOf(members, "u3")).toBeUndefined();
    });
});

describe(assignableBoxes, () => {
    it("offers every box that is not revoked, pending and offline included", () => {
        const boxes = [
            box({ _id: "a" as BoxView["_id"], status: "online" }),
            box({ _id: "b" as BoxView["_id"], status: "revoked" }),
            box({ _id: "c" as BoxView["_id"], status: "pending" }),
            box({ _id: "d" as BoxView["_id"], status: "offline" }),
        ];

        expect(assignableBoxes(boxes).map((entry) => entry._id)).toStrictEqual(["a", "c", "d"]);
        expect(assignableBoxes(undefined)).toStrictEqual([]);
    });
});

describe(describeEnrolError, () => {
    it("rewords the plan-limit refusal into something the operator can act on", () => {
        const described = describeEnrolError("FORBIDDEN: boxes quota reached for this plan (limit 0)");

        expect(described.quota).toBe(true);
        expect(described.message).toMatch(/plan's box limit/u);
    });

    it("passes any other refusal through as the server worded it", () => {
        expect(describeEnrolError("a box needs a name")).toStrictEqual({ message: "a box needs a name", quota: false });
    });
});

describe(formatMegabytes, () => {
    it("prints megabytes in the studio's size format", () => {
        expect(formatMegabytes(4096)).toBe("4.0 GB");
        expect(formatMegabytes(512)).toBe("512 MB");
    });
});

describe(formatRelativeTime, () => {
    const now = 1_000_000_000;

    it.each([
        [now - 5000, "5s ago"],
        [now - 3 * 60_000, "3m ago"],
        [now - 2 * 3_600_000, "2h ago"],
        [now - 3 * 86_400_000, "3d ago"],
        [now + 5000, "0s ago"],
    ])("formats %d as %s", (at, expected) => {
        expect(formatRelativeTime(at, now)).toBe(expected);
    });
});

describe(assessTargetDraft, () => {
    const saved = { boxId: "", target: "cloudflare-wfp" };

    it("needs a box for celld-vps, and is incomplete without one", () => {
        expect(assessTargetDraft({ boxId: "", target: "celld-vps" }, saved)).toStrictEqual({ changed: true, complete: false, needsBox: true });
        expect(assessTargetDraft({ boxId: "box_1", target: "celld-vps" }, saved)).toStrictEqual({ changed: true, complete: true, needsBox: true });
    });

    it("treats the saved value as unchanged, and a different box as a change", () => {
        expect(assessTargetDraft(saved, saved).changed).toBe(false);

        const onBox = { boxId: "box_1", target: "celld-vps" };

        expect(assessTargetDraft(onBox, onBox).changed).toBe(false);
        expect(assessTargetDraft({ boxId: "box_2", target: "celld-vps" }, onBox).changed).toBe(true);
    });

    it("ignores a stale box once the target is back on Cloudflare", () => {
        expect(assessTargetDraft({ boxId: "box_1", target: "cloudflare-wfp" }, saved)).toStrictEqual({ changed: false, complete: true, needsBox: false });
    });

    it("never calls an unknown target complete", () => {
        expect(assessTargetDraft({ boxId: "", target: "aws" }, saved).complete).toBe(false);
    });
});
