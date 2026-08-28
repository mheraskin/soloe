import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('../', import.meta.url);

describe('installer CI contract', () => {
  it('installs and uninstalls the Windows package on a clean runner', () => {
    const workflow = readFileSync(new URL('.github/workflows/ci.yml', root), 'utf8');
    const releaseWorkflow = readFileSync(
      new URL('.github/workflows/release.yml', root),
      'utf8'
    );
    const smoke = readFileSync(
      new URL('scripts/smoke-windows-installer.ps1', root),
      'utf8'
    );

    expect(workflow).toMatch(
      /- name: Package Windows build\n        run: pnpm package:windows\n\n      - name: Smoke test Windows installer\n        shell: pwsh\n        run: \.\/scripts\/smoke-windows-installer\.ps1/u
    );
    expect(releaseWorkflow).toMatch(
      /- name: Smoke test Windows installer\n        if: matrix\.platform == 'windows'\n        shell: pwsh\n        run: \.\/scripts\/smoke-windows-installer\.ps1/u
    );
    expect(smoke).toContain("-ArgumentList '/S'");
    expect(smoke).toContain("'Soloe.exe'");
    expect(smoke).toContain("'Uninstall Soloe.exe'");
    expect(smoke).toContain('assertMissing');
  });

  it('launches the AppImage and installs and uninstalls the Debian package', () => {
    const workflow = readFileSync(new URL('.github/workflows/ci.yml', root), 'utf8');
    const releaseWorkflow = readFileSync(
      new URL('.github/workflows/release.yml', root),
      'utf8'
    );
    const smoke = readFileSync(
      new URL('scripts/smoke-linux-packages.sh', root),
      'utf8'
    );

    expect(workflow).toMatch(
      /- name: Package Linux builds\n        run: pnpm package:linux\n\n      - name: Smoke test Linux packages\n        run: bash scripts\/smoke-linux-packages\.sh/u
    );
    expect(releaseWorkflow).toMatch(
      /- name: Smoke test Linux packages\n        if: matrix\.platform == 'linux'\n        run: bash scripts\/smoke-linux-packages\.sh/u
    );
    expect(smoke).toContain('APPIMAGE_EXTRACT_AND_RUN=1');
    expect(smoke).toContain('assert_stays_running');
    expect(smoke).toContain('[[ $status -ne 124 && $status -ne 137 ]]');
    expect(smoke).toContain('(( elapsed < smoke_seconds ))');
    expect(smoke).toContain('sudo apt-get install -y "$deb"');
    expect(smoke).toContain('sudo apt-get remove -y "$package_name"');
    expect(smoke).toContain('assert_package_missing');
  });
});
