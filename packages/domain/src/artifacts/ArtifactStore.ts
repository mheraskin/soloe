import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type {
  ArtifactCatalogSnapshot,
  ArtifactDeleteResult,
  ArtifactDocument,
  ArtifactHomeOwnership,
  ArtifactMutationResult,
  ArtifactProjectRef,
  ArtifactSummary,
  ArtifactsChangeEvent,
  EditArtifactRequest,
  PublishArtifactRequest
} from '../../../../shared/types/artifacts.js';
import { ARTIFACT_ID_PATTERN } from '../../../../shared/types/artifacts.js';
import { renderGeneratedArtifactHome } from './GeneratedArtifactHome.js';

export const HOME_ARTIFACT_ID = 'home';
// Large enough for self-contained reports with several data-URL screenshots,
// while bounding memory in MCP, persistence, and renderer srcdoc paths.
export const MAX_ARTIFACT_HTML_BYTES = 24 * 1024 * 1024;
export const MAX_ARTIFACT_TITLE_LENGTH = 160;
export const MAX_ARTIFACT_DESCRIPTION_LENGTH = 600;

interface StoredArtifact {
  id: string;
  title: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  revision: string;
  homeOwnership: ArtifactHomeOwnership | null;
}

interface StoredCatalog {
  version: 1;
  projectId: string;
  projectName: string;
  revision: string;
  artifacts: StoredArtifact[];
}

export interface ArtifactStoreOptions {
  now?: () => Date;
  maxHtmlBytes?: number;
  assertProject?: (project: ArtifactProjectRef) => void | Promise<void>;
}

export class ArtifactStore {
  private readonly listeners = new Set<(event: ArtifactsChangeEvent) => void>();
  private readonly mutationQueues = new Map<string, Promise<void>>();
  private readonly now: () => Date;
  private readonly maxHtmlBytes: number;

  constructor(
    private readonly rootDir: string,
    private readonly options: ArtifactStoreOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
    this.maxHtmlBytes = options.maxHtmlBytes ?? MAX_ARTIFACT_HTML_BYTES;
  }

  async list(project: ArtifactProjectRef): Promise<ArtifactCatalogSnapshot> {
    await this.validateProject(project);
    await this.mutationQueues.get(project.id);
    const catalog = await this.loadCatalog(project);
    return publicCatalog(catalog);
  }

  async read(project: ArtifactProjectRef, artifactId: string): Promise<ArtifactDocument> {
    await this.validateProject(project);
    assertArtifactId(artifactId);
    await this.mutationQueues.get(project.id);
    const catalog = await this.loadCatalog(project);
    const artifact = catalog.artifacts.find((candidate) => candidate.id === artifactId);
    if (!artifact) {
      throw new ArtifactStoreError('artifact_not_found', `Artifact "${artifactId}" was not found`);
    }
    const html = await this.readHtml(project.id, artifactId);
    return {
      ...publicArtifact(catalog, artifact),
      html,
      catalogRevision: catalog.revision
    };
  }

