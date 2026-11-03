"""Push a phone notification when the banner changes to Amber or Red, or clears back to Green.

Uses ntfy (https://ntfy.sh): the owner installs the free ntfy app and subscribes to a private
topic name. The topic is kept in the NTFY_TOPIC secret; nothing is sent if it is unset.
Only public board content is sent (banner color, rule, link). Gray (unknown) changes are
not pushed, so a flaky feed does not page anyone.
"""
from __future__ import annotations

import os

import httpx

LABEL = {"red": "RED · WARNING", "amber": "AMBER · ADVISORY / WATCH", "green": "GREEN · ALL CLEAR"}
PRIORITY = {"red": "5", "amber": "4", "green": "2"}
TAGS = {"red": "rotating_light", "amber": "warning", "green": "white_check_mark"}


def decide(prev_color: str | None, new_color: str) -> bool:
    """Push on a change to Amber/Red, or Amber/Red clearing to Green. Never for Gray."""
    if not prev_color or prev_color == new_color or new_color == "gray":
        return False
    if new_color in ("amber", "red"):
        return True
    return new_color == "green" and prev_color in ("amber", "red")


def message(loc_name: str, new: dict, site_url: str | None) -> dict:
    color = new["banner"]["color"]
    # HTTP headers must be latin-1; keep the title ASCII.
    title = f"GRID {loc_name}: {LABEL[color]}".replace("·", "-")
    headers = {"Title": title, "Priority": PRIORITY[color], "Tags": TAGS[color]}
    if site_url:
        headers["Click"] = site_url
    return {"headers": headers, "body": new["banner"]["rule"]}


def maybe_notify(prev: dict | None, new: dict, loc_name: str, site_url: str | None,
                 client: httpx.Client | None = None) -> str:
    topic = os.environ.get("NTFY_TOPIC", "").strip()
    prev_color = ((prev or {}).get("banner") or {}).get("color")
    new_color = new["banner"]["color"]
    if not decide(prev_color, new_color):
        return f"no push ({prev_color} -> {new_color})"
    if not topic:
        return f"would push ({prev_color} -> {new_color}) but NTFY_TOPIC is not set"
    server = os.environ.get("NTFY_SERVER", "https://ntfy.sh").rstrip("/")
    m = message(loc_name, new, site_url)
    own = client is None
    client = client or httpx.Client(timeout=15)
    try:
        r = client.post(f"{server}/{topic}", content=m["body"].encode(), headers=m["headers"])
        return f"pushed ({prev_color} -> {new_color}): HTTP {r.status_code}"
    except httpx.HTTPError as exc:
        return f"push failed ({prev_color} -> {new_color}): {type(exc).__name__}"
    finally:
        if own:
            client.close()


def send_test(site_url: str | None = None, client: httpx.Client | None = None) -> str:
    """Send one clearly labeled test notification (used by the workflow's 'send test alert' option)."""
    topic = os.environ.get("NTFY_TOPIC", "").strip()
    if not topic:
        return "test not sent: NTFY_TOPIC is not set"
    server = os.environ.get("NTFY_SERVER", "https://ntfy.sh").rstrip("/")
    headers = {"Title": "GRID test", "Priority": "3", "Tags": "test_tube"}
    if site_url:
        headers["Click"] = site_url
    own = client is None
    client = client or httpx.Client(timeout=15)
    try:
        r = client.post(f"{server}/{topic}", headers=headers,
                        content="Test alert from GRID. If you see this, phone alerts are working. No action needed.".encode())
        return f"test sent: HTTP {r.status_code}"
    except httpx.HTTPError as exc:
        return f"test failed: {type(exc).__name__}"
    finally:
        if own:
            client.close()


if __name__ == "__main__":
    import sys
    print(send_test(sys.argv[1] if len(sys.argv) > 1 else None))
