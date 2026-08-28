import { describe, expect, it } from "vitest";

import { toProjectView } from "../lunora/projects";

/**
 * The public projection for `projects.listByOrg`.
 *
 * This exists because of a near-miss worth pinning. `listByOrg` used to
 * `return page` — the stored rows, verbatim — which was harmless while every
 * column was public. Adding the preview-password hash and salt to the table
 * turned that same line into an exfiltration: every org member would have
 * received both over the wire, with nothing failing and nothing logged.
 *
 * A projection is only a real boundary if something asserts what it drops, so
 * these tests name the secret columns explicitly.
 */
describe(toProjectView, () => {
    const row = {
        _id: "prj_1" as never,
        createdAt: 1_700_000_000_000,
        name: "Web",
        organizationId: "org_1" as never,
        previewPasswordHash: "5e884898da280471",
        previewPasswordSalt: "a1b2c3",
        slug: "web",
    };

    it("never carries the preview password hash or salt onto the wire", () => {
        const view = toProjectView(row);

        expect(view).not.toHaveProperty("previewPasswordHash");
        expect(view).not.toHaveProperty("previewPasswordSalt");
        expect(JSON.stringify(view)).not.toContain("5e884898da280471");
        expect(JSON.stringify(view)).not.toContain("a1b2c3");
    });

    it("reports protection as a boolean the dashboard can render", () => {
        expect(toProjectView(row).previewProtected).toBe(true);
        expect(toProjectView({ ...row, previewPasswordHash: undefined, previewPasswordSalt: undefined }).previewProtected).toBe(false);
    });

    it("keeps the fields the dashboard actually needs", () => {
        expect(toProjectView(row)).toStrictEqual({
            _id: "prj_1",
            createdAt: 1_700_000_000_000,
            name: "Web",
            organizationId: "org_1",
            previewProtected: true,
            slug: "web",
        });
    });

    it("omits optional fields rather than emitting undefined", () => {
        const view = toProjectView({ ...row, framework: "astro", githubRepo: "acme/web" });

        expect(view.framework).toBe("astro");
        expect(view.githubRepo).toBe("acme/web");
        expect(toProjectView(row)).not.toHaveProperty("framework");
    });
});
