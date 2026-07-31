import { describe, expect, it } from "vitest";
import {
  REMOTE_ELECTRON_NATIVE_METHODS,
  SERVER_RPC_METHODS,
  UI_STARTUP_RPCS,
  supportsRpc,
} from "../../shared/api-contract.js";

describe("Soloe API transport contract", () => {
  it("implements every shared UI startup call on the application server", () => {
    expect(UI_STARTUP_RPCS.filter((rpc) => !SERVER_RPC_METHODS.has(rpc))).toEqual([]);
  });

  it("keeps remote Electron PTY operations on the application server", () => {
    for (const method of [
      "terminal.start",
      "terminal.stop",
      "terminal.input",
      "terminal.resize",
      "terminal.listRunning",
      "terminal.replay",
    ]) {
      const [namespace, name] = method.split(".");
      expect(supportsRpc("remote-electron", namespace!, name!)).toBe(true);
      expect(REMOTE_ELECTRON_NATIVE_METHODS.has(method)).toBe(false);
    }
  });

  it("limits remote Electron native overrides to host-bound capabilities", () => {
    expect([...REMOTE_ELECTRON_NATIVE_METHODS].every((method) =>
      method.startsWith("window.") ||
      method.startsWith("browser.") ||
      method.startsWith("vault.")
    )).toBe(true);
  });

  it("keeps Files data and terminal paste operations on the application server", () => {
    for (const method of [
      "files.search",
      "files.pasteIntoTerminal",
      "files.pasteImagesIntoTerminal",
      "files.listTree",
      "files.readFile",
      "files.writeFile",
      "files.openInEditor",
    ]) {
      const [namespace, name] = method.split(".");
      expect(supportsRpc("browser", namespace!, name!)).toBe(true);
      expect(supportsRpc("remote-electron", namespace!, name!)).toBe(true);
      expect(REMOTE_ELECTRON_NATIVE_METHODS.has(method)).toBe(false);
    }
  });

  it("keeps process usage on the application server for shared clients", () => {
    expect(supportsRpc("browser", "system", "usage")).toBe(true);
    expect(supportsRpc("remote-electron", "system", "usage")).toBe(true);
    expect(REMOTE_ELECTRON_NATIVE_METHODS.has("system.usage")).toBe(false);
  });

  it("keeps bounded diagnostics on the application server for shared clients", () => {
    for (const method of ["diagnostics.list", "diagnostics.crashLogs"]) {
      const [namespace, name] = method.split(".");
      expect(supportsRpc("browser", namespace!, name!)).toBe(true);
      expect(supportsRpc("remote-electron", namespace!, name!)).toBe(true);
      expect(REMOTE_ELECTRON_NATIVE_METHODS.has(method)).toBe(false);
    }
  });

  it("keeps Vault server-backed in browsers and host-local in remote Electron", () => {
    for (const method of [
      "vault.list",
      "vault.save",
      "vault.update",
      "vault.delete",
      "vault.getSecret",
    ]) {
      const [namespace, name] = method.split(".");
      expect(supportsRpc("browser", namespace!, name!)).toBe(true);
      expect(supportsRpc("remote-electron", namespace!, name!)).toBe(true);
      expect(REMOTE_ELECTRON_NATIVE_METHODS.has(method)).toBe(true);
    }
  });

  it("keeps Overview generation and streams on the application server", () => {
    for (const method of [
      "overview.get",
      "overview.regenerate",
      "overview.askStart",
      "overview.askCancel",
    ]) {
      const [namespace, name] = method.split(".");
      expect(supportsRpc("browser", namespace!, name!)).toBe(true);
      expect(supportsRpc("remote-electron", namespace!, name!)).toBe(true);
      expect(REMOTE_ELECTRON_NATIVE_METHODS.has(method)).toBe(false);
    }
  });
});
