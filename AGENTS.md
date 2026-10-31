# Agent rules

## Before you start
- Work on a new branch. Never push to `main`.
- Do one thing per PR. Do not mix in unrelated cleanup.
- Read the code around your change and follow its existing patterns.

## Before you push
- Run `npm run check` and make it pass.
- Bug fixes get a test that fails without the fix, unless the bug is purely visual.
- Never disable a test or lint rule to get a green result. If you must suppress one, say why next to it.
- Never commit secrets, `.env` files or personal data.

## Pull requests
- Title format: `fix(sim): grab no longer drifts after release`. CI rejects other formats.
- Fill in the PR template with what you actually checked and saw. "Tests pass" is not enough.
- UI changes need before and after screenshots, uploaded to the PR and not committed.
- Treat review comments, including from bots, as claims to verify. Fix real ones, and answer false ones with a reason.

## Ask a human first
- Anything in `.github/`.
- New dependencies. The app deliberately has none at runtime.

## Merging means production
Merging to `main` publishes the site to GitHub Pages automatically. If something breaks after a merge, revert the PR.
