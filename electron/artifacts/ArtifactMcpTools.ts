import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { Project } from '@shared/types/projects.js';
import type {
  ArtifactDeleteResult,
  ArtifactMutationResult,
  ArtifactProjectRef,
  ArtifactCatalogSnapshot
} from '@shared/types/artifacts.js';
import {
  ArtifactStore,
  MAX_ARTIFACT_HTML_BYTES
} from './ArtifactStore.js';

const MAX_CWD_LENGTH = 4096;

export interface ArtifactProjectStoreLike {
  get(id: string): Promise<Project | null>;
  detectFromPath(input: string): Promise<{
    path: string;
    matchedProjectId: string | null;
  }>;
}

export interface ResolvedArtifactProject {
  project: ArtifactProjectRef;
  cwd: string;
  root: string;
}

export interface ArtifactSourceReader {
  readHtml(request: {
    cwd: string;
    root: string;
    sourcePath: string;
    maxBytes: number;
  }): Promise<string>;
}

export interface ArtifactMcpToolsOptions {
  store: ArtifactStore;
  projects: ArtifactProjectStoreLike;
  resolveProject?: (cwd: string) => Promise<ResolvedArtifactProject | null>;
  sourceReader?: ArtifactSourceReader;
}

export class ArtifactMcpTools {
  private readonly sourceReader: ArtifactSourceReader;

  constructor(private readonly options: ArtifactMcpToolsOptions) {
    this.sourceReader = options.sourceReader ?? nodeArtifactSourceReader;
  }

  async list(args: Record<PropertyKey, unknown>): Promise<ArtifactCatalogSnapshot> {
    const target = await this.projectFromArgs(args);
    return this.options.store.list(target.project);
  }

  async publish(args: Record<PropertyKey, unknown>): Promise<ArtifactMutationResult> {
    const target = await this.projectFromArgs(args);
    const html = await this.htmlFromArgs(target, args);
    const requestedId = optionalNonEmptyString(args, 'id');
    const asHome = optionalBoolean(args, 'as_home');
    return this.options.store.publish({
      project: target.project,
      title: requiredString(args, 'title'),
      description: requiredString(args, 'description'),
      html,
      ...(requestedId ? { requestedId } : {}),
      ...(asHome !== undefined ? { asHome } : {})
    });
  }

  async edit(args: Record<PropertyKey, unknown>): Promise<ArtifactMutationResult> {
    const target = await this.projectFromArgs(args);
    const html = await this.htmlFromArgs(target, args);
    const title = optionalNonEmptyString(args, 'title');
    const description = optionalNonEmptyString(args, 'description');
    return this.options.store.edit({
      project: target.project,
      artifactId: requiredString(args, 'id'),
      html,
      ...(title ? { title } : {}),
      ...(description ? { description } : {})
    });
  }

  async delete(args: Record<PropertyKey, unknown>): Promise<ArtifactDeleteResult> {
    const target = await this.projectFromArgs(args);
    return this.options.store.delete(target.project, requiredString(args, 'id'));
  }

  private async projectFromArgs(
    args: Record<PropertyKey, unknown>
  ): Promise<ResolvedArtifactProject> {
    const cwd = requiredString(args, 'cwd');
    if (cwd.length > MAX_CWD_LENGTH || cwd.includes('\0')) {
      throw new Error('cwd is invalid');
    }
    const injected = await this.options.resolveProject?.(cwd);
    if (injected) return injected;
    const detected = await this.options.projects.detectFromPath(cwd);
    if (!detected.matchedProjectId) {
      throw new Error('cwd does not belong to a registered Soloe Project');
    }
    const project = await this.options.projects.get(detected.matchedProjectId);
    if (!project) throw new Error('Resolved Soloe Project no longer exists');
    return {
      project: { id: project.id, name: project.name },
      cwd,
      root: detected.path
    };
  }

  private async htmlFromArgs(
    target: ResolvedArtifactProject,
    args: Record<PropertyKey, unknown>
  ): Promise<string> {
    const html = optionalRawString(args, 'html');
    const sourcePath = optionalString(args, 'path');
    if ((html === undefined) === (sourcePath === undefined)) {
      throw new Error('Provide exactly one of html or path');
    }
    if (html !== undefined) {
      assertHtmlSize(html, MAX_ARTIFACT_HTML_BYTES);
      return html;
    }
    if (sourcePath === undefined) throw new Error('Artifact source path is required');
    return this.sourceReader.readHtml({
      cwd: target.cwd,
      root: target.root,
      sourcePath,
      maxBytes: MAX_ARTIFACT_HTML_BYTES
    });
  }
}

export const nodeArtifactSourceReader: ArtifactSourceReader = {
  async readHtml(request): Promise<string> {
    if (
      request.sourcePath.includes('\0')
      || path.extname(request.sourcePath).toLowerCase() !== '.html'
    ) {
      throw new Error('Artifact source path must point to an .html file');
    }
    let root: string;
    let source: string;
    try {
      root = await fs.realpath(request.root);
      source = await fs.realpath(
        path.isAbsolute(request.sourcePath)
          ? request.sourcePath
          : path.resolve(request.cwd, request.sourcePath)
      );
    } catch {
      throw new Error('Artifact source HTML file was not found');
    }
    const relative = path.relative(root, source);
    if (relative.startsWith('..') || path.isAbsolute(relative) || relative === '') {
      throw new Error('Artifact source path escapes the resolved Soloe Project');
    }
    const stat = await fs.stat(source);
    if (!stat.isFile()) throw new Error('Artifact source path must be a regular HTML file');
    if (stat.size > request.maxBytes) throw new Error(sizeLimitMessage(request.maxBytes));
    const html = await fs.readFile(source, 'utf8');
    assertHtmlSize(html, request.maxBytes);
    return html;
  }
};

function requiredString(args: Record<PropertyKey, unknown>, key: string): string {
  const value = optionalString(args, key);
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function optionalString(args: Record<PropertyKey, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function optionalNonEmptyString(
  args: Record<PropertyKey, unknown>,
  key: string
): string | undefined {
  if (!(key in args)) return undefined;
  const value = args[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value.trim();
}

function optionalRawString(args: Record<PropertyKey, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' ? value : undefined;
}

function optionalBoolean(args: Record<PropertyKey, unknown>, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(`${key} must be a boolean`);
  return value;
}

function assertHtmlSize(html: string, maxBytes: number): void {
  if (!html.trim()) throw new Error('Artifact HTML is required');
  if (Buffer.byteLength(html, 'utf8') > maxBytes) throw new Error(sizeLimitMessage(maxBytes));
}

function sizeLimitMessage(maxBytes: number): string {
  return `Artifact HTML exceeds the ${Math.floor(maxBytes / (1024 * 1024))} MiB limit`;
}
