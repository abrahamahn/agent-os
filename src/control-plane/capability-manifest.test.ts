import { describe, expect, it } from 'vitest';

import { parseCapabilityManifest } from './capability-manifest';

function manifest(policy: Record<string, unknown>): unknown {
  return {
    schemaVersion: 1,
    activePhase: 'alpha',
    phases: { alpha: { workers: { worker: policy } } },
  };
}

describe('capability manifest', () => {
  it('accepts unique capabilities, bounded priorities, and repository-relative scopes', () => {
    expect(
      parseCapabilityManifest(
        manifest({
          capabilities: ['resource:medium', 'resource:heavy'],
          priority: 100,
          lifecycleRoles: ['integrator'],
          ownership: ['.', 'src/control-plane', 'fixtures/name..with-dots'],
          hotspots: ['src/agent'],
        }),
      ),
    ).toMatchObject({ activePhase: 'alpha' });
  });

  it.each([
    '../outside',
    'src/../outside',
    '/absolute',
    'C:/absolute',
    'src\\windows',
    'src//nested',
    'src/./nested',
    ' trailing',
    'trailing ',
    'nul\0path',
  ])('rejects unsafe ownership path %j', (ownership) => {
    expect(() =>
      parseCapabilityManifest(manifest({ capabilities: [], ownership: [ownership] })),
    ).toThrow(/ownership/iu);
  });

  it('rejects duplicate capabilities and invalid priorities', () => {
    expect(() =>
      parseCapabilityManifest(manifest({ capabilities: ['resource:medium', 'resource:medium'] })),
    ).toThrow(/capability policy/iu);
    expect(() => parseCapabilityManifest(manifest({ capabilities: [], priority: -1 }))).toThrow(
      /priority/iu,
    );
    expect(() => parseCapabilityManifest(manifest({ capabilities: [], priority: 1.5 }))).toThrow(
      /priority/iu,
    );
  });

  it('validates inactive phases before they can become authoritative', () => {
    expect(() =>
      parseCapabilityManifest({
        schemaVersion: 1,
        activePhase: 'alpha',
        phases: {
          alpha: { workers: { worker: { capabilities: [] } } },
          next: { workers: { worker: { capabilities: ['unknown'] } } },
        },
      }),
    ).toThrow(/capability policy/iu);
  });

  it('rejects arrays and whitespace-padded authority identifiers', () => {
    expect(() =>
      parseCapabilityManifest({ schemaVersion: 1, activePhase: 'alpha', phases: [] }),
    ).toThrow(/phases/iu);
    expect(() =>
      parseCapabilityManifest({
        schemaVersion: 1,
        activePhase: ' alpha ',
        phases: { ' alpha ': { workers: {} } },
      }),
    ).toThrow(/activePhase/iu);
    expect(() =>
      parseCapabilityManifest({
        schemaVersion: 1,
        activePhase: 'alpha',
        phases: { alpha: { workers: { ' worker ': { capabilities: [] } } } },
      }),
    ).toThrow(/capability policy/iu);
  });
});
