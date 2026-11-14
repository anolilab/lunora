package dev.lunora

/**
 * Merges a row-change `delta` frame into a list-shaped query result, ported from
 * `packages/client/src/delta-merge.ts` and `shared/page-result.ts`.
 *
 * The server sends row deltas only to a client that announced `pageDelta` on `connect`, and
 * insert placement (`protocol/README.md` §5.1.1) is normative: the server replays the same
 * placement before it sends the delta, so a different rule desyncs the list silently.
 */
internal object RowDelta {
    private const val ID_FIELD = "_id"
    private const val CREATION_FIELD = "_creationTime"
    private const val PAGE_FIELD = "page"

    /** What a `delta` frame resolves to: a value to publish, or nothing (keep the previous one). */
    sealed class Resolution {
        data class Publish(val value: WireValue) : Resolution()

        /** A row change that could not be merged into the cached base. */
        object Unmergeable : Resolution()
    }

    /**
     * An object with a string `key`, a string `table` and an `op` of insert, update or delete.
     * Anything else is an opaque payload.
     */
    fun isRowChange(value: WireValue): Boolean {
        if (value !is WireValue.Obj) return false

        val op = (field(value, "op") as? WireValue.Text)?.value

        return field(value, "key") is WireValue.Text &&
            field(value, "table") is WireValue.Text &&
            (op == "insert" || op == "update" || op == "delete")
    }

    /**
     * Resolves a decoded `delta` payload against the subscription's server base.
     *
     * With no base, or against a committed null, the row change cannot merge and is held. When the
     * base cannot take the merge the previous value is kept and the envelope is NOT published: the reference
     * re-snapshots here, but this port has no resubscribe-for-snapshot path, so the gap is
     * left until the next `data` frame rather than hidden behind a wrong value.
     */
    fun resolve(delta: WireValue, base: WireValue?): Resolution {
        if (!isRowChange(delta)) return Resolution.Publish(delta)

        if (base == null) return Resolution.Unmergeable

        return apply(base, delta as WireValue.Obj)?.let { Resolution.Publish(it) } ?: Resolution.Unmergeable
    }

    private fun apply(current: WireValue, delta: WireValue.Obj): WireValue? {
        val list = rowListOf(current) ?: return null
        val next = mergeRows(list, delta) ?: return null

        if (current is WireValue.Arr) return WireValue.Arr(next)

        val wrapper = current as WireValue.Obj

        return WireValue.Obj(wrapper.fields.map { (name, value) -> if (name == PAGE_FIELD) name to WireValue.Arr(next) else name to value })
    }

    private fun rowListOf(value: WireValue): List<WireValue>? = when (value) {
        is WireValue.Arr -> value.items
        is WireValue.Obj -> (field(value, PAGE_FIELD) as? WireValue.Arr)?.items
        else -> null
    }

    private fun mergeRows(list: List<WireValue>, delta: WireValue.Obj): List<WireValue>? {
        val key = (field(delta, "key") as WireValue.Text).value
        val op = (field(delta, "op") as WireValue.Text).value
        val row = field(delta, "row")
        val next = ArrayList<WireValue>(list.size + 1)
        var existingIndex = -1

        for (element in list) {
            val id = idOf(element) ?: return null

            if (id == key) {
                if (op == "delete") continue

                if (existingIndex == -1) existingIndex = next.size
            }

            next.add(element)
        }

        if (op == "delete") return next

        if (row !is WireValue.Obj) return null

        if (existingIndex == -1) {
            next.add(insertionIndexFor(next, row), row)
        } else {
            next[existingIndex] = row
        }

        return next
    }

    /** Descending when the first strictly-ordered numeric adjacent pair falls; ascending otherwise. */
    private fun isDescending(list: List<WireValue>): Boolean {
        var previous: Double? = null

        for (row in list) {
            val existing = creationOf(row) ?: continue
            val before = previous

            if (before != null) {
                if (existing < before) return true
                if (existing > before) return false
            }

            previous = existing
        }

        return false
    }

    private fun insertionIndexFor(list: List<WireValue>, row: WireValue.Obj): Int {
        val creation = creationOf(row) ?: return list.size
        val descending = isDescending(list)

        for ((index, existingRow) in list.withIndex()) {
            val existing = creationOf(existingRow) ?: continue

            if (if (descending) existing < creation else existing > creation) return index
        }

        return list.size
    }

    private fun field(value: WireValue.Obj, name: String): WireValue? = value.fields.firstOrNull { it.first == name }?.second

    private fun idOf(row: WireValue): String? = ((row as? WireValue.Obj)?.let { field(it, ID_FIELD) } as? WireValue.Text)?.value

    private fun creationOf(row: WireValue): Double? = ((row as? WireValue.Obj)?.let { field(it, CREATION_FIELD) } as? WireValue.Num)?.value
}
