// src/agent/host-validation.test.ts
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  dependencyBootstrapCommand,
  dependencyBootstrapEnvironment,
  dependencyPreparationIdentity,
  discoverTurboScratchRoots,
  HostValidationRunner,
  PRODUCT_VALIDATION_CACHE_POLICY,
  productExecutionEnvironment,
  productExecutionIdentity,
  productValidationScratchPolicy,
  productTurboScratchPolicy,
  sandboxedHostCommand,
} from './host-validation';

import type {
  HostValidationCheckId,
  HostValidationPolicy,
  HostValidationRequest,
} from './host-validation';
import type { RunRequest } from './resource-scheduler';
import type { WorkerEnvironmentCapabilities } from './worker-workspace';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const testBootstrapToolIdentity = {
  executable: '/controller-tools/pnpm',
  version: '10.26.2',
};
const TEST_BOOTSTRAP_COMMAND = [
  'pnpm',
  'install',
  '--offline',
  '--frozen-lockfile',
  '--ignore-scripts',
  '--ignore-pnpmfile',
] as const;
const TEST_BOOTSTRAP_ENVIRONMENT = {
  NODE_ENV: 'development',
  NPM_CONFIG_USERCONFIG: '/dev/null',
  NPM_CONFIG_GLOBALCONFIG: '/dev/null',
} as const;
const TEST_DEPENDENCY_FILES = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'turbo.json',
] as const;
const TEST_ENVIRONMENT_NAMES = [
  'PATH',
  'HOME',
  'CI',
  'NODE_ENV',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'XDG_CACHE_HOME',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'DATABASE_URL',
  'POSTGRES_URL',
] as const;
const TEST_DEPENDENCY_IDENTITY_PROFILE = {
  bootstrapCommand: TEST_BOOTSTRAP_COMMAND,
  bootstrapEnvironment: TEST_BOOTSTRAP_ENVIRONMENT,
  dependencyFiles: TEST_DEPENDENCY_FILES,
} as const;

const TEST_VALIDATION_POLICIES = {
  'shared-runtime-health': {
    resource: 'medium',
    command: ['pnpm', 'health-check'],
    requiredHostService: 'shared-runtime',
  },
  'postgres-smoke': {
    resource: 'heavy',
    command: ['pnpm', 'test:postgres-smoke'],
    requiredHostService: 'postgres',
  },
  'real-db': {
    resource: 'heavy',
    command: ['pnpm', 'test:real-db'],
    requiredHostService: 'postgres',
  },
  e2e: {
    resource: 'heavy',
    command: ['pnpm', 'test:e2e'],
    requiredHostService: 'shared-runtime',
  },
  'merge-gate': {
    resource: 'heavy',
    command: ['pnpm', 'ci:merge-gate:local'],
  },
} as const satisfies Readonly<Record<string, HostValidationPolicy>>;

const TEST_SERVICES = {
  'shared-runtime': { host: '127.0.0.1', portEnvironment: 'API_PORT', defaultPort: 8080 },
  postgres: { host: '127.0.0.1', portEnvironment: 'POSTGRES_PORT', defaultPort: 5432 },
} as const;

const TEST_RUNNER_PROFILE = {
  policies: TEST_VALIDATION_POLICIES,
  environmentNames: TEST_ENVIRONMENT_NAMES,
  services: TEST_SERVICES,
  ...TEST_DEPENDENCY_IDENTITY_PROFILE,
} as const;

interface Fixture {
  root: string;
  worktree: string;
  runtimeDir: string;
  sha: string;
  environment: WorkerEnvironmentCapabilities;
}

async function fixture(): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-os-host-validation-test-'));
  temporaryDirectories.push(root);
  const worktree = path.join(root, 'worktree');
  const runtimeDir = path.join(root, 'controller');
  await fs.mkdir(worktree);
  await execFileAsync('git', ['init', '--quiet'], { cwd: worktree });
  await execFileAsync('git', ['config', 'user.name', 'Host Fixture'], {
    cwd: worktree,
  });
  await execFileAsync('git', ['config', 'user.email', 'host@invalid.example'], {
    cwd: worktree,
  });
  await fs.writeFile(path.join(worktree, 'candidate.txt'), 'candidate\n');
  await fs.writeFile(
    path.join(worktree, 'package.json'),
    JSON.stringify({
      name: 'fixture-root',
      private: true,
      packageManager: 'pnpm@10.26.2',
    }),
  );
  await fs.writeFile(
    path.join(worktree, 'pnpm-workspace.yaml'),
    "packages:\n  - 'main/packages/*'\n",
  );
  await execFileAsync('git', ['add', 'candidate.txt', 'package.json', 'pnpm-workspace.yaml'], {
    cwd: worktree,
  });
  await execFileAsync('git', ['commit', '--quiet', '-m', 'candidate'], {
    cwd: worktree,
  });
  const sha = (
    await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: worktree,
      encoding: 'utf8',
    })
  ).stdout.trim();
  const environment: WorkerEnvironmentCapabilities = {
    schemaVersion: 1,
    environmentId: 'cycle-a-validation',
    workspace: worktree,
    gitControlDirectory: path.join(worktree, '.git'),
    branch: 'main',
    baseSha: sha,
    gitCommit: 'DIRECT_WITH_EXPORTED_GIT_DIR',
    hostLoopback: 'UNAVAILABLE',
    sharedRuntime: 'VIA_HOST_VALIDATION_RUNNER',
    postgres: 'VIA_HOST_VALIDATION_RUNNER',
    networkNamespace: 'CODEX_ISOLATED',
    createdAt: '2026-08-15T00:00:00.000Z',
  };
  return { root, worktree, runtimeDir, sha, environment };
}

function request(current: Fixture, checkId: HostValidationCheckId): HostValidationRequest {
  return {
    schemaVersion: 1,
    taskId: 'cycle-a-validation',
    generation: 0,
    requestedBy: 'A14',
    checkId,
    candidateSha: current.sha,
    worktree: current.worktree,
    gitControlDirectory: path.join(current.worktree, '.git'),
    environment: current.environment,
  };
}

