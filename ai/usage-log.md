<!--
AI Assistance Disclosure:
Tool: Claude Code (model: claude-opus-5-5), dates: 2026-11-08 to 2026-11-09
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
| Anselm Long    | Claude Code                              | 96 of 110[^claude]            | 20 key       |
| Isaac Chua     | Claude Code                              | 50 of 96                      | to be added  |
| Patrick Thomas | Claude Code                              | 57 of 79                      | 20 key       |
| Zhang Yuan     | Claude Code                              | 54 of 55                      | 20 key       |

[^claude]:
    Including 5 commits authored as `Claude` on Anselm's User Service tickets (USR-03, USR-05,
    USR-06, USR-07, USR-08), so the rows add up to the 294 the README gives.

## Adding your prompts

1. Find your transcripts: `ls ~/.claude/projects/ | grep foc-app`. Each checkout, worktree and
   Conductor workspace has a folder of its own, so there may be many. Pass them all.
2. Export them all once, to see each prompt and its time:
   `python3 ai/export-claude-code-log.py --author "Your Name" ~/.claude/projects/*foc-app* > /tmp/all.md`.
   Claude Code deletes old transcripts, after 30 days unless you changed `cleanupPeriodDays`. If
   your earliest prompts are gone, say which period your count covers.
3. Choose about 20 key prompts that show how you used AI, and export just those:
   `python3 ai/export-claude-code-log.py --author "Your Name" --pick 2026-10-01T14:05,2026-10-03T09:30:41 ~/.claude/projects/*foc-app* > /tmp/my-section.md`.
   A minute picks the first prompt in it; add the seconds from the full export to pick another.
   Include any prompt that comes close to the policy's limits (requirements, planning, design).
4. Read the output. Check the placeholders, and that nothing personal or secret is left. The
   exporter replaces email addresses, credentials in URLs, private keys, common token formats and
   values named like `password`, `secret`, `token` or `api_key`, but it can't recognise every
   secret, so this check is the one that counts.
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

20 key prompts, picked by Jonus from their 619 Claude Code prompts between 7 Sep 2026 and 8 Nov 2026.

| All 619 prompts, by use (tagged by keyword)               | Prompts |
| --------------------------------------------------------- | ------- |
| Routine: approvals, push and merge notices, status checks | 212     |
| Documentation and slides                                  | 94      |
| Implementation                                            | 86      |
| Debugging                                                 | 45      |
| Review and verification                                   | 41      |
| Requirements and planning (topic)                         | 36      |
| Learning / explanation                                    | 35      |
| Release and PR workflow                                   | 31      |
| General request                                           | 27      |
| Design and decisions (topic)                              | 7       |
| Testing                                                   | 5       |

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
- **Prompts:** Anselm's surviving Claude Code transcripts start on 13 Oct 2026, so the counts below cover 13 Oct to 9 Nov only; earlier sessions (including the September User Service work) are no longer available.

20 key prompts, picked by Anselm from their 69 Claude Code prompts between 13 Oct 2026 and 9 Nov 2026. Exported with `ai/export-claude-code-log.py`. Times are SGT. Models: `claude-opus-5-5`.

| All 69 prompts, by use (tagged by keyword)                | Prompts |
| --------------------------------------------------------- | ------- |
| Learning / explanation                                    | 28      |
| Implementation                                            | 15      |
| General request                                           | 12      |
| Review and verification                                   | 3       |
| Debugging                                                 | 3       |
| Release and PR workflow                                   | 2       |
| Requirements and planning (topic)                         | 2       |
| Design and decisions (topic)                              | 1       |
| Routine: approvals, push and merge notices, status checks | 1       |
| Documentation and slides                                  | 1       |
| Testing                                                   | 1       |

#### Tue 13 Oct 2026

**12:46** · General request · `main` · claude-opus-5-5

```text
brief me on the changes since last milestone
```

> **Key response:** Since D2 (Sprint 1, due 25 Sep), 37 PRs have merged to `main` and 8 are open. I've used D2 as the baseline because Sprint 2 (due 11 Oct) is the most recent milestone that has passed, but nothing has merged since 8 Oct.

