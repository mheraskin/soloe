import { describe, expect, it } from 'vitest';
import {
  ARTIFACT_GUIDE_KINDS,
  artifactAuthoringGuide,
  isArtifactGuideKind
} from './ArtifactAuthoringGuide.js';

describe('ArtifactAuthoringGuide', () => {
  it.each(ARTIFACT_GUIDE_KINDS)('returns bounded Soloe-native guidance for %s', (kind) => {
    const guide = artifactAuthoringGuide(kind);
    const serialized = JSON.stringify(guide);

    expect(guide).toMatchObject({ kind, canonicalFormat: 'html' });
    expect(guide.workflow.length).toBeGreaterThan(3);
    expect(guide.designChecks).toContainEqual(expect.stringContaining('self-contained'));
    expect(guide.soloeFlow.navigation.openArtifact).toContain('soloe.artifacts');
    expect(serialized).not.toMatch(/claude\.ai|CLAUDE_PLUGIN_DATA|built-in Artifact tool/iu);
    expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThan(12 * 1024);
  });

  it('keeps Project and software delivery advice distinct', () => {
    const project = artifactAuthoringGuide('project-status');
    const software = artifactAuthoringGuide('software-delivery');

    expect(project.pagePlan.always).toContainEqual(expect.stringContaining('action queue'));
    expect(software.pagePlan.always).toContainEqual(expect.stringContaining('pull-request'));
    expect(software.pagePlan.whenUseful).toContainEqual(expect.stringContaining('rollback'));
  });

  it('accepts only declared guide kinds', () => {
    expect(isArtifactGuideKind('general')).toBe(true);
    expect(isArtifactGuideKind('project-status')).toBe(true);
    expect(isArtifactGuideKind('software-delivery')).toBe(true);
    expect(isArtifactGuideKind('project-artifact')).toBe(false);
    expect(isArtifactGuideKind({ kind: 'general' })).toBe(false);
  });
});
