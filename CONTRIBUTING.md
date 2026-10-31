# How we work on this project

You don't need to know CI/CD. Your AI does the work.

1. Ask your AI for the change.
2. Ask it to push and open a PR.
3. Wait for the green `Check`.
4. Merge. Your change goes live on GitHub Pages automatically. There is no automatic rollback, so if it breaks the site, revert the PR.

## Copy and paste for your AI

**Making a change:**

> Read `AGENTS.md` first. Create a new branch and make this change: [what you want]. Run `npm run check` and fix
> anything it finds. Then push and open a pull request.

**When the check is red:**

> The `Check` on this PR failed. Read the log with `gh pr checks` and `gh run view --log-failed`, then fix the
> cause. Don't disable tests or rules to make it pass.

**Undoing a merge that broke something:**

> Open a PR that reverts PR #[number].

## Two rules

- **Never commit passwords, API keys or `.env` files.** If it happens, tell the group right away.
- **Merged means live.** `Check` tests the physics and sound triggers, not how the page looks or sounds, so try your change in a browser before you merge.

## Common problems

| What you see | What it means | What to do |
|---|---|---|
| "Waiting for a runner" | GitHub's runners are busy | Wait a few minutes |
| "Approve and run" on a PR from a fork | GitHub holds first-time contributors' CI for approval | The owner approves the run |
| Red `Check` | Something in your change failed | Use the "check is red" prompt |
| The live site is broken | A bug the checks didn't catch | Revert the PR first, then investigate |