**12:48** · Design and decisions (topic) · `main` · claude-opus-5-5

```text
okay looks good so far, can you draw the architecture of this app for now?
```

> **Key response:** Here's the current architecture, based on `compose.yaml`, `postgres-init.sql`, `contracts/events.schema.json` and the consumer wiring in each service: [code block] **Events (`contracts/events.schema.json`)** [code block] **Shared packages** - **`@foc/platform`**:

**13:10** · Learning / explanation · `main` · claude-opus-5-5

```text
whats the audit about
```

> **Key response:** The audit records are the User Service's log of admin actions on accounts: who did what to whom, when, and why. Your PR #230 only adds ways to search that log. Writing to it already existed in USR-03 (#179). What gets recorded Every row in `audit_records` (`user-service/src/db/schema.ts:161`) is one admin action:

**13:15** · Review and verification · `main` · claude-opus-5-5

```text
review responder to my prs
```

> **Key response:** The four #230 fixes are pushed, but CI on the new commits is still running, so I can't call it ready yet. The #231 agent is still working. The agent merged `origin/main` into the branch with no conflicts, so it's no longer behind. It replied in all four review threads and left one summary comment.

#### Thu 5 Nov 2026

**10:05** · Implementation · `main` · claude-opus-5-5

```text
Can you do the FOC app stuff
```

> **Key response:** In option B, the field is optional for one reason: so the CI check doesn't notice. The check, `test-harness/src/compat.ts`, flags only certain kinds of change. Adding an **optional** request field is additive, so it passes.

**11:15** · Learning / explanation · `main` · claude-opus-5-5

```text
whats the root cause?
```

> **Key response:** The root cause is that registration saves a password before anyone has shown they own the email address. Activation only confirms the inbox; it never asks who chose the password. On `main`: - **`register` sets the password.** `users.service.ts:84` hashes `input.password`.

**18:17** · Learning / explanation · `main` · claude-opus-5-5

```text
what are best practices?
```

> **Key response:** **Short version:** the usual guidance agrees with the plan, especially for _when_ the password is [redacted] It adds a few items on how the link behaves, and it changes how I described option B.

**18:28** · Learning / explanation · `feat/309-password-at-activation` · claude-opus-5-5

```text
how should i deploy this on aws?
```

