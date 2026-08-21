const MONOSPACE_PROBE_VARIANTS = ['normal 400', 'normal 700', 'italic 400', 'italic 700'] as const;
const MONOSPACE_PROBE_GLYPHS = ['i', 'M', 'W', '0', '@', '#', '.', ' '] as const;
const MONOSPACE_ADVANCE_TOLERANCE = 0.01;

let fontProbeContext: CanvasRenderingContext2D | null | undefined;

function cssFontFamilies(input: string): string | null {
  const families = input
    .split(',')
    .map((family) => family.trim())
    .filter(Boolean);
  return families.length > 0 ? families.join(', ') : null;
}

/** Keep proportional fonts out of the fixed Ghostty cell grid. */
export function isMonospaceFamily(family: string): boolean {
  const families = cssFontFamilies(family);
  if (families === null) return true;
  try {
    fontProbeContext ??= document.createElement('canvas').getContext('2d');
    if (fontProbeContext === null) return true;
    for (const variant of MONOSPACE_PROBE_VARIANTS) {
      fontProbeContext.font = `${variant} 32px ${families}, monospace`;
      const advances = MONOSPACE_PROBE_GLYPHS.map(
        (glyph) => fontProbeContext!.measureText(glyph).width
      );
      const reference = advances[0];
      if (reference === undefined || reference <= 0) continue;
      if (advances.some((advance) => Math.abs(advance - reference) >= MONOSPACE_ADVANCE_TOLERANCE)) {
        return false;
      }
    }
  } catch {
    return true;
  }
  return true;
}
