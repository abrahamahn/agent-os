// src/control-plane/runtime.ts
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

export const DEFAULT_CONTROL_PLANE_RUNTIME = resolve(tmpdir(), 'agent-os-runtime');

export function controlPlaneRuntime(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return resolve(environment['AGENT_OS_RUNTIME_DIR'] ?? DEFAULT_CONTROL_PLANE_RUNTIME);
}

export function controlPlaneRuntimeChild(
  name: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return resolve(controlPlaneRuntime(environment), name);
}
