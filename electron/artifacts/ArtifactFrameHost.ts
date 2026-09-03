import { ipcMain, protocol } from 'electron';
import {
  ARTIFACT_FRAME_CONTENT_SECURITY_POLICY,
  ArtifactFrameRegistry
} from '@soloe/domain';
import { IpcChannels } from '@shared/types/ipc.js';
import { ipcInvoke } from '../ipc/result.js';

const ARTIFACT_FRAME_SCHEME = 'soloe-artifact';

export function registerArtifactFrameScheme(): void {
  protocol.registerSchemesAsPrivileged([{
    scheme: ARTIFACT_FRAME_SCHEME,
    privileges: {
      standard: true,
      secure: true
    }
  }]);
}

export class ArtifactFrameHost {
  private readonly registry = new ArtifactFrameRegistry();
  private registered = false;

  register(): void {
    if (this.registered) return;
    this.registered = true;
    protocol.handle(ARTIFACT_FRAME_SCHEME, (request) =>
      artifactFrameResponse(this.registry, request.url)
    );
    ipcMain.handle(IpcChannels.artifacts.prepareFrame, (_event, html: string) =>
      ipcInvoke(async () => {
        const ticket = this.registry.issue(html);
        return { url: `${ARTIFACT_FRAME_SCHEME}://frame/${ticket.token}` };
      })
    );
  }

  dispose(): void {
    if (!this.registered) return;
    this.registered = false;
    ipcMain.removeHandler(IpcChannels.artifacts.prepareFrame);
    protocol.unhandle(ARTIFACT_FRAME_SCHEME);
    this.registry.clear();
  }
}

export function artifactFrameResponse(
  registry: ArtifactFrameRegistry,
  requestUrl: string
): Response {
  const url = new URL(requestUrl);
  const token = url.hostname === 'frame' && url.pathname.startsWith('/')
    ? url.pathname.slice(1)
    : '';
  const html = registry.read(token);
  if (html === null) {
    return new Response('Artifact frame not found', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' }
    });
  }
  return new Response(html, {
    status: 200,
    headers: artifactFrameHeaders()
  });
}

export function artifactFrameHeaders(): Record<string, string> {
  return {
    'cache-control': 'no-store',
    'content-security-policy': ARTIFACT_FRAME_CONTENT_SECURITY_POLICY,
    'content-type': 'text/html; charset=utf-8',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff'
  };
}