  async publish(request: PublishArtifactRequest): Promise<ArtifactMutationResult> {
    await this.validateProject(request.project);
    const title = validateTitle(request.title);
    const description = validateDescription(request.description);
    validateHtml(request.html, this.maxHtmlBytes);
    if (request.asHome && request.requestedId && request.requestedId !== HOME_ARTIFACT_ID) {
      throw new ArtifactStoreError(
        'invalid_artifact_id',
        `Home artifacts use the reserved "${HOME_ARTIFACT_ID}" ID`
      );
    }
    if (!request.asHome && request.requestedId === HOME_ARTIFACT_ID) {
      throw new ArtifactStoreError(
        'invalid_artifact_id',
        `The "${HOME_ARTIFACT_ID}" ID is reserved for the Project home artifact`
      );
    }
    if (request.requestedId) assertArtifactId(request.requestedId);

    return this.queueMutation(request.project.id, async () => {
      const catalog = await this.loadCatalog(request.project);
      const artifactId = request.asHome
        ? HOME_ARTIFACT_ID
        : request.requestedId ?? await this.uniqueId(request.project.id, catalog, title);
      const existing = catalog.artifacts.find((artifact) => artifact.id === artifactId);
      if (existing) {
        const existingHtml = await this.readHtml(request.project.id, artifactId);
        const identical = existing.title === title
          && existing.description === description
          && existingHtml === request.html
          && existing.homeOwnership === (request.asHome ? 'user' : null);
        if (request.requestedId && identical) {
          return mutationResult(catalog, existing, false);
        }
        if (!(request.asHome && existing.homeOwnership === 'system')) {
          throw new ArtifactStoreError(
            'artifact_id_collision',
            `Artifact ID "${artifactId}" already exists; use edit_artifact to replace it`
          );
        }
      }

      const timestamp = this.now().toISOString();
      const next = cloneCatalog(catalog, request.project.name);
      const stored: StoredArtifact = {
        id: artifactId,
        title,
        description,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
        revision: artifactRevision(title, description, request.html, timestamp),
        homeOwnership: request.asHome ? 'user' : null
      };
      replaceArtifact(next, stored);
      const writes = new Map<string, string>([[htmlFilename(artifactId), request.html]]);
      const homeGenerated = !request.asHome && this.refreshGeneratedHome(next, writes, timestamp);
      next.revision = randomUUID();
      await this.commit(request.project.id, next, writes);
      this.broadcast(next);
      return mutationResult(next, stored, homeGenerated);
    });
  }

  async edit(request: EditArtifactRequest): Promise<ArtifactMutationResult> {
    await this.validateProject(request.project);
    assertArtifactId(request.artifactId);
    validateHtml(request.html, this.maxHtmlBytes);

    return this.queueMutation(request.project.id, async () => {
      const catalog = await this.loadCatalog(request.project);
      const existing = catalog.artifacts.find((artifact) => artifact.id === request.artifactId);
      if (!existing) {
        throw new ArtifactStoreError(
          'artifact_not_found',
          `Artifact "${request.artifactId}" was not found`
        );
      }
      const title = request.title === undefined ? existing.title : validateTitle(request.title);
      const description = request.description === undefined
        ? existing.description
        : validateDescription(request.description);
      const timestamp = this.now().toISOString();
      const next = cloneCatalog(catalog, request.project.name);
      const stored: StoredArtifact = {
        ...existing,
        title,
        description,
        updatedAt: timestamp,
        revision: artifactRevision(title, description, request.html, timestamp),
        homeOwnership: existing.id === HOME_ARTIFACT_ID ? 'user' : null
      };
      replaceArtifact(next, stored);
      const writes = new Map<string, string>([[htmlFilename(stored.id), request.html]]);
      const homeGenerated = stored.id !== HOME_ARTIFACT_ID
        && this.refreshGeneratedHome(next, writes, timestamp);
      next.revision = randomUUID();
      await this.commit(request.project.id, next, writes);
      this.broadcast(next);
      return mutationResult(next, stored, homeGenerated);
    });
  }

  async delete(project: ArtifactProjectRef, artifactId: string): Promise<ArtifactDeleteResult> {
    await this.validateProject(project);
    assertArtifactId(artifactId);
    return this.queueMutation(project.id, async () => {
      const catalog = await this.loadCatalog(project);
      const existing = catalog.artifacts.find((artifact) => artifact.id === artifactId);
      if (!existing) {
        return {
          projectId: project.id,
          artifactId,
          deleted: false,
          revision: catalog.revision,
          restoredGeneratedHome: false
        };
      }
      if (existing.homeOwnership === 'system') {
        throw new ArtifactStoreError(
          'generated_home_required',
          'The system-generated home cannot be deleted; publish or edit a custom home instead'
        );
      }

      const timestamp = this.now().toISOString();
      const next = cloneCatalog(catalog, project.name);
      next.artifacts = next.artifacts.filter((artifact) => artifact.id !== artifactId);
      const writes = new Map<string, string>();
      const restoredGeneratedHome = existing.homeOwnership === 'user';
      if (restoredGeneratedHome || hasSystemHome(next)) {
        this.refreshGeneratedHome(next, writes, timestamp, true);
      }
      next.revision = randomUUID();
      await this.commit(project.id, next, writes);
      if (!restoredGeneratedHome) {
        await safeUnlink(path.join(this.projectDir(project.id), htmlFilename(artifactId)));
      }
      this.broadcast(next);
      return {
        projectId: project.id,
        artifactId,
        deleted: true,
        revision: next.revision,
        restoredGeneratedHome
      };
    });
  }

