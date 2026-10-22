"""Writes the load report (TST-03, #166) from what ./scripts-load.sh measured.

    python3 load/report.py OUT_DIR REPORT_PATH

OUT_DIR holds k6's user.json, supplier.json and credit.json (see load/lib.js). The rest comes
from the environment: STUDENTS, SUPPLIERS, WALLETS, USER_READY, SESSION, CREDIT_READY, WALLET,
STABLE and OTHER_CONTAINERS (how many containers outside the load stack were running). Prints how many targets were missed.
"""

import json
import os
import platform
import subprocess
import sys

out, report = sys.argv[1], sys.argv[2]
env = os.environ
runs = {name: json.load(open(os.path.join(out, f"{name}.json"))) for name in ("user", "supplier", "credit")}
REQUIREMENT = {
    "login": "US-NFR3.1.1",
    "profile": "US-NFR3.1.1",
    "list": "SS-NFR2.1.1",
    "search": "SS-NFR2.1.1",
    "lookup": "SS-NFR2.1.1",
    "wallet": "CS-NFR3.1.1",
}


def run(*command):
    return subprocess.run(command, capture_output=True, text=True).stdout.strip()


def ms(value):
    return "n/a" if value is None else f"{value:.0f} ms"


def verdict(ok):
    return "Met" if ok else "**Missed**"


rows, missed = [], 0
for result in runs.values():
    for e in result["endpoints"]:
        missed += not e["ok"]
        rows.append(
            f"| {REQUIREMENT[e['endpoint']]} | `{e['endpoint']}` | ≤ {e['target']} ms | {ms(e.get('p95'))} "
            f"| {ms(e.get('p99'))} | {e['requests']} | {e['failedRate'] * 100:.2f}% | {verdict(e['ok'])} |"
        )


def restarted(seconds, answered):
    return float(seconds) <= 60 and answered == "200"


user_ok = restarted(env["USER_READY"], env["SESSION"])
credit_ok = restarted(env["CREDIT_READY"], env["WALLET"])
ordering_ok = env["STABLE"] == "yes"
missed += (not user_ok) + (not credit_ok) + (not ordering_ok)

cpus, memory = (run("docker", "info", "--format", "{{.NCPU}} {{.MemTotal}}").split() + ["?", "0"])[:2]
machine = f"{platform.system()} {platform.machine()}; Docker with {cpus} CPUs and {int(memory) / 2**30:.1f} GiB"
unrecorded = any(e.get("p99") is None for result in runs.values() for e in result["endpoints"])
note = (
    "\n\np99 reads n/a where k6 did not keep it: before the harness asked for it, it kept only up to p95."
    if unrecorded
    else ""
)
count = lambda name: f"{int(env[name]):,}"
others = int(env.get("OTHER_CONTAINERS", "0"))
alone = "nothing else ran beside them" if others == 0 else f"{others} other containers were running too"

first = runs["user"]
date = os.path.basename(report)[len("load-") : -len(".md")]
text = f"""# Load and latency, {date}

Measured by `./scripts-load.sh` (TST-03, [#166](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/166))
on a stack of its own, from commit `{run("git", "rev-parse", "--short", "HEAD")}`.

- **Load:** {first["vus"]} concurrent virtual users (k6) in each scenario, for {first["seconds"]} s, each
  pausing {first["thinkS"]} s between requests, as a person does.
- **Data:** {count("STUDENTS")} students who sign in, {count("SUPPLIERS")} active suppliers, {count("WALLETS")} wallets.
- **Machine:** {machine}. The virtual users and the stack share it; {alone}.
- The User Service's sign-in limits are raised on this stack only (`compose.load.yaml`).

## Response times

| Requirement | Endpoint | Target (p95) | p95 | p99 | Requests | Failed | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
{chr(10).join(rows)}{note}

## Restarts and ordering

| Requirement | Check | Measured | Result |
| --- | --- | --- | --- |
| US-NFR3.1.2 | User Service ready after a restart (≤ 60 s), a session from before still valid | {env["USER_READY"]} s; the session answers {env["SESSION"]} | {verdict(user_ok)} |
| CS-NFR3.1.2 | Credit Service ready after a restart (≤ 60 s) | {env["CREDIT_READY"]} s; a wallet read answers {env["WALLET"]} | {verdict(credit_ok)} |
| SS-NFR2.1.2 | The same supplier query, twice, returns the same order | {env["STABLE"]} | {verdict(ordering_ok)} |

That transfers and returns requested before a restart complete without repair (CS-NFR3.1.2) is
checked by `./scripts-restart-check.sh`, which CI runs. The Order Service's targets (OS-NFR2) and
the share of credit steps recorded within five seconds (CS-NFR3.1.1) are ORD-12,
[#181](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/181), on this harness.
"""
with open(report, "w") as file:
    file.write(text)
print(f"Wrote {report}: {missed} target(s) missed.")
