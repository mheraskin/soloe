const ARTIFACT_FRAME_BRIDGE = `<script data-soloe-artifact-bridge>
(() => {
  window.addEventListener('keydown', (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const direction = event.key === '=' || event.key === '+'
      ? 'in'
      : event.key === '-' || event.key === '_'
        ? 'out'
        : event.key === '0'
          ? 'reset'
          : null;
    if (!direction) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    window.parent.postMessage({
      channel: 'soloe.artifacts',
      action: 'zoom',
      direction
    }, '*');
  }, true);
})();
</script>`;

export function artifactFrameDocument(html: string): string {
  const head = /<head(?:\s[^>]*)?>/iu.exec(html);
  if (head?.index !== undefined) {
    const insertion = head.index + head[0].length;
    return `${html.slice(0, insertion)}${ARTIFACT_FRAME_BRIDGE}${html.slice(insertion)}`;
  }
  const documentElement = /<html(?:\s[^>]*)?>/iu.exec(html);
  if (documentElement?.index !== undefined) {
    const insertion = documentElement.index + documentElement[0].length;
    return `${html.slice(0, insertion)}${ARTIFACT_FRAME_BRIDGE}${html.slice(insertion)}`;
  }
  const doctype = /^\s*<!doctype\s+html[^>]*>/iu.exec(html);
  if (doctype) {
    return `${doctype[0]}${ARTIFACT_FRAME_BRIDGE}${html.slice(doctype[0].length)}`;
  }
  return `${ARTIFACT_FRAME_BRIDGE}${html}`;
}