  onChange(listener: (event: ArtifactsChangeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async validateProject(project: ArtifactProjectRef): Promise<void> {
    const id = project.id.trim();
    if (!id || id !== project.id || /[\\/:*?"<>|\x00-\x1f]/u.test(id) || id.includes('..')) {
      throw new ArtifactStoreError('invalid_project_id', 'Project ID is not safe for storage');
    }
    if (!project.name.trim()) {
      throw new ArtifactStoreError('invalid_project', 'Project name is required');
    }
    await this.options.assertProject?.(project);
  }

  private async loadCatalog(project: ArtifactProjectRef): Promise<StoredCatalog> {
    const filePath = path.join(this.projectDir(project.id), 'index.json');
    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyCatalog(project);
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new ArtifactStoreError('invalid_artifact_catalog', 'Artifact catalog is not valid JSON');
    }
    return parseCatalog(parsed, project);
  }

  private refreshGeneratedHome(
    catalog: StoredCatalog,
    writes: Map<string, string>,
    timestamp: string,
    force = false
  ): boolean {
    const currentHome = catalog.artifacts.find((artifact) => artifact.id === HOME_ARTIFACT_ID);
    if (!force && currentHome?.homeOwnership === 'user') return false;
    const summaries = publicCatalog(catalog).artifacts.filter((artifact) => !artifact.isHome);
    const html = renderGeneratedArtifactHome({ projectName: catalog.projectName, artifacts: summaries });
    const home: StoredArtifact = {
      id: HOME_ARTIFACT_ID,
      title: `${catalog.projectName} artifacts`,
      description: 'Project artifact library and searchable overview.',
      createdAt: currentHome?.createdAt ?? timestamp,
      updatedAt: timestamp,
      revision: artifactRevision(
        `${catalog.projectName} artifacts`,
        'Project artifact library and searchable overview.',
        html,
        timestamp
      ),
      homeOwnership: 'system'
    };
    replaceArtifact(catalog, home);
    writes.set(htmlFilename(HOME_ARTIFACT_ID), html);
    return true;
  }

  private async uniqueId(
    projectId: string,
    catalog: StoredCatalog,
    title: string
  ): Promise<string> {
    const base = slugify(title);
    const used = new Set(catalog.artifacts.map((artifact) => artifact.id));
    if (!used.has(base) && !(await fileExists(path.join(this.projectDir(projectId), `${base}.html`)))) {
      return base;
    }
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const candidate = `${base.slice(0, 54).replace(/-+$/u, '')}-${randomBytes(4).toString('hex')}`;
      if (!used.has(candidate)
        && !(await fileExists(path.join(this.projectDir(projectId), `${candidate}.html`)))) {
        return candidate;
      }
    }
    throw new ArtifactStoreError('artifact_id_collision', 'Could not allocate a unique artifact ID');
  }

  private async readHtml(projectId: string, artifactId: string): Promise<string> {
    const filePath = path.join(this.projectDir(projectId), htmlFilename(artifactId));
    const stat = await fs.stat(filePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        throw new ArtifactStoreError('artifact_content_missing', 'Artifact HTML is missing');
      }
      throw error;
    });
    if (!stat.isFile()) {
      throw new ArtifactStoreError('artifact_content_missing', 'Artifact HTML is not a file');
    }
    if (stat.size > this.maxHtmlBytes) {
      throw new ArtifactStoreError('artifact_too_large', sizeLimitMessage(this.maxHtmlBytes));
    }
    return fs.readFile(filePath, 'utf8');
  }

  private async commit(
    projectId: string,
    catalog: StoredCatalog,
    writes: Map<string, string>
  ): Promise<void> {
    const dir = this.projectDir(projectId);
    await fs.mkdir(dir, { recursive: true });
    for (const [filename, html] of writes) {
      await atomicWrite(path.join(dir, filename), html);
    }
    await atomicWrite(path.join(dir, 'index.json'), `${JSON.stringify(catalog, null, 2)}\n`);
  }

  private projectDir(projectId: string): string {
    const dir = path.join(this.rootDir, projectId);
    assertWithin(this.rootDir, dir);
    return dir;
  }

  private queueMutation<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationQueues.get(projectId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    this.mutationQueues.set(projectId, result.then(() => undefined, () => undefined));
    return result;
  }

  private broadcast(catalog: StoredCatalog): void {
    const event: ArtifactsChangeEvent = {
      projectId: catalog.projectId,
      snapshot: publicCatalog(catalog)
    };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A consumer must not break a committed domain mutation.
      }
    }
  }
}

