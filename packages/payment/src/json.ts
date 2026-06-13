/**
 * Defensive accessors for parsed-but-untyped webhook payloads (provider events arrive as
 * `unknown` after JSON parsing). Shared by the provider adapters — never returns `any`.
 */

export const asRecord = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {});

export const readString = (object: Record<string, unknown>, key: string): string | undefined => (typeof object[key] === "string" ? object[key] : undefined);

export const readNumber = (object: Record<string, unknown>, key: string): number | undefined => (typeof object[key] === "number" ? object[key] : undefined);

export const readBoolean = (object: Record<string, unknown>, key: string): boolean | undefined => (typeof object[key] === "boolean" ? object[key] : undefined);
