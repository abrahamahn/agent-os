import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ValidationCheckProfile {
  readonly resource: 'medium' | 'heavy';
  readonly command: readonly string[];
  readonly requiredHostService?: string;
}

export interface ValidationServiceProfile {
  readonly host: string;
  readonly portEnvironment?: string;
  readonly defaultPort: number;
}

export interface ValidationProfile {
  readonly schemaVersion: 1;
  readonly environmentNames: readonly string[];
  readonly bootstrap: {
    readonly command: readonly string[];
    readonly environment: Readonly<Record<string, string>>;
    readonly dependencyFiles: readonly string[];
  };
  readonly scratchPaths: readonly string[];
  readonly services: Readonly<Record<string, ValidationServiceProfile>>;
  readonly checks: Readonly<Record<string, ValidationCheckProfile>>;
}

const DEFAULT_PROFILE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../config/validation-profile.json',
);

function isTextArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === 'string' && entry.trim().length > 0)
  );
}

function isUniqueTextArray(value: unknown): value is string[] {
  return isTextArray(value) && new Set(value).size === value.length;
}

function isRelativePathArray(value: unknown): value is string[] {
  return (
    isUniqueTextArray(value) &&
    value.every(
      (entry) =>
        !entry.includes('\\') &&
        !entry.includes('\0') &&
        !entry.startsWith('/') &&
        !/^[a-z]:/iu.test(entry) &&
        entry.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..'),
    )
  );
}

function isEnvironment(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.entries(value).every(
      ([name, entry]) => name.trim().length > 0 && typeof entry === 'string',
    )
  );
}

export function parseValidationProfile(value: unknown): ValidationProfile {
  if (typeof value !== 'object' || value === null) {
    throw new Error('validation profile must be an object');
  }
  const candidate = value as Record<string, unknown>;
  if (candidate['schemaVersion'] !== 1 || !isUniqueTextArray(candidate['environmentNames'])) {
    throw new Error('validation profile has an unsupported schema or environment list');
  }
  const bootstrap = candidate['bootstrap'];
  if (typeof bootstrap !== 'object' || bootstrap === null || Array.isArray(bootstrap)) {
    throw new Error('validation profile bootstrap must be an object');
  }
  const bootstrapRecord = bootstrap as Record<string, unknown>;
  if (
    !isTextArray(bootstrapRecord['command']) ||
    !isEnvironment(bootstrapRecord['environment']) ||
    !isRelativePathArray(bootstrapRecord['dependencyFiles']) ||
    !isRelativePathArray(candidate['scratchPaths'])
  ) {
    throw new Error('validation profile has invalid bootstrap or scratch settings');
  }
  const services = candidate['services'];
  if (typeof services !== 'object' || services === null || Array.isArray(services)) {
    throw new Error('validation profile services must be an object');
  }
  for (const [serviceId, rawService] of Object.entries(services)) {
    if (serviceId.trim().length === 0 || typeof rawService !== 'object' || rawService === null) {
      throw new Error('validation profile has an invalid service');
    }
    const service = rawService as Record<string, unknown>;
    if (
      typeof service['host'] !== 'string' ||
      service['host'].trim().length === 0 ||
      (service['portEnvironment'] !== undefined &&
        (typeof service['portEnvironment'] !== 'string' ||
          service['portEnvironment'].trim().length === 0)) ||
      !Number.isInteger(service['defaultPort']) ||
      Number(service['defaultPort']) < 1 ||
      Number(service['defaultPort']) > 65_535
    ) {
      throw new Error(`validation profile has an invalid service: ${serviceId}`);
    }
  }
  const checks = candidate['checks'];
  if (typeof checks !== 'object' || checks === null || Array.isArray(checks)) {
    throw new Error('validation profile checks must be an object');
  }
  for (const [checkId, rawCheck] of Object.entries(checks)) {
    if (checkId.trim().length === 0 || typeof rawCheck !== 'object' || rawCheck === null) {
      throw new Error('validation profile has an invalid check');
    }
    const check = rawCheck as Record<string, unknown>;
    if (
      (check['resource'] !== 'medium' && check['resource'] !== 'heavy') ||
      !isTextArray(check['command']) ||
      check['command'].length === 0 ||
      (check['requiredHostService'] !== undefined &&
        (typeof check['requiredHostService'] !== 'string' ||
          !Object.hasOwn(services, check['requiredHostService'])))
    ) {
      throw new Error(`validation profile has an invalid check: ${checkId}`);
    }
  }
  return value as ValidationProfile;
}

export function loadValidationProfile(
  path = process.env['AGENT_OS_VALIDATION_PROFILE_PATH'] ?? DEFAULT_PROFILE_PATH,
): ValidationProfile {
  return parseValidationProfile(JSON.parse(readFileSync(path, 'utf8')) as unknown);
}
