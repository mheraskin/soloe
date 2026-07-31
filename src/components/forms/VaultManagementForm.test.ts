import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import VaultManagementForm from './VaultManagementForm.svelte';

describe('VaultManagementForm', () => {
  it('renders an accessible empty state until a session is selected', () => {
    const { body } = render(VaultManagementForm);

    expect(body).toContain('Credential Vault');
    expect(body).toContain('Select a session to manage credentials');
    expect(body).toContain('role="status"');
    expect(body).not.toContain('type="password"');
  });
});
