import type { AppendAuthAuditEntry, AppendAuthAuditOptions } from "./audit";

/** What the audit hook does with a row past persisting it, which admin-plane rows get too. */
interface AuditHookSinkConfig extends AppendAuthAuditOptions {
    onRecord?: (entry: AppendAuthAuditEntry) => Promise<void> | void;
}

/**
 * The config each audit hook was built with, by the hook function better-auth holds. The hook config lives
 * inside the app's auth options, where codegen cannot name it, so the writer finds it through the instance.
 * Kept out of `audit.ts`, which is a public subpath (`@lunora/auth/audit`).
 */
const AUDIT_HOOK_CONFIGS = new WeakMap<object, AuditHookSinkConfig>();

const registerAuditHookConfig = (hook: object, config: AuditHookSinkConfig): void => {
    AUDIT_HOOK_CONFIGS.set(hook, config);
};

const auditHookConfigOf = (hook: object): AuditHookSinkConfig | undefined => AUDIT_HOOK_CONFIGS.get(hook);

export { auditHookConfigOf, registerAuditHookConfig };
export type { AuditHookSinkConfig };
