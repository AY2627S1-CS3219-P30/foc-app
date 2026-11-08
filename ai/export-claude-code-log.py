#!/usr/bin/env python3
# AI Assistance Disclosure:
# Tool: Claude Code (model: claude-opus-5-5), date: 2026-11-08
# Scope: Generated this exporter, which writes one member's section of ai/usage-log.md.
# Author review: Jonus read the rules below and checked the section it wrote for him.
"""Write one member's section of ai/usage-log.md from their Claude Code transcripts.

Claude Code keeps each session as a JSON-lines file under ~/.claude/projects/<folder>/, where
<folder> is the checkout's path with every "/" turned into "-". Run this on your own machine:

    python3 ai/export-claude-code-log.py --author "Your Name" \
        ~/.claude/projects/-Users-you-path-to-foc-app > /tmp/my-section.md

then paste the output under your heading in ai/usage-log.md and run Prettier on the file.

What it keeps, and what it leaves out:
- Prompts you typed. Prompts written by Claude to its own subagents, terminal commands you ran in
  the session, and the summaries Claude Code writes when a session runs out of context are left
  out. A prompt that a resumed session repeats is kept once.
- Pasted text becomes "[pasted text, N lines]", and screenshots become a note. Email addresses,
  tokens and anything after "password:" and similar are replaced with placeholders.
- A prompt is quoted word for word unless it is routine: a short approval, a push or merge notice,
  or a status check ("pushed, open the pr", "is the ci done yet"). Routine prompts are counted per
  day instead. A prompt that touches requirements, planning, design or decisions is always quoted,
  however short.
- The key response is the start of Claude's last message in that turn.
- The "use" tag is assigned by keyword from the prompt and the branch, so treat it as a guide.
"""

from __future__ import annotations

import argparse
import datetime as dt
import glob
import json
import os
import re
import sys

SKIP_PREFIXES = (
    "<bash-input>",
    "<bash-stdout>",
    "<bash-stderr>",
    "<local-command",
    "Caveat:",
    "[Request interrupted",
    "<task-notification>",
    "This session is being continued",
    "<artifact-content-authored-by-others/>",
    "<user-memory-input>",
    "<ci-monitor-event>",
)

SECRETS = [
    (re.compile(r"[\w.+-]+@[\w-]+(\.[\w-]+)+"), "[email]"),
    (
        re.compile(
            r"\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|sk-[A-Za-z0-9_-]{20,}"
            r"|AKIA[0-9A-Z]{16}|xox[abp]-[\w-]+|eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]+)"
        ),
        "[token]",
    ),
    (
        re.compile(r"(?i)\b(password|passwd|secret|token|api[_-]?key)(\s*[:=]\s*|\s+is\s+)(\S{6,})"),
        r"\1\2[redacted]",
    ),
    (re.compile(r"\b[A-Fa-f0-9]{48,}\b"), "[hex]"),
]

# Always quoted: anything near the policy's prohibited phases.
TOPIC_REQUIREMENTS = re.compile(
    r"\b(requirements?|nfrs?|frs?|n2hs?|nice.to.haves?|n\d(\.\d)?|tickets?|issues|backlog|"
    r"sprints?|prioriti\w*|milestones?|gantt|project plan|roles?|allocation|assign\w*)\b",
    re.I,
)
TOPIC_DESIGN = re.compile(
    r"\b(design\w*|architect\w*|adrs?|schemas?|decisions?|decide\w*|trade.?offs?|rationale|"
    r"justif\w*|risks?|which (one|is better|should|\d)|should (we|i) (use|pick|choose|take))\b",
    re.I,
)
ROUTINE = re.compile(
    r"^\s*(ok(ay)?|yes|yea|yeah|yep|y|no|nope|nah|sure|thanks|thank you|ty|continue|go ahead|"
    r"done|pushed|merged|committed|stop|wait|got it|cool|nice|great|sorry|rerun|retry|proceed|"
    r"try again|open it|post (them|it))\b"
    r"|^/(model|clear|compact|login|config|cost|status)\b"
    r"|\b(pushed|merged|is the ci|ci (done|finished|passed)|is it done|isit done|is .* done yet|"
    r"done yet|still running|what'?s next|whats next|taking so long|let me know when|open the prs?|"
    r"logged in|continue from where|status|ready to (merge|push)|merge main into|stash|"
    r"resolve the merge conflicts|solve the merge conflicts|mark .* ready|commit message|"
    r"commands to commit|make a branch)\b",
    re.I,
)
ROUTINE_MAX_CHARS = 120

