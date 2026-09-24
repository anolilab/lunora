/**
 * Read a call's dollar cost from AI SDK `providerMetadata`, defensively. AI
 * Gateway surfaces per-request cost there (under a provider bag's `cost` field)
 * once cost routing is enabled; until then it is absent and this returns
 * `undefined`. Probing rather than hard-depending keeps a span correct with or
 * without a gateway in front.
 * @experimental
 */
const reportedCostOf = (providerMetadata: unknown): number | undefined => {
    if (typeof providerMetadata !== "object" || providerMetadata === null) {
        return undefined;
    }

    for (const bag of Object.values(providerMetadata as Record<string, unknown>)) {
        if (typeof bag === "object" && bag !== null) {
            const { cost } = bag as { cost?: unknown };

            if (typeof cost === "number" && Number.isFinite(cost)) {
                return cost;
            }
        }
    }

    return undefined;
};

export default reportedCostOf;
