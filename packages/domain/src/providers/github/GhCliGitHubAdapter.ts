import type {
  CreatedGitHubRepository,
  CreateGitHubRepositoryIntent,
  GitHubOwner,
  GitHubProviderStatus
} from '@shared/types/providers.js';
import { runGitCommand, type GitCommandResult } from '../../git/GitCommandRunner.js';
import type { GitHubProviderAdapter } from './GitHubProviderService.js';

export interface GhCliGitHubAdapterOptions {
  binary?: string;
  run?: (binary: string, args: string[]) => Promise<GitCommandResult>;
}

export class GhCliGitHubAdapter implements GitHubProviderAdapter {
  private readonly binary: string;
  private readonly run: NonNullable<GhCliGitHubAdapterOptions['run']>;
  private login: string | null = null;

  constructor(options: GhCliGitHubAdapterOptions = {}) {
    this.binary = options.binary?.trim() || 'gh';
    this.run = options.run ?? ((binary, args) => runGitCommand(binary, args, {
      timeoutMs: 30_000,
      stdoutLimitBytes: 1024 * 1024,
      stderrLimitBytes: 16 * 1024
    }));
  }

  async status(): Promise<GitHubProviderStatus> {
    const auth = await this.run(this.binary, ['auth', 'status', '--hostname', 'github.com']);
    if (auth.code !== 0) {
      this.login = null;
      return {
        available: auth.code !== null,
        authenticated: false,
        error: auth.code === null
          ? 'GitHub CLI is unavailable on this Device.'
          : 'GitHub CLI is not authenticated for github.com.'
      };
    }
    const user = await this.run(this.binary, ['api', 'user']);
    const parsed = parseObject(user.stdout);
    const login = typeof parsed?.['login'] === 'string' ? parsed['login'].trim() : '';
    if (user.code !== 0 || !login) {
      this.login = null;
      return {
        available: true,
        authenticated: false,
        error: 'GitHub identity could not be resolved on this Device.'
      };
    }
    this.login = login;
    return { available: true, authenticated: true, login };
  }

  async listOwners(): Promise<GitHubOwner[]> {
    const status = await this.status();
    if (!status.authenticated || !status.login) return [];
    const organizations = await this.run(this.binary, [
      'api', 'user/orgs', '--paginate', '--jq', '.[].login'
    ]);
    const result: GitHubOwner[] = [{ login: status.login, kind: 'user' }];
    if (organizations.code === 0) {
      for (const line of organizations.stdout.split(/\r?\n/u)) {
        const login = line.trim();
        if (login && !result.some((owner) => owner.login.toLowerCase() === login.toLowerCase())) {
          result.push({ login, kind: 'organization' });
        }
      }
    }
    return result;
  }

  async repositoryExists(owner: string, name: string): Promise<boolean> {
    const result = await this.run(this.binary, ['api', `repos/${owner}/${name}`, '--silent']);
    if (result.code === 0) return true;
    if (/\b404\b|not found/iu.test(result.stderr)) return false;
    throw new Error('GitHub repository availability could not be verified.');
  }

  async createRepository(
    intent: CreateGitHubRepositoryIntent
  ): Promise<CreatedGitHubRepository> {
    const status = this.login
      ? { available: true, authenticated: true, login: this.login }
      : await this.status();
    if (!status.authenticated || !status.login) {
      throw new Error('GitHub authentication is required on this Device.');
    }
    const endpoint = status.login.toLowerCase() === intent.owner.toLowerCase()
      ? 'user/repos'
      : `orgs/${intent.owner}/repos`;
    const args = [
      'api', '--method', 'POST', endpoint,
      '-f', `name=${intent.name}`,
      '-F', `private=${intent.visibility === 'private' ? 'true' : 'false'}`,
      ...(intent.description ? ['-f', `description=${intent.description}`] : [])
    ];
    const result = await this.run(this.binary, args);
    if (result.code !== 0) throw new Error('GitHub repository creation failed on this Device.');
    const repository = parseObject(result.stdout);
    const providerRepositoryId = requiredString(repository, 'node_id');
    const url = requiredString(repository, 'html_url');
    const sshUrl = requiredString(repository, 'ssh_url');
    const responseOwner = parseObject(repository?.['owner']);
    return {
      provider: 'github',
      providerRepositoryId,
      owner: requiredString(responseOwner, 'login'),
      name: requiredString(repository, 'name'),
      visibility: repository?.['private'] === true ? 'private' : 'public',
      url,
      sshUrl
    };
  }
}

function parseObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string') {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function requiredString(value: Record<string, unknown> | null, key: string): string {
  const field = value?.[key];
  if (typeof field !== 'string' || !field.trim()) {
    throw new Error('GitHub returned an invalid repository response.');
  }
  return field.trim();
}
