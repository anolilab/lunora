"""A minimal, protocol-conformant Lunora client.

Implements the transport documented in ``protocol/README.md``:

- ``query`` / ``mutation`` round-trips over ``POST /_lunora/rpc``.
- Live ``subscribe`` over the WebSocket ``data``/``delta``/``ack``/``error``/
  ``resume``/``settled`` frames.
- ``subscribe_shape`` over the poke (``pokeStart``/``pokePart``/``pokeEnd``) path.
- An async WS token provider mirroring the TS ``WsTokenProvider``.

The wire framing (frame builders + the inbound-frame dispatcher) is factored into
pure functions/methods so it is unit-testable against the shared golden fixtures
with no network. The HTTP transport is injectable; the optional live WebSocket
loop uses the ``websockets`` package when present.
"""

from __future__ import annotations

import asyncio
import inspect
import json
import urllib.request
from typing import Any, Awaitable, Callable, Optional, Union

from .wire import decode_wire, encode_wire, stable_wire_key

RPC_PATH = "/_lunora/rpc"
WS_PATH = "/_lunora/ws"

# A WS token provider: a value, a callable returning a value, or an async callable.
WsToken = Union[None, str, Callable[[], Union[None, str, Awaitable[Optional[str]]]]]

Callback = Callable[[Any], None]
ErrorCallback = Callable[["SubscriptionError"], None]
Unsubscribe = Callable[[], None]


