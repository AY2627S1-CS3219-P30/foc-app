# AI Assistance Disclosure:
# Tool: Claude Code (Claude Opus 5.5), dates: 2026-11-04 to 2026-11-09
# Scope: Joint work by Zhang Yuan and Jonus Ho (#181). Generated the implementation of the Order
#   Service rows and the CS-NFR3.1.1 credit-step row, which holds reservations, transfers and
#   returns to 99% each.
# Author review: Zhang Yuan validated the implementation as mostly correct. Jonus Ho reviewed it,
#   the per-kind 99% check came from that review, and he ran the final load test before committing
#   its report.

"""Writes the load report (TST-03, #166) from what ./scripts-load.sh measured.

    python3 load/report.py OUT_DIR REPORT_PATH

OUT_DIR holds k6's user.json, supplier.json, credit.json and order.json (see load/lib.js), and
live.json from load/live.mjs, the live-update streams held while those ran (N1.4, #332), and
credit-requested.psv and credit-recorded.psv, each credit step as `order|kind|epoch seconds`, from
the Order and Credit databases (CS-NFR3.1.1). The rest comes from the environment: STUDENTS, SUPPLIERS, WALLETS, ERRANDS (what the harness counted after
seeding), USER_READY, SESSION, CREDIT_READY, WALLET, STABLE and OTHER_CONTAINERS (how many
containers outside the load stack were running). Writes the report, then exits 3 if it says any
target was missed.
"""

import json
import math
import os
import platform
import subprocess
import sys

out, report = sys.argv[1], sys.argv[2]
env = os.environ
runs = {name: json.load(open(os.path.join(out, f"{name}.json"))) for name in ("user", "supplier", "credit", "order")}
live = json.load(open(os.path.join(out, "live.json")))
REQUIREMENT = {
    "login": "US-NFR3.1.1",
    "profile": "US-NFR3.1.1",
    "list": "SS-NFR2.1.1",
    "search": "SS-NFR2.1.1",
    "lookup": "SS-NFR2.1.1",
    "wallet": "CS-NFR3.1.1",
    "create": "OS-NFR2.1.1",
    "open": "OS-NFR2.1.1",
    "details": "OS-NFR2.1.1",
    "command": "OS-NFR2.1.2",
}


def run(*command):
    return subprocess.run(command, capture_output=True, text=True).stdout.strip()


def ms(value):
    return "n/a" if value is None else f"{value:.0f} ms"


def verdict(ok):
    return "Met" if ok else "**Missed**"


def commit():
    """The commit measured, `-dirty` when a tracked file differs from it. Changes to docs, Markdown
    and .gitignore are left out, as they cannot change a figure."""
    head = run("git", "rev-parse", "--short", "HEAD")
    changed = subprocess.run(
        ["git", "diff", "--quiet", "HEAD", "--", ".", ":(exclude)docs", ":(exclude)*.md", ":(exclude).gitignore"]
    ).returncode
    return head if changed == 0 else f"{head}-dirty"


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


# N1.4 (#332): what load/live.mjs found while the scenarios ran.
streams = live["students"] * live["streamsEach"]
latency = live["latencyMs"]
live_checks = [
    (
        "Streams held open, each saying `ready`",
        "all of them",
        f"{live['streamsReady']} of {streams} ({live['students']} students × {live['streamsEach']})",
        live["streamsOpened"] == streams and live["streamsReady"] == streams,
    ),
    (
        "An accept reaches its requester's stream, p95",
        "< 1 s",
        f"{ms(latency['p95'])} (p50 {ms(latency['p50'])}, max {ms(latency['max'])}; {live['timed']} accepts)",
        live["timed"] > 0 and latency["p95"] is not None and latency["p95"] < 1000,
    ),
    ("Nudges lost: none within 5 s of the accept", "0", str(live["lost"]), live["lost"] == 0),
    ("A sixth stream for one student", "refused, `429`", str(live["sixthStream"]), live["sixthStream"] == 429),
    (
        "Errands the client could not post, see open, or accept",
        "0",
        f"{live['failures']} of {live['errands'] + live['failures']}",
        live["failures"] == 0,
    ),
]
missed += sum(not ok for *_, ok in live_checks)
live_rows = "\n".join(f"| {check} | {target} | {measured} | {verdict(ok)} |" for check, target, measured, ok in live_checks)

# CS-NFR3.1.1: each credit step the run asked for, from when the Order Service asked for it to when
# the Credit Service recorded its decision. One never recorded counts as late. Each kind must reach
# 99% on its own, so the reservations, about half the steps, cannot hide a slow kind.
def steps(name):
    path = os.path.join(out, name)
    lines = open(path).read().splitlines() if os.path.exists(path) else []
    return {(order, kind): float(at) for order, kind, at in (line.split("|") for line in lines if line)}


