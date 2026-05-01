/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { confirmStore } from './confirm.svelte';

describe('ConfirmStore — ask/confirm/cancel', () => {
  beforeEach(() => {
    // Reset internal state between tests by cancelling any open dialog.
    if (confirmStore.open) confirmStore.cancel();
  });

  it('ask: opens dialog with provided options', async () => {
    const p = confirmStore.ask({
      title: 'Title',
      message: 'msg',
      confirmLabel: 'Yes',
      cancelLabel: 'No',
      tone: 'danger'
    });
    expect(confirmStore.open).toBe(true);
    expect(confirmStore.title).toBe('Title');
    expect(confirmStore.message).toBe('msg');
    expect(confirmStore.confirmLabel).toBe('Yes');
    expect(confirmStore.cancelLabel).toBe('No');
    expect(confirmStore.tone).toBe('danger');
    confirmStore.cancel();
    await p;
  });

  it('confirm: resolves true and closes', async () => {
    const p = confirmStore.ask({ message: 'go?' });
    confirmStore.confirm();
    await expect(p).resolves.toBe(true);
    expect(confirmStore.open).toBe(false);
  });

  it('cancel: resolves false and closes', async () => {
    const p = confirmStore.ask({ message: 'go?' });
    confirmStore.cancel();
    await expect(p).resolves.toBe(false);
    expect(confirmStore.open).toBe(false);
  });

  it('ask while another is open: previous resolves false', async () => {
    const first = confirmStore.ask({ message: 'first' });
    const second = confirmStore.ask({ message: 'second' });
    await expect(first).resolves.toBe(false);
    confirmStore.confirm();
    await expect(second).resolves.toBe(true);
  });

  it('defaults: confirmLabel/cancelLabel/tone fall back', async () => {
    const p = confirmStore.ask({ message: 'go?' });
    expect(confirmStore.confirmLabel).toBe('Confirm');
    expect(confirmStore.cancelLabel).toBe('Cancel');
    expect(confirmStore.tone).toBe('default');
    confirmStore.cancel();
    await p;
  });
});
