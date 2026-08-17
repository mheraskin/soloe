import { describe, expect, it } from "vitest";

import { shouldEnsureTailscaleSharing, tailscaleServeTarget } from "./ServerHost.js";

describe("shouldEnsureTailscaleSharing", () => {
  it("publishes the device when a development server has no bundled web root", () => {
    expect(shouldEnsureTailscaleSharing({ SOLOE_WEB_ROOT: "" })).toBe(true);
  });

  it("honors an explicit opt-out", () => {
    expect(shouldEnsureTailscaleSharing({ SOLOE_TAILSCALE_AUTO_SERVE: "0" })).toBe(false);
  });
});

describe("tailscaleServeTarget", () => {
  it("targets the separate development browser host", () => {
    expect(tailscaleServeTarget("http://127.0.0.1:4317", {
      SOLOE_WEB_ROOT: "",
    })).toBe("http://127.0.0.1:4318");
  });

  it("honors a custom development browser port", () => {
    expect(tailscaleServeTarget("http://127.0.0.1:4317", {
      SOLOE_WEB_ROOT: "",
      SOLOE_WEB_PORT: "5173",
    })).toBe("http://127.0.0.1:5173");
  });

  it("targets the API server when packaged web assets are present", () => {
    expect(tailscaleServeTarget("http://127.0.0.1:4317", {
      SOLOE_WEB_ROOT: "/Applications/Soloe.app/Contents/Resources/out/web",
    })).toBe("http://127.0.0.1:4317");
  });
});
