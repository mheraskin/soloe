import type { DeviceId } from '@shared/types/devices.js';
import type {
  ArtifactCatalogSnapshot,
  ArtifactDocument,
  ArtifactFrameSource,
  ArtifactProjectRef,
  ArtifactsChangeEvent
} from '@shared/types/artifacts.js';
import { ipc } from '../lib/ipc';

const SEEN_STORAGE_KEY = 'soloe.artifacts.seenByProject.v1';
const MAX_NAVIGATION_HISTORY = 20;

interface ArtifactRoute {
  deviceId?: DeviceId;
}

interface ArtifactNavigationState {
  back: string[];
  forward: string[];
}

export class ArtifactsStore {
  snapshotsByProject = $state<Record<string, ArtifactCatalogSnapshot>>({});
  documentsByProject = $state<Record<string, ArtifactDocument>>({});
  frameSourcesByProject = $state<Record<string, ArtifactFrameSource>>({});
  loadedByProject = $state<Record<string, boolean>>({});
  loadingByProject = $state<Record<string, boolean>>({});
  errorByProject = $state<Record<string, string | null>>({});
  seenRevisionByProject = $state<Record<string, string>>(loadSeenRevisions());

  private navigationByProject = $state<Record<string, ArtifactNavigationState>>({});
  private readonly requestGeneration = new Map<string, number>();
  private readonly remoteDeviceByProject = new Map<string, DeviceId>();
  private detachers: Array<() => void> = [];

  attachListeners(): void {
    this.detach();
    this.detachers.push(ipc.artifacts.onChange((event) => this.applyChange(event)));
    this.detachers.push(ipc.connection.onReconnect(() => {
      for (const [projectId, loaded] of Object.entries(this.loadedByProject)) {
        if (!loaded) continue;
        const snapshot = this.snapshotsByProject[projectId];
        if (!snapshot) continue;
        const route = this.remoteDeviceByProject.get(projectId);
        void this.ensureCatalog(
          { id: projectId, name: snapshot.projectName },
          route ? { deviceId: route } : undefined,
          true
        ).catch(() => undefined);
      }
    }));
  }

  detach(): void {
    for (const detach of this.detachers) detach();
    this.detachers = [];
  }

  async ensureCatalog(
    project: ArtifactProjectRef,
    route?: ArtifactRoute,
    force = false
  ): Promise<ArtifactCatalogSnapshot> {
    const existing = this.snapshotsByProject[project.id];
    if (!force && this.loadedByProject[project.id] && existing) return existing;
    const generation = (this.requestGeneration.get(project.id) ?? 0) + 1;
    this.requestGeneration.set(project.id, generation);
    this.loadingByProject[project.id] = true;
    this.errorByProject[project.id] = null;
    try {
      const snapshot = route?.deviceId
        ? await ipc.artifacts.list(project, route)
        : await ipc.artifacts.list(project);
      if (this.requestGeneration.get(project.id) === generation) {
        this.snapshotsByProject[project.id] = snapshot;
        this.loadedByProject[project.id] = true;
        if (route?.deviceId) this.remoteDeviceByProject.set(project.id, route.deviceId);
        else this.remoteDeviceByProject.delete(project.id);
      }
      return snapshot;
    } catch (error) {
      if (this.requestGeneration.get(project.id) === generation) {
        this.errorByProject[project.id] = errorMessage(error);
      }
      throw error;
    } finally {
      if (this.requestGeneration.get(project.id) === generation) {
        this.loadingByProject[project.id] = false;
      }
    }
  }

  async openHome(
    project: ArtifactProjectRef,
    route?: ArtifactRoute
  ): Promise<ArtifactDocument | null> {
    const snapshot = await this.ensureCatalog(project, route);
    if (!snapshot.homeArtifactId) {
      delete this.documentsByProject[project.id];
      delete this.frameSourcesByProject[project.id];
      this.setNavigation(project.id, { back: [], forward: [] });
      return null;
    }
    const document = await this.loadDocument(project, snapshot.homeArtifactId, route);
    this.setNavigation(project.id, { back: [], forward: [] });
    return document;
  }

  async openArtifact(
    project: ArtifactProjectRef,
    artifactId: string,
    route?: ArtifactRoute
  ): Promise<ArtifactDocument> {
    const current = this.documentsByProject[project.id];
    const document = await this.loadDocument(project, artifactId, route);
    if (!current) {
      this.setNavigation(project.id, { back: [], forward: [] });
    } else if (current.id !== artifactId) {
      const navigation = this.navigation(project.id);
      this.setNavigation(project.id, {
        back: [...navigation.back, current.id].slice(-MAX_NAVIGATION_HISTORY),
        forward: []
      });
    }
    return document;
  }

  canGoBack(projectId: string): boolean {
    return Boolean(
      this.documentsByProject[projectId]
      && this.navigation(projectId).back.length > 0
    );
  }

  canGoForward(projectId: string): boolean {
    return Boolean(
      this.documentsByProject[projectId]
      && this.navigation(projectId).forward.length > 0
    );
  }

