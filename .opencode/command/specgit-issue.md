---
description: Start a SpecGit delivery from a title or existing issue number
---

<!-- specgit-managed-entry-point -->

# /specgit-issue

Thin trigger for the delivery bootstrap. The canonical behavior lives in the
AGENTS.md SpecGit block; this command only launches it.

## Steps

1. Collect the argument: `$ARGUMENTS` is either an issue title (create) or a
   pure number (reuse). Multiple arguments = N issues in one delivery.
2. Run from the repo root:

   ```bash
   specgit issue "$ARGUMENTS" --json
   ```

3. On success report the brief: issue URL(s), PR URL (draft), branch name —
   then fill in the draft PR's scaffold (Why / What changed / Evidence).
   Its placeholders are advisory; never treat them as gates and never
   remove the closing references.
4. Switch to the delivery branch and begin the TDD loop.
5. On error, read `errors[].fix` and follow it — never bypass the record.
