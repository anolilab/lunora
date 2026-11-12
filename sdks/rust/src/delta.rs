//! Merging a row-change `delta` frame into a cached list result — a port of
//! `packages/client/src/delta-merge.ts` and the list rules in `shared/page-result.ts`.
//!
//! The server sends `{ key, op, table, row }` to a client that announced
//! `pageDelta`. The insert placement is NORMATIVE (protocol README 5.1.1): the
//! delta carries no index, and the server replays this exact rule before sending
//! it, so a different placement desyncs the list silently.

use crate::wire::WireValue;

const ID_FIELD: &str = "_id";
const CREATION_FIELD: &str = "_creationTime";
const PAGE_FIELD: &str = "page";

#[derive(Clone, Copy, PartialEq)]
enum Op {
    Delete,
    Insert,
    Update,
}

/// A decoded row change.
pub(crate) struct RowDelta<'a> {
    key: &'a str,
    op: Op,
    row: Option<&'a WireValue>,
}

fn field<'a>(fields: &'a [(String, WireValue)], name: &str) -> Option<&'a WireValue> {
    fields.iter().find(|(key, _)| key == name).map(|(_, value)| value)
}

/// An object with a string `key`, a string `table` and an `op` of insert, update
/// or delete. Anything else is an opaque payload that replaces the value.
pub(crate) fn as_row_delta(value: &WireValue) -> Option<RowDelta<'_>> {
    let WireValue::Object(fields) = value else {
        return None;
    };

    let Some(WireValue::String(key)) = field(fields, "key") else {
        return None;
    };

    let Some(WireValue::String(_)) = field(fields, "table") else {
        return None;
    };

    let op = match field(fields, "op") {
        Some(WireValue::String(name)) if name == "insert" => Op::Insert,
        Some(WireValue::String(name)) if name == "update" => Op::Update,
        Some(WireValue::String(name)) if name == "delete" => Op::Delete,
        _ => return None,
    };

    Some(RowDelta {
        key,
        op,
        row: field(fields, "row"),
    })
}

fn row_id(row: &WireValue) -> Option<&str> {
    match row {
        WireValue::Object(fields) => match field(fields, ID_FIELD) {
            Some(WireValue::String(id)) => Some(id),
            _ => None,
        },
        _ => None,
    }
}

fn creation_time(row: &WireValue) -> Option<f64> {
    match row {
        WireValue::Object(fields) => match field(fields, CREATION_FIELD) {
            Some(WireValue::Number(time)) => Some(*time),
            _ => None,
        },
        _ => None,
    }
}

/// Newest-first when the first strictly-ordered numeric adjacent pair descends;
/// ascending when indeterminate.
fn is_descending(list: &[WireValue]) -> bool {
    let mut previous: Option<f64> = None;

    for row in list {
        let Some(existing) = creation_time(row) else {
            continue;
        };

        if let Some(before) = previous {
            if existing < before {
                return true;
            }

            if existing > before {
                return false;
            }
        }

        previous = Some(existing);
    }

    false
}

/// Where an inserted row lands: appended without a numeric creation time,
/// otherwise before the first row that sorts after it in the list's own direction.
fn insertion_index_for(list: &[WireValue], row: &WireValue) -> usize {
    let Some(creation) = creation_time(row) else {
        return list.len();
    };

    let descending = is_descending(list);

    list.iter()
        .position(|existing| creation_time(existing).is_some_and(|time| if descending { time < creation } else { time > creation }))
        .unwrap_or(list.len())
}

/// `None` when the list is not id-keyable or an insert/update carries no row.
fn merge_rows(list: &[WireValue], delta: &RowDelta<'_>) -> Option<Vec<WireValue>> {
    let mut next: Vec<WireValue> = Vec::with_capacity(list.len() + 1);
    let mut existing: Option<usize> = None;

    for element in list {
        let id = row_id(element)?;

        if id == delta.key {
            // A delete drops every row with the key; one for an absent key is a no-op.
            if delta.op == Op::Delete {
                continue;
            }

            existing.get_or_insert(next.len());
        }

        next.push(element.clone());
    }

    if delta.op == Op::Delete {
        return Some(next);
    }

    let row = delta.row?;

    match existing {
        Some(index) => next[index] = row.clone(),
        None => {
            let index = insertion_index_for(&next, row);

            next.insert(index, row.clone());
        }
    }

    Some(next)
}

/// Applies `delta` to `current`, a bare array or a `{ page: [...] }` result, never
/// mutating it. A paginated result keeps every field outside `page`.
/// `None` when the value cannot be merged.
pub(crate) fn apply_delta(current: &WireValue, delta: &RowDelta<'_>) -> Option<WireValue> {
    match current {
        WireValue::Array(list) => merge_rows(list, delta).map(WireValue::Array),
        WireValue::Object(fields) => {
            let Some(WireValue::Array(list)) = field(fields, PAGE_FIELD) else {
                return None;
            };

            let merged = merge_rows(list, delta)?;

            Some(WireValue::Object(
                fields
                    .iter()
                    .map(|(name, value)| {
                        if name == PAGE_FIELD {
                            (name.clone(), WireValue::Array(merged.clone()))
                        } else {
                            (name.clone(), value.clone())
                        }
                    })
                    .collect(),
            ))
        }
        _ => None,
    }
}

/// What a `data`/`delta` frame does to a subscription's server base.
pub(crate) enum Resolved {
    /// Adopt this value as the new server base.
    Adopt(WireValue),
    /// A row change that cannot be merged into the base we hold. Publishing the
    /// `{ key, op, table, row }` envelope would never be reconciled, so the
    /// previous value stays and the subscription is poisoned: later deltas are
    /// ignored, cursor included, until a `data` frame or a resubscribe.
    Keep,
}

/// Resolves a decoded `delta` payload against the subscription's server base.
/// `base` is `None` before the subscription has received any value; a row change
/// cannot merge into nothing, so it is held like any other unmergeable change.
pub(crate) fn resolve_delta(payload: WireValue, base: Option<&WireValue>) -> Resolved {
    let Some(delta) = as_row_delta(&payload) else {
        return Resolved::Adopt(payload);
    };

    let Some(base) = base else {
        return Resolved::Keep;
    };

    match apply_delta(base, &delta) {
        Some(merged) => Resolved::Adopt(merged),
        None => Resolved::Keep,
    }
}
