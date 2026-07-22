"""Tagged value codec for the Lunora RPC/WS wire, ported from ``shared/wire-codec.ts``.

The wire is JSON with no reviver. Values JSON cannot carry (bigints, bytes,
``Date``, ``Map``/``Set``, ``URL``, ``NaN``/``Infinity``, ``undefined`` in an
array position) are encoded as self-delimiting tagged arrays whose first element
is the sentinel :data:`TAG`. Pure-JSON values encode to a byte-identical tree.

Because Python lacks TypeScript's distinct ``bigint``/``Map``/``Set``/``Date``
types, this module provides thin wrappers (:class:`WireBigInt`, :class:`WireDate`,
:class:`WireMap`, :class:`WireSet`, :class:`WireUrl`, :class:`WireBytes`,
:class:`WireError`) plus the :data:`UNDEFINED` sentinel. ``decode`` returns these
wrappers so that ``encode(decode(x)) == x`` holds for every fixture — the
protocol-conformance contract. Plain ``int``/``float``/``str``/``dict``/``list``
map to JSON numbers/strings/objects/arrays; ``bytes``/``bytearray`` map to the
2-element ``Uint8Array`` byte form.

See ``protocol/README.md`` §2 for the normative grammar.
"""

from __future__ import annotations

import base64
import math
from dataclasses import dataclass, field
from typing import Any

TAG = "$lunora.wire$"
MAX_DEPTH = 64
MAX_BIGINT_DIGITS = 1024


class _Undefined:
    """Singleton sentinel for JS ``undefined`` (distinct from ``None``/``null``)."""

    _instance: "_Undefined | None" = None

    def __new__(cls) -> "_Undefined":
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    def __repr__(self) -> str:  # pragma: no cover - trivial
        return "UNDEFINED"


UNDEFINED = _Undefined()


@dataclass(frozen=True)
class WireBigInt:
    """A ``v.bigint()`` value — encodes to ``[TAG, "bigint", "<decimal>"]``."""

    value: int


@dataclass(frozen=True)
class WireDate:
    """A ``Date`` — epoch milliseconds (``float('nan')`` for an invalid date)."""

    epoch_ms: float

    @classmethod
    def from_datetime(cls, dt: Any) -> "WireDate":
        return cls(int(dt.timestamp() * 1000))

    def to_datetime(self) -> Any:
        import datetime as _dt

        return _dt.datetime.fromtimestamp(self.epoch_ms / 1000, tz=_dt.timezone.utc)


@dataclass(frozen=True)
class WireUrl:
    """A ``URL`` — encodes to ``[TAG, "url", "<href>"]``."""

    href: str


@dataclass
class WireMap:
    """A ``Map`` — an ordered list of ``(key, value)`` pairs (keys may be non-string)."""

    entries: list[tuple[Any, Any]] = field(default_factory=list)


@dataclass
class WireSet:
    """A ``Set`` — an ordered list of items."""

    items: list[Any] = field(default_factory=list)


@dataclass(frozen=True)
class WireBytes:
    """A typed-array / ``ArrayBuffer`` view carrying its constructor name.

    Plain ``Uint8Array`` bytes use Python ``bytes`` instead (the 2-element wire
    form); this wrapper preserves the exact view type (``ArrayBuffer``,
    ``Float32Array``, …) so it round-trips.
    """

    data: bytes
    ctor: str


@dataclass
class WireError:
    """An ``Error`` — name, message, own enumerable props, and an optional cause."""

    name: str
    message: str
    props: dict[str, Any] = field(default_factory=dict)
    cause: Any = UNDEFINED


