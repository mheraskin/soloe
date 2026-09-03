import type { ArtifactSummary } from '../../../../shared/types/artifacts.js';

export interface GeneratedArtifactHomeInput {
  projectName: string;
  artifacts: ArtifactSummary[];
}

export function renderGeneratedArtifactHome(input: GeneratedArtifactHomeInput): string {
  const artifacts = input.artifacts.filter((artifact) => !artifact.isHome);
  const cards = artifacts.map((artifact) => renderCard(artifact)).join('\n');
  const empty = artifacts.length === 0
    ? '<section class="empty" id="empty"><strong>No artifacts yet</strong><p>Published reports, specifications, and project documents will appear here.</p></section>'
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(input.projectName)} artifacts</title>
<style>
:root{color-scheme:light dark;--bg:#f8fafc;--surface:#fff;--surface-2:#f1f5f9;--text:#0f172a;--muted:#64748b;--line:#e2e8f0;--accent:#2563eb;--danger:#b91c1c;--shadow:0 1px 2px rgba(15,23,42,.05),0 8px 28px rgba(15,23,42,.06)}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}button,input{font:inherit}.shell{width:min(1120px,100%);margin:auto;padding:clamp(24px,5vw,64px) clamp(18px,4vw,48px) 48px}.eyebrow{margin:0 0 8px;color:var(--accent);font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}.heading{display:flex;align-items:end;justify-content:space-between;gap:24px}.heading h1{margin:0;font-size:clamp(28px,4vw,44px);line-height:1.08;letter-spacing:-.035em}.heading p{max-width:560px;margin:12px 0 0;color:var(--muted);font-size:15px}.count{flex:none;padding:7px 11px;border:1px solid var(--line);border-radius:999px;background:var(--surface);color:var(--muted);font-size:12px;font-weight:650}.search{position:relative;margin:32px 0 20px}.search svg{position:absolute;left:14px;top:50%;width:17px;transform:translateY(-50%);color:var(--muted)}.search input{width:100%;height:46px;padding:0 16px 0 42px;border:1px solid var(--line);border-radius:12px;background:var(--surface);color:var(--text);outline:none;box-shadow:var(--shadow)}.search input:focus{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 18%,transparent)}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,300px),1fr));gap:14px}.card{display:flex;min-height:190px;flex-direction:column;padding:20px;border:1px solid var(--line);border-radius:14px;background:var(--surface);box-shadow:var(--shadow)}.card h2{margin:0;font-size:17px;line-height:1.3;letter-spacing:-.012em}.card p{display:-webkit-box;overflow:hidden;margin:10px 0 20px;color:var(--muted);-webkit-box-orient:vertical;-webkit-line-clamp:3}.card footer{display:flex;align-items:center;gap:8px;margin-top:auto}.updated{margin-right:auto;color:var(--muted);font-size:12px}.action{min-height:34px;padding:6px 10px;border:1px solid var(--line);border-radius:8px;background:var(--surface-2);color:var(--text);cursor:pointer;font-weight:650}.action:hover{border-color:var(--accent);color:var(--accent)}.action.delete{color:var(--muted)}.action.delete:hover{border-color:var(--danger);color:var(--danger)}.action:focus-visible{outline:3px solid color-mix(in srgb,var(--accent) 35%,transparent);outline-offset:2px}.empty{padding:64px 24px;border:1px dashed var(--line);border-radius:14px;text-align:center;color:var(--muted)}.empty strong{display:block;margin-bottom:6px;color:var(--text);font-size:16px}.empty p{margin:0}.hidden{display:none!important}
@media(max-width:600px){.heading{align-items:start;flex-direction:column}.shell{padding-top:28px}.card{min-height:170px}}
@media(prefers-color-scheme:dark){:root{--bg:#090d14;--surface:#111827;--surface-2:#182131;--text:#f1f5f9;--muted:#94a3b8;--line:#263244;--accent:#60a5fa;--danger:#f87171;--shadow:none}}
@media(prefers-reduced-motion:no-preference){.card,.action{transition:border-color .15s ease,color .15s ease,transform .15s ease}.card:hover{transform:translateY(-1px)}}
</style>
</head>
<body>
<main class="shell">
  <p class="eyebrow">Project artifacts</p>
  <div class="heading"><div><h1>${escapeHtml(input.projectName)}</h1><p>A durable library of reports, decisions, specifications, and interactive project documents.</p></div><span class="count" id="count">${artifacts.length} ${artifacts.length === 1 ? 'artifact' : 'artifacts'}</span></div>
  <label class="search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="8"></circle><path d="m21 21-4.3-4.3"></path></svg><input id="search" type="search" aria-label="Search artifacts" placeholder="Search titles and descriptions" autocomplete="off"></label>
  <section class="grid" id="artifacts" aria-live="polite">${cards}</section>
  ${empty}
  <section class="empty hidden" id="no-results"><strong>No matching artifacts</strong><p>Try a different title or keyword.</p></section>
</main>
<script>
(() => {
  const search = document.getElementById('search');
  const count = document.getElementById('count');
  const noResults = document.getElementById('no-results');
  const cards = Array.from(document.querySelectorAll('[data-artifact-id]'));
  const send = (action, artifactId) => window.parent.postMessage({ channel: 'soloe.artifacts', action, artifactId }, '*');
  document.addEventListener('click', (event) => {
    const button = event.target instanceof Element ? event.target.closest('button[data-action]') : null;
    if (!button) return;
    send(button.dataset.action, button.dataset.artifactId);
  });
  search?.addEventListener('input', () => {
    const query = search.value.trim().toLocaleLowerCase();
    let visible = 0;
    for (const card of cards) {
      const match = !query || (card.dataset.search || '').includes(query);
      card.classList.toggle('hidden', !match);
      if (match) visible += 1;
    }
    count.textContent = query ? visible + ' matching' : cards.length + (cards.length === 1 ? ' artifact' : ' artifacts');
    noResults?.classList.toggle('hidden', visible !== 0 || cards.length === 0);
  });
})();
</script>
</body>
</html>`;
}

function renderCard(artifact: ArtifactSummary): string {
  const search = `${artifact.title} ${artifact.description}`.toLocaleLowerCase();
  return `<article class="card" data-artifact-id="${artifact.id}" data-search="${escapeAttribute(search)}"><h2>${escapeHtml(artifact.title)}</h2><p>${escapeHtml(artifact.description)}</p><footer><time class="updated" datetime="${escapeAttribute(artifact.updatedAt)}">${escapeHtml(formatUpdatedAt(artifact.updatedAt))}</time><button class="action delete" type="button" data-action="delete" data-artifact-id="${artifact.id}" aria-label="Delete ${escapeAttribute(artifact.title)}">Delete</button><button class="action" type="button" data-action="open" data-artifact-id="${artifact.id}">Open</button></footer></article>`;
}

function formatUpdatedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return 'Updated recently';
  return `Updated ${date.toLocaleDateString('en', { dateStyle: 'medium' })}`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character] ?? character);
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/\r?\n/gu, ' ');
}