TAG_REQUIREMENTS = re.compile(
    r"\b(requirements?|nfrs?|frs?|n2hs?|nice.to.haves?|backlog|sprints?|prioriti\w*|gantt|"
    r"project plan|roles?|allocation)\b",
    re.I,
)
TAG_SLIDES = re.compile(r"\b(slides?|deck|presentation)\b", re.I)
TAG_DESIGN = re.compile(
    r"\b(design\w*|architect\w*|adrs?|schemas?|trade.?offs?|rationale|justif\w*)\b"
    r"|\bwhich (one|\d) (should|shld)\b",
    re.I,
)
USES = [
    ("Learning / explanation", re.compile(
        r"\b(explain|understand|analy[sz]e|run me thr?u|what is|whats|wahts|what are|how does|"
        r"how do|why does|isnt there|is there|what does|meaning|mean)\b", re.I)),
    ("Debugging", re.compile(
        r"\b(fail\w*|error\w*|bug\w*|broken|not working|crash\w*|flak\w*|fix\w*|wrong)\b", re.I)),
    ("Testing", re.compile(r"\b(tests?|e2e|smoke|load test|coverage)\b", re.I)),
    ("Documentation and slides", re.compile(
        r"\b(readme|docs?|document\w*|runbook|report|pr description|comments?|reply|tracker|"
        r"diagrams?)\b", re.I)),
    ("Review and verification", re.compile(r"\b(review\w*|check\w*|verify|vet|audit)\b", re.I)),
    ("Release and PR workflow", re.compile(
        r"\b(commit\w*|push\w*|merge\w*|tags?|release\w*|rc\d|ci|prs?|rebase|branch\w*)\b", re.I)),
    ("Implementation", re.compile(r"\b(tickets?|implement\w*|build|add|create|do)\b", re.I)),
]
BRANCH_USES = [
    ("docs/", "Documentation and slides"),
    ("fix/", "Debugging"),
    ("test/", "Testing"),
    ("ci/", "Release and PR workflow"),
    ("chore/", "Boilerplate and tooling"),
    ("refactor/", "Refactoring"),
]


def text_and_images(content):
    if isinstance(content, str):
        return content, 0
    if not isinstance(content, list) or any(b.get("type") == "tool_result" for b in content):
        return None, 0
    texts = [b["text"] for b in content if b.get("type") == "text"]
    images = sum(1 for b in content if b.get("type") == "image")
    return "\n".join(texts), images


def clean_prompt(raw: str) -> str:
    s = re.sub(r"<system-reminder>.*?</system-reminder>", "", raw, flags=re.S)

    def pasted(m):
        n = len(m.group(2).strip().splitlines())
        return f"[pasted text, {n} line{'s' if n != 1 else ''}]"

    s = re.sub(r'<pasted_content id="([^"]+)">(.*?)</pasted_content id="\1">', pasted, s, flags=re.S)
    command = re.search(r"<command-name>(.*?)</command-name>", s)
    if command:
        args = re.search(r"<command-args>(.*?)</command-args>", s, re.S)
        s = command.group(1).strip() + (" " + args.group(1).strip() if args and args.group(1).strip() else "")
    return re.sub(r"[ \t]+$", "", s, flags=re.M).strip()


def redact(s: str) -> str:
    for pattern, repl in SECRETS:
        s = pattern.sub(repl, s)
    return s


def use_of(prompt: str, branch: str) -> str:
    if TAG_REQUIREMENTS.search(prompt):
        return "Requirements and planning (topic)"
    if TAG_SLIDES.search(prompt):
        return "Documentation and slides"
    if TAG_DESIGN.search(prompt):
        return "Design and decisions (topic)"
    for label, pattern in USES:
        if pattern.search(prompt):
            return label
    if "?" in prompt and len(prompt) < 200:
        return "Learning / explanation"
    for prefix, label in BRANCH_USES:
        if (branch or "").startswith(prefix):
            return label
    return "Implementation" if (branch or "").startswith("feat/") else "General request"


def is_routine(prompt: str) -> bool:
    if len(prompt) > ROUTINE_MAX_CHARS or "[pasted text" in prompt or "screenshot" in prompt:
        return False
    if TOPIC_REQUIREMENTS.search(prompt) or TOPIC_DESIGN.search(prompt):
        return False
    return bool(ROUTINE.search(prompt))


def key_response(text: str, limit: int = 320) -> str:
    t = re.sub(r"```.*?```", "[code block]", text, flags=re.S)
    t = re.sub(r"(?m)(^\|.*\n?)+", "[table] ", t)
    t = re.sub(r"(?m)^#+\s*", "", t)
    t = re.sub(r"\s+", " ", t).strip()
    if len(t) > limit:
        cut = t[:limit]
        end = max(cut.rfind(". "), cut.rfind("? "), cut.rfind("! "), cut.rfind(": "))
        t = cut[: end + 1] if end > limit // 2 else cut.rsplit(" ", 1)[0] + " …"
    if t.count("**") % 2:
        t += "**"
    if t.count("`") % 2:
        t += "`"
    return t.replace("<", "&lt;")


