"""The transport-level error types.

Their own module rather than ``client.py`` because the write path
(``lunora.submit``) classifies a failed replay by them, and ``client.py`` imports
the write path — putting them in either of those two makes the import a cycle.
"""

from __future__ import annotations

from typing import Any, Optional

from .wire import WireFormatError, decode_wire

#: The server answered with a success whose ``result`` does not decode. The
#: write COMMITTED — replaying it can only return the same bytes — so a queued
#: write carrying this settles ``committed``, with this error and no value.
#: Raised by this client only; no server envelope carries it.
WIRE_DECODE_FAILED = "WIRE_DECODE_FAILED"

#: The worker's (or an edge's) answer to a request body over its cap. A verdict
#: on the REQUEST's size, not its content, whether or not it carries an envelope.
PAYLOAD_TOO_LARGE = "PAYLOAD_TOO_LARGE"


class LunoraError(Exception):
    """A coded error raised from an RPC ``{ "error": { code, message, data } }`` envelope.

    ``transient`` says the call did not reach a verdict — a reply carrying no
    envelope at all (an edge error page, a WAF block, a proxy). It is set where
    the STATUS is still in scope, because nothing downstream can recover it:
    ``code`` alone cannot tell an ``INTERNAL`` the function returned from the
    ``INTERNAL`` this client synthesises for a body that never came from one.
    """

    def __init__(self, code: str, message: str, data: Any = None, transient: bool = False) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = data
        self.transient = transient


class SubscriptionError:
    """A subscription-scoped error frame the server pushed."""

    def __init__(self, message: str, code: Optional[str] = None) -> None:
        self.message = message
        self.code = code

    def __repr__(self) -> str:  # pragma: no cover - trivial
        return f"SubscriptionError(code={self.code!r}, message={self.message!r})"


def envelope_error(envelope: dict) -> LunoraError:
    """The :class:`LunoraError` an ``{ code, message, data }`` envelope carries.

    A ``data`` that does not decode is dropped rather than raised: the code is
    the server's verdict and still has to reach the caller as this SDK's error.
    Raising the codec error instead escaped every ``LunoraError`` handler the
    caller wrote, and out of a flush it lost every write already drained.
    """

    code = envelope.get("code")
    message = envelope.get("message")

    try:
        data = decode_wire(envelope["data"]) if envelope.get("data") is not None else None
    except WireFormatError:
        data = None

    return LunoraError(code if isinstance(code, str) else "INTERNAL", message if isinstance(message, str) else "request failed", data)


def reply_error(body: Any, status: int) -> Optional[LunoraError]:
    """The error a whole RPC reply carries, or ``None`` for a readable success.

    ONE predicate for the single-call path and for a batch reply with no
    ``results``, because a durable write's fate must not depend on how many
    siblings were queued with it (``protocol/README.md`` §4.3):

    - A CODED envelope is the server's verdict and is classified by its code
      alone, whatever the HTTP status: a coded 5xx is terminal, a transient
      code (``lunora.submit.is_transient``) re-queues.
    - A 413 is ``PAYLOAD_TOO_LARGE`` whatever its body: an edge refuses an
      oversized body with its own HTML page before the worker could code one.
    - Any other reply with no envelope never came from a Lunora function — an
      edge error page, a WAF block, a proxy, a body that is not a JSON object
      — so it is transport: ``INTERNAL`` and transient.
    """

    if isinstance(body, dict) and isinstance(body.get("error"), dict):
        return envelope_error(body["error"])

    if status == 413:
        return LunoraError(PAYLOAD_TOO_LARGE, "HTTP 413 without an error envelope")

    if not 200 <= status <= 299:
        return LunoraError("INTERNAL", f"HTTP {status} without an error envelope", transient=True)

    if not isinstance(body, dict):
        return LunoraError("INTERNAL", "response body is not a JSON object", transient=True)

    return None


def decode_failed(error: Exception) -> LunoraError:
    """The error a committed write whose result does not decode settles with."""

    return LunoraError(WIRE_DECODE_FAILED, f"result could not be wire-decoded: {error}")