requested, recorded = steps("credit-requested.psv"), steps("credit-recorded.psv")
KINDS = {"RESERVE": "reservations", "TRANSFER": "transfers", "RELEASE": "returns"}
in_time = {kind: 0 for kind in KINDS}
asked = {kind: 0 for kind in KINDS}
for (order, kind), at in requested.items():
    asked[kind] += 1
    done = recorded.get((order, kind))
    in_time[kind] += done is not None and done - at <= 5
steps_ok = all(asked[k] and in_time[k] >= 0.99 * asked[k] for k in KINDS)


def share(kind):
    if not asked[kind]:
        return f"no {KINDS[kind]}"
    # Rounded down, so a share just under 99% never reads as 99.0%.
    percent = math.floor(1000 * in_time[kind] / asked[kind]) / 10
    return f"{in_time[kind]:,} of {asked[kind]:,} {KINDS[kind]} ({percent}%)"


by_kind = ", ".join(share(kind) for kind in KINDS)

user_ok = restarted(env["USER_READY"], env["SESSION"])
credit_ok = restarted(env["CREDIT_READY"], env["WALLET"])
ordering_ok = env["STABLE"] == "yes"
# OS-NFR2.1.2: a cancel starts a credit return and a confirmation a transfer, so an answer that
# already says its step is pending did not wait for the Credit Service.
waits = runs["order"]["creditPending"]
unblocked_ok = waits["answers"] > 0 and waits["pending"] == waits["answers"]
missed += (not user_ok) + (not credit_ok) + (not ordering_ok) + (not unblocked_ok) + (not steps_ok)

cpus, memory = (run("docker", "info", "--format", "{{.NCPU}} {{.MemTotal}}").split() + ["?", "0"])[:2]
machine = f"{platform.system()} {platform.machine()}; Docker with {cpus} CPUs and {int(memory) / 2**30:.1f} GiB"
count = lambda name: f"{int(env[name]):,}"
others = int(env.get("OTHER_CONTAINERS", "0"))
alone = "nothing else ran beside them" if others == 0 else f"{others} other containers were running too"

first = runs["user"]
date = os.path.basename(report)[len("load-") : -len(".md")]
text = f"""# Load and latency, {date}

Measured by `./scripts-load.sh` (TST-03, [#166](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/166))
on a stack of its own, from commit `{commit()}`.

- **Load:** {first["vus"]} concurrent virtual users (k6) in each scenario, for {first["seconds"]} s, each
  pausing {first["thinkS"]} s between requests, as a person does.
- **Data:** {count("STUDENTS")} students who sign in, {count("SUPPLIERS")} active suppliers, {count("WALLETS")} wallets,
  {count("ERRANDS")} open errands (all open: the open list's worst case).
- **Machine:** {machine}. The virtual users and the stack share it; {alone}.
- The User Service's sign-in limits are raised on this stack only (`compose.load.yaml`).

## Response times

| Requirement | Endpoint | Target (p95) | p95 | p99 | Requests | Failed | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
{chr(10).join(rows)}

## Restarts, ordering, commands and credit steps

| Requirement | Check | Measured | Result |
| --- | --- | --- | --- |
| US-NFR3.1.2 | User Service ready after a restart (≤ 60 s), a session from before still valid | {env["USER_READY"]} s; the session answers {env["SESSION"]} | {verdict(user_ok)} |
| CS-NFR3.1.2 | Credit Service ready after a restart (≤ 60 s) | {env["CREDIT_READY"]} s; a wallet read answers {env["WALLET"]} | {verdict(credit_ok)} |
| SS-NFR2.1.2 | The same supplier query, twice, returns the same order | {env["STABLE"]} | {verdict(ordering_ok)} |
| OS-NFR2.1.2 | A cancel or a confirmation answers before its credit step, saying the step is pending | {waits["pending"]} of {waits["answers"]} answers | {verdict(unblocked_ok)} |
| CS-NFR3.1.1 | Reservations, transfers and returns recorded within 5 s of being requested (≥ 99% of each) | {by_kind} | {verdict(steps_ok)} |

## Live updates (N1.4)

{live['students']} students each held {live['streamsEach']} live-update streams
([ADR 0011](../adr/0011-live-updates.md)) straight to the Order Service while the scenarios above
ran, so their response times were measured with {streams} streams open. Meanwhile an errand was
posted and accepted at a steady rate, and each accept was timed from its answer to the nudge on
the requester's stream ([#332](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/332)).

| Check | Target | Measured | Result |
| --- | --- | --- | --- |
{live_rows}

That transfers and returns requested before a restart complete without repair (CS-NFR3.1.2) is
checked by `./scripts-restart-check.sh`, which CI runs.
"""
with open(report, "w") as file:
    file.write(text)
print(f"Wrote {report}: {missed} target(s) missed.")
sys.exit(3 if missed else 0)
