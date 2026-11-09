<!--
AI Assistance Disclosure:
Tool: Claude Code (model: claude-opus-5-5), date: 2026-11-08
Scope: Generated this template for members to fill up.
Author review: Jonus checked the entries and the redactions before committing.
-->

# AI usage log

This is the team's shared log under the course's AI Usage Policy (Appendix 2 of the project
document). The summary is the last section of the [README](../README.md#ai-use-summary).

## What is in here

- **Key prompts.** Exported key decision prompts and learning so each member quotes about 20 key
  prompts, exported from their own Claude Code transcripts with
  [`export-claude-code-log.py`](export-claude-code-log.py).
  - Each section also counts all of that member's prompts by use, so the scale is still shown.
  - Prompts are quoted exactly. Pasted text, screenshots, email addresses and secrets are replaced
    with placeholders.
- **Key responses.** The start of Claude's last message in each quoted turn.
- **AI-assisted commits.** Commits on `main` with a `Co-Authored-By: Claude …` trailer, grouped by
  the ticket or area their subject names. They show when, and on what, each member used AI. They
  undercount: Jonus's commits stopped carrying the trailer after 23 Oct, so they understate his
  later use.

Commit counts leave out merge commits and are taken from `main` at `646c67e` (8 Nov 2026).

## Summary

| Member         | Tools                                    | AI-assisted commits on `main` | Prompts here |
| -------------- | ---------------------------------------- | ----------------------------- | ------------ |
| Jonus Ho       | Claude Code; GitHub Copilot coding agent | 37 of 140                     | 20 key       |
| Anselm Long    | Claude Code                              | 91 of 105                     | to be added  |
| Isaac Chua     | Claude Code                              | 50 of 96                      | to be added  |
| Patrick Thomas | Claude Code                              | 57 of 79                      | to be added  |
| Zhang Yuan     | Claude Code                              | 54 of 55                      | 20 key       |

## Adding your prompts

1. Find your transcripts: `ls ~/.claude/projects/ | grep foc-app`.
2. Export them all once, to see each prompt and its time:
   `python3 ai/export-claude-code-log.py --author "Your Name" ~/.claude/projects/<that folder> > /tmp/all.md`.
3. Choose about 20 key prompts that show how you used AI, and export just those:
   `python3 ai/export-claude-code-log.py --author "Your Name" --pick 2026-10-01T14:05,2026-10-03T09:30 ~/.claude/projects/<that folder> > /tmp/my-section.md`.
   Include any prompt that comes close to the policy's limits (requirements, planning, design).
4. Read the output. Check the placeholders, and that nothing personal or secret is left.
5. Paste it under your heading, in place of "Prompts: to be added", then run
   `npx prettier --write ai/usage-log.md`.

If you also used another tool, such as ChatGPT or Copilot, add those prompts by hand in the same
format: the time, the use, the exact prompt in a `text` block, and the key response.

## Jonus Ho

- **Tools:** Claude Code (Anthropic), in the terminal and the desktop app. GitHub Copilot coding
  agent made two merge commits: `783dbc1` (23 Sep) and `020702f` (14 Oct).
- **AI-assisted commits on `main`:** 37 of 140. Models named in their trailers:
  Claude Opus 5.5 (34), Claude Opus 5 (3).

### Key prompts

20 key prompts, picked by Jonus from their 610 Claude Code prompts between 7 Sep 2026 and 8 Nov 2026.

| All 610 prompts, by use (tagged by keyword)               | Prompts |
| --------------------------------------------------------- | ------- |
| Routine: approvals, push and merge notices, status checks | 285     |
| Documentation and slides                                  | 73      |
| Implementation                                            | 65      |
| Review and verification                                   | 39      |
| Requirements and planning (topic)                         | 36      |
| Learning / explanation                                    | 33      |
| Debugging                                                 | 33      |
| Release and PR workflow                                   | 20      |
| General request                                           | 16      |
| Design and decisions (topic)                              | 7       |
| Testing                                                   | 3       |

#### Tue 8 Sep 2026

**11:52** · Learning / explanation · `main` · claude-opus-5

```text
help me understand this project run me thru every detail so i understand what im supposed to do check the @project-instructions folder
```

> **Key response:** I read all four documents and the repo. Here's the full picture. --- 1. What you're building **Friend on Campus (FoC)** — a peer-to-peer campus errand platform. A **requester** posts an errand ("bring my prints from PC Commons to PGP"), picking a supplier/location and delivery details.

#### Thu 10 Sep 2026

**09:47** · Learning / explanation · `main` · claude-opus-5

```text
for n4 explain to me how the caching works, also how the dependency scan is done
```

> **Key response:** Caching The problem it solves Every CI run starts on a blank machine — nothing installed. So `npm ci` (or `pip install`, or `go mod download`) has to fetch every package from the internet. For one Node service that's a few hundred packages, maybe 60–90 seconds.

#### Sun 20 Sep 2026

**10:08** · Learning / explanation · `main` · claude-opus-5

```text
its okay, can u help me with [PLT-01] Monorepo scaffold and service template
 #115
read thru @docs/CS3219-ProjectDocument-FoC.pdf  and @docs/EXECUTION-PLAN.md

run me thru waht u plan to do first before starting, analyse and be as meticulous as possible
```

> **Key response:** PLT-01 is done and up: **https://github.com/AY2627S1-CS3219-P30/foc-app/pull/174** All four acceptance criteria verified, not just asserted: [table] Plus all four images build, run as `uid=1000(node)`, report `healthy`, and shut down cleanly on SIGTERM — 186 MB each.

**10:32** · Documentation and slides · `feat/PLT-01-service-scaffold` · claude-opus-5

```text
so is this to set up the project on local? so other ppl can set it up? if so can u put/modify our readme to add instructions on how to set it up?
```

> **Key response:** Yes — that's exactly what PLT-01 is for, and writing the setup guide caught **two bugs that would have hit every teammate on day one**: **`npm run dev:*` didn't work at all.** It used `-r ts-node/register`, a CommonJS loader, which can't load this ESM workspace — it failed with `Unknown file extension ".ts"`.

#### Sat 26 Sep 2026

**17:34** · Learning / explanation · `main` · claude-opus-5-5

```text
i just merged anselms prs into main actually how do i run it, or is there no frontend built yet, or what can i start up first
```

> **Key response:** There is a frontend, but it's the clickable prototype running on hard-coded data. It doesn't call any service yet. What works end to end today is the user-service API, so start the stack in Docker and try it with `curl`.

#### Thu 1 Oct 2026

**10:53** · Review and verification · `main` · claude-opus-5-5

```text
check latest main do i have to rebuild my database
```

> **Key response:** Yes, the rebuild worked. Your stack is up on fresh databases and healthy: - **Migrations:** all three migrate containers exited with 0, and each database has its Drizzle migrations recorded: 2 for users, 2 for suppliers, 4 for credit.

#### Thu 8 Oct 2026

**15:02** · Review and verification · `feat/ADM-admin-controls` · claude-opus-5-5

```text
help me review this pr feat(order): list the caller's errands at GET /orders/mine- #225
#225
```

> **Key response:** **[#225](https://github.com/AY2627S1-CS3219-P30/foc-app/pull/225) looks good to merge.** It's a small, focused PR by Zhang Yuan (`volleyballkickedme`): 9 files, +156 lines. CI is green and it merges cleanly. Nothing I found blocks it. What's right about it:

**16:55** · Documentation and slides · `feat/ADM-admin-controls` · claude-opus-5-5

```text
okay the comments are addressed, double check if all good ill merge
```

> **Key response:** It's all good, so you can merge. CI is green on the new head (`6d795d8`), the PR merges cleanly, and every comment was properly addressed: [table] The PR still has no approving review, only my "Comment" review.

#### Tue 20 Oct 2026

**15:59** · Implementation · `main` · claude-opus-5-5

```text
Do this task here: “Narrow the token-example allowlist in .gitleaks.toml”
```

> **Key response:** The narrowed allowlist is built and tested. I've saved it as a patch on `main` rather than applying it, because the #247 fix is still uncommitted in this checkout, and it stays out of #247.

**17:27** · Documentation and slides · `main` · claude-opus-5-5

```text
do the dry run and update the runbook
```

> **Key response:** The degraded page and "Try again" recovery work on today's `main`. Two more checks: the Wallets tab, which Isaac can use for "balances before and after", and the optional RabbitMQ step.

#### Wed 21 Oct 2026

**17:29** · Review and verification · `main` · claude-opus-5-5

```text
https://github.com/AY2627S1-CS3219-P30/foc-app/pull/259

can u review this pr
```

> **Key response:** **[#259](https://github.com/AY2627S1-CS3219-P30/foc-app/pull/259) looks good to merge.** It's Patrick's WEB-04, connectivity and conflict recovery: one commit, +512 lines, CI green, and it merges cleanly with `main` (it's 11 commits behind, so it needs a branch update first). Nothing blocks it; three minor notes.

#### Thu 22 Oct 2026

**09:26** · Release and PR workflow · `main` · claude-opus-5-5

```text
help me do up ticket 271 then gimme the commit commands
```

> **Key response:** 271 is done on branch `feat/271-referred-errands`, ready for you to commit. **The cause, confirmed:** the backend for disputes has existed since #229, but the console never used it. The Errands page still had a placeholder ("Arrives with ORD-11"), and nothing called the list or decision endpoints.

**12:28** · Implementation · `feat/271-referred-errands` · claude-opus-5-5

```text
what did this command do
./scripts-demo-journey.sh --stage
```

> **Key response:** It deliberately creates the one failed message (a "dead letter") that you redrive live in Part 3.4. It does this by cutting the Credit Service off from its database while a student activates, for longer than Credit keeps retrying. It doesn't stop any container.

#### Fri 23 Oct 2026

**11:09** · Debugging · `feat/166-load-harness` · claude-opus-5-5

```text
i pushed alrdy but i found this also ticket #296 failed

[pasted text, 6 lines]

resolve these issues and the comments before proceeding and tell me what has been done alrdy for resolving patricks comments
```

> **Key response:** I've fixed the #296 failure, but you need to commit and push it. Why #296 failed The gate this PR adds did its job. Two critical advisories, both fixed in 16.4.1, were published for the Next.js version the PR had bumped to (16.3.8):

#### Tue 27 Oct 2026

**09:21** · Debugging · `feat/166-load-harness` · claude-opus-5-5

```text
my ticket 267 failed the browser journey ci and also that one takes very long
```

> **Key response:** The six hours wasn't #297's code. In normal runs this job takes about 6 minutes: [table] The problem is that one install step: it depends on Ubuntu's package mirrors, and nothing bounds it. **To unblock #297 now,** rerun only the cancelled job. Its code had already passed every other check:

#### Thu 29 Oct 2026

**01:24** · Implementation · `feat/330-edge-live` · claude-opus-5-5

```text
start the seed attribution and fresh clone walkthrough
```

> **Key response:** Both #168 items are ready to commit on `docs/168-attribution-walkthrough`. Only `README.md` changes. **Seed data attribution:** a new **Seed data** section next to the image licences. `supplier-seed-data.csv` and the six photos are the course template's, `CS3219-AY2627S1/FoC-Template` (MIT).

#### Sat 7 Nov 2026

**22:22** · Release and PR workflow · `fix/369-370-371-socket-follow-ups` · claude-opus-5-5

```text
[pasted text, 10 lines]



can i push the rc1 now ior is the run on mian not finished
```

> **Key response:** Still running. The run says `in_progress`, and there's no publish line because "Publish images" hasn't started yet. It only shows up once the `ci` gate job passes. Since you last checked, the core and resilience smoke tests have finished.

#### Sun 8 Nov 2026

**17:17** · Learning / explanation · `main` · claude-opus-5-5

```text
isnt there an out and inbox for the services? do they live in rabbitmq or in the db of each service
```

> **Key response:** They're tables in each service's own PostgreSQL database, not in RabbitMQ. RabbitMQ only carries an event between the sender's outbox and the receiver's inbox. **Who has what** (`platform/src/events/` defines the tables, and each service creates them in its own migrations):

**18:06** · Learning / explanation · `main` · claude-opus-5-5

```text
can u run me thru the demo and tell me how to do it myself i want to try it step by step now, so i guess u can start it up here then give me the steps
```

> **Key response:** None of your five windows is signed in yet. The edge log shows the only sign-ins happened at 18:07, when the seed itself ran. Since then the tabs have only had their session refreshes refused (54 of them), which is what a signed-out tab does.

**18:45** · Debugging · `main` · claude-opus-5-5

```text
okay im done stop the running stuff also found this frotnend error
[1 screenshot attached]
```

> **Key response:** I've fixed both bugs on a new branch, `fix/ledger-audit-checklist`. The full web-app suite passes (549 tests, 5 skipped), and lint and the type check are clean. I haven't looked at the fixed pages in a browser yet. **Stopped:** the demo stack, the five demo Chrome windows and my browser tab.

## Anselm Long

- **Tool:** Claude Code (Anthropic). Models named in commit trailers: Claude Opus 5.5 (54), Claude Opus 5.5 (1M context) (21), Claude Sonnet 5 (16).
- **AI-assisted commits on `main`:** 91 of 105.
- **Prompts:** to be added by Anselm. See [Adding your prompts](#adding-your-prompts).

### AI-assisted commits

| Work (ticket or scope in the subject) | Commits | Dates           | Example                                                                                                      |
| ------------------------------------- | ------- | --------------- | ------------------------------------------------------------------------------------------------------------ |
| no ticket or scope                    | 5       | 15 Sep – 4 Nov  | `58ca86a` ci: cache Playwright browsers                                                                      |
| scope `user-service`                  | 15      | 20 Sep – 4 Nov  | `b6127ac` fix(user-service): reject unknown audit-record filters                                             |
| scope `contracts`                     | 3       | 20 Sep – 13 Oct | `2b86dbb` style(contracts): format README                                                                    |
| USR-02                                | 1       | 20 Sep          | `69959e2` feat(user-service): login, refresh-token rotation and logout (USR-02)                              |
| USR-01                                | 1       | 20 Sep          | `bfb2660` feat(user-service): registration, one-time activation and identity lookup (USR-01)                 |
| USR-06                                | 1       | 21 Sep          | `6f7f357` feat(auth-client): shared auth middleware for the other services (USR-06)                          |
| USR-03                                | 1       | 21 Sep          | `7846cf1` feat(user-service): RBAC, profile edits and admin controls (USR-03)                                |
| scope `auth-client`                   | 1       | 21 Sep          | `7861357` fix(auth-client): a new status or role is an authorization outcome, not an outage                  |
| scope `web-app`                       | 15      | 13 Oct – 4 Nov  | `3144dd4` feat(web-app): log out from the desktop sidebar                                                    |
| #238                                  | 2       | 27 Oct – 3 Nov  | `091b9b8` docs(adr): record Anselm's approval of ADRs 0002–0009 (#238)                                       |
| USR-11                                | 1       | 27 Oct          | `27c3319` fix(user-service): answer the four who-may-act refusals with 403 (USR-11)                          |
| USR-09                                | 2       | 27 Oct – 29 Oct | `840a079` feat(user): real activation email, resend, and no token on an open route (USR-09)                  |
| scope `platform`                      | 1       | 27 Oct          | `9d7eea0` chore(platform): remove the Vercel deploy and declare local Compose as the D4 deployment           |
| NTH-03                                | 1       | 3 Nov           | `0e656b4` feat(chat): admin read-only access, message limits and 90-day retention (NTH-03, #163)             |
| #346                                  | 11      | 3 Nov – 4 Nov   | `d247fdc` refactor(chat): drop the socket's unread sessionId (#346)                                          |
| scope `order`                         | 1       | 3 Nov           | `5e6aa8e` fix(order): pin each chat lookup status, and say when a suspended courier keeps the channel        |
| scope `recovery`                      | 1       | 3 Nov           | `781ad8c` fix(recovery): say how a pre-chat backup's volume gets foc_chat                                    |
| scope `scripts`                       | 1       | 3 Nov           | `8349aa2` fix(scripts): give chat its own port in the demo, e2e and load stacks                              |
| scope `chat`                          | 8       | 3 Nov – 4 Nov   | `0b5768b` fix(chat): refuse an end time that is not a date-time                                              |
| #166                                  | 2       | 3 Nov           | `ac5ba59` docs: correct the LCP exception's reasoning; note the clean release run (#166)                     |
| scope `user`                          | 1       | 3 Nov           | `d96d17b` fix(user): build the reset link without a trailing slash's help, and record what reset leaves open |
| #309                                  | 11      | 3 Nov – 6 Nov   | `bd0594b` fix(web-app): point a refused sign-in to activation (#309)                                         |
| scope `compose`                       | 2       | 4 Nov           | `297da3b` fix(compose): forward chat's retention settings                                                    |
| scope `adr`                           | 1       | 4 Nov           | `8895c30` docs(adr): record that chat's admin reads are recorded                                             |
| scope `smoke`                         | 1       | 4 Nov           | `c1c54f1` fix(smoke): send a random Sec-WebSocket-Key, not RFC 6455's sample                                 |
| USR-12                                | 1       | 5 Nov           | `7adcb9e` feat(user): set the password at activation (USR-12, #309)                                          |

## Isaac Chua

- **Tool:** Claude Code (Anthropic). Models named in commit trailers: Claude Opus 5.5 (50).
- **AI-assisted commits on `main`:** 50 of 96.
- **Prompts:** to be added by Isaac. See [Adding your prompts](#adding-your-prompts).

### AI-assisted commits

| Work (ticket or scope in the subject) | Commits | Dates          | Example                                                                                  |
| ------------------------------------- | ------- | -------------- | ---------------------------------------------------------------------------------------- |
| scope `order`                         | 22      | 1 Oct          | `f9483b5` feat(order): add append-only operator alerts migration                         |
| no ticket or scope                    | 7       | 1 Oct          | `b6445fa` docs: format PR context table                                                  |
| scope `reports`                       | 1       | 1 Oct          | `18388e9` docs(reports): add the 2026-10-01 credit conservation report                   |
| CRD-07                                | 1       | 1 Oct          | `2c21c11` feat(order): reconcile workflows stuck waiting on Credit (CRD-07)              |
| scope `system`                        | 2       | 1 Oct – 26 Oct | `02551b2` test(system): Order's largest reward and Credit's limits agree                 |
| #152                                  | 2       | 1 Oct          | `bd1968e` docs: refresh PR context with live blocker audit for #152, #165, #172          |
| NTH-05                                | 1       | 1 Oct          | `919128f` test(system): property, race, fault-matrix and broker replay evidence (NTH-05) |
| #165                                  | 1       | 1 Oct          | `a05e066` docs: mark #165 merged in PR context                                           |
| scope `test-harness`                  | 2       | 1 Oct          | `ad378b1` test(test-harness): prove isolation without mutating append-only tables        |
| #211                                  | 1       | 1 Oct          | `c6b40cd` docs: record owner-directed gate PRs #211-#215 in PR context                   |
| CRD-09                                | 4       | 20 Oct         | `94eaad7` feat(credit): make the initial allocation configuration (CRD-09)               |
| #234                                  | 1       | 20 Oct         | `b13293c` docs: refresh PR context for #234, #238 and the merges since 15 Oct            |
| scope `credit`                        | 2       | 26 Oct         | `c9fdb07` refactor(credit): state the economy invariants once, and check them live       |
| scope `platform`                      | 1       | 26 Oct         | `336653f` fix(platform): stack scripts read what the service issued, not .env            |
| #238                                  | 1       | 26 Oct         | `85a102c` docs(adr): record Isaac's approval of ADRs 0002–0009 (#238)                    |
| #160                                  | 1       | 28 Oct         | `1a36c6d` docs: record #160 merged and the remaining #167 gates                          |

## Patrick Thomas

- **Tool:** Claude Code (Anthropic). Models named in commit trailers: Claude Opus 5.5 (1M context) (46), Claude Opus 4.8 (1M context) (11), Claude Fable 5.1 (1).
- **AI-assisted commits on `main`:** 57 of 79.
- **Prompts:** to be added by Patrick. See [Adding your prompts](#adding-your-prompts).

### AI-assisted commits

| Work (ticket or scope in the subject) | Commits | Dates           | Example                                                                                    |
| ------------------------------------- | ------- | --------------- | ------------------------------------------------------------------------------------------ |
| SUP-01                                | 5       | 28 Sep – 30 Sep | `619b021` SUP-01: parse seed CSV with papaparse                                            |
| scope `db`                            | 4       | 30 Sep – 1 Oct  | `0cb90a2` fix(db): address review findings on the Drizzle migration                        |
| no ticket or scope                    | 3       | 30 Sep – 22 Oct | `31e24ec` fix: address Active requests rename review comments                              |
| SUP-02                                | 2       | 30 Sep – 1 Oct  | `23e2792` fix(supplier-service): address SUP-02 review feedback                            |
| WEB-00                                | 2       | 30 Sep – 1 Oct  | `5bf0299` fix(web-app): harden API clients, form primitives and review follow-ups (WEB-00) |
| scope `platform`                      | 1       | 30 Sep          | `573e113` refactor(platform): retire the bespoke runMigrations runner                      |
| scope `smoke`                         | 1       | 1 Oct           | `247f9e9` fix(smoke): count cleanly exited one-shot containers as ready                    |
| scope `supplier-service`              | 1       | 1 Oct           | `f2f7cc4` fix(supplier-service): cap Idempotency-Key length; document DELETE retry         |
| scope `web`                           | 6       | 13 Oct – 4 Nov  | `b6609a3` test(web): cover supplier page flows                                             |
| WEB-01                                | 3       | 20 Oct – 21 Oct | `16f0d5b` feat(web-app): request composer on the Order API (WEB-01)                        |
| SUP-04                                | 3       | 20 Oct – 21 Oct | `c2fc556` feat(web-app): supplier picker and deletion hold (SUP-04)                        |
| scope `order`                         | 4       | 21 Oct          | `92f4359` docs(order): rewrap the discovery paragraph in the README                        |
| scope `web-app`                       | 9       | 21 Oct          | `639d2f9` fix(web-app): word errand status for each part in it                             |
| scope `credit`                        | 1       | 21 Oct          | `bafcccc` feat(credit): say how each ledger row changed the wallet's total                 |
| WEB-04                                | 3       | 21 Oct          | `e3d7e6c` fix(web-app): address WEB-04 review notes                                        |
| WEB-02                                | 1       | 21 Oct          | `df4abb1` feat(web-app): take errands from post to paid in the app (WEB-02, WEB-05)        |
| WEB-03                                | 1       | 22 Oct          | `2d288b6` feat(web-app): show real order history, receipts and wallet (WEB-03)             |
| #264                                  | 3       | 27 Oct – 29 Oct | `bb47b83` fix(web-app): say when order updates pause, and resume on refresh (#264)         |
| #238                                  | 2       | 29 Oct          | `f62ae7c` docs: record Patrick's ADR approval in the project context (#238)                |
| #344                                  | 1       | 29 Oct          | `c64918f` docs(chat): agree N1.2 design in ADR 0012 and the chat contract (#344)           |
| scope `e2e`                           | 1       | 4 Nov           | `59e31b9` test(e2e): send delivery instructions when the chat journey creates its errand   |

## Zhang Yuan

- **Tool:** Claude Code (Anthropic). Models named in commit trailers: Claude Opus 5.5 (54).
- **AI-assisted commits on `main`:** 54 of 55.
- **Prompts:** 20 key prompts, below. Zhang's Claude Code transcripts on their machine start on
  12 Oct 2026, so the AI-assisted commits from 30 Sep to 8 Oct have no prompts here.

### Key prompts

20 key prompts, picked by Zhang Yuan from their 249 Claude Code prompts between 12 Oct 2026 and 7 Nov 2026.

| All 249 prompts, by use (tagged by keyword)               | Prompts |
| --------------------------------------------------------- | ------- |
| Routine: approvals, push and merge notices, status checks | 46      |
| Implementation                                            | 42      |
| Review and verification                                   | 41      |
| Learning / explanation                                    | 35      |
| Documentation and slides                                  | 26      |
| General request                                           | 26      |
| Release and PR workflow                                   | 15      |
| Debugging                                                 | 8       |
| Design and decisions (topic)                              | 6       |
| Testing                                                   | 2       |
| Requirements and planning (topic)                         | 2       |

#### Wed 14 Oct 2026

**18:54** · Learning / explanation · `main` · claude-opus-5-5

```text
https://github.com/AY2627S1-CS3219-P30/foc-app/pull/229. Work with me to review the comments on this PR. Explain what is wrong with each one
```

> **Key response:** I went through all 9 inline comments from jonushzw against the code. The review was left on `233bcad`, which is still the branch head, so every comment applies to the current code. Each one below covers what's wrong, whether I agree, and the smallest fix. --- 1.

**19:15** · Learning / explanation · `feat/171-admin-referral-decision` · claude-opus-5-5

```text
explain what the empty admin list does to existing referrals, and explain waht the existing referrals are.
```

> **Key response:** What an existing referral is A referral is the single administrator assigned to decide a disputed errand. It is stored on the order row as `referred_admin_id`. The scheduler sets it with an `ADMIN_ASSIGNED` transition, and that one value decides who can act:

**19:18** · Learning / explanation · `feat/171-admin-referral-decision` · claude-opus-5-5

```text
explain thie interaction between order and user service in this scenario end to end
```

> **Key response:** Two separate channels connect the services, and in this scenario they work independently: - **Scheduler channel:** the Order Service's scheduler polls the User Service for "who may act". This is the channel that clears referrals.

**19:21** · Learning / explanation · `feat/171-admin-referral-decision` · claude-opus-5-5

```text
i follow until point 6. Once i hvae this list of admins, how are the errands assigned to an admin?
```

> **Key response:** From step 6, the scheduler has the list of admins who can act, say `[A, B, C]`. It then handles each dispute that needs an admin, one at a time. All the steps below run in the Order Service against its own database; the User Service isn't called again during the run. 7.

**19:24** · Implementation · `feat/171-admin-referral-decision` · claude-opus-5-5

```text
is it becauyse with an empty list, all admins are not in the list, therefore all the tasks belong to someone not in the list and people who are not in the list do not have a right to act on disputes?
```

> **Key response:** Yes, that's it. The scheduler's rule is "not on the list means can't act". An empty list has nobody on it, so every admin holding a dispute counts as unable to act, and every referral gets cleared. One correction: the list doesn't decide who has the right to act. The real check happens on every request.

**19:25** · Learning / explanation · `feat/171-admin-referral-decision` · claude-opus-5-5

```text
what are the implications if i make the method do nothing if an empty list is returned from user service
```

> **Key response:** Doing nothing on an empty list is safe for existing referrals, but you lose the alert for the case where nobody at all can take disputes. The change would be: [code block] **What you gain** - **Existing referrals are never wiped by one bad response.** That's the same protection as the SQL guard, but it's visible in …

**19:26** · Learning / explanation · `feat/171-admin-referral-decision` · claude-opus-5-5

```text
what is the difference between this and the SQL guard
```

> **Key response:** Both leave existing referrals alone when the list is empty, recover the same way on the next good list, and still clear on a partial list. The only real difference is what happens to disputes that have no admin yet while the list is empty.

**19:28** · Learning / explanation · `feat/171-admin-referral-decision` · claude-opus-5-5

```text
what about this permanent alert row?
```

> **Key response:** First a correction: I said the SQL guard's alerts would show on the operator dashboard in #228. I checked, and they wouldn't. Nothing reads `REFERRAL_UNASSIGNED` rows: not this PR, and not #228, whose diff never mentions the alerts table.

#### Thu 15 Oct 2026

**11:32** · Learning / explanation · `feat/171-admin-referral-decision` · claude-opus-5-5

```text
the issue is the value of the column at the moment that the issue is escalated to admin?
```

> **Key response:** Yes. `delivered_at` doesn't change once the errand is escalated. The courier can only record a delivery from `PICKED_UP` (`order-state-machine.ts:177`), and nothing in `DISPUTED` sets it. So whatever the column holds at escalation is what the receipt gets. Which state the errand was escalated from decides it:

**11:38** · Implementation · `feat/171-admin-referral-decision` · claude-opus-5-5

```text
what if the delivered_at time is changed to the time of escalation while waiting for the admin decision, and then changed to decision time after the admin makes the decision
```

> **Key response:** That ends with the same receipt as today, but it adds stored data that's false, more code, and a new problem on the cancel path. Here's what each stage would hold, for a dispute raised from `PICKED_UP`: [table] **What the receipt gets:** the decision time, which is exactly what it publishes now.

**11:39** · Implementation · `feat/171-admin-referral-decision` · claude-opus-5-5

```text
why cant i just change the delivered_at column to be nullable
```

> **Key response:** You can, and it's already done for the database. Migration `0010` makes `order_receipts.delivered_at` nullable, and `orders.delivered_at` was always nullable. The stored receipt does hold `NULL` for these errands. What you can't make nullable is the API field:

#### Mon 19 Oct 2026

**12:09** · Design and decisions (topic) · `feat/232-order-d3-evidence` · claude-opus-5-5

```text
Record my approval in docs/adr/README.md dated today, on a branch from origin/main with a PR. Raise the three ADR 0005/0006 mismatches as a comment on #238 for Isaac and Jonus. Then move on to #233.
```

> **Key response:** 238 is done on my side, and #233 is built but not committed. **#238.** [#246](https://github.com/AY2627S1-CS3219-P30/foc-app/pull/246) records your approval, dated 2026-10-19.

#### Wed 21 Oct 2026

**11:31** · Debugging · `main` · claude-opus-5-5

```text
bun dev doesnt work
```

> **Key response:** `bun dev` works on this machine. I ran it from `web-app/`, it was ready in about 350 ms, and http://localhost:3000 returned 200. I've stopped my copy, so port 3000 is free for you. The likely reason the app looks broken is that **the backends aren't running**.

**11:41** · Learning / explanation · `main` · claude-opus-5-5

```text
what is blocking me from being able to demonstrate order and credit service functionality using the frontend
```

> **Key response:** Nothing on the backend is blocking you. The Order and Credit services, and the parts of the web app's API client that call them, are already on `main`. What's missing is the student screens that use them. There are three layers. **1.**

**16:03** · Learning / explanation · `main` · claude-opus-5-5

```text
Does this logic already exist in Order Service?
```

> **Key response:** Yes. The Order Service on `main` already decides and stores the reason. The only thing missing was returning it. **Already on `main`:** - **Deciding it:** each rule in `order-state-machine.ts` that moves an errand into `RELEASE_PENDING_CREDIT` sets `releaseReason`.

**16:04** · Learning / explanation · `main` · claude-opus-5-5

```text
what is blocking this PR from being approved
```

> **Key response:** Nothing is stopping you from approving #257. What's stopping it from merging is the 5 comments I left on it, which are still open. **What the `main` branch rules require:** - **Passing CI:** it passes. - **Branch up to date with `main`:** it is. - **Approvals:** none are required.

**16:07** · Learning / explanation · `main` · claude-opus-5-5

```text
what is the suspension gap
```

> **Key response:** The Order Service tries to hide from the other participant on an errand that someone was suspended, but students can still work it out. **What it's meant to do** When a suspension changes an errand, the status history keeps the real entry: for example, action `REQUESTER_SUSPENDED` with reason "requester suspended".

**16:08** · Documentation and slides · `main` · claude-opus-5-5

```text
File Issue under as an Order Service gap, assigned to me. Approve this PR and change the inline comments to a PR commet
```

> **Key response:** I filed the issue, moved the comments, and approved #257, which can now merge. - **Issue:** I filed [#260](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/260), "Order Service gap: a participant can still tell the other was suspended".

#### Thu 22 Oct 2026

**00:00** · Testing · `pastchum/web-02-to-web-05-assess` · claude-opus-5-5

```text
start up the app. I wnat to try an end to end test of the Order Service functionality
```

> **Key response:** The stack is up on PR #262's code, every container reports healthy, and `./scripts-smoke.sh` passes all its checks. The other containers were already built from the same code, so only order-service and web-app were rebuilt. Your data was kept. **To try the Order Service end to end in the browser** 1.

**13:04** · Review and verification · `main` · claude-opus-5-5

```text
1. Requester should not accept their own orders
2. Unrelated users cannot update an order
3. Same student can simultaneously request errands and fulfill others errands, showing that a student can be both a requester and a couriter
4. Negative credit check
5. When a courier withdraws the order goes back to open.


Give me the curl commands to run on zshell to show this
```

> **Key response:** I ran these twice against your local stack and every step returned the expected result. Paste the setup block into zsh first, then each numbered block in order (each block uses the IDs and versions left by the one before). You need `jq`, which you already have.

### AI-assisted commits

| Work (ticket or scope in the subject) | Commits | Dates           | Example                                                                                          |
| ------------------------------------- | ------- | --------------- | ------------------------------------------------------------------------------------------------ |
| scope `order-service`                 | 1       | 30 Sep          | `c6c5d4f` docs(order-service): align the order state model with D1 and document its integrations |
| scope `order`                         | 27      | 8 Oct – 21 Oct  | `8588ebd` test(order): bind the test server to 127.0.0.1                                         |
| scope `web-app`                       | 3       | 12 Oct – 15 Oct | `233bcad` chore(web-app): regenerate the User Service client for GET /internal/admins            |
| scope `user`                          | 2       | 12 Oct – 15 Oct | `34382b2` feat(user): list active administrators at GET /internal/admins                         |
| #171                                  | 2       | 12 Oct – 15 Oct | `8724815` docs: record #171's migration as 0011                                                  |
| #170                                  | 1       | 13 Oct          | `535f573` feat(order): requester reports and auto-confirmation (#170)                            |
| scope `contracts`                     | 2       | 16 Oct – 19 Oct | `f508757` docs(contracts): add Patrick as a reviewer of the receipt change                       |
| ORD-06                                | 1       | 16 Oct          | `aee0890` feat(order): act on a participant's suspension (ORD-06)                                |
| scope `platform`                      | 1       | 17 Oct          | `3831879` test(platform): expect the user-suspensions dead-letter queue in the smoke run         |
| ORD-14                                | 1       | 19 Oct          | `1c15c98` style: format the ORD-14 context entry with Prettier                                   |
| scope `adr`                           | 1       | 19 Oct          | `1cde24a` docs(adr): record Zhang Yuan's approval of ADRs 0002–0008                              |
| #162                                  | 1       | 30 Oct          | `1eba94b` chore(web-app): regenerate the Order types for the implemented chat lookup (#162)      |
| NTH-02                                | 2       | 30 Oct          | `77a5a08` feat(order): serve the Chat Service's lookup (NTH-02, #162)                            |
| NTH-11                                | 1       | 30 Oct          | `8d24ed5` feat(chat): wire the fifth service into the stack (NTH-11, #345)                       |
| #276                                  | 3       | 3 Nov – 4 Nov   | `30e1ed8` feat(web-app): show the items on an errand's receipt (#276)                            |
| #268                                  | 3       | 3 Nov – 4 Nov   | `27064cf` fix(order): re-project a replayed command and key admin decisions (#268)               |
| #238                                  | 1       | 4 Nov           | `0c48cde` docs(adr): record Zhang Yuan's approval and accept ADRs 0007 and 0009 (#238)           |
| #392                                  | 1       | 7 Nov           | `415a439` fix(platform): connect to the broker with Nagle off (#392)                             |
