# Cutting a release (REL-03, #169)

A release is a name on images that already exist. Pushing a tag gives the six images CI built and
scanned for that commit the same name, and records the commit and their digests in a GitHub Release.
Nothing is rebuilt, so what the team rehearses is exactly what CI scanned.

| Tag                | What it is                       |
| ------------------ | -------------------------------- |
| `rc1-d4`, `rc2-d4` | a release candidate: a pre-release |
| `v1.0-d4`          | the final release                |

## Cut one

Merge everything it needs, then wait for that commit's run on `main` to finish: CI publishes a
commit's images only after its run passes.

```bash
gh run list --repo AY2627S1-CS3219-P30/foc-app --branch main --event push --limit 1
git fetch origin main
git tag rc1-d4 origin/main
git push origin rc1-d4
```

The push runs the **Release** workflow (`.github/workflows/release.yml`), which runs
`./scripts-release.sh`. Its Release, at `releases/tag/rc1-d4`, gives the commit, the six digests,
and the commands to start those images and to roll back to them. That page is the record #169 asks
for: the exact commit and image tags.

A tag runs the workflow as it is at the tagged commit, so one on a commit from before the workflow
was merged runs nothing.

## If it refuses

The workflow's log says which of these it is. All are safe: it reads all six images before tagging
any, and creates a Release last.

| It says                                     | What happened                                                 | What to do                                                                                                                                                              |
| ------------------------------------------- | ------------------------------------------------------------- | -----------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `not found`, `Nothing was tagged`           | that commit's images are not published yet, or its run failed | Wait for its run on `main` to pass, then `gh run rerun --failed <run>`, with the run from `gh run list --workflow release.yml --limit 1`. If its run failed, tag a later commit. |
| `not on main`                               | the tag is on a commit CI never published                     | `git push --delete origin rc1-d4`, `git tag -d rc1-d4`, and tag a commit on `main`.                                                                                     |
| `A release tag never moves`                 | the tag already names other images                            | Use the next number, `rc3-d4`. Delete the Git tag you just pushed.                                                                                                      |
| `Could not tell what … names`               | the registry gave an answer other than `not found`            | Read its answer, then re-run.                                                                                                                                           |
| `No Release was made`                       | a tagged image came back with another digest                  | Stop and find out why: those images are not what CI scanned.                                                                                                            |
| `gh` says the Release already exists        | an earlier run finished                                       | Nothing. It is done.                                                                                                                                                    |

## Rehearse it

Start the Release page's commands from a checkout of the tag. If `pull` says `unauthorized` or
`denied`, the packages are private: see the README's
[Published images](../../README.md#published-images).

To rehearse the demo on it, run `FOC_IMAGE_TAG=<the tag> ./scripts-seed-demo.sh --fresh` from that
checkout, as the [D4 runbook](../demo/d4-runbook.md#start-from-zero) says.

To rehearse rolling back to the previous release, read its Release for its commit, review the
migrations between the two as the [rollback runbook](backup-restore-rollback.md) says, and run the
drill from a checkout of the newer one. It uses a Compose project of its own and leaves your stack
alone:

```bash
./scripts-recovery-drill.sh --rollback-tag sha-<the previous release's full commit>
```

Rollback takes the `sha-` tag, not the release's name: the two are the same images, and only the
`sha-` tag is checked to be a full commit. Its result is in `.recovery-results/drill.json`; dated
evidence goes under `docs/reports/`.

## Never

- **Move a release tag.** It says which images were rehearsed. If those were wrong, cut the next one.
- **Rebuild a release's images.** Anything built later is not what was scanned and rehearsed.
- **Tag a commit that is not on `main`.** CI scanned and published nothing for it, and the script
  refuses it.
