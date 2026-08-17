/**
 * @vitest-environment jsdom
 */
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

import Checkbox from './checkbox/checkbox.svelte';
import RadioGroupHarness from './radio-group/radio-group.test-harness.svelte';
import Switch from './switch/switch.svelte';

describe('selection controls', () => {
  const mounted: Array<ReturnType<typeof mount>> = [];

  afterEach(async () => {
    for (const component of mounted.splice(0)) await unmount(component);
    document.body.innerHTML = '';
  });

  it('exposes and styles the switch checked state', () => {
    const onCheckedChange = vi.fn();
    const target = document.createElement('div');
    document.body.append(target);
    mounted.push(mount(Switch, { target, props: { checked: false, onCheckedChange } }));
    flushSync();

    const control = target.querySelector<HTMLElement>('[role="switch"]');
    expect(control?.getAttribute('aria-checked')).toBe('false');
    control?.click();
    flushSync();

    expect(control?.dataset.state).toBe('checked');
    expect(control?.getAttribute('aria-checked')).toBe('true');
    expect(control?.className).toContain('data-[state=checked]:bg-primary');
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it('exposes and styles the checkbox checked state', () => {
    const onCheckedChange = vi.fn();
    const target = document.createElement('div');
    document.body.append(target);
    mounted.push(mount(Checkbox, { target, props: { checked: false, onCheckedChange } }));
    flushSync();

    const control = target.querySelector<HTMLElement>('[role="checkbox"]');
    expect(control?.getAttribute('aria-checked')).toBe('false');
    control?.click();
    flushSync();

    expect(control?.dataset.state).toBe('checked');
    expect(control?.getAttribute('aria-checked')).toBe('true');
    expect(control?.className).toContain('data-[state=checked]:bg-primary');
    expect(control?.querySelector('svg')).not.toBeNull();
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it('exposes and styles the radio checked state', () => {
    const target = document.createElement('div');
    document.body.append(target);
    mounted.push(mount(RadioGroupHarness, { target }));
    flushSync();

    const first = target.querySelector<HTMLElement>('[aria-label="First option"]');
    const second = target.querySelector<HTMLElement>('[aria-label="Second option"]');
    expect(first?.dataset.state).toBe('checked');
    expect(second?.dataset.state).toBe('unchecked');
    second?.click();
    flushSync();

    expect(first?.dataset.state).toBe('unchecked');
    expect(second?.dataset.state).toBe('checked');
    expect(second?.className).toContain('data-[state=checked]:bg-primary');
    expect(second?.querySelector('[data-slot="radio-group-indicator"] span')).not.toBeNull();
  });
});
