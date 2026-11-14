package lunora

// Row-delta merge: a delta frame carrying a row change ({key, op, table, row}) is
// folded into the subscription's cached server base instead of being published as
// the query result. The rules, and the insert placement in particular, are
// normative (protocol README 5.1.1) and match the reference client exactly: the
// server replays the same placement before it sends the delta, so any other rule
// desyncs the list silently.

const (
	idField       = "_id"
	creationField = "_creationTime"
	pageField     = "page"

	// PageDeltaCapability is the connect-frame capability that lets the server
	// send a row delta for a list result instead of a full snapshot.
	PageDeltaCapability = "pageDelta"
)

// mutationDelta is a decoded row change.
type mutationDelta struct {
	key string
	op  string
	row map[string]any
	// hasRow distinguishes an absent row from a present one; insert/update need it.
	hasRow bool
}

// asMutationDelta reports whether payload is a row change: an object with a string
// key, a string table and an op of insert, update or delete. Anything else is an
// opaque payload and replaces the value.
func asMutationDelta(payload any) (mutationDelta, bool) {
	object, ok := payload.(map[string]any)
	if !ok {
		return mutationDelta{}, false
	}

	key, keyOK := object["key"].(string)
	_, tableOK := object["table"].(string)
	op, opOK := object["op"].(string)

	if !keyOK || !tableOK || !opOK || (op != "insert" && op != "update" && op != "delete") {
		return mutationDelta{}, false
	}

	row, hasRow := object["row"].(map[string]any)

	return mutationDelta{key: key, op: op, row: row, hasRow: hasRow}, true
}

// rowListOf returns the row array of a bare-array result or of a plain object whose
// `page` is an array.
func rowListOf(value any) ([]any, bool) {
	switch typed := value.(type) {
	case []any:
		return typed, true
	case map[string]any:
		page, ok := typed[pageField].([]any)

		return page, ok
	}

	return nil, false
}

func creationTimeOf(row any) (float64, bool) {
	object, ok := row.(map[string]any)
	if !ok {
		return 0, false
	}

	number, ok := object[creationField].(float64)

	return number, ok
}

// isDescending reads the list's direction from its first strictly-ordered numeric
// adjacent pair; a list too short or all-equal reads as ascending.
func isDescending(list []any) bool {
	var previous float64

	seen := false

	for _, row := range list {
		current, ok := creationTimeOf(row)
		if !ok {
			continue
		}

		if seen {
			if current < previous {
				return true
			}

			if current > previous {
				return false
			}
		}

		previous = current
		seen = true
	}

	return false
}

// insertionIndexFor is where a merging client splices a new row: a row without a
// numeric creation time appends; otherwise before the first row that sorts after it
// in the list's direction, else append.
func insertionIndexFor(list []any, row map[string]any) int {
	creation, ok := row[creationField].(float64)
	if !ok {
		return len(list)
	}

	descending := isDescending(list)

	for index, existingRow := range list {
		existing, ok := creationTimeOf(existingRow)
		if !ok {
			continue
		}

		if (descending && existing < creation) || (!descending && existing > creation) {
			return index
		}
	}

	return len(list)
}

// mergeRows applies delta to list, returning a new slice. ok is false when the list
// is not id-keyable (an element lacks a string _id) or an insert/update carries no row.
func mergeRows(list []any, delta mutationDelta) ([]any, bool) {
	next := make([]any, 0, len(list)+1)
	existingIndex := -1

	for _, element := range list {
		object, isObject := element.(map[string]any)
		if !isObject {
			return nil, false
		}

		id, isString := object[idField].(string)
		if !isString {
			return nil, false
		}

		if id == delta.key {
			// A delete drops every row with the id; one for a row this list never
			// held is a legitimate no-op.
			if delta.op == "delete" {
				continue
			}

			if existingIndex == -1 {
				existingIndex = len(next)
			}
		}

		next = append(next, element)
	}

	if delta.op == "delete" {
		return next, true
	}

	if !delta.hasRow {
		return nil, false
	}

	if existingIndex == -1 {
		at := insertionIndexFor(next, delta.row)
		next = append(next, nil)
		copy(next[at+1:], next[at:])
		next[at] = delta.row
	} else {
		next[existingIndex] = delta.row
	}

	return next, true
}

// applyDelta merges a row change into base without mutating it. A paginated result
// keeps every field outside `page`; a bare array stays a bare array. ok is false
// when the base is not a mergeable list or the merge itself cannot be applied.
func applyDelta(base any, delta mutationDelta) (any, bool) {
	list, ok := rowListOf(base)
	if !ok {
		return nil, false
	}

	merged, ok := mergeRows(list, delta)
	if !ok {
		return nil, false
	}

	if wrapper, isWrapper := base.(map[string]any); isWrapper {
		result := make(map[string]any, len(wrapper))
		for key, value := range wrapper {
			result[key] = value
		}

		result[pageField] = merged

		return result, true
	}

	return merged, true
}

// resolveDataPayload decides the new server base for a data or delta frame. A data
// frame replaces it. A delta that is a row change merges into the cached base; with
// no cached base it cannot merge, so it is held like any other unmergeable change.
//
// publish is false when a row change cannot be merged. The reference client
// re-snapshots there; this port has no resubscribe-for-snapshot path, so it keeps the
// previous value rather than publishing the row-change envelope as the query result.
// The caller poisons the subscription so no later delta moves the resume cursor past
// the dropped change; the next data frame or resubscribe reconciles.
func resolveDataPayload(kind string, base any, value any) (next any, publish bool) {
	if kind != "delta" {
		return value, true
	}

	delta, isRowChange := asMutationDelta(value)
	if !isRowChange {
		return value, true
	}

	// No base, or a committed null, cannot take a row change: applyDelta reports it as unmergeable.
	merged, ok := applyDelta(base, delta)
	if !ok {
		return nil, false
	}

	return merged, true
}
