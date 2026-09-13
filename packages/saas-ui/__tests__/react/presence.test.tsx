import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { PresenceMemberLike } from "../../src/core";
import { PresenceBar } from "../../src/react/presence";

const NOW = Date.UTC(2026, 8, 12, 12, 0, 0);

const member = (sessionId: string, userId?: string, name?: string): PresenceMemberLike => {
    return {
        data: name === undefined ? undefined : { name },
        lastSeen: NOW,
        sessionId,
        userId,
    };
};

describe("presenceBar", () => {
    it("shows one avatar per person and says who is here", () => {
        render(<PresenceBar currentUserId="u1" members={[member("t1", "u1", "Ada Lovelace"), member("t2", "u2", "Grace Hopper")]} />);

        expect(screen.getByText("AL")).toBeInTheDocument();
        expect(screen.getByText("GH")).toBeInTheDocument();
        expect(screen.getByText("1 other person is here")).toBeInTheDocument();
    });

    it("marks the viewer's own avatar", () => {
        const { container } = render(<PresenceBar currentUserId="u1" members={[member("t1", "u1", "Ada")]} />);

        expect(container.querySelector(".lu-saas-avatar--self")).not.toBeNull();
        expect(screen.getByTitle("Ada (you)")).toBeInTheDocument();
    });

    it("collapses past the cap", () => {
        const many = Array.from({ length: 10 }, (_, index) => member(`t${index.toString()}`, `u${index.toString()}`, `P${index.toString()}`));

        render(<PresenceBar cap={3} currentUserId={undefined} members={many} />);

        expect(screen.getByText("+7")).toBeInTheDocument();
    });

    it("marks itself busy while the subscription is connecting", () => {
        const { container } = render(<PresenceBar currentUserId="u1" members={undefined} />);

        expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    });
});
