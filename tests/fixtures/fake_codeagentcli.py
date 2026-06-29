#!/usr/bin/env python3
"""Fake codeagentcli for memory eval harness tests."""

import json
import sys

for line in sys.stdin:
    line = line.strip()
    if line:
        message = json.loads(line)
        user_message = message.get("message", {})
        print(json.dumps({"type": "assistant", "message": f"received {user_message.get('role')}"}), flush=True)

print(
    json.dumps(
        {
            "type": "result",
            "subtype": "success",
            "is_error": False,
            "duration_ms": 123,
            "duration_api_ms": 100,
            "num_turns": 1,
            "result": "fake success",
            "stop_reason": "end_turn",
            "session_id": "fake-session",
            "total_cost_usd": 0.0,
            "usage": {
                "input_tokens": 1,
                "output_tokens": 1,
                "cache_creation_input_tokens": 0,
                "cache_read_input_tokens": 0,
            },
            "modelUsage": {},
            "permission_denials": [],
            "uuid": "fake-result",
        }
    ),
    flush=True,
)
