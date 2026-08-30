# Agent OS Repository Contract

Agent OS exists to reduce coordination and verification cost, not to manufacture more process. Its own repository must follow the same low-entropy rules it should eventually enforce for other repositories.

## Git/worktree lifecycle

- `main` is the only persistent working branch; keep one normal `main` checkout/worktree.
- Temporary branches/worktrees/folders are allowed only when real isolation is useful for the current task, not by default.
- The agent that creates temporary state owns the full lifecycle. Before DONE: integrate the finished task into `main`, run the repository's established completion/pre-push gate, push `main`, remove temporary worktrees/folders, delete temporary local branches, delete temporary remote branches if pushed, prune stale worktree metadata, and verify a clean tree.
- Never leave branch/worktree/temp-folder cleanup debt for another agent.

## Scope discipline

- One task = one repository + one semantic Agent OS capability/domain + one primary objective.
- Be comprehensive inside that narrow scope. Do not partially advance multiple orchestration subsystems at once.
- Dependencies may be inspected; unrelated capabilities are read-only unless a minimal coordinated edit is required.
- No drive-by refactors, speculative framework work, or "while here" automation.
- Finish implementation/specification, focused validation, canonical documentation update, integration, and cleanup before starting another capability.

## Artifact discipline

Use **edit existing owner > consolidate duplicates > delete superseded material > create a new artifact**.

- New governance objects have a default budget of zero. Do not create new handoffs, plans, TODO files, progress logs, checklists, matrices, registries, review memos, architecture summaries, or templates unless explicitly requested or no existing canonical owner can represent the information.
- If a handoff is needed, prefer one root `HANDOFF.md` updated in place; do not create dated/domain/agent-specific handoffs.
- Track progress with a small number of comprehensive checkmark lists rather than scattered narrative status files.
- Git history is the archive. Current documentation should continuously replace/delete stale or conflicting material after valid information is consolidated.

## Orchestrator design requirements

When Agent OS coordinates other repositories, design toward mechanically enforcing these rules rather than adding prose about them:

- one persistent `main` branch per repository;
- at most one writable task per repository by default; parallelism should favor different repositories or genuinely disjoint explicitly leased scopes;
- temporary branch/worktree creator owns merge/push/remote-branch deletion/worktree removal/pruning;
- task leases name one repository, one semantic domain, owned paths and read-only dependencies;
- diffs that escape the leased domain are rejected or surfaced before integration;
- new governance/documentation artifacts are disallowed by default unless the task explicitly grants creation;
- completed documentation cleanup should normally have non-positive governance-artifact growth;
- repository completion cannot be reported while agent-created temp branches/worktrees/folders remain;
- one root `HANDOFF.md` maximum when a repository uses handoffs;
- prefer existing canonical checklists and owner documents over generating another status representation.

Do not build a new workflow subsystem merely to enforce a rule that can be implemented with existing Git, filesystem, manifest, lint, or CI primitives.

## Validation cadence

- Use existing README/package metadata as the command authority.
- Run narrow affected checks during development.
- Run the established completion/pre-push gate once when the slice is ready, plus risk-specific checks required by the change.
- Do not repeatedly run expensive full validation after every small edit merely to produce evidence.

## Definition of done

DONE means the selected capability is complete, relevant validation passes, the result is integrated and pushed to `main`, every temporary resource created by the task is removed, and the workflow/repository is simpler or at least no more cognitively expensive than before.
