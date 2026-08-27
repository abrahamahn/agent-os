# Agent OS

[![CI](https://github.com/abrahamahn/agent-os/actions/workflows/ci.yml/badge.svg)](https://github.com/abrahamahn/agent-os/actions/workflows/ci.yml)

Agent OS is a standalone, TypeScript-first control plane for coordinating coding agents across
software projects. It manages task lifecycles, isolated worker workspaces, independent review,
exact-SHA integration, host validation, resource leases, evidence, and bounded process cleanup.

The orchestrator is project-agnostic. A target repository supplies a thin adapter and declarative
profiles; Agent OS supplies the execution and safety machinery.

> Agent OS is currently pre-release (`0.1.0`). Its command runner is integrated with Codex, while
> target repositories and validation commands may use any development stack.

The [roadmap](ROADMAP.md) describes the next major step: a zero-copy hierarchy with one
orchestrator, two or three managers, three or four workers per manager, durable communication,
escalation, user approval gates, and concurrent team execution.

## What it provides

- Durable `BUILD → REVIEW → INTEGRATE → VALIDATE → ACCEPTED` task orchestration.
- Independent reviewer sessions bound to immutable Git candidates.
- Exact commit and tree capture in a controller-owned Git object store.
- Isolated worker workspaces with explicit Git metadata and environment capabilities.
- Host validation with admitted environments, dependency identity, disposable scratch mounts, and
  execution attestation.
- Host-wide medium/heavy resource scheduling and machine-pressure limits.
- Validation evidence bound to the candidate SHA, command, dependencies, and environment.
- Fail-closed process discovery and dry-run cleanup limited to explicit repository roots.
- Target-defined roles, ownership, validation workflows, host services, and safety policy.

## TypeScript is first-class

Agent OS is implemented in strict TypeScript and directly understands common TypeScript workflows:

- pnpm, npm, yarn, and bun commands.
- `tsc`, `tsx`, Vitest, ESLint, Vite, Turbo, and Playwright processes.
- Repository-wide versus package/file-scoped TypeScript validation.
- `package.json`, lockfiles, `tsconfig.json`, and `tsconfig.base.json` evidence.
- pnpm workspace discovery and bounded `node_modules/.cache`, Vite, and Turbo scratch mounts.

Repository-wide TypeScript checks receive broad/heavy scheduling. Focused package or file checks can
use medium leases.

Agent OS also recognizes Rust, Python, Go, Java/Gradle/Maven, .NET, Make, and CMake workloads. A
target profile can define additional commands without changing the orchestrator.

## Architecture

```text
Target repository
├── thin adapter
├── capability profile
└── validation profile
         │
         ▼
Agent OS
├── orchestrator and cycle executor
├── worker workspace substrate
├── resource scheduler
├── host validation and evidence
└── process guardian
```

Agent OS never imports target application code. The adapter invokes Agent OS with an explicit target
worktree and points it at target-owned JSON profiles.

## Requirements

- Node.js `24.13` or newer (`<27`).
- pnpm `10.26.2` through Corepack.
- Git.
- Codex on `PATH` for automated cycle execution, or `AGENT_OS_CODEX_EXECUTABLE` set to a compatible
  executable.
- Linux and Bubblewrap (`bwrap`) for the real read-only host-validation sandbox. Other control-plane
  and scheduling features can run without Bubblewrap.

## Install

```bash
git clone https://github.com/abrahamahn/agent-os.git
cd agent-os
corepack enable
pnpm install --frozen-lockfile
pnpm check
```

Agent OS is currently operated from its repository rather than installed as a global package. A
target adapter can invoke it from anywhere with `pnpm --dir /path/to/agent-os <command>`.

## Connect a target repository

Keep target policy in the target repository, for example:

```text
your-project/
├── config/orchestration/capabilities.json
├── config/orchestration/validation-profile.json
└── tools/orchestration-adapter.ts
```

The adapter should set absolute paths and always pass the target worktree explicitly:

```bash
export AGENT_OS_CAPABILITIES_PATH=/work/your-project/config/orchestration/capabilities.json
export AGENT_OS_VALIDATION_PROFILE_PATH=/work/your-project/config/orchestration/validation-profile.json
export AGENT_OS_ALLOWED_WORKTREE_ROOTS=/work/your-project

pnpm --dir /work/agent-os agent-resource \
  run --worktree /work/your-project --agent A11 --resource heavy -- \
  pnpm check
```

The default profiles in [`config/`](config/) are intentionally neutral. Replace them through the
environment variables above; do not copy application-specific policy into Agent OS.

### TypeScript validation profile

This is a complete pnpm/TypeScript target profile:

```json
{
  "schemaVersion": 1,
  "environmentNames": [
    "PATH",
    "HOME",
    "CI",
    "NODE_ENV",
    "NODE_OPTIONS",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "XDG_CACHE_HOME",
    "GIT_DIR",
    "GIT_WORK_TREE"
  ],
  "bootstrap": {
    "command": [
      "pnpm",
      "install",
      "--offline",
      "--frozen-lockfile",
      "--ignore-scripts",
      "--ignore-pnpmfile"
    ],
    "environment": {
      "NODE_ENV": "development",
      "NPM_CONFIG_USERCONFIG": "/dev/null",
      "NPM_CONFIG_GLOBALCONFIG": "/dev/null"
    },
    "dependencyFiles": [
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "tsconfig.json",
      "turbo.json"
    ]
  },
  "scratchPaths": ["node_modules/.cache", ".turbo"],
  "services": {},
  "checks": {
    "type-check": {
      "resource": "heavy",
      "command": ["pnpm", "exec", "tsc", "--build"]
    },
    "test": {
      "resource": "heavy",
      "command": ["pnpm", "exec", "vitest", "run"]
    }
  }
}
```

`bootstrap.command` may be empty. Dependency files and scratch paths must be unique, safe paths
relative to the target repository. Checks may reference a declared host service.

### Capability profile

[`config/capabilities.json`](config/capabilities.json) defines phases, worker IDs, resource
capabilities, lifecycle roles, ownership, priorities, and review risks. Set
`AGENT_OS_CAPABILITIES_PATH` to use a target-owned profile.

Capability lists must be unique. Priorities are non-negative safe integers. Ownership and hotspot
scopes use unique repository-relative POSIX paths; `.` represents the repository root, while
absolute paths, traversal segments, backslashes, and empty path segments are rejected. Every phase
is validated when the profile loads, including phases that are not currently active.

## Command surfaces

| Command                    | Responsibility                                                                                      |
| -------------------------- | --------------------------------------------------------------------------------------------------- |
| `pnpm agent-os`            | Initialize cycles, register agents/tasks, ingest results, reconcile, inspect queues, and supervise. |
| `pnpm agent-substrate`     | Provision or attach worker workspaces and operate host-validation jobs.                             |
| `pnpm agent-resource`      | Inspect capacity, print role policy, and run medium/heavy commands.                                 |
| `pnpm quality-control`     | Run exact-SHA checks and create classified quality evidence.                                        |
| `pnpm validation-evidence` | Reserve, start, complete, inspect, and wait for validation jobs.                                    |
| `pnpm process-guardian`    | Inspect target processes, protect shared development processes, and perform bounded cleanup.        |

### Orchestration

```bash
pnpm agent-os init --cycle cycle-a
pnpm agent-os register-agent --agent A2 --role builder
pnpm agent-os register-task --file task.json
pnpm agent-os execute-cycle --max-commands 4 --timeout-seconds 3600
pnpm agent-os status
pnpm agent-os review-queue
pnpm agent-os integration-queue
pnpm agent-os blockers
```

### Resources

```bash
pnpm agent-resource role-policy --agent A2
pnpm agent-resource resource-status --verbose
pnpm agent-resource run \
  --worktree /work/your-project \
  --agent A11 \
  --resource heavy \
  -- pnpm check
```

Persistent development servers and watchers are target-owned and rejected by the resource runner.

### Worker substrate and host validation

```bash
pnpm agent-substrate provision \
  --task task-1 \
  --source /work/your-project \
  --base <full-git-sha> \
  --branch agent/task-1

pnpm agent-substrate host-register --file registration.json
pnpm agent-substrate host-request --file request.json
pnpm agent-substrate host-run --once
pnpm agent-substrate host-status
```

### Process guardian

Every process operation requires an explicit repository. Cleanup is a dry run unless `--apply` is
present.

```bash
pnpm process-guardian process-status --repository /work/your-project
pnpm process-guardian process-cleanup --repository /work/your-project --orphans
pnpm process-guardian process-cleanup --repository /work/your-project --orphans --apply
```

Target adapters should also supply a unique tmux prefix and allowed script roots.

## Runtime configuration

Common environment variables:

| Variable                               | Purpose                                                       |
| -------------------------------------- | ------------------------------------------------------------- |
| `AGENT_OS_CAPABILITIES_PATH`           | Target capability profile.                                    |
| `AGENT_OS_VALIDATION_PROFILE_PATH`     | Target validation profile.                                    |
| `AGENT_OS_ALLOWED_WORKTREE_ROOTS`      | Path-delimited host-validation roots.                         |
| `AGENT_OS_CONTROLLER_DIR`              | Durable controller state directory.                           |
| `AGENT_OS_RUNTIME_DIR`                 | Control-plane runtime directory.                              |
| `AGENT_OS_AGENT_ID`                    | Default worker identity for resource and quality commands.    |
| `AGENT_OS_CODEX_EXECUTABLE`            | Codex-compatible command runner.                              |
| `AGENT_OS_TMUX_SESSION_PREFIX`         | Prefix identifying orchestrator-owned tmux sessions.          |
| `AGENT_OS_SCRIPT_ROOTS`                | Comma-separated target roots admitted for process signatures. |
| `AGENT_OS_MAX_LOAD_RATIO`              | Resource scheduler load threshold.                            |
| `AGENT_OS_AGENT_MIN_FREE_MEMORY_RATIO` | Minimum free-memory ratio.                                    |
| `AGENT_OS_MAX_PROCESSES`               | Host process-count threshold.                                 |

Controller state defaults to `~/.local/state/agent-os`. Temporary worker and validation workspaces
are created below `/tmp` unless configured otherwise.

## Safety model

- Target paths are explicit; Agent OS does not infer a sibling application repository.
- Candidate and validation evidence is bound to full Git SHAs.
- Review runs against a durable, immutable candidate materialization.
- Validation receives only environment names admitted by the target profile.
- Source and Git metadata are read-only inside the Bubblewrap product sandbox.
- Writable validation paths are declared, bounded, disposable scratch mounts.
- Heavy and broad commands require corresponding worker capabilities.
- Process cleanup revalidates PID identity and repository ownership before signalling.
- Operational tooling such as Codex, editor services, and MCP servers is excluded from cleanup.

## Development

```bash
pnpm format:check
pnpm lint
pnpm type-check
pnpm test
pnpm check
```

`pnpm check` is the required local gate and the command run by GitHub Actions.
