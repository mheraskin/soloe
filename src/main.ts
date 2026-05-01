import type { Session, SessionDraft } from '@shared/types/sessions.js';

const apiStatus = document.querySelector<HTMLPreElement>('#api-status')!;
const sessionsEl = document.querySelector<HTMLDivElement>('#sessions')!;
const refreshBtn = document.querySelector<HTMLButtonElement>('#refresh')!;
const seedBtn = document.querySelector<HTMLButtonElement>('#seed')!;

function showApiStatus(): void {
  const exposed = Boolean(window.cockpit);
  const lines = [
    `cockpit.sessions: ${exposed ? 'ready' : 'missing'}`,
    `cockpit.terminal: ${exposed ? 'ready' : 'missing'}`
  ];
  apiStatus.textContent = lines.join('\n');
}

async function refreshSessions(): Promise<void> {
  const res = await window.cockpit.sessions.list();
  if (!res.ok) {
    sessionsEl.textContent = `Error: ${res.error}`;
    return;
  }
  if (res.value.length === 0) {
    sessionsEl.textContent = 'No sessions yet.';
    return;
  }
  sessionsEl.replaceChildren(...res.value.map(renderSession));
}

function renderSession(s: Session): HTMLElement {
  const row = document.createElement('div');
  row.className = 'session';
  row.append(
    span('name', s.name, true),
    span('kind', s.kind),
    span('cwd', s.cwd),
    span('run-mode', s.runMode)
  );
  return row;
}

function span(cls: string, text: string, strong = false): HTMLElement {
  const el = document.createElement(strong ? 'strong' : 'span');
  el.className = cls;
  el.textContent = text;
  return el;
}

async function seedSessions(): Promise<void> {
  const drafts: SessionDraft[] = [
    {
      kind: 'standard_terminal',
      name: 'Local shell',
      cwd: '/',
      shell: 'auto',
      runMode: 'windows'
    },
    {
      kind: 'claude_code',
      name: 'Claude (new)',
      cwd: '/home/me/project',
      runMode: 'wsl',
      wslDistro: 'Ubuntu',
      resumeMode: 'new',
      fullscreenTui: true
    },
    {
      kind: 'codex',
      name: 'Codex (resume last)',
      cwd: '/home/me/project',
      runMode: 'wsl',
      wslDistro: 'Ubuntu',
      resumeMode: 'resume_last'
    }
  ];
  for (const draft of drafts) {
    await window.cockpit.sessions.create(draft);
  }
  await refreshSessions();
}

refreshBtn.addEventListener('click', () => void refreshSessions());
seedBtn.addEventListener('click', () => void seedSessions());

showApiStatus();
void refreshSessions();
