"""Lunora Python SDK — a minimal, protocol-conformant client for a Lunora deployment.

See ``protocol/README.md`` for the language-independent wire protocol this
implements, and ``sdks/python/README.md`` for usage.
"""

from .client import (
    LunoraClient,
    LunoraError,
    SubscriptionError,
    build_connect_frame,
    build_rpc_body,
    build_shape_subscribe_frame,
    build_subscribe_frame,
    build_unsubscribe_frame,
    parse_rpc_response,
)
from .wire import (
    TAG,
    UNDEFINED,
    WireBigInt,
    WireBytes,
    WireDate,
    WireError,
    WireMap,
    WireSet,
    WireUrl,
    decode_wire,
    encode_wire,
    stable_stringify,
    stable_wire_key,
)

__all__ = [
    "TAG",
    "UNDEFINED",
    "LunoraClient",
    "LunoraError",
    "SubscriptionError",
    "WireBigInt",
    "WireBytes",
    "WireDate",
    "WireError",
    "WireMap",
    "WireSet",
    "WireUrl",
    "build_connect_frame",
    "build_rpc_body",
    "build_shape_subscribe_frame",
    "build_subscribe_frame",
    "build_unsubscribe_frame",
    "decode_wire",
    "encode_wire",
    "parse_rpc_response",
    "stable_stringify",
    "stable_wire_key",
]

__version__ = "0.1.0"
