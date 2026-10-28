#!/usr/bin/env python3
"""Open separate Chrome profiles for the five demo identities; never reads their passwords."""
import json
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parent
state = root / ".demo-state/foc-d4-demo"


def main():
    preview = len(sys.argv) == 2 and sys.argv[1] == "--print"
    if len(sys.argv) > (2 if preview else 1):
        raise ValueError("Usage: python3 scripts-demo-tabs.py [--print]")
    demo = json.loads((state / "overview.json").read_text())
    edge = demo["edge"]
    order = {key: "/request/" + item["orderId"] for key, item in demo["orders"].items()}
    tabs = {
        "requester": ["/login", "/suppliers", "/wallet", "/order-history", order["prints"], order["cancel"]],
        "courier": ["/login", "/feed", "/wallet", order["prints"], order["race"]],
        "raceCourier": ["/login", "/feed", "/wallet", order["race"]],
        "adminA": ["/login", "/admin", "/admin/users", "/admin/role-requests", "/admin/wallets", "/admin/errands", "/admin/operations"],
        "adminB": ["/login", "/admin/role-requests", "/admin/audit", "/admin/activity", "/admin/operations"],
    }
    if not preview and sys.platform != "darwin":
        raise ValueError("Automatic profile opening uses macOS Chrome. Use --print for the complete tab list on other systems.")
    if not preview and not Path("/Applications/Google Chrome.app").exists():
        raise ValueError("Install Google Chrome, or use --print and open separate browser profiles manually.")
    for key, paths in tabs.items():
        person = demo["personas"][key]
        urls = [edge + path for path in paths]
        print(f"{person['name']} ({person['email']}):")
        print("\n".join("  " + url for url in urls))
        if not preview:
            profile = state / "browsers" / key
            profile.mkdir(parents=True, exist_ok=True, mode=0o700)
            subprocess.run(["open", "-na", "Google Chrome", "--args", f"--user-data-dir={profile}", *urls], check=True)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, OSError, subprocess.SubprocessError) as error:
        print(f"Demo tabs failed: {error}", file=sys.stderr)
        sys.exit(1)
