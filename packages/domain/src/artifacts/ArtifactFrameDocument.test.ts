import { describe, expect, it } from 'vitest';
import { artifactFrameDocument } from './ArtifactFrameDocument.js';

describe('artifactFrameDocument', () => {
  it('installs the trusted key bridge before artifact scripts without moving the doctype', () => {
    const html = '<!doctype html><html><head><script>artifact()</script></head><body></body></html>';
    const rendered = artifactFrameDocument(html);

    expect(rendered.startsWith('<!doctype html><html><head>')).toBe(true);
    expect(rendered).toContain("action: 'zoom'");
    expect(rendered.indexOf('data-soloe-artifact-bridge'))
      .toBeLessThan(rendered.indexOf('<script>artifact()</script>'));
  });

  it('supports HTML fragments and documents without a head', () => {
    expect(artifactFrameDocument('<main>Report</main>')).toMatch(
      /^<script data-soloe-artifact-bridge>/u
    );
    expect(artifactFrameDocument('<html><body>Report</body></html>')).toContain(
      '<html><script data-soloe-artifact-bridge>'
    );
  });
});
