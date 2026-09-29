/**
 * Rows both ports' card suites render. The two suites assert the same
 * behaviours against the same core and differ only in how they mount and
 * dispatch, so the data lives here once.
 */
import type { ActivityRow, OrganizationRow, ProjectRow } from "../src/core";

const CREATED_SENTENCE = /created the project Website/u;
const NOW = Date.UTC(2026, 8, 11, 12, 0, 0);
const HOUR = 3_600_000;

const noop = async (): Promise<void> => {};

const project = (name: string, overrides: Partial<ProjectRow> = {}): ProjectRow => {
    return {
        _creationTime: NOW,
        _id: `p-${name}`,
        createdBy: "u1",
        name,
        organizationId: "org1",
        slug: name.toLowerCase(),
        ...overrides,
    };
};

const activity = (action: string, createdAt: number, meta?: Record<string, unknown>): ActivityRow => {
    return {
        _creationTime: createdAt,
        _id: `a-${createdAt.toString()}`,
        action,
        actorId: "u1",
        createdAt,
        meta,
        organizationId: "org1",
        subjectType: "project",
    };
};

const organization = (name: string, plan: string, seats: number): OrganizationRow => {
    return {
        _creationTime: NOW,
        _id: `o-${name}`,
        name,
        organizationId: `org-${name}`,
        plan,
        seats,
        slug: name.toLowerCase(),
        status: "active",
        updatedAt: NOW,
    };
};

export { activity, CREATED_SENTENCE, HOUR, noop, NOW, organization, project };
