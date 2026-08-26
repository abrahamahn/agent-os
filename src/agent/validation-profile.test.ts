import { describe, expect, it } from 'vitest';

import { parseValidationProfile } from './validation-profile';

describe('validation target profile', () => {
  it('accepts target-defined commands and admitted environment names', () => {
    expect(
      parseValidationProfile({
        schemaVersion: 1,
        environmentNames: ['PATH', 'DATABASE_URL'],
        bootstrap: {
          command: ['make', 'bootstrap'],
          environment: { BUILD_MODE: 'test' },
          dependencyFiles: ['Makefile'],
        },
        scratchPaths: ['build'],
        services: {
          database: { host: '127.0.0.1', portEnvironment: 'DATABASE_PORT', defaultPort: 5432 },
        },
        checks: {
          verify: {
            resource: 'medium',
            command: ['make', 'test'],
            requiredHostService: 'database',
          },
        },
      }),
    ).toMatchObject({
      environmentNames: ['PATH', 'DATABASE_URL'],
      bootstrap: { command: ['make', 'bootstrap'], dependencyFiles: ['Makefile'] },
      scratchPaths: ['build'],
      services: { database: { defaultPort: 5432 } },
      checks: { verify: { command: ['make', 'test'] } },
    });
  });

  it('rejects duplicate environment admission and malformed commands', () => {
    expect(() =>
      parseValidationProfile({
        schemaVersion: 1,
        environmentNames: ['PATH', 'PATH'],
        bootstrap: { command: [], environment: {}, dependencyFiles: [] },
        scratchPaths: [],
        services: {},
        checks: { verify: { resource: 'medium', command: [] } },
      }),
    ).toThrow(/environment list/iu);
  });

  it('rejects target paths that escape the repository', () => {
    expect(() =>
      parseValidationProfile({
        schemaVersion: 1,
        environmentNames: ['PATH'],
        bootstrap: { command: [], environment: {}, dependencyFiles: ['../outside.lock'] },
        scratchPaths: [],
        services: {},
        checks: { verify: { resource: 'medium', command: ['make', 'test'] } },
      }),
    ).toThrow(/bootstrap or scratch/iu);
  });

  it('accepts a complete TypeScript target contract', () => {
    const profile = parseValidationProfile({
      schemaVersion: 1,
      environmentNames: ['PATH', 'HOME', 'CI', 'NODE_OPTIONS'],
      bootstrap: {
        command: ['pnpm', 'install', '--offline', '--frozen-lockfile'],
        environment: { NODE_ENV: 'development' },
        dependencyFiles: ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json'],
      },
      scratchPaths: ['node_modules/.cache', '.turbo'],
      services: {},
      checks: {
        'type-check': { resource: 'heavy', command: ['pnpm', 'exec', 'tsc', '--build'] },
        test: { resource: 'heavy', command: ['pnpm', 'exec', 'vitest', 'run'] },
      },
    });

    expect(profile.checks['type-check']?.command).toEqual(['pnpm', 'exec', 'tsc', '--build']);
    expect(profile.checks['test']?.command).toEqual(['pnpm', 'exec', 'vitest', 'run']);
  });
});