def _b64encode(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def _b64decode(text: str) -> bytes:
    return base64.b64decode(text)


def encode_wire(value: Any, depth: int = 0) -> Any:
    """Encode ``value`` into a JSON-safe tree, tagging JSON-hostile leaves."""

    if depth > MAX_DEPTH:
        raise ValueError(f"wire-codec: value nesting exceeds the {MAX_DEPTH}-level limit")

    if value is UNDEFINED:
        return [TAG, "undefined"]

    if value is None:
        return None

    # bool is a subclass of int — check it first so it stays a JSON boolean.
    if isinstance(value, bool):
        return value

    if isinstance(value, WireBigInt):
        return [TAG, "bigint", str(value.value)]

    if isinstance(value, int):
        return value

    if isinstance(value, float):
        if math.isnan(value):
            return [TAG, "nan"]
        if value == math.inf:
            return [TAG, "inf"]
        if value == -math.inf:
            return [TAG, "-inf"]
        return value

    if isinstance(value, str):
        return value

    if isinstance(value, WireDate):
        return [TAG, "date", encode_wire(value.epoch_ms, depth + 1)]

    if isinstance(value, WireUrl):
        return [TAG, "url", value.href]

    if isinstance(value, WireError):
        props = {k: encode_wire(v, depth + 1) for k, v in value.props.items() if v is not UNDEFINED}
        encoded = [TAG, "error", value.name, value.message, props]
        if value.cause is not UNDEFINED:
            encoded.append(encode_wire(value.cause, depth + 1))
        return encoded

    if isinstance(value, WireMap):
        return [TAG, "map", [[encode_wire(k, depth + 1), encode_wire(v, depth + 1)] for k, v in value.entries]]

    if isinstance(value, WireSet):
        return [TAG, "set", [encode_wire(item, depth + 1) for item in value.items]]

    if isinstance(value, WireBytes):
        return [TAG, "bytes", _b64encode(value.data), value.ctor]

    if isinstance(value, (bytes, bytearray)):
        return [TAG, "bytes", _b64encode(bytes(value))]

    if isinstance(value, (list, tuple)):
        encoded = [encode_wire(item, depth + 1) for item in value]
        if len(encoded) > 0 and encoded[0] == TAG:
            return [TAG, "arr", encoded]
        return encoded

    if isinstance(value, dict):
        result: dict[str, Any] = {}
        for key, field_value in value.items():
            if field_value is UNDEFINED:
                continue
            result[str(key)] = encode_wire(field_value, depth + 1)
        return result

    raise TypeError(
        f"wire-codec: cannot encode a {type(value).__name__} over the Lunora wire — "
        "only plain values, dict/list, bytes, and the Wire* wrappers round-trip"
    )


def decode_wire(value: Any, depth: int = 0) -> Any:
    """Inverse of :func:`encode_wire`: revive tagged leaves to Wire* wrappers."""

    if depth > MAX_DEPTH:
        raise ValueError(f"wire-codec: value nesting exceeds the {MAX_DEPTH}-level limit")

    if value is None or isinstance(value, (bool, int, float, str)):
        return value

    if isinstance(value, list):
        if len(value) > 0 and value[0] == TAG:
            tag = value[1]
            if tag == "undefined":
                return UNDEFINED
            if tag == "nan":
                return math.nan
            if tag == "inf":
                return math.inf
            if tag == "-inf":
                return -math.inf
            if tag == "bigint":
                raw = value[2]
                if not isinstance(raw, str) or len(raw) > MAX_BIGINT_DIGITS or not _is_bigint_literal(raw):
                    raise ValueError(f"wire-codec: invalid or over-long bigint (max {MAX_BIGINT_DIGITS} digits)")
                return WireBigInt(int(raw))
            if tag == "date":
                return WireDate(decode_wire(value[2], depth + 1))
            if tag == "url":
                return WireUrl(value[2])
            if tag == "map":
                return WireMap([(decode_wire(k, depth + 1), decode_wire(v, depth + 1)) for k, v in value[2]])
            if tag == "set":
                return WireSet([decode_wire(item, depth + 1) for item in value[2]])
            if tag == "error":
                props = decode_wire(value[4], depth + 1) if len(value) > 4 else {}
                cause = decode_wire(value[5], depth + 1) if len(value) > 5 else UNDEFINED
                return WireError(value[2], value[3], dict(props), cause)
            if tag == "bytes":
                data = _b64decode(value[2])
                ctor = value[3] if len(value) > 3 else "Uint8Array"
                if ctor == "Uint8Array":
                    return data
                return WireBytes(data, ctor)
            if tag == "arr":
                return [decode_wire(item, depth + 1) for item in value[2]]
            # Unknown tag (forward-compat): treat as an ordinary array.
            return [decode_wire(item, depth + 1) for item in value]
        return [decode_wire(item, depth + 1) for item in value]

    if isinstance(value, dict):
        return {key: decode_wire(item, depth + 1) for key, item in value.items()}

    raise TypeError(f"wire-codec: cannot decode a {type(value).__name__}")


def _is_bigint_literal(raw: str) -> bool:
    body = raw[1:] if raw.startswith("-") else raw
    return len(body) > 0 and body.isdigit()


# --- Stable subscription / dedup key ---------------------------------------


def _format_number(value: Any) -> str:
    if isinstance(value, bool):  # pragma: no cover - handled before this is reached
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    # float: match JS ``JSON.stringify`` — integral floats drop the decimal.
    if math.isfinite(value) and value.is_integer():
        return str(int(value))
    return repr(value)


def _json_string(text: str) -> str:
    import json

    return json.dumps(text, ensure_ascii=False)


def stable_stringify(value: Any) -> str:
    """Canonical, sorted-key JSON encoding of a **pure-JSON** tree.

    Operates on the output of :func:`encode_wire`, so it only ever sees
    ``None``/``bool``/``int``/``float``/``str``/``list``/``dict``. Object keys are
    sorted at every depth (code-point order); arrays keep order; ``None`` fields
    are kept; :data:`UNDEFINED` (or an array-position ``UNDEFINED``) encodes as
    ``null``.
    """

    if value is UNDEFINED or value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return _format_number(value)
    if isinstance(value, str):
        return _json_string(value)
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(stable_stringify(item) for item in value) + "]"
    if isinstance(value, dict):
        parts = []
        for key in sorted(value.keys()):
            item = value[key]
            if item is UNDEFINED:
                continue
            parts.append(f"{_json_string(key)}:{stable_stringify(item)}")
        return "{" + ",".join(parts) + "}"
    raise TypeError(f"stable_stringify: cannot encode a {type(value).__name__}")


def stable_wire_key(value: Any) -> str:
    """Stable cache/dedup key for ``value``: ``stable_stringify(encode_wire(value))``."""

    return stable_stringify(encode_wire(value))
