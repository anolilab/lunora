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
import binascii
import math
from dataclasses import dataclass, field
from typing import Any

TAG = "$lunora.wire$"
MAX_DEPTH = 64
MAX_BIGINT_DIGITS = 1024

#: Largest integer a float64 holds exactly (2**53 - 1). JSON numbers are
#: float64, so an integer past this cannot cross the wire as a number without
#: changing value — ``WireBigInt`` and its tag exist for that case.
MAX_EXACT_INTEGER = 2**53 - 1

#: Largest epoch a ``Date`` holds (ECMAScript TimeClip). Past this, and for any
#: non-finite epoch, ``new Date(v)`` is an Invalid Date.
MAX_TIME_VALUE = 8.64e15


class WireFormatError(ValueError):
    """A wire value this codec refuses: malformed, over-long, or out of range.

    Subclasses :class:`ValueError` because that is what every bound in this
    module used to raise bare, and a caller catching the old type keeps working.
    The named type is what makes ``except WireFormatError`` around a decode
    complete: the codec previously let a raw ``IndexError`` out of a short
    tagged array and a raw ``ValueError`` out of a truncated map entry, so a
    caller catching the codec's own errors caught neither, and in the socket
    read loop one such frame ended every subscription on the client.
    """


class _Undefined:
    """Singleton sentinel for JS ``undefined`` (distinct from ``None``/``null``)."""

    _instance: _Undefined | None = None

    def __new__(cls) -> _Undefined:
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
    def from_datetime(cls, dt: Any) -> WireDate:
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
    try:
        return base64.b64decode(text, validate=True)
    except binascii.Error as error:
        raise WireFormatError(f"wire-codec: invalid base64 in bytes tag: {error}") from error


def encode_wire(value: Any, depth: int = 0) -> Any:
    """Encode ``value`` into a JSON-safe tree, tagging JSON-hostile leaves."""

    if depth > MAX_DEPTH:
        raise WireFormatError(f"wire-codec: value nesting exceeds the {MAX_DEPTH}-level limit")

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
        # Python's int is arbitrary-precision; a JSON number is not. Passing a
        # larger one straight through meant the server's own JSON.parse rounded
        # it, so the value that arrived was quietly a different integer. Refuse,
        # as the Go port does, and name the way across.
        if value > MAX_EXACT_INTEGER or value < -MAX_EXACT_INTEGER:
            raise WireFormatError(f"wire-codec: integer {value} exceeds the exact float64 range — wrap it in WireBigInt so it crosses the wire as a bigint tag")
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
        f"wire-codec: cannot encode a {type(value).__name__} over the Lunora wire — only plain values, dict/list, bytes, and the Wire* wrappers round-trip"
    )


def decode_wire(value: Any, depth: int = 0) -> Any:
    """Inverse of :func:`encode_wire`: revive tagged leaves to Wire* wrappers."""

    if depth > MAX_DEPTH:
        raise WireFormatError(f"wire-codec: value nesting exceeds the {MAX_DEPTH}-level limit")

    if value is None or isinstance(value, (bool, int, float, str)):
        return value

    if isinstance(value, list):
        if len(value) > 0 and value[0] == TAG:
            # Not `value[1]`: a bare `[TAG]` is a legitimate forward-compat
            # shape every other port hands back as an ordinary array, and
            # indexing it raised a bare IndexError out of the codec instead.
            tag = value[1] if len(value) > 1 else None
            if tag == "undefined":
                return UNDEFINED
            if tag == "nan":
                return math.nan
            if tag == "inf":
                return math.inf
            if tag == "-inf":
                return -math.inf
            if tag == "bigint":
                raw = value[2] if len(value) > 2 else None
                if not isinstance(raw, str) or len(raw) > MAX_BIGINT_DIGITS or not _is_bigint_literal(raw):
                    raise WireFormatError(f"wire-codec: invalid or over-long bigint (max {MAX_BIGINT_DIGITS} digits)")
                return WireBigInt(int(raw))
            if tag == "date":
                # Epoch milliseconds, and nothing else: `None` or a string would
                # otherwise become a `WireDate` carrying a value no arithmetic can
                # use, re-encoded as a legitimate-looking date tag. `bool` is an
                # `int` in Python, so it is excluded explicitly.
                epoch = decode_wire(_payload(value, "date"), depth + 1)
                if isinstance(epoch, bool) or not isinstance(epoch, (int, float)):
                    raise WireFormatError("wire-codec: malformed date tag")
                return WireDate(_time_clip(epoch))
            if tag == "url":
                href = _payload(value, "url")
                if not isinstance(href, str):
                    raise WireFormatError("wire-codec: malformed url tag")
                return WireUrl(href)
            if tag == "map":
                return _decode_map(value, depth)
            if tag == "set":
                return WireSet([decode_wire(item, depth + 1) for item in _payload_list(value, "set")])
            if tag == "error":
                return _decode_error(value, depth)
            if tag == "bytes":
                return _decode_bytes(value)
            if tag == "arr":
                return [decode_wire(item, depth + 1) for item in _payload_list(value, "arr")]
            # Unknown tag (forward-compat): treat as an ordinary array.
            return [decode_wire(item, depth + 1) for item in value]
        return [decode_wire(item, depth + 1) for item in value]

    if isinstance(value, dict):
        return {key: decode_wire(item, depth + 1) for key, item in value.items()}

    raise WireFormatError(f"wire-codec: cannot decode a {type(value).__name__}")


