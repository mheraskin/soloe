import { describe, expect, it } from "vitest";
import {
  CLIENT_NATIVE_METHODS,
  DEVICE_RPC_METHODS,
  PWA_PANE_REQUIREMENTS,
  REMOTE_ELECTRON_NATIVE_METHODS,
  SERVER_EVENT_METHODS,
  SERVER_RPC_METHODS,
  SOLOE_API_METHODS,
  operationOwner,
  supportsRpc,
} from "./api-contract.js";

const apiKeys = new Set(
  Object.entries(SOLOE_API_METHODS).flatMap(([namespace, methods]) =>
    methods.map((method) => `${namespace}.${method}`),
  ),
);

describe("Soloe API compatibility matrix", () => {
  it("classifies every declared API method on every transport", () => {
    expect(apiKeys.size).toBe(
      Object.values(SOLOE_API_METHODS).reduce(
        (count, methods) => count + methods.length,
        0,
      ),
    );
    for (const key of apiKeys) {
      const [namespace, method] = key.split(".");
      for (const transport of [
        "local-electron",
        "remote-electron",
        "browser",
      ] as const) {
        const owner = operationOwner(transport, namespace!, method!);
        expect(
          supportsRpc(transport, namespace!, method!),
          `${transport} ${key}`,
        ).toBe(owner !== "unsupported");
      }
    }
  });

  it("classifies every advertised RPC, event, and native replacement", () => {
    for (const key of SERVER_RPC_METHODS) {
      expect(
        apiKeys.has(key) || DEVICE_RPC_METHODS.has(key),
        `${key} is neither renderer-visible nor a host-private Device RPC`,
      ).toBe(true);
    }
    for (const key of DEVICE_RPC_METHODS) {
      expect(SERVER_RPC_METHODS, key).toContain(key);
      expect(apiKeys, `${key} must stay behind CockpitApi`).not.toContain(key);
    }
    for (const collection of [
      SERVER_EVENT_METHODS,
      CLIENT_NATIVE_METHODS,
      REMOTE_ELECTRON_NATIVE_METHODS,
    ]) {
      for (const key of collection) {
        expect(apiKeys, key).toContain(key);
      }
    }
  });

  it("keeps host-bound remote Electron operations native", () => {
    for (const key of apiKeys) {
      const [namespace, method] = key.split(".");
      const owner = operationOwner("remote-electron", namespace!, method!);
      if (owner === "electron-native") {
        expect(["window", "browser", "vault", "connections"]).toContain(namespace);
      }
    }
    expect(operationOwner("remote-electron", "vault", "getSecret")).toBe(
      "electron-native",
    );
    expect(operationOwner("browser", "vault", "getSecret")).toBe(
      "application-server",
    );
    expect(operationOwner("browser", "browser", "openDevTools")).toBe(
      "unsupported",
    );
  });

  it("supports every required operation for visible PWA panes", () => {
    for (const [pane, requirements] of Object.entries(PWA_PANE_REQUIREMENTS)) {
      for (const key of requirements) {
        const [namespace, method] = key.split(".");
        expect(
          supportsRpc("browser", namespace!, method!),
          `${pane} requires ${key}`,
        ).toBe(true);
      }
    }
  });
});
