# Copyright 2026 Google LLC
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Deterministic loopback FakeBidiUpstream + live FastAPI proxy launcher for Playwright E2E.

Starts a local WebSocket stand-in for CX Agent Studio (GECX) BidiRunSession on an
ephemeral loopback port and launches the production FastAPI proxy (`proxy.main:app`)
via Uvicorn on `127.0.0.1` (`CLOUDBANK_E2E_PROXY_PORT`, default `8765`) with zero
GCP credentials required.
"""

from __future__ import annotations

import asyncio
import base64
import json
import math
import os
import signal
import struct
import time
from pathlib import Path
from typing import Any

import uvicorn
import websockets
from websockets.asyncio.server import ServerConnection

_E2E_PROXY_PORT = int(os.environ.get("CLOUDBANK_E2E_PROXY_PORT") or "8765")
_E2E_WEB_PORT = int(os.environ.get("CLOUDBANK_E2E_WEB_PORT") or "4173")

os.environ.setdefault("CLOUDBANK_GCP_PROJECT_ID", "cloudbank-e2e-test")
os.environ.setdefault("CLOUDBANK_LOCATION", "eu")
os.environ.setdefault("CLOUDBANK_APP_ID", "00000000-0000-4000-8000-000000000001")
os.environ.setdefault(
    "PROXY_ALLOWED_ORIGINS",
    ",".join(
        dict.fromkeys(
            [
                f"http://127.0.0.1:{_E2E_WEB_PORT}",
                f"http://localhost:{_E2E_WEB_PORT}",
                f"http://127.0.0.1:{_E2E_PROXY_PORT}",
                f"http://localhost:{_E2E_PROXY_PORT}",
                "http://127.0.0.1:4173",
                "http://localhost:4173",
                "http://127.0.0.1:5173",
                "http://localhost:5173",
                "http://127.0.0.1:8765",
                "http://localhost:8765",
            ]
        )
    ),
)
os.environ.setdefault(
    "PROXY_ALLOWED_HOSTS",
    ",".join(
        dict.fromkeys(
            [
                f"127.0.0.1:{_E2E_PROXY_PORT}",
                f"localhost:{_E2E_PROXY_PORT}",
                "127.0.0.1:8765",
                "localhost:8765",
                "127.0.0.1",
                "localhost",
            ]
        )
    ),
)
os.environ.setdefault("PROXY_WARM_CREDENTIALS", "0")
os.environ.setdefault("PROXY_MAX_SESSIONS", "16")
os.environ.setdefault("PROXY_KEEPALIVE_SECONDS", "60")

from proxy import main as proxy_main  # noqa: E402


def _format_gbp_exact_2dp(amount_pence: int) -> str:
    """Format integer pence as £X,XXX.XX matching UI formatGBPFromPence."""
    pounds, pence = divmod(abs(amount_pence), 100)
    sign = "-" if amount_pence < 0 else ""
    return f"{sign}£{pounds:,}.{pence:02d}"


def _load_chloe_figures() -> dict[str, Any]:
    """Derive E2E spoken figures directly from canonical shared/personas/chloe.json."""
    chloe_path = Path(__file__).resolve().parents[2] / "shared" / "personas" / "chloe.json"
    snapshot = json.loads(chloe_path.read_text(encoding="utf-8"))
    current_balance = int(snapshot["accounts"]["current"]["balance_pence"])
    month_txns = [
        tx
        for tx in snapshot["transactions"]
        if int(tx["month_offset"]) == 0 and int(tx["amount_pence"]) > 0
    ]
    subs_txns = [tx for tx in month_txns if tx.get("is_subscription") is True]
    netflix_tx = next(
        (tx for tx in subs_txns if str(tx["vendor"]).lower() == "netflix"),
        {"amount_pence": 4500},
    )
    return {
        "current_balance_str": _format_gbp_exact_2dp(current_balance),
        "nov_total_str": _format_gbp_exact_2dp(
            sum(int(tx["amount_pence"]) for tx in month_txns)
        ),
        "nov_txn_count": len(month_txns),
        "subs_total_str": _format_gbp_exact_2dp(
            sum(int(tx["amount_pence"]) for tx in subs_txns)
        ),
        "subs_count": len(subs_txns),
        "netflix_str": _format_gbp_exact_2dp(int(netflix_tx["amount_pence"])),
    }


_CHLOE_FIGURES = _load_chloe_figures()


def _build_24khz_tone_b64(duration_ms: int = 80) -> str:
    """Generate a short 24 kHz 16-bit mono LINEAR16 tone for real Web Audio playback."""
    sample_rate = 24000
    num_samples = (sample_rate * duration_ms) // 1000
    samples = [
        int(1800 * math.sin(2.0 * math.pi * 440.0 * idx / sample_rate))
        for idx in range(num_samples)
    ]
    pcm_bytes = struct.pack(f"<{num_samples}h", *samples)
    return base64.b64encode(pcm_bytes).decode("ascii")


_SPEECH_AUDIO_B64 = _build_24khz_tone_b64(80)


class FakeBidiUpstream:
    """Deterministic loopback BidiRunSession server backing Playwright browser tests."""

    def __init__(self) -> None:
        self._session_seq: dict[str, int] = {}
        self._session_turns: dict[str, int] = {}
        self._seeded_sessions: set[str] = set()

    def _next_seq(self, session_id: str) -> int:
        nxt = self._session_seq.get(session_id, 0) + 1
        self._session_seq[session_id] = nxt
        return nxt

    def _next_turn(self, session_id: str) -> int:
        nxt = self._session_turns.get(session_id, 0) + 1
        self._session_turns[session_id] = nxt
        return nxt

    async def handle(self, conn: ServerConnection) -> None:
        session_id = "unknown"
        last_audio_at = 0.0
        voice_turn_armed = True
        pending_voice_task: asyncio.Task[None] | None = None

        async def _delayed_voice_reply(sid: str) -> None:
            await asyncio.sleep(0.55)
            await self._reply_to_voice_utterance(conn, sid)

        try:
            async for raw in conn:
                if not isinstance(raw, str):
                    continue
                frame: dict[str, Any] = json.loads(raw)

                cfg = frame.get("config")
                if isinstance(cfg, dict):
                    session_path = str(cfg.get("session") or "")
                    session_id = session_path.rsplit("/", 1)[-1] or "unknown"
                    continue

                rt = frame.get("realtimeInput")
                if not isinstance(rt, dict):
                    continue

                variables = rt.get("variables")
                if isinstance(variables, dict):
                    if session_id in self._seeded_sessions:
                        raise RuntimeError(
                            f"Resumed session {session_id} unexpectedly re-seeded variables"
                        )
                    snapshot = variables.get("customer_snapshot")
                    if not isinstance(snapshot, dict) or "accounts" not in snapshot:
                        raise RuntimeError("Missing server-seeded customer_snapshot")
                    self._seeded_sessions.add(session_id)
                    continue

                text = rt.get("text")
                if isinstance(text, str) and text.strip():
                    if pending_voice_task is not None and not pending_voice_task.done():
                        pending_voice_task.cancel()
                    should_close = await self._reply_to_text(conn, session_id, text.strip())
                    if should_close:
                        await conn.close()
                        return
                    continue

                audio_b64 = rt.get("audio")
                if isinstance(audio_b64, str) and audio_b64:
                    now = time.monotonic()
                    if last_audio_at > 0.0 and (now - last_audio_at) > 0.45:
                        voice_turn_armed = True
                    last_audio_at = now
                    if voice_turn_armed and (
                        pending_voice_task is None or pending_voice_task.done()
                    ):
                        voice_turn_armed = False
                        pending_voice_task = asyncio.create_task(
                            _delayed_voice_reply(session_id)
                        )
        except websockets.exceptions.ConnectionClosed:
            return
        finally:
            if pending_voice_task is not None and not pending_voice_task.done():
                pending_voice_task.cancel()

    async def _reply_to_voice_utterance(
        self, conn: ServerConnection, session_id: str
    ) -> None:
        turn_idx = self._next_turn(session_id)
        bal = _CHLOE_FIGURES["current_balance_str"]
        await conn.send(
            json.dumps(
                {
                    "recognitionResult": {
                        "transcript": "What is my current account balance?",
                        "isFinal": True,
                    }
                }
            )
        )
        await conn.send(
            json.dumps(
                {
                    "sessionOutput": {
                        "turnIndex": turn_idx,
                        "turnCompleted": False,
                        "audio": _SPEECH_AUDIO_B64,
                    }
                }
            )
        )
        await conn.send(
            json.dumps(
                {
                    "sessionOutput": {
                        "turnIndex": turn_idx,
                        "turnCompleted": True,
                        "text": f"<warm> <positive> Your current account balance is {bal}.",
                    }
                }
            )
        )

    async def _reply_to_text(
        self, conn: ServerConnection, session_id: str, prompt: str
    ) -> bool:
        lower = prompt.lower()
        turn_idx = self._next_turn(session_id)

        if "trigger goaway" in lower:
            seq = self._next_seq(session_id)
            ui_payload = {
                "seq": seq,
                "page": "savings",
                "extra_monthly_pence": 4500,
            }
            await conn.send(
                json.dumps(
                    {
                        "sessionOutput": {
                            "turnIndex": turn_idx,
                            "turnCompleted": False,
                            "payload": ui_payload,
                        }
                    }
                )
            )
            await conn.send(
                json.dumps(
                    {
                        "sessionOutput": {
                            "turnIndex": turn_idx,
                            "turnCompleted": True,
                            "text": "Adding £45 a month reaches your savings target sooner.",
                        }
                    }
                )
            )
            await conn.send(json.dumps({"goAway": {}}))
            return True

        if "confirm resumed" in lower:
            prev_seq = self._session_seq.get(session_id, 1)
            next_seq = self._next_seq(session_id)
            await conn.send(
                json.dumps(
                    {
                        "sessionOutput": {
                            "turnIndex": turn_idx,
                            "turnCompleted": False,
                            "payload": {
                                "seq": next_seq,
                                "page": "mortgage",
                                "subview": "rates",
                            },
                        }
                    }
                )
            )
            await conn.send(
                json.dumps(
                    {
                        "sessionOutput": {
                            "turnIndex": turn_idx,
                            "turnCompleted": True,
                            "text": "Here are your fixed-rate renewal options.",
                            "diagnosticInfo": {
                                "messages": [
                                    {
                                        "chunks": [
                                            {
                                                "agentTransfer": {
                                                    "targetAgent": "mortgage_agent",
                                                    "displayName": "mortgage_agent",
                                                }
                                            },
                                            {
                                                "updatedVariables": {
                                                    "ui_view_state": {
                                                        "seq": float(prev_seq),
                                                        "page": "savings",
                                                        "extra_monthly_pence": 4500.0,
                                                    }
                                                }
                                            },
                                        ]
                                    }
                                ]
                            },
                        }
                    }
                )
            )
            return False

        if "subscription" in lower or "netflix" in lower:
            seq = self._next_seq(session_id)
            subs_count = _CHLOE_FIGURES["subs_count"]
            subs_total = _CHLOE_FIGURES["subs_total_str"]
            netflix_amt = _CHLOE_FIGURES["netflix_str"]
            ui_payload = {
                "seq": seq,
                "page": "spending",
                "view": "subscriptions",
                "period": "this_month",
                "highlight_vendor": "Netflix",
            }
            await conn.send(
                json.dumps(
                    {
                        "sessionOutput": {
                            "turnIndex": turn_idx,
                            "turnCompleted": False,
                            "payload": ui_payload,
                        }
                    }
                )
            )
            await asyncio.sleep(0.02)
            await conn.send(
                json.dumps(
                    {
                        "sessionOutput": {
                            "turnIndex": turn_idx,
                            "turnCompleted": True,
                            "text": (
                                f"<warm> <positive> You have {subs_count} recurring charges this "
                                f"month totalling {subs_total}, including Netflix at {netflix_amt}. "
                                "To cancel Netflix, open Account settings on help.netflix.com and "
                                "select Cancel Membership."
                            ),
                            "googleSearchSuggestions": {
                                "htmls": [
                                    (
                                        '<div><a href="https://www.google.com/search?q=cancel+netflix+uk">'
                                        "Cancel Netflix subscription UK</a></div>"
                                    )
                                ],
                                "webSearchQueries": ["cancel netflix subscription uk"],
                            },
                            "citations": {
                                "citedChunks": [
                                    {
                                        "uri": "https://help.netflix.com/en/node/407",
                                        "title": "How to cancel Netflix",
                                    }
                                ]
                            },
                            "diagnosticInfo": {
                                "messages": [
                                    {
                                        "chunks": [
                                            {
                                                "agentTransfer": {
                                                    "targetAgent": "everyday_banking_agent",
                                                    "displayName": "everyday_banking_agent",
                                                }
                                            },
                                            {
                                                "updatedVariables": {
                                                    "ui_view_state": {
                                                        "seq": float(seq),
                                                        "page": "spending",
                                                        "view": "subscriptions",
                                                        "period": "this_month",
                                                        "highlight_vendor": "Netflix",
                                                    }
                                                }
                                            },
                                        ]
                                    }
                                ]
                            },
                        }
                    }
                )
            )
            return False

        seq = self._next_seq(session_id)
        nov_tot = _CHLOE_FIGURES["nov_total_str"]
        nov_cnt = _CHLOE_FIGURES["nov_txn_count"]
        await conn.send(
            json.dumps(
                {
                    "sessionOutput": {
                        "turnIndex": turn_idx,
                        "turnCompleted": False,
                        "payload": {
                            "seq": seq,
                            "page": "spending",
                            "view": "overview",
                            "period": "this_month",
                        },
                        "audio": _SPEECH_AUDIO_B64,
                    }
                }
            )
        )
        await conn.send(
            json.dumps(
                {
                    "sessionOutput": {
                        "turnIndex": turn_idx,
                        "turnCompleted": True,
                        "text": f"Your November spending totals {nov_tot} across {nov_cnt} transactions.",
                    }
                }
            )
        )
        return False


async def _serve() -> None:
    fake_upstream = FakeBidiUpstream()
    real_ws_connect = websockets.connect

    async with websockets.serve(
        fake_upstream.handle,
        host="127.0.0.1",
        port=0,
        max_size=4 * 1024 * 1024,
    ) as upstream_server:
        sockets = list(upstream_server.sockets)
        upstream_port = int(sockets[0].getsockname()[1])
        loopback_uri = f"ws://127.0.0.1:{upstream_port}/ws/bidi"

        async def _fake_get_token() -> str:
            return "e2e-loopback-bearer-token"

        def _redirected_connect(uri: str, *args: Any, **kwargs: Any) -> Any:
            target = loopback_uri if uri.startswith("wss://ces.googleapis.com/") else uri
            return real_ws_connect(target, *args, **kwargs)

        proxy_main._tokens.get_token = _fake_get_token
        proxy_main.websockets.connect = _redirected_connect  # type: ignore[assignment]

        config = uvicorn.Config(
            proxy_main.app,
            host="127.0.0.1",
            port=_E2E_PROXY_PORT,
            ws_max_size=1_048_576,
            log_level="warning",
        )
        server = uvicorn.Server(config)

        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(sig, server.handle_exit, sig, None)

        await server.serve()


def main() -> None:
    asyncio.run(_serve())


if __name__ == "__main__":
    main()
