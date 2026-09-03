import { ARTIFACT_ID_PATTERN } from '@shared/types/artifacts.js';

export type ArtifactFrameMessage =
  | { channel: 'soloe.artifacts'; action: 'open'; artifactId: string }
  | { channel: 'soloe.artifacts'; action: 'delete'; artifactId: string };

export function parseArtifactFrameMessage(value: unknown): ArtifactFrameMessage | null {
  if (!isRecord(value) || Object.keys(value).length !== 3) return null;
  if (value['channel'] !== 'soloe.artifacts') return null;
  if (value['action'] !== 'open' && value['action'] !== 'delete') return null;
  if (typeof value['artifactId'] !== 'string' || !ARTIFACT_ID_PATTERN.test(value['artifactId'])) {
    return null;
  }
  return {
    channel: 'soloe.artifacts',
    action: value['action'],
    artifactId: value['artifactId']
  };
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