export class ArtifactStoreError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ArtifactStoreError';
  }
}

export function assertArtifactId(value: string): void {
  if (!ARTIFACT_ID_PATTERN.test(value)) {
    throw new ArtifactStoreError(
      'invalid_artifact_id',
      'Artifact ID must contain 1-64 lowercase letters, numbers, or interior hyphens'
    );
  }
}

function emptyCatalog(project: ArtifactProjectRef): StoredCatalog {
  return {
    version: 1,
    projectId: project.id,
    projectName: project.name,
    revision: '0',
    artifacts: []
  };
}

function parseCatalog(value: unknown, project: ArtifactProjectRef): StoredCatalog {
  if (!isRecord(value)
    || value['version'] !== 1
    || value['projectId'] !== project.id
    || typeof value['projectName'] !== 'string'
    || typeof value['revision'] !== 'string'
    || !Array.isArray(value['artifacts'])) {
    throw new ArtifactStoreError('invalid_artifact_catalog', 'Artifact catalog has an invalid shape');
  }
  const artifacts = value['artifacts'].map((entry) => parseStoredArtifact(entry));
  const ids = new Set<string>();
  for (const artifact of artifacts) {
    if (ids.has(artifact.id)) {
      throw new ArtifactStoreError('invalid_artifact_catalog', 'Artifact catalog contains duplicate IDs');
    }
    ids.add(artifact.id);
  }
  return {
    version: 1,
    projectId: project.id,
    projectName: project.name,
    revision: value['revision'],
    artifacts
  };
}

function parseStoredArtifact(value: unknown): StoredArtifact {
  if (!isRecord(value)) {
    throw new ArtifactStoreError('invalid_artifact_catalog', 'Artifact entry is invalid');
  }
  const id = requiredCatalogString(value, 'id');
  assertArtifactId(id);
  const ownership = value['homeOwnership'];
  if (ownership !== null && ownership !== 'system' && ownership !== 'user') {
    throw new ArtifactStoreError('invalid_artifact_catalog', 'Artifact home ownership is invalid');
  }
  if ((id === HOME_ARTIFACT_ID) !== (ownership !== null)) {
    throw new ArtifactStoreError('invalid_artifact_catalog', 'Artifact home entry is inconsistent');
  }
  return {
    id,
    title: requiredCatalogString(value, 'title'),
    description: requiredCatalogString(value, 'description', true),
    createdAt: requiredCatalogString(value, 'createdAt'),
    updatedAt: requiredCatalogString(value, 'updatedAt'),
    revision: requiredCatalogString(value, 'revision'),
    homeOwnership: ownership
  };
}

function requiredCatalogString(
  value: Record<PropertyKey, unknown>,
  key: string,
  allowEmpty = false
): string {
  const field = value[key];
  if (typeof field !== 'string' || (!allowEmpty && !field)) {
    throw new ArtifactStoreError('invalid_artifact_catalog', `Artifact ${key} is invalid`);
  }
  return field;
}

function publicCatalog(catalog: StoredCatalog): ArtifactCatalogSnapshot {
  return {
    projectId: catalog.projectId,
    projectName: catalog.projectName,
    revision: catalog.revision,
    homeArtifactId: catalog.artifacts.some((artifact) => artifact.id === HOME_ARTIFACT_ID)
      ? HOME_ARTIFACT_ID
      : null,
    artifacts: [...catalog.artifacts]
      .sort((left, right) => {
        if (left.id === HOME_ARTIFACT_ID) return -1;
        if (right.id === HOME_ARTIFACT_ID) return 1;
        return right.updatedAt.localeCompare(left.updatedAt);
      })
      .map((artifact) => publicArtifact(catalog, artifact))
  };
}