def _payload(value: list, tag: str) -> Any:
    """The tag's payload slot, or a typed rejection when the array is too short.

    ``value[2]`` on a truncated tag raised a bare ``IndexError`` straight out of
    :func:`decode_wire`, so ``except WireFormatError`` around a decode caught
    nothing — and in the socket read loop one such frame ended every
    subscription on the client rather than the one that carried it.
    """

    if len(value) < 3:
        raise WireFormatError(f"wire-codec: malformed {tag} tag")

    return value[2]


def _payload_list(value: list, tag: str) -> list:
    """The tag's payload slot as a list.

    Iterating it unchecked let a ``str`` payload iterate PER CHARACTER, so
    ``[TAG, "set", "xx"]`` decoded to a two-item set of ``"x"`` rather than
    being refused. The reference throws; so does every other port.
    """

    items = _payload(value, tag)

    if not isinstance(items, list):
        raise WireFormatError(f"wire-codec: malformed {tag} tag")

    return items


def _decode_error(value: list, depth: int) -> WireError:
    """Decode an ``error`` tag, refusing one with no props object.

    The props slot is not optional: the reference reads it with ``Object.keys``,
    which throws on ``null`` or a missing slot, so a port that quietly
    substituted ``{}`` accepted a frame the reference refuses.
    """

    if len(value) < 5 or not isinstance(value[4], dict):
        raise WireFormatError("wire-codec: malformed error tag")

    props = decode_wire(value[4], depth + 1)
    cause = decode_wire(value[5], depth + 1) if len(value) > 5 else UNDEFINED

    return WireError(value[2], value[3], dict(props), cause)


def _decode_map(value: list, depth: int) -> WireMap:
    """Decode a ``map`` tag, refusing an entry that is not a real pair.

    Destructuring ``for k, v in value[2]`` raised a bare ``ValueError`` on a
    truncated entry — the right outcome reported as the wrong kind of error, so
    a caller catching the codec's own type saw an unhandled exception instead.
    """

    pairs: list[tuple[Any, Any]] = []
    seen: dict[str, int] = {}

    for entry in _payload_list(value, "map"):
        if not isinstance(entry, list) or len(entry) != 2:
            raise WireFormatError("wire-codec: malformed map entry")

        key = decode_wire(entry[0], depth + 1)
        item = decode_wire(entry[1], depth + 1)
        identity = _map_key_identity(key)

        # Last write wins, at the FIRST occurrence's position — the reference
        # builds a real Map, and `Map.prototype.set` on a key already present
        # overwrites the value in place rather than appending. Keeping both
        # entries left two peers of one deployment reading a different value
        # from identical bytes, and re-encoded as two entries a map the
        # reference emits as one.
        if identity is not None and identity in seen:
            pairs[seen[identity]] = (key, item)
            continue

        if identity is not None:
            seen[identity] = len(pairs)

        pairs.append((key, item))

    return WireMap(pairs)