> **Key response:** Run the existing Compose stack on a single EC2 instance, using the images CI already publishes. First, though, check that the team actually wants a hosted deployment. The README says D4 is deployed as local containers on purpose, and that "there is no hosted deployment" (PLT-11, #286).

**18:30** · Learning / explanation · `feat/309-password-at-activation` · claude-opus-5-5

```text
why not one EC2 per container?
```

> **Key response:** You could, but it gives you microservices isolation the hard way. You'd pay more and rebuild things Compose does for you, without gaining much a single host lacks. If you want each service separate, ECS is the AWS tool for that, not one instance per container.

**18:34** · Documentation and slides · `feat/309-password-at-activation` · claude-opus-5-5

```text
draw an ascii diagram of the infra
```

> **Key response:** This is the one-EC2 setup I recommended. The inside of the host follows the README's deployment diagram (`README.md:470`). I've added the AWS pieces around it: Caddy for HTTPS, SES for mail, and S3, SSM and EBS snapshots for backups and access.

**19:24** · Implementation · `feat/309-password-at-activation` · claude-opus-5-5

```text
so what aws services do i need
```

> **Key response:** For the single-EC2 setup, you need five services, plus a few optional ones. **Required** [table] **Strongly recommended** [table] **Optional** - **Route 53** for DNS, about $0.50 a month plus the domain. Any DNS provider works; you just need a name for Let's Encrypt to issue a certificate.

**19:28** · Implementation · `feat/309-password-at-activation` · claude-opus-5-5

```text
eli5 the stack and what i should propose to my team
```

> **Key response:** The stack, explained simply Think of FoC as a small office building. - **The front desk (edge, nginx).** Every visitor comes in through one door, `:3000`. The desk sends each visitor to the right room, turns away anyone asking for staff-only rooms (`/internal` and `/metrics`), and stops anyone who's making too many …

**19:31** · Learning / explanation · `feat/309-password-at-activation` · claude-opus-5-5

```text
whats caddy
```

> **Key response:** Caddy is a small web server that sits in front of your app and handles HTTPS for you, automatically. It's the doorman outside the building. Browsers connect to Caddy over encrypted HTTPS on port 443. Caddy then passes each request to the edge on `127.0.0.1:3000` over plain HTTP inside the machine.

#### Fri 6 Nov 2026

**02:58** · Debugging · `feat/309-password-at-activation` · claude-opus-5-5

```text
can u fix those
```

> **Key response:** Of the three items, I fixed one, CI is rerunning, and two need you. 1. **CI failed, so I fixed that first.** The secret scanner (gitleaks) flagged an example activation token the PR had added to the contract. It's just the text "foc-activation-token-example" in base64, but it matches the scanner's API-key rule.

**03:10** · Implementation · `feat/309-password-at-activation` · claude-opus-5-5

```text
propose a hosting plam
```

> **Key response:** I've written up the hosting proposal as a page: [link removed] The link is private for now. Use the page's Share menu to give your teammates access. The proposal is an optional hosted copy of the D4 release on one EC2 t3.medium instance.

**14:49** · Learning / explanation · `main` · claude-opus-5-5

```text
https://nus-aws-cloud.awsapps.com/start/#/?tab=accounts im using the nus accoutn actually
```

> **Key response:** The wizard now starts properly. Both of your attempts stopped at stage 1 because the `!` prefix gives a script no terminal input. Every prompt got an empty answer at once, and the "is this the right account" check defaulted to no. Nothing was created in AWS. Run it in a separate terminal tab, from the repo root:

**23:17** · Learning / explanation · `main` · claude-opus-5-5

```text
must we have backups?
```

> **Key response:** No. For this copy, backups are optional, and skipping most of stage 14 is reasonable: - **Nothing official runs on it.** The local Compose stack is the official D4 deployment. This server is a convenience link for testers and graders.

**23:19** · Review and verification · `main` · claude-opus-5-5

```text
i can't get emails, can we check that
```

> **Key response:** I can't reach the server, so I'll need you to run three checks and paste me the output. Between them they show whether the problem is in the app's settings, the login to Mail Manager, or what Mail Manager does with the mail afterwards. Run them in the Session Manager tab as `ubuntu`, in `~/foc-app`. **1.**

**23:28** · General request · `main` · claude-opus-5-5

```text
give me a brief for my tream
```

> **Key response:** I've written the team brief as a page: [link removed] It's private for now, so share it from the page's Share menu before you post the link. It uses the same look as your "FoC on EC2" proposal so the two read as a pair. It covers:

**23:34** · Learning / explanation · `main` · claude-opus-5-5

```text
how can my friends modify the server and stuff?
```

> **Key response:** Right now they can't. The only way onto the server is Session Manager, and that goes through your NUS sign-in to an account that is yours alone. You also can't give them AWS logins, because NUS blocks creating IAM users. Most "modifying" doesn't need server access anyway:

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
- **Prompts:** 20 key prompts, below, from the Claude Code transcripts on Patrick's laptop. They
  start on 13 Oct 2026 and cover the 12 AI-assisted commits made on it (13 Oct to 4 Nov). The
  other 45, from 28 Sep to 29 Oct, were made on Patrick's Mac mini (author email
  `patrick@patricks-Mac-mini.local`), whose transcripts are not in this export.

### Key prompts

20 key prompts, picked by Patrick Thomas from their 89 Claude Code prompts between 13 Oct 2026 and 9 Nov 2026. Exported with `ai/export-claude-code-log.py`. Times are SGT. Models: `claude-opus-5-5`.

| All 89 prompts, by use (tagged by keyword)                | Prompts |
| --------------------------------------------------------- | ------- |
| General request                                           | 20      |
| Review and verification                                   | 15      |
| Debugging                                                 | 13      |
| Release and PR workflow                                   | 12      |
| Documentation and slides                                  | 10      |
| Learning / explanation                                    | 9       |
| Design and decisions (topic)                              | 6       |
| Requirements and planning (topic)                         | 2       |
| Routine: approvals, push and merge notices, status checks | 1       |
| Implementation                                            | 1       |

