from typing import Any

_FAKE_HELP_URLS = (
    ("spotify", "https://support.spotify.com/uk/article/close-account/"),
    ("puregym", "https://www.puregym.com/help-centre/"),
    ("adobe", "https://helpx.adobe.com/uk/manage-account/using/cancel-subscription.html"),
    ("icloud", "https://support.apple.com/en-gb/108047"),
    ("national trust", "https://www.nationaltrust.org.uk/membership"),
    ("aviva", "https://www.aviva.co.uk/help-and-support/"),
)


def fake_tool_call(
    tool: Tool,
    input: dict[str, Any],
    callback_context: CallbackContext,
) -> dict[str, Any] | None:
    """Deterministic fake Google Search tool response for NAIVE goldens and simulations."""
    del tool, callback_context
    query = str((input or {}).get("query") or "").strip() or "how to cancel subscription UK"
    lowered = query.lower()
    url = "https://help.netflix.com/en/node/407"
    for keyword, candidate_url in _FAKE_HELP_URLS:
        if keyword in lowered:
            url = candidate_url
            break
    return {
        "search_query": query,
        "snippets": [
            {
                "url": url,
                "title": "How to cancel - Help Centre",
                "text": (
                    "Sign in to your account page in the provider's app or website, "
                    "open Membership and Billing, and select Cancel Membership. "
                    "Your subscription remains active until the end of the current billing period."
                ),
            }
        ],
    }
