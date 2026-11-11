from typing import Any, Optional


def fake_tool_call(
    tool: Tool,
    input: dict[str, Any],
    callback_context: CallbackContext,
) -> Optional[dict[str, Any]]:
    """Deterministic fake googleSearchTool response for NAIVE goldens and simulations."""
    del tool, callback_context
    query = str((input or {}).get("query") or "").strip() or "how to cancel subscription UK"
    return {
        "search_query": query,
        "snippets": [
            {
                "url": "https://help.netflix.com/en/node/407",
                "title": "How to cancel - Help Centre",
                "text": (
                    "Sign in to your account page in the provider's app or website, "
                    "open Membership and Billing, and select Cancel Membership. "
                    "Your subscription remains active until the end of the current billing period."
                ),
            }
        ],
    }