class LunoraError(Exception):
    """A coded error raised from an RPC ``{ "error": { code, message, data } }`` envelope."""

    def __init__(self, code: str, message: str, data: Any = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = data


class SubscriptionError:
    """A subscription-scoped error frame the server pushed."""

    def __init__(self, message: str, code: Optional[str] = None) -> None:
        self.message = message
        self.code = code

    def __repr__(self) -> str:  # pragma: no cover - trivial
        return f"SubscriptionError(code={self.code!r}, message={self.message!r})"


# --- Pure framing helpers (no I/O; fixture-tested) --------------------------


def build_rpc_body(function_path: str, args: Any, shard_key: Optional[str] = None) -> dict:
    """Build the ``POST /_lunora/rpc`` JSON body. ``shard_key`` is omitted when ``None``."""

    body: dict[str, Any] = {"args": encode_wire(args if args is not None else {}), "functionPath": function_path}
    if shard_key is not None:
        body["shardKey"] = shard_key
    return body


def parse_rpc_response(body: dict) -> Any:
    """Return ``decode_wire(result)`` or raise :class:`LunoraError` from an ``error`` envelope."""

    if "error" in body:
        err = body["error"]
        data = decode_wire(err["data"]) if "data" in err and err["data"] is not None else None
        raise LunoraError(err.get("code", "INTERNAL"), err.get("message", "request failed"), data)
    return decode_wire(body.get("result"))


def build_connect_frame(client_id: Optional[str], context: Optional[dict] = None) -> dict:
    frame: dict[str, Any] = {"id": "connect", "type": "connect"}
    if client_id is not None:
        frame["clientId"] = client_id
    if context is not None:
        frame["context"] = context
    return frame


def build_subscribe_frame(
    sub_id: str,
    function_path: str,
    args: Any,
    table: Optional[str] = None,
    since_seq: Optional[int] = None,
    since_epoch: Optional[str] = None,
) -> dict:
    query: dict[str, Any] = {
        "args": encode_wire(args if args is not None else {}),
        "functionPath": function_path,
        "table": table if table is not None else function_path,
    }
    if since_seq is not None:
        query["sinceSeq"] = since_seq
    if since_epoch is not None:
        query["sinceEpoch"] = since_epoch
    return {"id": sub_id, "query": query, "type": "subscribe"}


def build_unsubscribe_frame(sub_id: str) -> dict:
    return {"id": sub_id, "type": "unsubscribe"}


def build_shape_subscribe_frame(
    shape_id: str,
    name: str,
    args: Any = None,
    since_checkpoint: Optional[int] = None,
    since_epoch: Optional[str] = None,
) -> dict:
    shape: dict[str, Any] = {"name": name}
    if args is not None:
        shape["args"] = encode_wire(args)
    frame: dict[str, Any] = {"id": shape_id, "shape": shape, "type": "shape_subscribe"}
    if since_checkpoint is not None:
        frame["sinceCheckpoint"] = since_checkpoint
    if since_epoch is not None:
        frame["sinceEpoch"] = since_epoch
    return frame


def _derive_ws_url(url: str) -> str:
    if url.startswith("https://"):
        return "wss://" + url[len("https://") :]
    if url.startswith("http://"):
        return "ws://" + url[len("http://") :]
    return url


def _join(base: str, path: str) -> str:
    return (base[:-1] if base.endswith("/") else base) + path


# --- Client -----------------------------------------------------------------


class _Subscription:
    def __init__(self, sub_id: str, function_path: str, args: Any, shard_key: Optional[str]) -> None:
        self.id = sub_id
        self.function_path = function_path
        self.args = args
        self.args_key = stable_wire_key(args if args is not None else {})
        self.shard_key = shard_key
        self.acked = False
        self.server_cursor: Optional[int] = None
        self.server_epoch: Optional[str] = None
        self.last_value: Any = None
        self.callbacks: list[Callback] = []
        self.error_callbacks: list[ErrorCallback] = []


class _ShapeSubscription:
    def __init__(self, shape_id: str, name: str, args: Any, shard_key: Optional[str]) -> None:
        self.id = shape_id
        self.name = name
        self.args = args
        self.shard_key = shard_key
        self.rows: dict[str, Any] = {}
        self.server_cursor: Optional[int] = None
        self.server_epoch: Optional[str] = None
        self.callbacks: list[Callable[[list], None]] = []
        self.error_callbacks: list[ErrorCallback] = []


class LunoraClient:
    def __init__(
        self,
        url: str,
        ws_url: Optional[str] = None,
        auth_token: Optional[str] = None,
        ws_token: WsToken = None,
        client_id: str = "python-client",
        http_post: Optional[Callable[[str, dict, bytes], tuple[int, dict]]] = None,
    ) -> None:
        self.url = url
        self.ws_url = ws_url if ws_url is not None else _join(_derive_ws_url(url), WS_PATH)
        self.auth_token = auth_token
        self.ws_token = ws_token
        self.client_id = client_id
        self._http_post = http_post if http_post is not None else _urllib_post
        self._subs: dict[str, _Subscription] = {}
        self._shapes: dict[str, _ShapeSubscription] = {}
        self._poke_buffers: dict[str, dict] = {}
        self._next_sub_id = 0
        self._next_shape_id = 0
        self._send: Optional[Callable[[dict], None]] = None

    # --- HTTP RPC -----------------------------------------------------------

    async def query(self, function_path: str, args: Any = None, shard_key: Optional[str] = None) -> Any:
        return await self._rpc(function_path, args, shard_key, mutation_id=None)

    async def mutation(
        self, function_path: str, args: Any = None, shard_key: Optional[str] = None, mutation_id: Optional[str] = None
    ) -> Any:
        return await self._rpc(function_path, args, shard_key, mutation_id=mutation_id)

    async def _rpc(self, function_path: str, args: Any, shard_key: Optional[str], mutation_id: Optional[str]) -> Any:
        headers = {"content-type": "application/json"}
        if self.auth_token:
            headers["authorization"] = f"Bearer {self.auth_token}"
        if mutation_id is not None:
            headers["x-lunora-mutation-id"] = mutation_id
        body = json.dumps(build_rpc_body(function_path, args, shard_key)).encode("utf-8")
        status, parsed = await asyncio.get_event_loop().run_in_executor(
            None, lambda: self._http_post(_join(self.url, RPC_PATH), headers, body)
        )
        return parse_rpc_response(parsed)

    # --- WS credential ------------------------------------------------------

    async def resolve_ws_token(self) -> Optional[str]:
        """Resolve the WS ``?token=`` credential fresh (mirrors ``WsTokenProvider``)."""

        token = self.ws_token
        if callable(token):
            result = token()
            if inspect.isawaitable(result):
                result = await result
            return result
        return token

    def ws_url_for(self, shard_key: Optional[str], token: Optional[str]) -> str:
        params = []
        if shard_key is not None:
            params.append("shard=" + _percent(shard_key))
        if token is not None:
            params.append("token=" + _percent(token))
        if not params:
            return self.ws_url
        sep = "&" if "?" in self.ws_url else "?"
        return self.ws_url + sep + "&".join(params)

    # --- Subscriptions ------------------------------------------------------

    def subscribe(
        self,
        function_path: str,
        args: Any,
        on_data: Callback,
        on_error: Optional[ErrorCallback] = None,
        shard_key: Optional[str] = None,
    ) -> Unsubscribe:
        self._next_sub_id += 1
        sub_id = f"sub_{self._next_sub_id}"
        sub = _Subscription(sub_id, function_path, args, shard_key)
        sub.callbacks.append(on_data)
        if on_error is not None:
            sub.error_callbacks.append(on_error)
        self._subs[sub_id] = sub
        self._send_subscribe(sub)

        def unsubscribe() -> None:
            self._subs.pop(sub_id, None)
            if self._send is not None:
                self._send(build_unsubscribe_frame(sub_id))

        return unsubscribe

    def subscribe_shape(
        self,
        name: str,
        args: Any,
        on_rows: Callable[[list], None],
        on_error: Optional[ErrorCallback] = None,
        shard_key: Optional[str] = None,
    ) -> Unsubscribe:
        self._next_shape_id += 1
        shape_id = f"shape_{self._next_shape_id}"
        shape = _ShapeSubscription(shape_id, name, args, shard_key)
        shape.callbacks.append(on_rows)
        if on_error is not None:
            shape.error_callbacks.append(on_error)
        self._shapes[shape_id] = shape
        if self._send is not None:
            self._send(build_shape_subscribe_frame(shape_id, name, args))

        def unsubscribe() -> None:
            self._shapes.pop(shape_id, None)
            if self._send is not None:
                self._send({"id": shape_id, "type": "shape_unsubscribe"})

        return unsubscribe

    def _send_subscribe(self, sub: _Subscription) -> None:
        if self._send is None:
            return
        frame = build_subscribe_frame(
            sub.id, sub.function_path, sub.args, since_seq=sub.server_cursor, since_epoch=sub.server_epoch
        )
        self._send(frame)

    # --- Inbound frame dispatch (fixture-tested) ---------------------------

    def handle_frame(self, frame: dict) -> dict:
        """Apply one server frame; invoke callbacks. Returns a descriptor for testing."""

        kind = frame.get("type")
        if kind == "ack":
            sub = self._subs.get(frame["id"])
            if sub is not None:
                sub.acked = True
            return {"kind": "ack", "id": frame.get("id")}

        if kind in ("data", "delta"):
            return self._handle_data(frame)

        if kind == "error":
            return self._handle_error(frame)

        if kind == "resume":
            return self._advance(frame, "resume")

        if kind == "settled":
            desc = self._advance(frame, "settled")
            if "lastMutationId" in frame:
                desc["lastMutationId"] = frame["lastMutationId"]
            return desc

        if kind == "pokeStart":
            self._poke_buffers[frame["pokeId"]] = {
                "baseCheckpoint": frame.get("baseCheckpoint"),
                "epoch": frame.get("epoch"),
                "parts": {},
            }
            return {"kind": "pokeStart", "pokeId": frame["pokeId"]}

        if kind == "pokePart":
            buf = self._poke_buffers.get(frame["pokeId"])
            if buf is not None:
                buf["parts"].setdefault(frame["shapeId"], []).extend(frame.get("rowsPatch", []))
            return {"kind": "pokePart", "pokeId": frame["pokeId"], "shapeId": frame.get("shapeId")}

        if kind == "pokeEnd":
            return self._handle_poke_end(frame)

        if kind == "complete":
            self._subs.pop(frame.get("id"), None)
            return {"kind": "complete", "id": frame.get("id")}

        return {"kind": "ignored", "type": kind}

    def _handle_data(self, frame: dict) -> dict:
        sub = self._subs.get(frame.get("id"))
        if "data" in frame and frame["data"] is not None:
            value = decode_wire(frame["data"])
        else:
            # Minimal delta handling: replace wholesale (the full protocol merges
            # a mutation-delta into the server base; a wholesale replace is a
            # correct fallback and keeps the SDK dependency-free).
            value = decode_wire(frame.get("delta"))
        if sub is not None:
            sub.last_value = value
            if "cursor" in frame:
                sub.server_cursor = frame["cursor"]
            if "epoch" in frame:
                sub.server_epoch = frame["epoch"]
            for cb in list(sub.callbacks):
                cb(value)
        desc = {"kind": "data", "id": frame.get("id"), "value": value}
        if "cursor" in frame:
            desc["cursor"] = frame["cursor"]
        if "epoch" in frame:
            desc["epoch"] = frame["epoch"]
        return desc

    def _handle_error(self, frame: dict) -> dict:
        env = frame.get("error") or {}
        code = env.get("code") if isinstance(env, dict) else None
        message = frame.get("message") or (env.get("message") if isinstance(env, dict) else None) or "subscription error"
        error = SubscriptionError(message, code)
        sub_id = frame.get("id")
        sub = self._subs.get(sub_id) if sub_id is not None else None
        if sub is not None:
            for cb in list(sub.error_callbacks):
                cb(error)
        shape = self._shapes.get(sub_id) if sub_id is not None else None
        if shape is not None:
            for cb in list(shape.error_callbacks):
                cb(error)
        return {"kind": "error", "id": sub_id, "code": code, "message": message}

    def _advance(self, frame: dict, kind: str) -> dict:
        sub = self._subs.get(frame.get("id"))
        if sub is not None:
            sub.acked = True
            if "cursor" in frame:
                sub.server_cursor = frame["cursor"]
            if "epoch" in frame:
                sub.server_epoch = frame["epoch"]
        desc = {"kind": kind, "id": frame.get("id")}
        if "cursor" in frame:
            desc["cursor"] = frame["cursor"]
        return desc

    def _handle_poke_end(self, frame: dict) -> dict:
        buf = self._poke_buffers.pop(frame["pokeId"], None)
        touched: list[str] = []
        if buf is not None:
            for shape_id, ops in buf["parts"].items():
                shape = self._shapes.get(shape_id)
                if shape is None:
                    continue
                for op in ops:
                    if op["op"] == "delete":
                        shape.rows.pop(op["key"], None)
                    elif op.get("value") is not None:
                        shape.rows[op["key"]] = decode_wire(op["value"])
                if "checkpoint" in frame:
                    shape.server_cursor = frame["checkpoint"]
                if "epoch" in frame:
                    shape.server_epoch = frame["epoch"]
                rows = list(shape.rows.values())
                for cb in list(shape.callbacks):
                    cb(rows)
                touched.append(shape_id)
        return {"kind": "pokeEnd", "pokeId": frame["pokeId"], "shapes": touched}

    # --- Live WebSocket loop (optional; needs the ``websockets`` package) ---

    async def connect_and_run(self, shard_key: Optional[str] = None, context: Optional[dict] = None) -> None:
        """Open the live WS, announce ``connect``, resend subscriptions, and dispatch frames.

        Runs until the socket closes. Requires the ``websockets`` package.
        """

        try:
            import websockets  # type: ignore
        except ImportError as exc:  # pragma: no cover - optional dependency
            raise RuntimeError("connect_and_run requires the 'websockets' package (pip install websockets)") from exc

        token = await self.resolve_ws_token()
        async with websockets.connect(self.ws_url_for(shard_key, token)) as socket:  # pragma: no cover - live I/O
            queue: list[dict] = []

            def send(frame: dict) -> None:
                queue.append(frame)

            self._send = send
            send(build_connect_frame(self.client_id, context))
            for sub in self._subs.values():
                send(build_subscribe_frame(sub.id, sub.function_path, sub.args))
            for shape in self._shapes.values():
                send(build_shape_subscribe_frame(shape.id, shape.name, shape.args))

            async def flush() -> None:
                while queue:
                    await socket.send(json.dumps(queue.pop(0)))

            await flush()
            async for raw in socket:
                if raw == "lunora-pong":
                    continue
                try:
                    frame = json.loads(raw)
                except (ValueError, TypeError):
                    continue
                self.handle_frame(frame)
                await flush()


def _percent(value: str) -> str:
    from urllib.parse import quote

    return quote(value, safe="")


def _urllib_post(url: str, headers: dict, body: bytes) -> tuple[int, dict]:
    request = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request) as response:  # noqa: S310 - user-provided origin
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:  # error envelopes still carry a JSON body
        raw = exc.read().decode("utf-8")
        return exc.code, json.loads(raw) if raw else {"error": {"code": "INTERNAL", "message": str(exc)}}
