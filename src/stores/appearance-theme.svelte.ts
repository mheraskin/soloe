import type { ThemePref } from '@shared/types/settings.js';

export type ResolvedTheme = Exclude<ThemePref, 'system'>;

export function resolveAppearanceTheme(
  preference: ThemePref,
  systemPrefersDark: boolean
): ResolvedTheme {
  if (preference === 'system') return systemPrefersDark ? 'dark' : 'light';
  return preference;
}

function detectSystemDark(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

class AppearanceThemeStore {
  preference = $state<ThemePref>('system');
  systemPrefersDark = $state(detectSystemDark());
  resolved = $derived(resolveAppearanceTheme(this.preference, this.systemPrefersDark));

  setPreference(preference: ThemePref): void {
    this.preference = preference;
  }

  attach(): () => void {
    if (typeof window.matchMedia !== 'function') return () => {};
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => {
      this.systemPrefersDark = media.matches;
    };
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }
}

export const appearanceTheme = new AppearanceThemeStore();
