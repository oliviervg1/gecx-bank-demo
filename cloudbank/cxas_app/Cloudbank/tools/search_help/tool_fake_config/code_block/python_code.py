from typing import Any, Optional


def fake_tool_call(
    tool: Tool,
    input: dict[str, Any],
    callback_context: CallbackContext,
) -> Optional[dict[str, Any]]:
    """Deterministic fake search response for NAIVE goldens and simulations."""
    del tool, callback_context
    query = str((input or {}).get("query") or "").strip()
    return {
        "answer": [
            "Sign in to your account page in the provider's app or website, open Membership and Billing, and select Cancel Membership. Your subscription remains active until the end of the current billing period."
        ],
        "search_queries": [query or "how to cancel subscription UK"],
    }