def load(paths):
    files = []
    for p in paths:
        p = os.path.expanduser(p)
        files += sorted(glob.glob(os.path.join(p, "*.jsonl"))) if os.path.isdir(p) else [p]
    prompts = {}
    for f in files:
        current = None
        with open(f, encoding="utf-8") as fh:
            for line in fh:
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                if r.get("isSidechain"):
                    continue
                if r.get("type") == "user" and not r.get("isMeta") and not r.get("isCompactSummary"):
                    raw, images = text_and_images(r.get("message", {}).get("content"))
                    if raw is None:
                        continue
                    raw = raw.strip()
                    if raw.startswith("[Request interrupted"):
                        current = None
                    if raw.startswith(SKIP_PREFIXES) or not (raw or images):
                        continue
                    p = clean_prompt(raw)
                    if images:
                        p = (p + "\n" if p else "") + f"[{images} screenshot{'s' if images > 1 else ''} attached]"
                    if not p:
                        continue
                    current = prompts.setdefault(
                        r["uuid"],
                        {"ts": r["timestamp"], "prompt": p, "branch": r.get("gitBranch") or "",
                         "response": "", "models": set()},
                    )
                elif r.get("type") == "assistant" and current is not None:
                    m = r.get("message", {})
                    if m.get("model") and not m["model"].startswith("<"):
                        current["models"].add(m["model"])
                    for b in m.get("content") or []:
                        if b.get("type") == "text" and b["text"].strip():
                            current["response"] = b["text"].strip()
    out = []
    for e in sorted(prompts.values(), key=lambda e: e["ts"]):
        if out and out[-1]["prompt"] == e["prompt"] and abs(parse(e["ts"]) - parse(out[-1]["ts"])).total_seconds() < 5:
            out[-1]["response"] = out[-1]["response"] or e["response"]
            out[-1]["models"] |= e["models"]
            continue
        out.append(e)
    return out


def parse(ts: str) -> dt.datetime:
    return dt.datetime.fromisoformat(ts.replace("Z", "+00:00"))


def fence(text: str) -> str:
    marker = "````" if "```" in text else "```"
    return f"{marker}text\n{text}\n{marker}"


def render(entries, author, tz, since, until):
    zone = dt.timezone(dt.timedelta(hours=tz))
    zone_name = "SGT" if tz == 8 else f"UTC{tz:+d}"
    picked = []
    for e in entries:
        when = parse(e["ts"]).astimezone(zone)
        if (since and when < since) or (until and when >= until):
            continue
        picked.append((when, e))
    if not picked:
        return f"No prompts found for {author}.\n"
    quoted = [(w, e) for w, e in picked if not is_routine(e["prompt"])]
    models = sorted({m for _, e in picked for m in e["models"]})
    uses = {}
    for _, e in quoted:
        u = use_of(e["prompt"], e["branch"])
        uses[u] = uses.get(u, 0) + 1
    lines = [
        f"Exported from {author}'s Claude Code transcripts with `ai/export-claude-code-log.py`: "
        f"{len(picked)} prompts from {picked[0][0]:%-d %b %Y} to {picked[-1][0]:%-d %b %Y}. "
        f"{len(quoted)} are quoted below; the other {len(picked) - len(quoted)} are routine "
        f"(approvals, push and merge notices, status checks) and are counted per day. "
        f"Times are {zone_name}. Models: {', '.join(f'`{m}`' for m in models)}.",
        "",
        "| Use (tagged by keyword) | Quoted prompts |",
        "| --- | --- |",
    ]
    lines += [f"| {u} | {n} |" for u, n in sorted(uses.items(), key=lambda x: -x[1])]
    lines.append("")
    day = None
    routine_today = 0

    def close_day():
        if day is not None and routine_today:
            lines.append(f"Routine prompts this day, not quoted: {routine_today}.")
            lines.append("")

    for when, e in picked:
        if when.date() != day:
            close_day()
            day, routine_today = when.date(), 0
            lines += [f"#### {when:%a %-d %b %Y}", ""]
        if is_routine(e["prompt"]):
            routine_today += 1
            continue
        meta = [f"**{when:%H:%M}**", use_of(e["prompt"], e["branch"])]
        if e["branch"] and e["branch"] != "HEAD":
            meta.append(f"`{e['branch']}`")
        if e["models"]:
            meta.append(", ".join(sorted(e["models"])))
        lines += [" · ".join(meta), "", fence(redact(e["prompt"])), ""]
        if e["response"]:
            lines += [f"> **Key response:** {redact(key_response(e['response']))}", ""]
    close_day()
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("paths", nargs="+", help="Claude Code project folders or .jsonl files")
    ap.add_argument("--author", required=True)
    ap.add_argument("--tz", type=int, default=8, help="hours from UTC for the times shown (default 8)")
    ap.add_argument("--since", help="first local time to include, e.g. 2026-09-01T00:00")
    ap.add_argument("--until", help="local time to stop before, e.g. 2026-11-08T22:06")
    a = ap.parse_args()
    zone = dt.timezone(dt.timedelta(hours=a.tz))
    since = dt.datetime.fromisoformat(a.since).replace(tzinfo=zone) if a.since else None
    until = dt.datetime.fromisoformat(a.until).replace(tzinfo=zone) if a.until else None
    sys.stdout.write(render(load(a.paths), a.author, a.tz, since, until))


if __name__ == "__main__":
    main()