function publicArtifact(catalog: StoredCatalog, artifact: StoredArtifact): ArtifactSummary {
  return {
    ...artifact,
    projectId: catalog.projectId,
    isHome: artifact.id === HOME_ARTIFACT_ID
  };
}

function cloneCatalog(catalog: StoredCatalog, projectName: string): StoredCatalog {
  return {
    ...catalog,
    projectName,
    artifacts: catalog.artifacts.map((artifact) => ({ ...artifact }))
  };
}

function replaceArtifact(catalog: StoredCatalog, next: StoredArtifact): void {
  const index = catalog.artifacts.findIndex((artifact) => artifact.id === next.id);
  if (index === -1) catalog.artifacts.push(next);
  else catalog.artifacts[index] = next;
}

function mutationResult(
  catalog: StoredCatalog,
  artifact: StoredArtifact,
  homeGenerated: boolean
): ArtifactMutationResult {
  return {
    project: { id: catalog.projectId, name: catalog.projectName },
    projectId: catalog.projectId,
    artifact: publicArtifact(catalog, artifact),
    revision: catalog.revision,
    homeGenerated
  };
}

function hasSystemHome(catalog: StoredCatalog): boolean {
  return catalog.artifacts.some((artifact) => artifact.homeOwnership === 'system');
}

function validateTitle(value: string): string {
  const title = value.trim();
  if (!title) throw new ArtifactStoreError('invalid_artifact_metadata', 'Artifact title is required');
  if (title.length > MAX_ARTIFACT_TITLE_LENGTH) {
    throw new ArtifactStoreError(
      'invalid_artifact_metadata',
      `Artifact title exceeds ${MAX_ARTIFACT_TITLE_LENGTH} characters`
    );
  }
  return title;
}

function validateDescription(value: string): string {
  const description = value.trim();
  if (!description) {
    throw new ArtifactStoreError('invalid_artifact_metadata', 'Artifact description is required');
  }
  if (description.length > MAX_ARTIFACT_DESCRIPTION_LENGTH) {
    throw new ArtifactStoreError(
      'invalid_artifact_metadata',
      `Artifact description exceeds ${MAX_ARTIFACT_DESCRIPTION_LENGTH} characters`
    );
  }
  return description;
}

function validateHtml(html: string, maxBytes: number): void {
  if (!html.trim()) throw new ArtifactStoreError('invalid_artifact_html', 'Artifact HTML is required');
  if (Buffer.byteLength(html, 'utf8') > maxBytes) {
    throw new ArtifactStoreError('artifact_too_large', sizeLimitMessage(maxBytes));
  }
}

function sizeLimitMessage(maxBytes: number): string {
  return `Artifact HTML exceeds the ${Math.floor(maxBytes / (1024 * 1024))} MiB limit`;
}

function artifactRevision(
  title: string,
  description: string,
  html: string,
  updatedAt: string
): string {
  return createHash('sha256')
    .update(JSON.stringify({ title, description, html, updatedAt }), 'utf8')
    .update(randomBytes(8))
    .digest('hex');
}

function slugify(title: string): string {
  const slug = title.toLocaleLowerCase('en')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 64)
    .replace(/-+$/u, '');
  if (!slug || slug === HOME_ARTIFACT_ID) return `artifact-${randomBytes(4).toString('hex')}`;
  return slug;
}

function htmlFilename(artifactId: string): string {
  assertArtifactId(artifactId);
  return `${artifactId}.html`;
}

function assertWithin(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new ArtifactStoreError('invalid_project_id', 'Artifact path escapes its storage root');
  }
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const temporaryPath = `${filePath}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    await fs.writeFile(temporaryPath, content, 'utf8');
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await safeUnlink(temporaryPath);
    throw error;
  }
}

async function safeUnlink(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