#### Tue 13 Oct 2026

**12:13** · Requirements and planning (topic) · `pastchum/drom0` · claude-opus-5-5

```text
on the branch pastchum:pastchum/pasted-text-review,



Solid D2 deliverable — server authz is right (`@Authenticated` on reads, `@AdminOnly` + `If-Match` on writes), 422 field errors are wired to inputs with `aria-invalid`/`aria-describedby`, effects cancel properly, and the image fallback is accessible. A few things I'd want fixed:

### Blocking

**1. Each listing page makes 21 requests, and one failure blanks the page** — `web-app/src/lib/supplier-api.ts:20-37`
`listSupplierDetails` does `GET /suppliers` then `Promise.all` over 20 `GET /suppliers/{id}`, and it reruns on every filter/sort/page/debounced search. Any single detail call that times out or 5xxs rejects the lot and the user gets "Could not load suppliers" even though the list loaded. Root cause is `SupplierListItem` (`contracts/supplier-service.openapi.yaml:382-390`) lacking `floor`, `locationDescription`, `openingHours` — adding them is additive and passes the new compat gate. Interim: `Promise.allSettled` with the summary as fallback.

**2. No page-level tests** — `page.tsx` holds most of the logic but only `SupplierCard`, `SupplierForm` (one 422) and URL-building are tested. At minimum: filter resets to page 1, PUT/DELETE send `If-Match`, a failed detail fetch, retry, and students not seeing "Add supplier". #128's DoD also asks for integration tests.

### Should fix
- **Hard-coded building list** (`supplier-display.ts:13-33`) — a supplier added in a new building can never be filtered for, and #128 says no hard-coded supplier data. A facet endpoint or merging buildings from results would do.
- **Edit form opens off-screen** (`page.tsx:154-161`) — at 360 px clicking Edit on a lower card does nothing visible. Focus the form heading + `scrollIntoView` (or use a dialog), and return focus on cancel/save.
- **Focus lost on page change** (`page.tsx:242-294`) — pagination unmounts while loading so focus drops to `<body>`. Keep the list mounted with `aria-busy`, or move focus to the results count.
- **412 STALE_VERSION leaves the admin stuck** (`page.tsx:92-109`) — the form keeps the stale `editing.version` so every retry 412s. Re-fetch on 412 and keep typed values. Delete shows the 412 text but doesn't `reload()`.
- **Opening-hours errors shown twice** (`SupplierForm.tsx:65-74`, `:225`) — `error('openingHours')` matches every `openingHours.*` path; duplicate-day errors only show in the generic alert.
- **CI coverage** — the 4 skips are expected for a web-only diff, but nothing exercises the web app against a real Supplier Service, so the 20 cards / axe / 403 claims are manual-only. Worth attaching the evidence, or routing `suppliers/**` to the stack job.

### Minor
- Branch is 87 commits behind main — no semantic conflicts I could see, but rebase and re-run CI.
- Single quotes in `ResponsiveShell.tsx` / `supplier-api.ts` and new files; rest of `web-app` uses double quotes.
- `showCreditPill={false}` (`page.tsx:146`) hides the credit pill for students too — `{!admin}`?
- Suppliers link is added inline (`page.tsx:144`) rather than in `ADMIN_NAV`, so it's missing from `/admin`.
- `SupplierForm.tsx:106` — "a, b," sends an empty tag and 422s; `.filter(Boolean)`.
- "Add supplier" while editing silently discards the edit; the `role="status"` count remounts each load so may not be announced; no focus move to first invalid field after 422.
- `SupplierCard.tsx:81` checks `latitude !== null` — if the generated type allows `undefined` the map link becomes `q=undefined,undefined`.


what fixes areq required?
```

> **Key response:** You need six fixes before merging. The rest can wait or be dropped. I checked each point against the PR #200 code (`pastchum/pasted-text-review`), and one of the minor points turned out not to be a bug. Required before merge 1. **One failed detail call blanks the whole page** (`supplier-api.ts:27`). This is real:

**12:15** · Debugging · `pastchum/supplier-service-fixes` · claude-opus-5-5

```text
generate a prompt to fix each of 1 through 6 on the required before merging
```

> **Key response:** Here are six prompts, one per fix. Each one is self-contained. Run them in this order, on the same branch, one after another: 1. **#6 (rebase)** first, so every other fix lands on current `main`. 2. **#1, #3, #4, #5** next. They all touch `page.tsx`, so running them in parallel would cause conflicts. 3.

**12:16** · Design and decisions (topic) · `pastchum/supplier-service-fixes` · claude-opus-5-5

```text
Branch: pastchum/pasted-text-review (PR #200). Work in web-app/.

Bug: `listSupplierDetails` in web-app/src/lib/supplier-api.ts does GET /suppliers, then `Promise.all` over up to 20 GET /suppliers/{id} calls. If any one detail call fails (timeout/5xx/404 because it was deleted between calls), the whole promise rejects and web-app/src/app/(app)/suppliers/page.tsx shows "Could not load suppliers", even though the list itself loaded.

Fix (interim, client-side only; do NOT change the OpenAPI contract in this PR):
1. Switch to `Promise.allSettled`. For each rejected detail call, fall back to the `SupplierListItem` summary (supplierId, name, type, building, imageUrl) instead of failing.
2. Model the result so the UI knows which entries are partial, e.g. return `suppliers: Array<{ summary: SupplierListItem; detail: Supplier | null }>` or a discriminated union. Export a `SupplierListItem` type from components['schemas']['SupplierListItem'].
3. Update SupplierCard (web-app/src/components/SupplierCard.tsx) to render a summary-only entry: show name/type/building/image, show "Details unavailable" (or similar) in place of floor/location/hours/tags/map, and hide Edit for that card (editing needs `version`). Delete can stay hidden too.
4. Only throw (and show the page-level ErrorState) when the GET /suppliers list call itself fails.
5. Keep the existing cancellation (`current` flag) and page-clamping logic in page.tsx working with the new shape.
6. Match surrounding style (double quotes if main uses them after rebase; check eslint/prettier config).

Tests: in web-app/test/supplier-api.test.ts add cases where (a) all details succeed, (b) one detail call rejects → result still has all items, that one marked summary-only, (c) list call fails → rejects. In web-app/test/suppliers.test.tsx add a SupplierCard test for the summary-only rendering (no Edit button, fallback text).

Run `bun test`, `bun run lint`, `bun run build`. Commit as `fix(web): degrade to summaries when a supplier detail fetch fails`.

Also draft (don't file) a follow-up issue: add floor, locationDescription, openingHours to SupplierListItem in contracts/supplier-service.openapi.yaml (additive, passes the compat gate) so the listing needs one request instead of 21.
```

> **Key response:** I've committed the fix as `d2bc6fd` (`fix(web): degrade to summaries when a supplier detail fetch fails`). It's on a new local branch, `pastchum/supplier-detail-fallback`, not on PR #200's branch, and nothing is pushed.

**12:22** · Learning / explanation · `pastchum/pasted-text-review` · claude-opus-5-5

```text
stash pop and compare the changes to what you originally intended to do. what is the difference in the approaches?
```

> **Key response:** I applied the stash on `pastchum/pasted-text-review`, here in this workspace. It applied cleanly, I dropped the entry afterwards, and the stash list is now empty. The changes are uncommitted, and all 89 tests pass with them. My version is still committed separately on `pastchum/supplier-detail-fallback` (`d2bc6fd`).

**12:54** · Requirements and planning (topic) · `pastchum/pasted-text-review` · claude-opus-5-5

```text
Branch: pastchum/pasted-text-review (PR #200, closes #128). Work in web-app/. Fixes for partial detail failures, 412 recovery, form focus and live building lists should already be on the branch. Read the current page.tsx before writing tests.

Gap: web-app/src/app/(app)/suppliers/page.tsx holds most of the logic but has no tests. Only SupplierCard, one SupplierForm 422 case and URL building are covered (web-app/test/suppliers.test.tsx, web-app/test/supplier-api.test.ts). #128's Definition of Done requires "Unit and integration tests committed alongside the change".

Part A: page tests (bun:test + happy-dom, following the setup at the top of web-app/test/suppliers.test.tsx). Mock `useAuth` (authed should call its callback with a fake token; `user.roles` controls admin vs student) and either mock `supplierApi` or stub `fetch` to route by method + path. Prefer stubbing fetch, so the real openapi-fetch client and ApiError mapping are exercised. Add web-app/test/suppliers-page.test.tsx covering:
1. Initial load calls GET /suppliers with page=1, pageSize=20, sort=name, order=asc and renders one card per item plus "N suppliers found".
2. Changing type, building, sort or order while on page 2 resets to page 1 (assert the query string of the next request).
3. Typing in search is debounced (use fake timers): only one request after 300 ms, and it resets to page 1.
4. Next/Previous pagination sends the right page and disables at the ends.
5. List request fails → ErrorState with "Could not load suppliers"; clicking Retry re-requests and renders cards.
6. One detail request fails → page still renders, that card is summary-only.
7. Empty result → EmptyState copy.
8. Student (`roles: ["STUDENT"]`): no "Add supplier", no Edit/Delete buttons. Admin: all present.
9. Admin edit → PUT /suppliers/{id} sent with If-Match equal to the supplier's version and the form's body. Admin delete (stub window.confirm → true) → DELETE with If-Match, then the list reloads.
10. PUT 412 → form keeps typed values, and the retry uses the refreshed version.
11. PUT 422 with details → field errors render with aria-invalid on the matching inputs.

Part B: integration test. Look at how other services/web features in the repo do integration or stack tests (search .github/workflows, any docker-compose test job, Playwright config). If a stack/e2e harness exists, add a supplier-listing test that runs against the real Supplier Service:
- student browses and sees cards
- student POST /suppliers returns 403
- admin creates, edits, deletes
Then make CI run it when suppliers/** or web-app/src/app/(app)/suppliers/** changes. If no harness exists, write the smallest viable one (e.g. a bun test that hits a running supplier service via SUPPLIER_SERVICE_URL, skipped when unset) and document how to run it in web-app/README.md. Tell me which route you took.

Run `bun test`, `bun run lint`, `bun run build`. Commit Part A and Part B separately: `test(web): cover supplier page flows` and `test(web): add supplier listing integration test`.
```

> **Key response:** I've added both test layers and made two commits on `pastchum/pasted-text-review`: `b6609a3 test(web): cover supplier page flows` and `e2de01a test(web): add supplier listing integration test`. I haven't pushed, so the new CI job hasn't run on GitHub yet.

#### Tue 20 Oct 2026

**17:04** · Review and verification · `pastchum/xx3t6` · claude-opus-5-5

```text
give me a code review on the branch feat/235-admin-account-errands
```

> **Key response:** I reviewed `feat/235-admin-account-errands` (commit `40983d9`) against `main`: 9 files, about 310 added lines. I couldn't run the tests or the type check because `web-app/node_modules` isn't installed. I read the code for the first three findings myself and they hold up.

#### Wed 21 Oct 2026

**16:00** · Learning / explanation · `pastchum/47dm6` · claude-opus-5-5

```text
pastchum/release-reason-order-projection for PR #257

Pull in PR comments, assess validity and explain why the issues come about
```

> **Key response:** I read all five review comments on PR #257 (all from volleyballkickedme) and checked each one against the PR branch. All five are valid. None is a correctness bug: the code does what the PR says. Four are about tests or docs, and one points at a privacy leak that was there before this PR. 1.

**16:06** · Release and PR workflow · `pastchum/release-reason-order-projection` · claude-opus-5-5

```text
.context/attachments/BQ81Ql/Transcript of PR #257 issues explanation.md was 1 always an issue before this PR?
```

> **Key response:** Yes. Issue 1 was already there before PR #257, and the PR doesn't make it worse. **Where it came from:** commit `e2ecb76` (2026-10-19, "fix(order): keep suspensions private…") added both `withoutSuspension` (`order-service/src/orders/orders.service.ts:26`) and the contract's "so it does not reveal the suspension" …

**17:07** · Debugging · `pastchum/zkrz7` · claude-opus-5-5

```text
for branch fix/260-system-outcome-for-every-system-move with PR #261,

/code-review
perform a code review on it.
```

> **Key response:** I reviewed PR #261 (`fix/260-system-outcome-for-every-system-move`) and found 8 issues. Two are real bugs in `asParticipantSees`, two are leaks the new README doesn't mention, and four are about tests. Bugs in the masking logic (`order-service/src/orders/orders.service.ts`) 1.

**17:08** · General request · `pastchum/m9ja5` · claude-opus-5-5

```text
investigate and assess what needs to be done for issues WEB 02, WEB-03 and WEB-05
```

> **Key response:** The backend for all three issues is already done. Every ticket they're blocked by (ORD-03/04/10/11, CRD-05, WEB-01) is closed, so this is front-end work in `web-app/`. Right now the feed, order history, wallet, and the detail and edit pages for mock errands all read the in-memory mock store (`src/lib/store.tsx`).

**17:35** · Learning / explanation · `pastchum/w6qx8` · claude-opus-5-5

```text
pull in branch pastchum/web-04-connectivity-recovery with PR #259

triage the PR comments, assess their validity and explain for each one why the issue comes about.

display a summary of all the findings in the following table at the end:
| comment number | validity | reason |
|-----------------|----------|----------|
```

> **Key response:** I've checked out `pastchum/web-04-connectivity-recovery` (PR #259). It has one review from jonushzw: an approval-style comment ("nothing blocking") and three inline notes, all marked Minor. There are no other issue comments. --- Comment 1:

#### Thu 22 Oct 2026

**12:21** · Design and decisions (topic) · `main` · claude-opus-5-5

```text
generate a database schema and system diagram for the order service
```

> **Key response:** I've published both diagrams on one page: https://claude.ai/artifact/N19yJJRjZ4FuVRamHAkzTs They're built from `order-service/src/db/schema.ts`, migrations `0000` to `0015`, `app.module.ts` and the `order-service` block in `compose.yaml`.

**12:56** · Learning / explanation · `main` · claude-opus-5-5

```text
how does rabbit mq being down affect services
```

> **Key response:** **Short version:** a running service keeps serving HTTP and accepting writes while RabbitMQ is down. What stops is anything that happens _between_ services, because those steps travel as events. Once the broker comes back, everything catches up and nothing is lost. The one weak spot is startup:

**12:59** · Learning / explanation · `main` · claude-opus-5-5

```text
how do i demo the rabbit mq duplicate message
```

> **Key response:** All 19 checks passed, so the duplicate part is working. Step 2 shows that the two extra copies were counted as duplicates and moved no extra credits: still one wallet, one issue of 10 credits. On the day, run `./scripts-demo-journey.sh --stage` before the slot.

**14:29** · General request · `pastchum/xrhs3` · claude-opus-5-5

```text
investigate the raw sql code in each of the services.

i want to know if they can be converted into drizzle-kit to simplify deployments
```

> **Key response:** I didn't change anything. Short answer: **the services already use drizzle-kit for migrations.** The hand-written SQL that's left is mostly things drizzle-kit can't express, so converting more of it wouldn't make deployments simpler. There are a few smaller cleanups worth doing.

#### Tue 27 Oct 2026

**21:41** · General request · `pastchum/3kyk1` · claude-opus-5-5

```text
pull in the issues that are assigned to @pastchum and see what needs to be done
```

> **Key response:** You have 8 open issues assigned to you, and none of them has a PR yet. Today is Tue 27 Oct. Here they are by deadline, taken from the D4 tracker (#288): Overdue (was due Sun 25 Oct) **#238 DOC-04:**

**21:51** · Design and decisions (topic) · `pastchum/pastchum-issues-review` · claude-opus-5-5

```text
Fix issue #264 in AY2627S1-CS3219-P30/foc-app: "Web app: order page stops updating after 10 minutes on a visible tab". Run `gh issue view 264` for the full context. It's P1 and due Thu 29 Oct.

The bug:
- `useOrder` in web-app/src/lib/use-order.ts keeps polling every SETTLED_DELAY_MS once an order is settled.
- `nextDelay()` returns `null` once `Date.now() - since.current >= IDLE_LIMIT_MS` (10 minutes). That stops `usePoll` (web-app/src/lib/use-poll.ts).
- Only `useOnReturn` (online / visibilitychange) resets `since.current`. A tab that simply stays visible never fires either event.
- So a student watching an OPEN errand never sees a courier accept it, and nothing on the page says updates have stopped. The same goes for a DELIVERED errand waiting for confirmation and a DISPUTED one waiting for an administrator.

What to build (the fix proposed in the issue):
1. `useOrder` also returns a `paused` boolean. It is true when settled polling has gone idle: the order isn't final, isn't waiting on credit, and `nextDelay` returned `null`. It is false again once a read happens because of a return to the tab, a refresh, or a status change. Don't count a 4xx/UNEXPECTED stop as "paused", because that is already shown through `problem`. Keep the existing behaviour otherwise, including `version` ordering, `stillWaiting`, `skew` and 404 handling.
2. Resuming: `refresh()`, or a new `resume()` if that turns out cleaner, resets `since.current`, reads once, and restarts settled polling. Check that `usePoll`'s `readNow` actually restarts the loop after a `null` delay. If it doesn't, fix that in `usePoll` without changing how its other callers behave.
3. In web-app/src/app/(app)/request/[id]/OrderDetail.tsx, while `paused`, show a short, polite hint such as "Updates paused" with a "Refresh" button that calls the resume path. Match the copy style, design tokens and accessibility of the existing status and problem messages (an aria-live region if the neighbouring messages use one). It must work at 360, 768 and 1440 px.
4. Tests in web-app/test/ (bun test; follow the patterns in order-history.test.tsx and errand-actions.test.tsx). Cover at least:
   - polling pauses after IDLE_LIMIT_MS on a settled, non-final order, and `paused` becomes true
   - refreshing reads exactly once, `paused` becomes false, and settled polling resumes
   - a final order never reports paused
   - OrderDetail shows the hint and its button works
   Use fake timers or controlled time, not real waits.

Conventions: branch from origin/main as fix/264-order-updates-paused. Keep the doc comment above `useOrder` accurate. Run lint, typecheck and `bun test` in web-app before opening the PR. Open the PR against main with "Closes #264", and describe the behaviour change and how you tested it.
```

> **Key response:** I've opened PR #320, which fixes #264: https://github.com/AY2627S1-CS3219-P30/foc-app/pull/320. The order page now says when its updates have stopped and lets the student start them again. Lint and typecheck have no errors, and `bun test` passes (376 pass, 0 fail).

#### Wed 4 Nov 2026

**00:22** · Debugging · `pastchum/pasted-text` · claude-opus-5-5

```text
Fix the failing CI actions. I've attached the failure logs. .context/attachments/5uTfuU/Browser_journeys__smoke__126033582537.log .context/attachments/BcFIbC/Browser_journeys__release__126033582600.log .context/attachments/wbq34t/CI_126039555851.log .context/attachments/Vh4tbc/Fix errors instructions.md
```

> **Key response:** I've fixed the failure and pushed it to PR #365 as `59e31b9`. I couldn't run the end-to-end tests here because Docker isn't running, so the new CI run will be the real check. Typecheck and lint pass. **Cause:** The smoke and release browser-journey jobs both failed on the same thing.

#### Mon 9 Nov 2026

**04:35** · Learning / explanation · `pastchum/kviv0` · claude-opus-5-5

```text
is there a ci cd way to aws such that any pushes to main will automatically deploy CI/CD onto the AWS instance set up by @anselmlong
```

> **Key response:** Yes, and most of it is already in place. You'd add one job to `ci.yml`. Nothing for AWS is in the repo yet: no workflow, runbook, `compose.aws.yaml` or AWS secrets (the only repo secrets are the old Vercel ones).

**15:25** · Implementation · `pastchum/ci/cd-aws-deployment` · claude-opus-5-5

```text
do up the scripts
```

> **Key response:** I've written the scripts. Merging changes nothing until someone sets the variable that turns auto-deploy on. Nothing is committed yet. Files **`scripts-deploy.sh`** runs on the EC2 host: `./scripts-deploy.sh sha-&lt;commit>`, or a release tag such as `rc1-d4`.

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