#: Bytes per element for the typed-array views the codec round-trips. A view
#: whose payload is not a whole number of elements is not a view the reference
#: can rebuild — ``new Float32Array(buffer)`` raises a ``RangeError`` there —
#: so accepting it would hand the consumer bytes it cannot reconstruct.
#: ``ArrayBuffer`` is absent deliberately: it is untyped, so nothing to align.
TYPED_ARRAY_ELEMENT_SIZES = {
    "BigInt64Array": 8,
    "BigUint64Array": 8,
    "Float32Array": 4,
    "Float64Array": 8,
    "Int16Array": 2,
    "Int32Array": 4,
    "Int8Array": 1,
    "Uint16Array": 2,
    "Uint32Array": 4,
    "Uint8Array": 1,
    "Uint8ClampedArray": 1,
}


def _decode_bytes(value: list) -> Any:
    encoded = _payload(value, "bytes")

    if not isinstance(encoded, str):
        raise WireFormatError("wire-codec: malformed bytes tag")

    data = _b64decode(encoded)
    ctor = value[3] if len(value) > 3 else "Uint8Array"

    if ctor == "Uint8Array":
        return data

    if ctor != "ArrayBuffer":
        size = TYPED_ARRAY_ELEMENT_SIZES.get(ctor)

        # An UNKNOWN ctor name decodes to raw bytes, dropping the name — the
        # forward-compat rule in protocol/README.md §2.1. Keeping it re-encoded
        # a 4-element form the reference emits as 3, so the same value relayed
        # through JS and through here produced different bytes, and therefore
        # different stable subscription keys.
        if size is None:
            return data

        if len(data) % size != 0:
            raise WireFormatError(f"wire-codec: {ctor} payload of {len(data)} bytes is not a multiple of its {size}-byte element")

    return WireBytes(data, ctor)


def _time_clip(epoch: float) -> float:
    """``new Date(epoch).getTime()`` — ECMAScript TimeClip.

    A ``Date`` truncates its argument toward zero, and anything non-finite or
    past +-8.64e15 becomes an Invalid Date, which the reference re-encodes as
    ``[TAG,"date",[TAG,"nan"]]``. Keeping the epoch verbatim put a date back on
    the wire carrying a value the reference's own ``Date`` never holds.
    """

    if not math.isfinite(epoch) or abs(epoch) > MAX_TIME_VALUE:
        return math.nan

    return math.trunc(epoch)


def _map_key_identity(key: Any) -> str | None:
    """A map key's collapse identity, or ``None`` when it never collapses.

    The reference's ``Map`` compares keys by SameValueZero: primitives by value
    (``NaN`` equal to itself), everything else by reference — so two
    structurally identical ``Date``/bytes keys stay two entries there and must
    stay two here. Only the scalar kinds get an identity.
    """

    if key is None:
        return "null"

    if key is UNDEFINED:
        return "undefined"

    # bool before int: Python's bool IS an int, but JS `true` and `1` are
    # distinct keys.
    if isinstance(key, bool):
        return f"bool:{key}"

    if isinstance(key, WireBigInt):
        return f"big:{key.value}"

    if isinstance(key, (int, float)):
        if isinstance(key, float) and math.isnan(key):
            return "num:nan"

        try:
            number = float(key)
        except OverflowError:
            # JSON.parse renders an over-large literal as +-Infinity; Python
            # keeps it exact, so collapse it the way the reference would see it.
            number = math.inf if key > 0 else -math.inf

        return f"num:{number!r}"

    if isinstance(key, str):
        return f"str:{key}"

    return None


def _is_bigint_literal(raw: str) -> bool:
    # NOT `body.isdigit()`: that is Unicode-aware and true for '\u0663'
    # (Arabic-Indic three) and '\u00b2' (superscript two), which `int()` then
    # accepts or refuses inconsistently — so '\u0663' decoded to 3 here while
    # the reference, whose `\d` is ASCII-only, refused the same frame.
    body = raw.removeprefix("-")

    return len(body) > 0 and all("0" <= char <= "9" for char in body)


# --- Stable subscription / dedup key ---------------------------------------