  async back(
    project: ArtifactProjectRef,
    route?: ArtifactRoute
  ): Promise<ArtifactDocument | null> {
    const current = this.documentsByProject[project.id];
    const navigation = this.navigation(project.id);
    const artifactId = navigation.back.at(-1);
    if (!current || !artifactId) return null;
    const document = await this.loadDocument(project, artifactId, route);
    this.setNavigation(project.id, {
      back: navigation.back.slice(0, -1),
      forward: [...navigation.forward, current.id].slice(-MAX_NAVIGATION_HISTORY)
    });
    return document;
  }

  async forward(
    project: ArtifactProjectRef,
    route?: ArtifactRoute
  ): Promise<ArtifactDocument | null> {
    const current = this.documentsByProject[project.id];
    const navigation = this.navigation(project.id);
    const artifactId = navigation.forward.at(-1);
    if (!current || !artifactId) return null;
    const document = await this.loadDocument(project, artifactId, route);
    this.setNavigation(project.id, {
      back: [...navigation.back, current.id].slice(-MAX_NAVIGATION_HISTORY),
      forward: navigation.forward.slice(0, -1)
    });
    return document;
  }

  async refresh(project: ArtifactProjectRef, route?: ArtifactRoute): Promise<void> {
    const currentId = this.documentsByProject[project.id]?.id;
    const snapshot = await this.ensureCatalog(project, route, true);
    const nextId = currentId && snapshot.artifacts.some((artifact) => artifact.id === currentId)
      ? currentId
      : snapshot.homeArtifactId;
    if (nextId) await this.loadDocument(project, nextId, route);
    else {
      delete this.documentsByProject[project.id];
      delete this.frameSourcesByProject[project.id];
      this.setNavigation(project.id, { back: [], forward: [] });
    }
  }

  async delete(
    project: ArtifactProjectRef,
    artifactId: string,
    route?: ArtifactRoute
  ): Promise<void> {
    if (route?.deviceId) await ipc.artifacts.delete(project, artifactId, route);
    else await ipc.artifacts.delete(project, artifactId);
    await this.ensureCatalog(project, route, true);
    await this.openHome(project, route);
  }

  markSeen(projectId: string): void {
    const revision = this.snapshotsByProject[projectId]?.revision;
    if (!revision || revision === '0') return;
    this.seenRevisionByProject[projectId] = revision;
    persistSeenRevisions(this.seenRevisionByProject);
  }

  unread(projectId: string | null | undefined): boolean {
    if (!projectId) return false;
    const revision = this.snapshotsByProject[projectId]?.revision;
    return Boolean(revision && revision !== '0' && this.seenRevisionByProject[projectId] !== revision);
  }

  private async loadDocument(
    project: ArtifactProjectRef,
    artifactId: string,
    route?: ArtifactRoute
  ): Promise<ArtifactDocument> {
    this.loadingByProject[project.id] = true;
    this.errorByProject[project.id] = null;
    try {
      const document = route?.deviceId
        ? await ipc.artifacts.read(project, artifactId, route)
        : await ipc.artifacts.read(project, artifactId);
      const frameSource = await ipc.artifacts.prepareFrame(document.html);
      this.documentsByProject[project.id] = document;
      this.frameSourcesByProject[project.id] = frameSource;
      return document;
    } catch (error) {
      this.errorByProject[project.id] = errorMessage(error);
      throw error;
    } finally {
      this.loadingByProject[project.id] = false;
    }
  }

  private applyChange(event: ArtifactsChangeEvent): void {
    const eventDeviceId = 'deviceId' in event && typeof event.deviceId === 'string'
      ? event.deviceId
      : null;
    const routedDeviceId = this.remoteDeviceByProject.get(event.projectId) ?? null;
    if (this.loadedByProject[event.projectId] && routedDeviceId !== eventDeviceId) return;
    this.snapshotsByProject[event.projectId] = event.snapshot;
    this.loadedByProject[event.projectId] = true;
    if (eventDeviceId) this.remoteDeviceByProject.set(event.projectId, eventDeviceId);
    else this.remoteDeviceByProject.delete(event.projectId);
    const current = this.documentsByProject[event.projectId];
    if (current && !event.snapshot.artifacts.some((artifact) => artifact.id === current.id)) {
      delete this.documentsByProject[event.projectId];
      delete this.frameSourcesByProject[event.projectId];
      this.setNavigation(event.projectId, { back: [], forward: [] });
      return;
    }
    const memberIds = new Set(event.snapshot.artifacts.map((artifact) => artifact.id));
    const navigation = this.navigation(event.projectId);
    this.setNavigation(event.projectId, {
      back: navigation.back.filter((artifactId) => memberIds.has(artifactId)),
      forward: navigation.forward.filter((artifactId) => memberIds.has(artifactId))
    });
  }

  private navigation(projectId: string): ArtifactNavigationState {
    return this.navigationByProject[projectId] ?? { back: [], forward: [] };
  }

  private setNavigation(projectId: string, navigation: ArtifactNavigationState): void {
    this.navigationByProject[projectId] = navigation;
  }
}

export const artifacts = new ArtifactsStore();

function loadSeenRevisions(): Record<string, string> {
  if (typeof localStorage === 'undefined') return {};
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(SEEN_STORAGE_KEY) ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    );
  } catch {
    return {};
  }
}

function persistSeenRevisions(revisions: Record<string, string>): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(SEEN_STORAGE_KEY, JSON.stringify(revisions));
  } catch {
    // Activity state remains available for this renderer session.
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
