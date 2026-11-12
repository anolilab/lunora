"""Row-delta merging: splice one ``{key, op, table, row}`` change into a cached list result.

A client that announces ``pageDelta`` (see ``build_connect_frame``) receives a ``delta`` frame
carrying a row change instead of a full ``data`` snapshot. The insert placement is NORMATIVE
(protocol/README.md 5.1.1): the server replays it before it sends the delta, so a different rule
desyncs the list silently and for good. Mirrors ``packages/client/src/delta-merge.ts`` and
``shared/page-result.ts``.
"""

from __future__ import annotations

from typing import Any, Optional

ID_FIELD = "_id"
CREATION_FIELD = "_creationTime"
PAGE_FIELD = "page"

_ROW_OPS = ("insert", "update", "delete")


def is_mutation_delta(value: Any) -> bool:
    """True for a row change; any other payload is opaque and replaces the value."""
    return isinstance(value, dict) and isinstance(value.get("key"), str) and isinstance(value.get("table"), str) and value.get("op") in _ROW_OPS


def row_list_of(value: Any) -> Optional[list]:
    """The row list a result carries: the bare array, or a plain object's ``page`` array."""
    if isinstance(value, list):
        return value
    if isinstance(value, dict) and isinstance(value.get(PAGE_FIELD), list):
        return value[PAGE_FIELD]
    return None


def _creation_time(row: Any) -> Optional[float]:
    value = row.get(CREATION_FIELD) if isinstance(row, dict) else None
    # `bool` is an `int` in Python, but a JSON boolean is not a number.
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def is_descending(rows: list) -> bool:
    """True when the FIRST strictly-ordered adjacent numeric pair runs downwards (newest-first)."""
    previous: Optional[float] = None
    for row in rows:
        existing = _creation_time(row)
        if existing is None:
            continue
        if previous is not None:
            if existing < previous:
                return True
            if existing > previous:
                return False
        previous = existing
    return False


def insertion_index_for(rows: list, row: dict) -> int:
    creation = _creation_time(row)
    if creation is None:
        return len(rows)
    descending = is_descending(rows)
    for index, existing_row in enumerate(rows):
        existing = _creation_time(existing_row)
        if existing is not None and (existing < creation if descending else existing > creation):
            return index
    return len(rows)


def merge_rows(rows: list, delta: dict) -> Optional[list]:
    """Merge ``delta`` into a copy of ``rows``; ``None`` when it cannot be merged."""
    key, op, row = delta["key"], delta["op"], delta.get("row")
    merged: list = []
    existing_index = -1
    for element in rows:
        element_id = element.get(ID_FIELD) if isinstance(element, dict) else None
        if not isinstance(element_id, str):
            return None
        if element_id == key:
            # A delete drops every row with the key; one for an absent key is a no-op.
            if op == "delete":
                continue
            if existing_index == -1:
                existing_index = len(merged)
        merged.append(element)
    if op == "delete":
        return merged
    if not isinstance(row, dict):
        return None
    if existing_index == -1:
        merged.insert(insertion_index_for(merged, row), row)
    else:
        merged[existing_index] = row
    return merged


def apply_delta(current: Any, delta: dict) -> Optional[Any]:
    """The merged result (never mutating ``current``), or ``None`` when it cannot be merged."""
    rows = row_list_of(current)
    if rows is None:
        return None
    merged = merge_rows(rows, delta)
    if merged is None or isinstance(current, list):
        return merged
    return {**current, PAGE_FIELD: merged}
