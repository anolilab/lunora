"""The transport-level error types.

Their own module rather than ``client.py`` because the write path
(``lunora.submit``) classifies a failed replay by them, and ``client.py`` imports
the write path — putting them in either of those two makes the import a cycle.
"""

from __future__ import annotations

from typing import Any, Optional


class LunoraError(Exception):
    """A coded error raised from an RPC ``{ "error": { code, message, data } }`` envelope.

    ``transient`` says the call did not reach a verdict — a 5xx, or a non-2xx
    carrying no envelope at all (an edge error page, a WAF block, a proxy). It is
    set where the STATUS is still in scope, because nothing downstream can
    recover it: ``code`` alone cannot tell a ``BAD_REQUEST`` the function
    returned from the ``INTERNAL`` this client synthesises for a body that never
    came from one.
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