async function authorize(
  runner: HostValidationRunner,
  current: Fixture,
  checks: HostValidationCheckId[],
): Promise<void> {
  await runner.registerEnvironment({
    taskId: 'cycle-a-validation',
    generation: 0,
    requestedBy: 'A14',
    worktree: current.worktree,
    gitControlDirectory: path.join(current.worktree, '.git'),
    candidateSha: current.sha,
    allowedChecks: checks,
    eligibility: 'READY_FOR_VALIDATION',
    environment: current.environment,
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

describe('controller-authorized host validation', () => {
  it('supports a repository with no JavaScript package manager or bootstrap step', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-os-generic-validation-test-'));
    temporaryDirectories.push(root);
    await fs.writeFile(
      path.join(root, 'Cargo.toml'),
      '[package]\nname = "fixture"\nversion = "0.1.0"\n',
    );

    const dependency = dependencyPreparationIdentity(root, {
      hostEnvironment: { PATH: '/usr/bin:/bin' },
      bootstrapCommand: [],
      bootstrapEnvironment: {},
      dependencyFiles: ['Cargo.toml', 'Cargo.lock'],
    });

    expect(dependency.command).toEqual([]);
    expect(dependency.bootstrapTool).toEqual({ executable: 'NONE', version: 'NONE' });
    expect(discoverTurboScratchRoots(root)).toEqual([]);
    expect(productValidationScratchPolicy(root, ['target']).mounts).toEqual(['target']);
  });

  it('wraps fixed policy commands in PID/IPC isolation with read-only source', async () => {
    const current = await fixture();
    const command = sandboxedHostCommand(
      request(current, 'shared-runtime-health'),
      TEST_VALIDATION_POLICIES['shared-runtime-health'],
    );
    expect(command.slice(0, 2)).toEqual(['bwrap', '--unshare-pid']);
    expect(command).toEqual(expect.arrayContaining(['--unshare-ipc', '--new-session', '--tmpfs']));
    const cacheMount = command.indexOf(PRODUCT_VALIDATION_CACHE_POLICY.target);
    expect(command[cacheMount - 1]).toBe('--tmpfs');
    expect(PRODUCT_VALIDATION_CACHE_POLICY).toMatchObject({
      mount: 'tmpfs',
      writable: true,
      disposable: true,
    });
    expect(command).toContain(current.worktree);
    expect(command).not.toContain('--bind');
    expect(command).toEqual(
      expect.arrayContaining([
        '--ro-bind',
        current.worktree,
        '/tmp/agent-os-validation-workspace',
        '--ro-bind',
        path.join(current.worktree, '.git'),
        '/tmp/agent-os-validation-git-control',
      ]),
    );
    expect(command.slice(-2)).toEqual(['pnpm', 'health-check']);
    const policyTokens = Object.values(TEST_VALIDATION_POLICIES).flatMap(
      (policy) => policy.command,
    );
    for (const forbidden of ['dev', 'start', 'stop', 'restart', 'docker']) {
      expect(policyTokens).not.toContain(forbidden);
    }
  });

  it('fails closed on workspace patterns and symlinks that escape package-root authority', async () => {
    const current = await fixture();
    await fs.writeFile(
      path.join(current.worktree, 'pnpm-workspace.yaml'),
      "packages:\n  - '../outside/*'\n",
    );
    expect(() => discoverTurboScratchRoots(current.worktree)).toThrow(/Unsafe pnpm workspace/iu);

    await fs.writeFile(
      path.join(current.worktree, 'pnpm-workspace.yaml'),
      "packages:\n  - '/tmp/outside/*'\n",
    );
    expect(() => discoverTurboScratchRoots(current.worktree)).toThrow(/Unsafe pnpm workspace/iu);

    const outside = path.join(current.root, 'outside-package');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'package.json'), JSON.stringify({ name: 'outside' }));
    await fs.mkdir(path.join(current.worktree, 'packages'));
    await fs.symlink(outside, path.join(current.worktree, 'packages', 'escape'));
    await fs.writeFile(
      path.join(current.worktree, 'pnpm-workspace.yaml'),
      "packages:\n  - 'packages/*'\n",
    );
    expect(() => discoverTurboScratchRoots(current.worktree)).toThrow(/traversed a symlink/iu);
  });

  it('binds only effective workspace roots, not incidental Turbo bytes, into execution identity', async () => {
    const current = await fixture();
    const hostEnvironment = { PATH: '/trusted/bin', HOME: '/trusted/home' };
    const dependency = dependencyPreparationIdentity(current.worktree, {
      ...TEST_DEPENDENCY_IDENTITY_PROFILE,
      hostEnvironment,
      bootstrapTool: testBootstrapToolIdentity,
    });
    const policy = TEST_VALIDATION_POLICIES['shared-runtime-health'];
    const initial = productExecutionIdentity(
      request(current, 'shared-runtime-health'),
      policy,
      dependency.key,
      hostEnvironment,
    );

    const workspacePackage = path.join(current.worktree, 'main/packages/approved');
    await fs.mkdir(path.join(workspacePackage, '.turbo'), { recursive: true });
    await fs.writeFile(
      path.join(workspacePackage, 'package.json'),
      JSON.stringify({ name: '@fixture/approved' }),
    );
    const approved = productExecutionIdentity(
      request(current, 'shared-runtime-health'),
      policy,
      dependency.key,
      hostEnvironment,
    );
    expect(approved.key).not.toBe(initial.key);
    expect(approved.turboScratchPolicy.roots).toContain('main/packages/approved');

    await fs.writeFile(path.join(workspacePackage, '.turbo/incidental'), 'disposable bytes');
    await fs.mkdir(path.join(workspacePackage, '.turbo/fake-package'));
    await fs.writeFile(
      path.join(workspacePackage, '.turbo/fake-package/package.json'),
      JSON.stringify({ name: '@fixture/incidental-cache-package' }),
    );
    await fs.writeFile(
      path.join(current.worktree, 'pnpm-workspace.yaml'),
      "packages:\n  - 'main/packages/**'\n",
    );
    const changedBytes = productExecutionIdentity(
      request(current, 'shared-runtime-health'),
      policy,
      dependency.key,
      hostEnvironment,
    );
    expect(changedBytes.key).toBe(approved.key);

    const nonWorkspace = path.join(current.worktree, 'examples/not-workspace');
    await fs.mkdir(nonWorkspace, { recursive: true });
    await fs.writeFile(
      path.join(nonWorkspace, 'package.json'),
      JSON.stringify({ name: '@fixture/not-workspace' }),
    );
    const ignoredPackage = productExecutionIdentity(
      request(current, 'shared-runtime-health'),
      policy,
      dependency.key,
      hostEnvironment,
    );
    expect(ignoredPackage.key).toBe(approved.key);

    await fs.writeFile(
      path.join(current.worktree, 'pnpm-workspace.yaml'),
      "packages:\n  - 'main/packages/*'\n  - 'examples/*'\n",
    );
    const expandedPolicy = productExecutionIdentity(
      request(current, 'shared-runtime-health'),
      policy,
      dependency.key,
      hostEnvironment,
    );
    expect(expandedPolicy.key).not.toBe(approved.key);
    expect(expandedPolicy.turboScratchPolicy.roots).toContain('examples/not-workspace');
  });

  it('binds configured cache authority, not incidental ancestor directories, into identity', async () => {
    const current = await fixture();
    await fs.mkdir(path.join(current.worktree, 'main/packages/approved'), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(current.worktree, 'main/packages/approved/package.json'),
      JSON.stringify({
        name: '@fixture/approved',
        scripts: { lint: 'node -e ""' },
      }),
    );
    await fs.writeFile(
      path.join(current.worktree, 'pnpm-workspace.yaml'),
      "packages:\n  - 'main/packages/*'\n",
    );
    const dependency = dependencyPreparationIdentity(current.worktree, {
      ...TEST_DEPENDENCY_IDENTITY_PROFILE,
      hostEnvironment: { PATH: '/trusted/bin', HOME: '/trusted/home' },
      bootstrapTool: testBootstrapToolIdentity,
    });
    const policy = TEST_VALIDATION_POLICIES['shared-runtime-health'];
    const base = productExecutionIdentity(
      request(current, 'shared-runtime-health'),
      policy,
      dependency.key,
      { PATH: '/trusted/bin', HOME: '/trusted/home' },
    );
    await fs.mkdir(path.join(current.worktree, 'main/node_modules/.cache/unconfigured'), {
      recursive: true,
    });
    const filesystemOnly = productExecutionIdentity(
      request(current, 'shared-runtime-health'),
      policy,
      dependency.key,
      { PATH: '/trusted/bin', HOME: '/trusted/home' },
    );
    expect(filesystemOnly.key).toBe(base.key);
    expect(filesystemOnly.validationToolScratchPolicy.mounts).not.toContain(
      'main/node_modules/.cache/unconfigured',
    );

    await fs.writeFile(
      path.join(current.worktree, 'main/packages/approved/package.json'),
      JSON.stringify({
        name: '@fixture/approved',
        scripts: {
          lint: 'eslint . --cache --cache-location ../../node_modules/.cache/eslint/.fixture',
        },
      }),
    );
    const configured = productExecutionIdentity(
      request(current, 'shared-runtime-health'),
      policy,
      dependency.key,
      { PATH: '/trusted/bin', HOME: '/trusted/home' },
    );
    expect(configured.key).not.toBe(base.key);
    expect(configured.validationToolScratchPolicy.mounts).toContain(
      'main/node_modules/.cache/eslint',
    );

    await fs.writeFile(
      path.join(current.worktree, 'main/packages/approved/package.json'),
      JSON.stringify({
        name: '@fixture/approved',
        scripts: {
          lint: 'eslint . --cache --cache-location ../../../outside/.cache/file',
        },
      }),
    );
    expect(() => productValidationScratchPolicy(current.worktree)).toThrow(
      /escaped|outside node_modules/iu,
    );
    await fs.writeFile(
      path.join(current.worktree, 'main/packages/approved/package.json'),
      JSON.stringify({
        name: '@fixture/approved',
        scripts: {
          lint: 'eslint . --cache --cache-location /tmp/outside/.cache/file',
        },
      }),
    );
    expect(() => productValidationScratchPolicy(current.worktree)).toThrow(/unsafe/iu);
  });

  it('runs an attested product launcher with writable tool cache and immutable authority', async () => {
    const current = await fixture();
    const packageRoots = ['main/apps/portal', 'main/server/comms'];
    const deniedTurboRoots = ['examples/not-workspace', 'main/apps/excluded'];
    await fs.writeFile(
      path.join(current.worktree, 'pnpm-workspace.yaml'),
      "packages:\n  - 'main/apps/*'\n  - 'main/server/*'\n  - '!main/apps/excluded'\n",
    );
    await fs.writeFile(
      path.join(current.worktree, 'turbo.json'),
      JSON.stringify({ tasks: { lint: { cache: true } } }),
    );
    for (const packageRoot of packageRoots) {
      const directory = path.join(current.worktree, packageRoot);
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(
        path.join(directory, 'package.json'),
        JSON.stringify({
          name: `@fixture/${path.basename(directory)}`,
          scripts:
            packageRoot === 'main/apps/portal'
              ? {
                  lint: 'node -e ""',
                  'lint:configured':
                    'eslint . --cache --cache-location ../../node_modules/.cache/eslint/.eslintcache-fixture',
                }
              : { lint: 'node -e ""' },
        }),
      );
      await fs.mkdir(path.join(directory, 'src'));
      if (packageRoot === 'main/apps/portal') {
        await fs.writeFile(path.join(directory, 'src', 'valid.js'), 'export const valid = true;\n');
      }
    }
    for (const packageRoot of deniedTurboRoots) {
      const directory = path.join(current.worktree, packageRoot);
      await fs.mkdir(path.join(directory, '.turbo'), { recursive: true });
      await fs.writeFile(
        path.join(directory, 'package.json'),
        JSON.stringify({ name: `@fixture/${path.basename(directory)}` }),
      );
    }
    await fs.mkdir(path.join(current.worktree, 'node_modules', '.pnpm'), {
      recursive: true,
    });
    await fs.mkdir(path.join(current.worktree, 'node_modules', '.cache'), {
      recursive: true,
    });
    await fs.mkdir(path.join(current.worktree, 'node_modules', 'example'));
    await fs.writeFile(
      path.join(current.worktree, 'node_modules', 'example', 'index.js'),
      'module',
    );
    await fs.mkdir(path.join(current.worktree, '.turbo'), { recursive: true });
    for (const packageRoot of packageRoots) {
      await fs.mkdir(path.join(current.worktree, packageRoot, '.turbo'), {
        recursive: true,
      });
    }
    for (const relativePath of productValidationScratchPolicy(current.worktree).mounts) {
      await fs.mkdir(path.join(current.worktree, ...relativePath.split('/')), {
        recursive: true,
      });
    }
    expect(discoverTurboScratchRoots(current.worktree)).toEqual(['', ...packageRoots]);
    const turboPolicy = productTurboScratchPolicy(current.worktree);
    expect(turboPolicy.roots).toEqual(['', ...packageRoots]);
    expect(turboPolicy.roots.every((root) => !path.isAbsolute(root) && !root.includes('..'))).toBe(
      true,
    );
    const scratchPolicy = productValidationScratchPolicy(current.worktree);
    expect(scratchPolicy.mounts).toEqual(
      expect.arrayContaining([
        'node_modules/.cache',
        'main/node_modules/.cache/eslint',
        'main/apps/portal/node_modules/.cache',
        'main/apps/portal/node_modules/.vite-temp',
        'main/apps/portal/.turbo',
        'main/server/comms/.turbo',
      ]),
    );
    expect(scratchPolicy.mounts).not.toContain('main/apps/portal/node_modules');
    expect(scratchPolicy.mounts).not.toContain('node_modules/.pnpm');
    const originalSha = current.sha;
    const originalTree = (
      await execFileAsync('git', ['rev-parse', `${current.sha}^{tree}`], {
        cwd: current.worktree,
        encoding: 'utf8',
      })
    ).stdout.trim();
    const turboCli = await fs.realpath(path.resolve('node_modules/turbo/bin/turbo'));
    const vitestCli = await fs.realpath(path.resolve('node_modules/vitest/vitest.mjs'));
    const tscCli = await fs.realpath(path.resolve('node_modules/typescript/bin/tsc'));
    const eslintCli = await fs.realpath(path.resolve('node_modules/eslint/bin/eslint.js'));
    const pnpmExecutable = (
      await execFileAsync('which', ['pnpm'], { encoding: 'utf8' })
    ).stdout.trim();
    await fs.writeFile(
      path.join(current.worktree, 'main/apps/portal/vitest.config.mjs'),
      'export default { test: { globals: true, include: ["test/**/*.test.js"] } };\n',
    );
    await fs.mkdir(path.join(current.worktree, 'main/apps/portal/test'), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(current.worktree, 'main/apps/portal/test/scratch.test.js'),
      'it("loads through Vitest", () => {});\n',
    );
    await fs.writeFile(
      path.join(current.worktree, 'main/apps/portal/tsconfig.scratch.json'),
      JSON.stringify({
        compilerOptions: {
          allowJs: true,
          checkJs: false,
          noEmit: true,
          incremental: true,
          tsBuildInfoFile: 'node_modules/.cache/typescript/scratch.tsbuildinfo',
        },
        include: ['src/**/*.js'],
      }),
    );
    await fs.writeFile(
      path.join(current.worktree, 'eslint.config.mjs'),
      'export default [{ files: ["**/*.js"], rules: {} }];\n',
    );
    const productProbe = [
      process.execPath,
      '-e',
      `const fs=require('node:fs');const cp=require('node:child_process');
fs.writeFileSync('node_modules/.cache/turbo','cache-ok');
fs.writeFileSync('main/apps/portal/node_modules/.vite-temp/vite-temp','vite-ok');
fs.mkdirSync('main/apps/portal/node_modules/.cache/typescript',{recursive:true});
fs.writeFileSync('main/apps/portal/node_modules/.cache/typescript/manual','ts-ok');
fs.writeFileSync('main/node_modules/.cache/eslint/manual','eslint-ok');
fs.writeFileSync('main/apps/portal/.turbo/log','portal-log');
fs.writeFileSync('main/server/comms/.turbo/log','comms-log');
cp.execFileSync(process.execPath,[${JSON.stringify(turboCli)},'run','lint'],{stdio:'ignore'});
cp.execFileSync(process.execPath,[${JSON.stringify(vitestCli)},'run','--root','main/apps/portal','--config','vitest.config.mjs'],{stdio:'inherit'});
cp.execFileSync(process.execPath,[${JSON.stringify(tscCli)},'--project','main/apps/portal/tsconfig.scratch.json'],{stdio:'inherit'});
cp.execFileSync(process.execPath,[${JSON.stringify(eslintCli)},'--cache','--cache-location','main/node_modules/.cache/eslint/.cache','main/apps/portal/test/scratch.test.js'],{stdio:'ignore'});
let denied=0;for(const file of ['candidate.txt','node_modules/.pnpm/write-denied','node_modules/example/index.js','main/apps/portal/node_modules/random-write']){try{fs.writeFileSync(file,'changed')}catch{denied++}}
for(const file of ['main/apps/portal/sibling-denied','main/server/comms/sibling-denied']){try{fs.writeFileSync(file,'changed')}catch{denied++}}
for(const file of ['main/apps/portal/src/write-denied','main/apps/portal/package.json','examples/not-workspace/.turbo/write-denied','main/apps/excluded/.turbo/write-denied']){try{fs.writeFileSync(file,'changed')}catch{denied++}}
try{cp.execFileSync('git',['update-ref','refs/heads/agent-os-sandbox-write-denied','HEAD'],{stdio:'ignore'})}catch{denied++}
try{cp.execFileSync('git',['add','package.json'],{stdio:'ignore'})}catch{denied++}
if(denied!==12||fs.readFileSync('node_modules/.cache/turbo','utf8')!=='cache-ok'||fs.readFileSync('main/apps/portal/node_modules/.vite-temp/vite-temp','utf8')!=='vite-ok'||fs.readFileSync('main/apps/portal/node_modules/.cache/typescript/manual','utf8')!=='ts-ok'||fs.readFileSync('main/node_modules/.cache/eslint/manual','utf8')!=='eslint-ok'||fs.readFileSync('main/apps/portal/.turbo/log','utf8')!=='portal-log'||fs.readFileSync('main/server/comms/.turbo/log','utf8')!=='comms-log')process.exit(1);process.stdout.write('sandbox-product-started\\n');`,
    ] as const;
    const command = sandboxedHostCommand(
      request(current, 'shared-runtime-health'),
      TEST_VALIDATION_POLICIES['shared-runtime-health'],
      productProbe,
    );
    const executable = command[0];
    if (executable === undefined) throw new Error('sandbox command is empty');
    const result = await execFileAsync(executable, command.slice(1), {
      cwd: current.worktree,
      env: {
        ...productExecutionEnvironment(
          {
            PATH: `${path.dirname(process.execPath)}:${path.dirname(pnpmExecutable)}:/usr/bin:/bin`,
          },
          current.environment.gitControlDirectory,
        ),
        AGENT_OS_PRODUCT_ATTESTATION_TOKEN: 'sandbox-test-token',
      },
      encoding: 'utf8',
    });
    expect(result.stderr).toBe('');
    await expect(
      fs.lstat(path.join(current.worktree, 'main/apps/portal/.turbo/log')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(
      (
        await execFileAsync('git', ['rev-parse', 'HEAD'], {
          cwd: current.worktree,
          encoding: 'utf8',
        })
      ).stdout.trim(),
    ).toBe(originalSha);
    expect(
      (
        await execFileAsync('git', ['rev-parse', `${originalSha}^{tree}`], {
          cwd: current.worktree,
          encoding: 'utf8',
        })
      ).stdout.trim(),
    ).toBe(originalTree);
  });

  it('refuses to masquerade a Codex sandbox as the host runner', async () => {
    const current = await fixture();
    const runner = new HostValidationRunner({
      ...TEST_RUNNER_PROFILE,
      allowUnsafeTestRuntime: true,
      runtimeDir: current.runtimeDir,
      allowedWorktreeRoots: [current.root],
      hostEnvironment: { CODEX_SANDBOX_NETWORK_DISABLED: '1' },
    });
    await authorize(runner, current, ['shared-runtime-health']);
    await runner.request(request(current, 'shared-runtime-health'));
    await expect(runner.runNext()).rejects.toThrow(/founder-owned host environment/iu);
    expect((await runner.state()).jobs[0]?.status).toBe('QUEUED');
  });

  it('separates host-service unreachability from product failure', async () => {
    const current = await fixture();
    const execute = vi.fn(async () => ({
      exitCode: 7,
      resourceJobId: 'resource-1',
    }));
    const runner = new HostValidationRunner({
      ...TEST_RUNNER_PROFILE,
      allowUnsafeTestRuntime: true,
      runtimeDir: current.runtimeDir,
      allowedWorktreeRoots: [current.root],
      hostEnvironment: {},
      probeService: async () => false,
      execute,
    });
    await authorize(runner, current, ['postgres-smoke']);
    await runner.request(request(current, 'postgres-smoke'));
    await expect(runner.runNext()).resolves.toMatchObject({
      status: 'HOST_SERVICE_UNREACHABLE',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('classifies missing offline dependencies as infrastructure blocked before product logic', async () => {
    const current = await fixture();
    const runResourceJob = vi.fn(async () => ({
      exitCode: 1,
      job: { id: 'dependency-bootstrap-resource' },
    }));
    const runner = new HostValidationRunner({
      ...TEST_RUNNER_PROFILE,
      allowUnsafeTestRuntime: true,
      runtimeDir: current.runtimeDir,
      allowedWorktreeRoots: [current.root],
      hostEnvironment: {},
      probeService: async () => true,
      runResourceJob,
      bootstrapToolIdentity: testBootstrapToolIdentity,
    });
    await authorize(runner, current, ['shared-runtime-health']);
    await runner.request(request(current, 'shared-runtime-health'));
    await expect(runner.runNext()).resolves.toMatchObject({
      status: 'ENVIRONMENT_BLOCKED',
      exitCode: 1,
      resourceJobId: 'dependency-bootstrap-resource',
      summary: expect.stringContaining('DEPENDENCY_BOOTSTRAP_FAILED'),
    });
    expect(runResourceJob).toHaveBeenCalledOnce();
    expect(runResourceJob).toHaveBeenCalledWith(
      expect.objectContaining({
        command: dependencyBootstrapCommand(TEST_BOOTSTRAP_COMMAND),
        childEnvironmentMode: 'replace',
        resource: 'medium',
      }),
    );
    expect(dependencyBootstrapCommand(TEST_BOOTSTRAP_COMMAND)).toEqual([
      'pnpm',
      'install',
      '--offline',
      '--frozen-lockfile',
      '--ignore-scripts',
      '--ignore-pnpmfile',
    ]);
  });

  it('uses a fixed bootstrap environment and binds tool/environment identity to host jobs', async () => {
    const current = await fixture();
    const ambientOne = {
      PATH: '/trusted/bin',
      HOME: '/trusted/home',
      PNPM_HOME: '/ambient/pnpm-one',
      NPM_CONFIG_PRODUCTION: 'true',
    };
    const ambientTwo = {
      ...ambientOne,
      PNPM_HOME: '/ambient/pnpm-two',
      NPM_CONFIG_PRODUCTION: 'false',
    };
    const firstIdentity = dependencyPreparationIdentity(current.worktree, {
      ...TEST_DEPENDENCY_IDENTITY_PROFILE,
      hostEnvironment: ambientOne,
      bootstrapTool: testBootstrapToolIdentity,
    });
    const sanitized = dependencyBootstrapEnvironment(ambientOne, TEST_BOOTSTRAP_ENVIRONMENT);

    expect(sanitized).not.toHaveProperty('PNPM_HOME');
    expect(sanitized).not.toHaveProperty('NPM_CONFIG_PRODUCTION');
    expect(sanitized).toMatchObject({
      CI: 'true',
      NODE_ENV: 'development',
      NPM_CONFIG_USERCONFIG: '/dev/null',
      NPM_CONFIG_GLOBALCONFIG: '/dev/null',
    });
    expect(
      dependencyPreparationIdentity(current.worktree, {
        ...TEST_DEPENDENCY_IDENTITY_PROFILE,
        hostEnvironment: ambientTwo,
        bootstrapTool: testBootstrapToolIdentity,
      }).key,
    ).toBe(firstIdentity.key);
    expect(
      dependencyPreparationIdentity(current.worktree, {
        ...TEST_DEPENDENCY_IDENTITY_PROFILE,
        hostEnvironment: ambientOne,
        bootstrapTool: { ...testBootstrapToolIdentity, version: '10.27.0' },
      }).key,
    ).not.toBe(firstIdentity.key);
    expect(
      dependencyPreparationIdentity(current.worktree, {
        ...TEST_DEPENDENCY_IDENTITY_PROFILE,
        hostEnvironment: { ...ambientOne, PATH: '/different/trusted/bin' },
        bootstrapTool: testBootstrapToolIdentity,
      }).key,
    ).not.toBe(firstIdentity.key);

    const runnerOne = new HostValidationRunner({
      ...TEST_RUNNER_PROFILE,
      allowUnsafeTestRuntime: true,
      runtimeDir: current.runtimeDir,
      allowedWorktreeRoots: [current.root],
      hostEnvironment: ambientOne,
      bootstrapToolIdentity: testBootstrapToolIdentity,
      probeService: async () => true,
      execute: async () => ({ exitCode: 0, resourceJobId: 'identity-pass' }),
    });
    await authorize(runnerOne, current, ['shared-runtime-health']);
    const firstJob = await runnerOne.request(request(current, 'shared-runtime-health'));
    expect(firstJob.dependencyPreparationKey).toBe(firstIdentity.key);
    await expect(runnerOne.runNext()).resolves.toMatchObject({
      status: 'PASS',
    });

    const runnerTwo = new HostValidationRunner({
      ...TEST_RUNNER_PROFILE,
      allowUnsafeTestRuntime: true,
      runtimeDir: current.runtimeDir,
      allowedWorktreeRoots: [current.root],
      hostEnvironment: ambientOne,
      bootstrapToolIdentity: { ...testBootstrapToolIdentity, version: '10.27.0' },
    });
    const secondJob = await runnerTwo.request(request(current, 'shared-runtime-health'));
    expect(secondJob.status).toBe('QUEUED');
    expect(secondJob.id).not.toBe(firstJob.id);
    expect(secondJob.dependencyPreparationKey).not.toBe(firstJob.dependencyPreparationKey);
    expect(secondJob.environmentFingerprint).toBe(firstJob.environmentFingerprint);
    expect(secondJob.productExecutionKey).not.toBe(firstJob.productExecutionKey);
  });

  it('runs bootstrap then an attested successful product command on the default path', async () => {
    const current = await fixture();
    const calls: RunRequest[] = [];
    const runResourceJob = vi.fn(async (input: RunRequest) => {
      calls.push(input);
      return calls.length === 1
        ? { exitCode: 0, job: { id: 'bootstrap-pass' } }
        : {
            exitCode: 0,
            job: { id: 'product-pass' },
            execution: { productStarted: true, source: 'ATTESTED' as const },
          };
    });
    const runner = new HostValidationRunner({
      ...TEST_RUNNER_PROFILE,
      allowUnsafeTestRuntime: true,
      runtimeDir: current.runtimeDir,
      allowedWorktreeRoots: [current.root],
      hostEnvironment: { PATH: '/trusted/bin', HOME: '/trusted/home' },
      probeService: async () => true,
      runResourceJob,
      bootstrapToolIdentity: testBootstrapToolIdentity,
    });
    await authorize(runner, current, ['shared-runtime-health']);
    const queued = await runner.request(request(current, 'shared-runtime-health'));

    await expect(runner.runNext()).resolves.toMatchObject({
      status: 'PASS',
      exitCode: 0,
      resourceJobId: 'product-pass',
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      command: dependencyBootstrapCommand(TEST_BOOTSTRAP_COMMAND),
      resource: 'medium',
      reuseEligible: false,
      childEnvironmentMode: 'replace',
    });
    expect(calls[1]).toMatchObject({
      resource: 'medium',
      reuseEligible: true,
      executionAttestationRequired: true,
      childEnvironmentMode: 'replace',
    });
    expect(calls[1]?.environmentKey).not.toBe(calls[0]?.environmentKey);
    expect(calls[0]?.environmentKey).toBe(queued.dependencyPreparationKey);
    expect(calls[1]?.environmentKey).toBe(queued.productExecutionKey);
    expect(calls[1]?.childEnvironment).toMatchObject({
      CI: 'true',
      TMPDIR: '/tmp',
      XDG_CACHE_HOME: '/tmp/cache',
    });
    expect(calls[1]?.childEnvironment).not.toHaveProperty('DATABASE_URL');
    expect(calls[1]?.executionAttestation?.token).toBe(
      calls[1]?.childEnvironment?.['AGENT_OS_PRODUCT_ATTESTATION_TOKEN'],
    );
    await expect(fs.lstat(path.join(current.worktree, 'node_modules'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('separates dependency preparation from secret-safe product target identity', async () => {
    const current = await fixture();
    const databaseA = 'postgresql://user:secret-a@db-a.example/fixture';
    const databaseB = 'postgresql://user:secret-b@db-b.example/fixture';
    const dependencyA = dependencyPreparationIdentity(current.worktree, {
      ...TEST_DEPENDENCY_IDENTITY_PROFILE,
      hostEnvironment: { DATABASE_URL: databaseA, POSTGRES_URL: databaseA },
      bootstrapTool: testBootstrapToolIdentity,
    });
    const dependencyB = dependencyPreparationIdentity(current.worktree, {
      ...TEST_DEPENDENCY_IDENTITY_PROFILE,
      hostEnvironment: { DATABASE_URL: databaseB, POSTGRES_URL: databaseB },
      bootstrapTool: testBootstrapToolIdentity,
    });
    expect(dependencyB.key).toBe(dependencyA.key);

    const requestA = request(current, 'real-db');
    const productA = productExecutionIdentity(
      requestA,
      TEST_VALIDATION_POLICIES['real-db'],
      dependencyA.key,
      { DATABASE_URL: databaseA, POSTGRES_URL: databaseA },
      TEST_ENVIRONMENT_NAMES,
    );
    const productB = productExecutionIdentity(
      requestA,
      TEST_VALIDATION_POLICIES['real-db'],
      dependencyB.key,
      { DATABASE_URL: databaseB, POSTGRES_URL: databaseB },
      TEST_ENVIRONMENT_NAMES,
    );
    expect(productB.key).not.toBe(productA.key);
    expect(productB.environmentFingerprint).not.toContain(databaseB);
    expect(productB.environmentFingerprint).not.toContain('secret-b');
    expect(productA.sandboxCachePolicy).toEqual(productB.sandboxCachePolicy);
    expect(productA.key).toBe(
      productExecutionIdentity(
        requestA,
        TEST_VALIDATION_POLICIES['real-db'],
        dependencyA.key,
        {
          DATABASE_URL: databaseA,
          POSTGRES_URL: databaseA,
        },
        TEST_ENVIRONMENT_NAMES,
      ).key,
    );

    const admitted = productExecutionEnvironment(
      {
        DATABASE_URL: databaseA,
        POSTGRES_URL: databaseA,
        IRRELEVANT_AMBIENT_VALUE: 'must-not-run',
      },
      undefined,
      TEST_ENVIRONMENT_NAMES,
    );
    expect(admitted).toMatchObject({
      DATABASE_URL: databaseA,
      POSTGRES_URL: databaseA,
    });
    expect(admitted).not.toHaveProperty('IRRELEVANT_AMBIENT_VALUE');
    expect(
      productExecutionIdentity(
        requestA,
        TEST_VALIDATION_POLICIES['real-db'],
        dependencyA.key,
        {
          DATABASE_URL: databaseA,
          POSTGRES_URL: databaseA,
          IRRELEVANT_AMBIENT_VALUE: 'one',
        },
        TEST_ENVIRONMENT_NAMES,
      ).key,
    ).toBe(
      productExecutionIdentity(
        requestA,
        TEST_VALIDATION_POLICIES['real-db'],
        dependencyA.key,
        {
          DATABASE_URL: databaseA,
          POSTGRES_URL: databaseA,
          IRRELEVANT_AMBIENT_VALUE: 'two',
        },
        TEST_ENVIRONMENT_NAMES,
      ).key,
    );
  });

  it('does not reuse a compatible PASS when the required service is currently unreachable', async () => {
    const current = await fixture();
    const execute = vi.fn(async () => ({
      exitCode: 0,
      resourceJobId: 'product-pass',
    }));
    const passingRunner = new HostValidationRunner({
      ...TEST_RUNNER_PROFILE,
      allowUnsafeTestRuntime: true,
      runtimeDir: current.runtimeDir,
      allowedWorktreeRoots: [current.root],
      hostEnvironment: { DATABASE_URL: 'postgresql://same-target/fixture' },
      probeService: async () => true,
      execute,
      bootstrapToolIdentity: testBootstrapToolIdentity,
    });
    await authorize(passingRunner, current, ['real-db']);
    await passingRunner.request(request(current, 'real-db'));
    await expect(passingRunner.runNext()).resolves.toMatchObject({
      status: 'PASS',
    });

    const unavailableExecute = vi.fn(async () => ({
      exitCode: 0,
      resourceJobId: 'must-not-run',
    }));
    const unavailableRunner = new HostValidationRunner({
      ...TEST_RUNNER_PROFILE,
      allowUnsafeTestRuntime: true,
      runtimeDir: current.runtimeDir,
      allowedWorktreeRoots: [current.root],
      hostEnvironment: { DATABASE_URL: 'postgresql://same-target/fixture' },
      probeService: async () => false,
      execute: unavailableExecute,
      bootstrapToolIdentity: testBootstrapToolIdentity,
    });
    const queued = await unavailableRunner.request(request(current, 'real-db'));
    expect(queued.status).toBe('QUEUED');
    await expect(unavailableRunner.runNext()).resolves.toMatchObject({
      status: 'HOST_SERVICE_UNREACHABLE',
    });
    expect(unavailableExecute).not.toHaveBeenCalled();
  });

  it('passes the exact admitted product environment represented by the execution identity', async () => {
    const current = await fixture();
    const productEnvironment = {
      DATABASE_URL: 'postgresql://user:secret@db.example/fixture',
      POSTGRES_URL: 'postgresql://user:secret@db.example/fixture',
    };
    let captured: Record<string, string> | undefined;
    const runner = new HostValidationRunner({
      ...TEST_RUNNER_PROFILE,
      allowUnsafeTestRuntime: true,
      runtimeDir: current.runtimeDir,
      allowedWorktreeRoots: [current.root],
      hostEnvironment: productEnvironment,
      probeService: async () => true,
      execute: async (input) => {
        captured = input.productEnvironment;
        return { exitCode: 0, resourceJobId: 'product-env-pass' };
      },
      bootstrapToolIdentity: testBootstrapToolIdentity,
    });
    await authorize(runner, current, ['real-db']);
    const queued = await runner.request(request(current, 'real-db'));
    await expect(runner.runNext()).resolves.toMatchObject({ status: 'PASS' });
    expect(captured).toEqual(
      productExecutionEnvironment(
        productEnvironment,
        current.environment.gitControlDirectory,
        TEST_ENVIRONMENT_NAMES,
      ),
    );
    const dependency = dependencyPreparationIdentity(current.worktree, {
      ...TEST_DEPENDENCY_IDENTITY_PROFILE,
      hostEnvironment: productEnvironment,
      bootstrapTool: testBootstrapToolIdentity,
    });
    expect(queued.environmentFingerprint).toBe(
      productExecutionIdentity(
        request(current, 'real-db'),
        TEST_VALIDATION_POLICIES['real-db'],
        dependency.key,
        productEnvironment,
        TEST_ENVIRONMENT_NAMES,
      ).environmentFingerprint,
    );
  });

  it('classifies an attested nonzero product exit as product failure', async () => {
    const current = await fixture();
    let invocation = 0;
    const runResourceJob = vi.fn(async () => {
      invocation += 1;
      return invocation === 1
        ? { exitCode: 0, job: { id: 'bootstrap-pass' } }
        : {
            exitCode: 9,
            job: { id: 'product-failure' },
            execution: { productStarted: true, source: 'ATTESTED' as const },
          };
    });
    const runner = new HostValidationRunner({
      ...TEST_RUNNER_PROFILE,
      allowUnsafeTestRuntime: true,
      runtimeDir: current.runtimeDir,
      allowedWorktreeRoots: [current.root],
      hostEnvironment: {},
      probeService: async () => true,
      runResourceJob,
      bootstrapToolIdentity: testBootstrapToolIdentity,
    });
    await authorize(runner, current, ['shared-runtime-health']);
    await runner.request(request(current, 'shared-runtime-health'));

    await expect(runner.runNext()).resolves.toMatchObject({
      status: 'TARGET_TEST_FAILURE',
      exitCode: 9,
      resourceJobId: 'product-failure',
    });
    expect(runResourceJob).toHaveBeenCalledTimes(2);
  });

  it('classifies an unattested pre-product sandbox failure as environment blocked', async () => {
    const current = await fixture();
    let invocation = 0;
    const runResourceJob = vi.fn(async () => {
      invocation += 1;
      return invocation === 1
        ? { exitCode: 0, job: { id: 'bootstrap-pass' } }
        : {
            exitCode: 1,
            job: { id: 'sandbox-failure' },
            execution: {
              productStarted: false,
              source: 'ATTESTED' as const,
              failure: 'bubblewrap mount setup failed',
            },
          };
    });
    const runner = new HostValidationRunner({
      ...TEST_RUNNER_PROFILE,
      allowUnsafeTestRuntime: true,
      runtimeDir: current.runtimeDir,
      allowedWorktreeRoots: [current.root],
      hostEnvironment: {},
      probeService: async () => true,
      runResourceJob,
      bootstrapToolIdentity: testBootstrapToolIdentity,
    });
    await authorize(runner, current, ['shared-runtime-health']);
    await runner.request(request(current, 'shared-runtime-health'));

    await expect(runner.runNext()).resolves.toMatchObject({
      status: 'ENVIRONMENT_BLOCKED',
      exitCode: 1,
      resourceJobId: 'sandbox-failure',
      summary: expect.stringContaining('PRODUCT_EXECUTION_NOT_STARTED'),
    });
    expect(runResourceJob).toHaveBeenCalledTimes(2);
  });

  it('classifies a sandbox executable launch error as environment blocked', async () => {
    const current = await fixture();
    let invocation = 0;
    const runResourceJob = vi.fn(async () => {
      invocation += 1;
      if (invocation === 1) return { exitCode: 0, job: { id: 'bootstrap-pass' } };
      throw new Error('spawn bwrap ENOENT');
    });
    const runner = new HostValidationRunner({
      ...TEST_RUNNER_PROFILE,
      allowUnsafeTestRuntime: true,
      runtimeDir: current.runtimeDir,
      allowedWorktreeRoots: [current.root],
      hostEnvironment: {},
      probeService: async () => true,
      runResourceJob,
      bootstrapToolIdentity: testBootstrapToolIdentity,
    });
    await authorize(runner, current, ['shared-runtime-health']);
    await runner.request(request(current, 'shared-runtime-health'));

    await expect(runner.runNext()).resolves.toMatchObject({
      status: 'ENVIRONMENT_BLOCKED',
      summary: expect.stringContaining('spawn bwrap ENOENT'),
    });
    expect(runResourceJob).toHaveBeenCalledTimes(2);
  });

  it('rejects unregistered requester, SHA, check, and symlink roots', async () => {
    const current = await fixture();
    const runner = new HostValidationRunner({
      ...TEST_RUNNER_PROFILE,
      allowUnsafeTestRuntime: true,
      runtimeDir: current.runtimeDir,
      allowedWorktreeRoots: [current.root],
      hostEnvironment: {},
    });
    await authorize(runner, current, ['shared-runtime-health']);
    await expect(
      runner.request({
        ...request(current, 'shared-runtime-health'),
        requestedBy: 'forged-worker',
      }),
    ).rejects.toThrow(/not authorized/iu);
    await expect(
      runner.request({
        ...request(current, 'shared-runtime-health'),
        candidateSha: 'b'.repeat(40),
      }),
    ).rejects.toThrow(/not authorized/iu);
    await expect(runner.request(request(current, 'real-db'))).rejects.toThrow(/not authorized/iu);
    await expect(
      runner.registerEnvironment({
        taskId: '../escape',
        generation: 0,
        requestedBy: 'A14',
        worktree: current.worktree,
        gitControlDirectory: path.join(current.worktree, '.git'),
        candidateSha: current.sha,
        allowedChecks: ['shared-runtime-health'],
        eligibility: 'READY_FOR_VALIDATION',
        environment: current.environment,
      }),
    ).rejects.toThrow(/task identity/iu);
    await expect(
      runner.registerEnvironment({
        taskId: 'cycle-a-validation',
        generation: 0,
        requestedBy: 'forged-worker',
        worktree: current.worktree,
        gitControlDirectory: path.join(current.worktree, '.git'),
        candidateSha: current.sha,
        allowedChecks: ['shared-runtime-health'],
        eligibility: 'READY_FOR_VALIDATION',
        environment: current.environment,
      }),
    ).rejects.toThrow(/different authority/iu);

    const alias = path.join(current.root, 'alias');
    await fs.symlink(current.worktree, alias);
    await expect(
      runner.registerEnvironment({
        taskId: 'symlink-task',
        generation: 0,
        requestedBy: 'A14',
        worktree: alias,
        gitControlDirectory: path.join(current.worktree, '.git'),
        candidateSha: current.sha,
        allowedChecks: ['shared-runtime-health'],
        eligibility: 'READY_FOR_VALIDATION',
        environment: {
          ...current.environment,
          environmentId: 'symlink-task',
          workspace: alias,
        },
      }),
    ).rejects.toThrow(/symlink/iu);
  });

  it('binds PASS evidence to SHA/environment and fails if source changes during execution', async () => {
    const current = await fixture();
    const runner = new HostValidationRunner({
      ...TEST_RUNNER_PROFILE,
      allowUnsafeTestRuntime: true,
      runtimeDir: current.runtimeDir,
      allowedWorktreeRoots: [current.root],
      hostEnvironment: {},
      probeService: async () => true,
      execute: async () => {
        await fs.writeFile(path.join(current.worktree, 'tampered.txt'), 'changed during test\n');
        return { exitCode: 0, resourceJobId: 'resource-2' };
      },
    });
    await authorize(runner, current, ['shared-runtime-health']);
    const queued = await runner.request(request(current, 'shared-runtime-health'));
    expect(queued.environmentFingerprint).toMatch(/^[0-9a-f]{64}$/u);
    await expect(runner.runNext()).resolves.toMatchObject({
      status: 'ENVIRONMENT_BLOCKED',
      summary: expect.stringContaining('clean exact-SHA worktree'),
    });
  });

  it('recovers an expired RUNNING lease exactly once after restart', async () => {
    const current = await fixture();
    const execute = vi.fn(async () => ({
      exitCode: 0,
      resourceJobId: 'resource-3',
    }));
    const runner = new HostValidationRunner({
      ...TEST_RUNNER_PROFILE,
      allowUnsafeTestRuntime: true,
      runtimeDir: current.runtimeDir,
      allowedWorktreeRoots: [current.root],
      hostEnvironment: {},
      probeService: async () => true,
      execute,
      now: () => new Date('2026-08-15T00:10:00.000Z'),
    });
    await authorize(runner, current, ['shared-runtime-health']);
    await runner.request(request(current, 'shared-runtime-health'));
    const stateFile = path.join(current.runtimeDir, 'host-validation.json');
    const state = JSON.parse(await fs.readFile(stateFile, 'utf8')) as {
      jobs: Array<Record<string, unknown>>;
    };
    Object.assign(state.jobs[0] ?? {}, {
      status: 'RUNNING',
      attempt: 1,
      leaseToken: 'expired-runner',
      leaseExpiresAt: '2026-08-15T00:00:00.000Z',
    });
    await fs.writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`);

    await expect(runner.runNext()).resolves.toMatchObject({
      status: 'PASS',
      attempt: 2,
    });
    expect(execute).toHaveBeenCalledTimes(1);
    await expect(runner.runNext()).resolves.toBeUndefined();
  });

  it('fails closed on corrupt host-validation state', async () => {
    const current = await fixture();
    await fs.mkdir(current.runtimeDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(current.runtimeDir, 'host-validation.json'), 'not-json\n');
    const runner = new HostValidationRunner({
      ...TEST_RUNNER_PROFILE,
      allowUnsafeTestRuntime: true,
      runtimeDir: current.runtimeDir,
      hostEnvironment: {},
    });
    await expect(runner.state()).rejects.toThrow(/state is unreadable/iu);
  });
});
