package dev.lunora;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * Merges a row-change {@code delta} frame into a list-shaped query result.
 *
 * <p>Ported literally from the reference client's {@code delta-merge.ts} and {@code
 * shared/page-result.ts}; insert placement is normative (protocol README 5.1.1), because the server
 * replays the same placement before it sends the delta and a different rule desyncs silently.
 */
final class DeltaMerge {
    private static final String ID_FIELD = "_id";
    private static final String CREATION_FIELD = "_creationTime";
    private static final String PAGE_FIELD = "page";

    /** The connect-frame capability that makes the server send row deltas. */
    static final String PAGE_DELTA_CAPABILITY = "pageDelta";

    private DeltaMerge() {}

    /** The outcome of folding one {@code delta} payload into the server base. */
    sealed interface Outcome {
        /** The value to publish as the new server base. */
        record Publish(Object value) implements Outcome {}

        /** A row change that cannot be merged: keep the previous value. */
        record Keep() implements Outcome {}
    }

    /**
     * Resolves a decoded {@code delta} payload against the subscription's server base.
     *
     * <p>A payload that is not a row change replaces the value. A row change that cannot be merged,
     * including one with no cached base or against a committed null, is NOT published: the
     * reference re-snapshots here, but this port has no resubscribe-for-snapshot path, so it keeps
     * the previous value and the next {@code data} frame reconciles it.
     */
    static Outcome resolve(Object base, Object delta) {
        if (!isMutationDelta(delta)) {
            return new Outcome.Publish(delta);
        }

        Optional<Object> merged = applyDelta(base, asMap(delta));

        return merged.<Outcome>map(Outcome.Publish::new).orElseGet(Outcome.Keep::new);
    }

    /**
     * An object with a string {@code key}, a string {@code table} and an insert/update/delete op.
     */
    static boolean isMutationDelta(Object value) {
        if (!(value instanceof Map<?, ?> candidate)) {
            return false;
        }

        return candidate.get("key") instanceof String
                && candidate.get("table") instanceof String
                && ("insert".equals(candidate.get("op"))
                        || "update".equals(candidate.get("op"))
                        || "delete".equals(candidate.get("op")));
    }

    /**
     * Empty when {@code current} is not a row list or a row in it carries no string {@code _id}.
     */
    private static Optional<Object> applyDelta(Object current, Map<String, Object> delta) {
        List<?> list = rowListOf(current);

        if (list == null) {
            return Optional.empty();
        }

        List<Object> next = mergeRows(list, delta);

        if (next == null) {
            return Optional.empty();
        }

        if (current instanceof List) {
            return Optional.of(next);
        }

        // A paginated result keeps every field outside `page`.
        Map<String, Object> page = new LinkedHashMap<>(asMap(current));

        page.put(PAGE_FIELD, next);

        return Optional.of(page);
    }

    private static List<?> rowListOf(Object value) {
        if (value instanceof List<?> list) {
            return list;
        }

        if (value instanceof Map<?, ?> map && map.get(PAGE_FIELD) instanceof List<?> page) {
            return page;
        }

        return null;
    }

    private static List<Object> mergeRows(List<?> list, Map<String, Object> delta) {
        String key = (String) delta.get("key");
        String op = (String) delta.get("op");
        List<Object> next = new ArrayList<>();
        int existingIndex = -1;

        for (Object element : list) {
            // A list of scalars, or rows without `_id`, has no stable key to splice against.
            if (!(element instanceof Map<?, ?> row) || !(row.get(ID_FIELD) instanceof String id)) {
                return null;
            }

            if (id.equals(key)) {
                // A delete for a row this list never held is a legitimate no-op.
                if ("delete".equals(op)) {
                    continue;
                }

                if (existingIndex == -1) {
                    existingIndex = next.size();
                }
            }

            next.add(element);
        }

        if ("delete".equals(op)) {
            return next;
        }

        // insert / update both need the new row body to splice in.
        if (!(delta.get("row") instanceof Map<?, ?> row)) {
            return null;
        }

        if (existingIndex == -1) {
            next.add(insertionIndexFor(next, row), row);
        } else {
            next.set(existingIndex, row);
        }

        return next;
    }

    /** Where a new row splices in; see protocol README 5.1.1. */
    private static int insertionIndexFor(List<Object> list, Map<?, ?> row) {
        if (!(row.get(CREATION_FIELD) instanceof Number creation)) {
            return list.size();
        }

        boolean descending = isDescending(list);

        for (int index = 0; index < list.size(); index++) {
            if (((Map<?, ?>) list.get(index)).get(CREATION_FIELD) instanceof Number existing
                    && (descending
                            ? existing.doubleValue() < creation.doubleValue()
                            : existing.doubleValue() > creation.doubleValue())) {
                return index;
            }
        }

        return list.size();
    }

    /** The first strictly-ordered numeric adjacent pair decides; ascending when indeterminate. */
    private static boolean isDescending(List<Object> list) {
        Double previous = null;

        for (Object row : list) {
            if (!(((Map<?, ?>) row).get(CREATION_FIELD) instanceof Number number)) {
                continue;
            }

            double existing = number.doubleValue();

            if (previous != null) {
                if (existing < previous) {
                    return true;
                }

                if (existing > previous) {
                    return false;
                }
            }

            previous = existing;
        }

        return false;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> asMap(Object value) {
        return (Map<String, Object>) value;
    }
}
