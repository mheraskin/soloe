import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { renderGeneratedArtifactHome } from './GeneratedArtifactHome.js';

const artifacts = [
  {
    id: 'architecture',
    projectId: 'project',
    title: 'Architecture review',
    description: 'Explains the runtime boundary.',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    revision: 'one',
    isHome: false,
    homeOwnership: null
  },
  {
    id: 'research',
    projectId: 'project',
    title: 'Research report',
    description: 'Summarizes the customer interviews.',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-03T00:00:00.000Z',
    revision: 'two',
    isHome: false,
    homeOwnership: null
  }
];

describe('renderGeneratedArtifactHome', () => {
  it('filters cards client-side with an accessible no-results state', () => {
    const dom = new JSDOM(renderGeneratedArtifactHome({
      projectName: 'Soloe',
      artifacts
    }), { runScripts: 'dangerously' });
    const input = dom.window.document.querySelector<HTMLInputElement>('#search')!;
    input.value = 'customer';
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));

    const architecture = dom.window.document.querySelector<HTMLElement>(
      '[data-artifact-id="architecture"]'
    )!;
    const research = dom.window.document.querySelector<HTMLElement>(
      '[data-artifact-id="research"]'
    )!;
    expect(architecture.classList.contains('hidden')).toBe(true);
    expect(research.classList.contains('hidden')).toBe(false);
    expect(dom.window.document.querySelector('#count')?.textContent).toBe('1 matching');

    input.value = 'no match';
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    expect(dom.window.document.querySelector('#no-results')?.classList.contains('hidden'))
      .toBe(false);
  });
});
