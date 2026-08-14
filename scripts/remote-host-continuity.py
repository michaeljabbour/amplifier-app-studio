#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["websockets>=15,<16"]
# ///
"""Exercise Studio's real remote-host protocol across a client disconnect."""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import time
import uuid
from typing import Any
from urllib.parse import urlparse

import websockets


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", required=True, help="Amplifier Host base URL")
    parser.add_argument("--project-dir", required=True, help="Allowed project on the host")
    parser.add_argument("--origin", help="Exact allowed browser origin (defaults to --url)")
    parser.add_argument("--bundle", default="anchors")
    parser.add_argument("--mode", default="auto")
    parser.add_argument("--provider")
    parser.add_argument("--model")
    parser.add_argument("--gui-id", default=f"remote-continuity-{uuid.uuid4().hex[:12]}")
    parser.add_argument("--offline-seconds", type=float, default=5.0)
    parser.add_argument("--timeout-seconds", type=float, default=300.0)
    parser.add_argument(
        "--prompt",
        default=(
            "Confirm remote execution by inspecting this project with several tool calls, "
            "then answer with the hostname, project path, and a concise evidence summary."
        ),
    )
    return parser.parse_args()


def websocket_url(base_url: str, gui_id: str) -> str:
    parsed = urlparse(base_url)
    scheme = "wss" if parsed.scheme == "https" else "ws"
    base_path = parsed.path.rstrip("/")
    return f"{scheme}://{parsed.netloc}{base_path}/v1/api/session/{gui_id}"


def token_protocol(token: str) -> str:
    encoded = base64.urlsafe_b64encode(token.encode()).decode().rstrip("=")
    return f"amplifier-host.bearer.{encoded}"


def record_identity(envelope: dict[str, Any]) -> tuple[str, str]:
    if envelope.get("type") != "event" or envelope.get("channel") != "record":
        return "", ""
    record = envelope.get("payload")
    if not isinstance(record, dict):
        return "", ""
    record_type = str(record.get("type", ""))
    event = record.get("event")
    event_kind = str(event.get("kind", "")) if isinstance(event, dict) else ""
    return record_type, event_kind


def record_cursor(envelope: dict[str, Any], current: int) -> int:
    payload = envelope.get("payload")
    if not isinstance(payload, dict):
        return current
    value = payload.get("cursor", payload.get("sequence"))
    return max(current, value) if isinstance(value, int) else current


async def receive_json(socket: Any, timeout: float) -> dict[str, Any]:
    value = json.loads(await asyncio.wait_for(socket.recv(), timeout))
    if not isinstance(value, dict):
        raise RuntimeError("Amplifier Host returned a non-object message")
    if value.get("type") == "error":
        raise RuntimeError(str(value.get("message", "Amplifier Host error")))
    return value


async def run(args: argparse.Namespace) -> dict[str, Any]:
    token = os.environ.get("AMPLIFIER_HOST_TOKEN", "").strip()
    if not token:
        raise RuntimeError("Set AMPLIFIER_HOST_TOKEN without placing it on the command line")

    url = websocket_url(args.url, args.gui_id)
    origin = (args.origin or args.url).rstrip("/")
    protocols = ["amplifier-host.v1", token_protocol(token)]
    deadline = time.monotonic() + args.timeout_seconds
    cursor = 0
    first_records = 0
    replay_records = 0
    disconnect_event = "submit accepted"

    async with websockets.connect(url, origin=origin, subprotocols=protocols) as socket:
        options = {
            "guiId": args.gui_id,
            "projectDir": args.project_dir,
            "bundle": args.bundle,
            "mode": args.mode,
        }
        if args.provider:
            options["provider"] = args.provider
        if args.model:
            options["model"] = args.model
        await socket.send(
            json.dumps(
                {
                    "type": "start",
                    "version": 1,
                    "options": options,
                }
            )
        )
        ready = False
        started = False
        while not (ready and started):
            envelope = await receive_json(socket, max(1, deadline - time.monotonic()))
            cursor = record_cursor(envelope, cursor)
            record_type, _ = record_identity(envelope)
            ready = ready or envelope.get("type") == "ready"
            started = started or record_type == "session.started"

        await socket.send(
            json.dumps(
                {
                    "type": "op",
                    "version": 1,
                    "op": {
                        "op": "submit",
                        "text": args.prompt,
                        "manage_project_plan": True,
                        "presentation_capabilities": [
                            "markdown",
                            "amplifier-html",
                            "amplifier-svg",
                            "amplifier-dot",
                            "auto-height",
                        ],
                    },
                }
            )
        )
        while time.monotonic() < deadline:
            envelope = await receive_json(socket, max(1, deadline - time.monotonic()))
            cursor = record_cursor(envelope, cursor)
            record_type, event_kind = record_identity(envelope)
            if record_type:
                first_records += 1
            if event_kind == "prompt_submit" or record_type == "prompt_submitted":
                disconnect_event = event_kind or record_type
                break

    print(
        json.dumps(
            {
                "phase": "client_disconnected",
                "guiId": args.gui_id,
                "after": disconnect_event,
                "cursor": cursor,
                "offlineSeconds": args.offline_seconds,
            }
        ),
        flush=True,
    )
    await asyncio.sleep(args.offline_seconds)

    prompt_complete = False
    response = ""
    attached = False
    async with websockets.connect(url, origin=origin, subprotocols=protocols) as socket:
        await socket.send(json.dumps({"type": "attach", "version": 1, "since": cursor}))
        while time.monotonic() < deadline and not prompt_complete:
            envelope = await receive_json(socket, max(1, deadline - time.monotonic()))
            if envelope.get("type") == "ready":
                attached = envelope.get("attached") is True
                continue
            cursor = record_cursor(envelope, cursor)
            record_type, event_kind = record_identity(envelope)
            if record_type:
                replay_records += 1
            payload = envelope.get("payload")
            event = payload.get("event") if isinstance(payload, dict) else None
            if event_kind == "prompt_complete":
                prompt_complete = True
                if isinstance(event, dict):
                    response = str(event.get("response", ""))

    return {
        "phase": "complete",
        "guiId": args.gui_id,
        "remoteHost": urlparse(args.url).netloc,
        "projectDir": args.project_dir,
        "attached": attached,
        "firstConnectionRecords": first_records,
        "replayedOrLiveRecords": replay_records,
        "cursor": cursor,
        "promptComplete": prompt_complete,
        "response": response,
    }


if __name__ == "__main__":
    try:
        result = asyncio.run(run(arguments()))
    except Exception as error:
        raise SystemExit(f"remote host continuity failed: {error}") from error
    print(json.dumps(result, indent=2))
    if not result["attached"] or not result["promptComplete"] or not result["response"].strip():
        raise SystemExit("remote host continuity did not reach the required terminal state")
