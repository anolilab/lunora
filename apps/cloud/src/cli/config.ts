/**
 * CLI configuration (CLOUD-PLAN.md §2.2 — `lunora login/link/deploy`). The
 * deploy CLI persists the API endpoint, the deploy key, and the linked project
 * in a small config; the {@link ConfigStore} abstracts where it lives so the
 * command logic is unit-testable with an in-memory store.
 */

export interface CliConfig {
    apiUrl?: string;
    deployKey?: string;
    projectId?: string; // secret-scanner:allow -- domain field name
}

export interface ConfigStore {
    read: () => Promise<CliConfig>;
    write: (config: CliConfig) => Promise<void>;
}