def _format_number(value: Any) -> str:
    """Render a number exactly as ``String(v)`` does in JavaScript.

    Python's ``repr`` switches to exponent notation below 1e-4 and spells it
    ``1e-05``; ECMAScript stays positional down to 1e-7 and never pads the
    exponent (``0.00001``, ``1e-7``). The stable key is compared verbatim
    against one produced by the reference TypeScript client, so a different
    spelling here silently splits one subscription into two.
    """

    if isinstance(value, bool):  # pragma: no cover - handled before this is reached
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if not math.isfinite(value):  # pragma: no cover - tagged before this is reached
        return "null"
    magnitude = abs(value)

    if value.is_integer() and magnitude < 1e21:
        return _integral(value)

    if 1e-6 <= magnitude < 1e21:
        return _trim_zeros(f"{value:.17f}", value)

    return _exponential(value)


def _integral(value: float) -> str:
    """Positional spelling of an integral double, ECMAScript-style.

    ECMAScript prints the SHORTEST digit string that reads back as the same
    double and then zero-pads it, so ``String(2**60)`` is
    ``1152921504606847000`` — not the exact expansion ``1152921504606846976``
    that ``int(value)`` (and every other exact converter) produces. It also
    spells negative zero ``-0``, which every integer conversion flattens.
    """

    for precision in range(18):
        candidate = f"{value:.{precision}e}"
        if float(candidate) == value:
            mantissa, _, exponent = candidate.partition("e")
            sign = "-" if mantissa.startswith("-") else ""
            digits = mantissa.lstrip("-").replace(".", "").rstrip("0") or "0"

            return sign + digits.ljust(int(exponent) + 1, "0")

    return str(int(value))  # pragma: no cover - 17 significant digits always round-trip


def _trim_zeros(text: str, value: float) -> str:
    """Shortest positional spelling that still parses back to ``value``."""

    for precision in range(21):
        candidate = f"{value:.{precision}f}"
        if float(candidate) == value:
            text = candidate
            break

    if "." not in text:
        return text

    return text.rstrip("0").rstrip(".")


def _exponential(value: float) -> str:
    """Exponent spelling without ECMAScript's absent zero padding."""

    rendered = repr(value)

    for precision in range(18):
        candidate = f"{value:.{precision}e}"
        if float(candidate) == value:
            rendered = candidate
            break

    if "e" not in rendered:
        return rendered

    mantissa, _, exponent = rendered.partition("e")

    if "." in mantissa:
        mantissa = mantissa.rstrip("0").rstrip(".")

    sign = "-" if exponent.startswith("-") else "+"
    digits = exponent.lstrip("+-").lstrip("0") or "0"

    return f"{mantissa}e{sign}{digits}"


def _utf16_sort_key(value: str) -> tuple:
    """Order a string the way JavaScript's ``<`` does: by UTF-16 code unit.

    Python's ``sorted`` compares code points, which agrees inside the BMP but
    not above it: an astral character is its high surrogate (0xD83D) as UTF-16
    yet 0x1F600 as a code point, so it sorts before U+FFFD in JavaScript and
    after it here. A key set mixing the two would produce a different dedup key
    than the reference client for identical arguments.
    """

    return tuple(value.encode("utf-16-be"))


def _json_string(text: str) -> str:
    import json

    return json.dumps(text, ensure_ascii=False)


def stable_stringify(value: Any) -> str:
    """Canonical, sorted-key JSON encoding of a **pure-JSON** tree.

    Operates on the output of :func:`encode_wire`, so it only ever sees
    ``None``/``bool``/``int``/``float``/``str``/``list``/``dict``. Object keys are
    sorted at every depth in UTF-16 code-unit order (see :func:`_utf16_sort_key`;
    Python's own ``sorted`` is by code point, which disagrees for any key starting
    with a surrogate); arrays keep order; ``None`` fields
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
        for key in sorted(value.keys(), key=_utf16_sort_key):
            item = value[key]
            if item is UNDEFINED:
                continue
            parts.append(f"{_json_string(key)}:{stable_stringify(item)}")
        return "{" + ",".join(parts) + "}"
    raise TypeError(f"stable_stringify: cannot encode a {type(value).__name__}")


def stable_wire_key(value: Any) -> str:
    """Stable cache/dedup key for ``value``: ``stable_stringify(encode_wire(value))``."""

    return stable_stringify(encode_wire(value))
