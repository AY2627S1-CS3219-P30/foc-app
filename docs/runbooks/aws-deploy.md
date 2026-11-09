# Deploying to AWS (PLT-14, #357)

Every push to `main` that passes CI publishes six images as `sha-<commit>`. While auto-deploy is
on, the **Deploy** workflow then starts them on the EC2 host:

```
CI passes → publish (sha-<commit> on GHCR) → deploy job → SSM Run Command → ./scripts-deploy.sh on the host
```

GitHub signs in to AWS with OIDC: no AWS key is stored in GitHub, and port 22 can stay closed.
`./scripts-deploy.sh` checks out the commit, so `compose.yaml` matches the images, then pulls them,
starts them (each migrate container first), checks that `/edge/ready` answers 200, and runs the
credit invariants. It builds nothing, only moves forward, and never rolls back by itself.

## One-time setup

### 1. The host

As the host's user (`ubuntu` below), with Docker and the Compose plugin installed:

```bash
sudo usermod -aG docker ubuntu          # then log out and in again
git clone https://github.com/AY2627S1-CS3219-P30/foc-app.git ~/foc-app
cd ~/foc-app
./scripts-init-env.sh                   # then set the production values #357 lists
```

The clone must be at a commit that has `scripts-deploy.sh`. Its `.env` stays on the host. A deploy
that passes changes one line of it, `FOC_IMAGE_TAG`, to the tag it deployed, so any later
`docker compose` command in the clone starts the same images and never quietly goes back to older
ones. If TLS runs as a Compose override, name it `compose.aws.yaml` in the clone and the deploy
includes it. Alternatively, set `COMPOSE_FILE` in `.env`, which overrides the default. The images
are public, so no `docker login` is needed.

The SSM agent ships with Ubuntu's AMIs. It needs the instance to have a role with the managed policy
**AmazonSSMManagedInstanceCore** (EC2 → instance → Actions → Security → Modify IAM role). Check that
the instance shows under Systems Manager → Fleet Manager.

### 2. AWS: let GitHub send the command

1. IAM → Identity providers → Add provider: OpenID Connect, URL
   `https://token.actions.githubusercontent.com`, audience `sts.amazonaws.com`.
2. IAM → Roles → Create role → Web identity, with that provider. Replace its trust policy with
   the one below. Only jobs in this repository's `aws` environment can assume it:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [{
       "Effect": "Allow",
       "Principal": { "Federated": "arn:aws:iam::<ACCOUNT>:oidc-provider/token.actions.githubusercontent.com" },
       "Action": "sts:AssumeRoleWithWebIdentity",
       "Condition": {
         "StringEquals": {
           "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
           "token.actions.githubusercontent.com:sub": "repo:AY2627S1-CS3219-P30/foc-app:environment:aws"
         }
       }
     }]
   }
   ```

3. Give the role this inline policy and nothing else. It can run a shell command on this one
   instance and read the result:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Action": "ssm:SendCommand",
         "Resource": [
           "arn:aws:ec2:<REGION>:<ACCOUNT>:instance/<INSTANCE_ID>",
           "arn:aws:ssm:<REGION>::document/AWS-RunShellScript"
         ]
       },
       { "Effect": "Allow", "Action": "ssm:GetCommandInvocation", "Resource": "*" }
     ]
   }
   ```

### 3. GitHub: the environment and variables

Settings → Environments → New environment `aws`. Under **Deployment branches and tags**, choose
**Selected branches and tags** and add `main`. Don't skip this. The trust policy only checks that a
job names the `aws` environment, and the role can run any command as root on the instance, so
without the rule a workflow on any branch, including a pull request's, could use it. Release tags
still deploy by hand, because the workflow runs on `main` and takes the tag as its input. Required
reviewers are an optional second layer, if a person should approve each deploy.

Then set the environment's variables. None of them is a secret:

| Variable                 | Value                                                   |
| ------------------------ | ------------------------------------------------------- |
| `AWS_DEPLOY_ROLE_ARN`    | the role from step 2                                    |
| `AWS_REGION`             | e.g. `ap-southeast-1`                                   |
| `AWS_DEPLOY_INSTANCE_ID` | `i-…`                                                   |
| `AWS_DEPLOY_USER`        | the host's user, if not `ubuntu`                        |
| `AWS_DEPLOY_PATH`        | the clone, if not `/home/ubuntu/foc-app`                |
| `AWS_DEPLOY_URL`         | `https://<host>`, shown on each deploy                  |

Then turn on auto-deploy with a **repository** variable, which CI reads before the environment:

```bash
gh variable set AWS_AUTO_DEPLOY --body true --repo AY2627S1-CS3219-P30/foc-app
```

Before relying on it, try one deploy by hand (below).

## Deploying by hand

Actions → **Deploy** → Run workflow, with `sha-<commit>` or a release tag such as `rc1-d4`. Or:

```bash
gh workflow run deploy.yml -f tag=sha-$(git rev-parse origin/main)
```

On the host itself, `./scripts-deploy.sh sha-<commit>` does the same.

## Freezing what the host runs

For the D4 demo, or any time a merge must not change the live site:

```bash
gh variable set AWS_AUTO_DEPLOY --body false --repo AY2627S1-CS3219-P30/foc-app
```

CI still publishes images; deploy a release tag by hand when ready.

## When a deploy fails

The workflow's log ends with the script's output from the host. The script leaves the stack running
as it is, and prints the commit that last deployed cleanly. Look before changing anything:
`docker compose ps` and `docker compose logs <service>` on the host.

| It says                               | What to do                                                                                                                                       |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `local changes to tracked files`      | someone edited the clone by hand. Commit the change on `main`, or `git checkout -- <file>`, then run the deploy again                              |
| `not on main`                         | deploy a commit that is on `main`                                                                                                                |
| `already includes`                    | a newer commit is already deployed; nothing was changed                                                                                          |
| `did not become healthy`, `did not report the stack ready`, `smoke test` | fix forward with a new commit, or roll back: [Backup, restore and rollback](backup-restore-rollback.md), with the `sha-` the failure message gives |
| the workflow ends `Failed` with no output, or never leaves `Pending` | the instance is not reachable through SSM: check Fleet Manager and the instance's role                                       |

`.deploy-history` in the clone lists each deploy that passed, one per line: time, tag, commit.

By default a deploy checks that the stack is ready, not that it behaves: every container healthy,
`/edge/ready` answering 200, and the credit invariants holding. `DEPLOY_SMOKE=1` in the host's
`.env` also runs `./scripts-smoke.sh`. Leave it off on a host people use. The smoke test is made for
a throwaway stack:

- It stops the Order Service to check that `/edge/ready` notices, an outage of up to about two
  minutes.
- It sends a burst of writes to trip the edge's rate limit.
- It signs up `smoke-…@u.nus.edu` students and reads their activation mail from Mailpit. A host that
  sends through SES has no Mailpit, and those would be real emails.
