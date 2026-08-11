import { describe, expect, it } from 'vitest';
import { sessionRefreshIntents, type PollingSession } from './worktree-polling-policy';

describe('sessionRefreshIntents', () => {
  it('keeps exactly the selected Worktree foreground across many running shells', () => {
    const sessions = Array.from({ length: 20 }, (_, index) =>
      session(`session-${index}`, `/repo-${index}`, 'Ubuntu')
    );

    const intents = sessionRefreshIntents(sessions, 'session-7');

    expect(intents).toHaveLength(20);
    expect(intents.filter((intent) => intent.cadence === 'foreground')).toEqual([
      expect.objectContaining({ cwd: '/repo-7', wslDistro: 'Ubuntu' })
    ]);
  });

  it('deduplicates sessions in one Worktree and promotes it when any is selected', () => {
    const intents = sessionRefreshIntents([
      session('background', '/repo', 'Ubuntu'),
      session('selected', '/repo', 'Ubuntu')
    ], 'selected');

    expect(intents).toEqual([{
      cwd: '/repo', cadence: 'foreground', runMode: 'wsl', wslDistro: 'Ubuntu'
    }]);
  });

  it('keeps equal paths in different WSL distributions distinct', () => {
    const intents = sessionRefreshIntents([
      session('ubuntu', '/same-path', 'Ubuntu'),
      session('debian', '/same-path', 'Debian')
    ], 'debian');

    expect(intents).toEqual([
      { cwd: '/same-path', cadence: 'background', runMode: 'wsl', wslDistro: 'Ubuntu' },
      { cwd: '/same-path', cadence: 'foreground', runMode: 'wsl', wslDistro: 'Debian' }
    ]);
  });

  it('keeps every Worktree background when no Session is selected', () => {
    const intents = sessionRefreshIntents([
      session('one', '/one', 'Ubuntu'),
      session('two', '/two', 'Ubuntu')
    ], null);

    expect(intents.every((intent) => intent.cadence === 'background')).toBe(true);
  });
});

function session(id: string, cwd: string, wslDistro: string): PollingSession {
  return { id, cwd, runMode: 'wsl', wslDistro };
}
