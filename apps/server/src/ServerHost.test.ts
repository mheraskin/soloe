import { describe, expect, it } from "vitest";

import { shouldEnsureTailscaleSharing } from "./ServerHost.js";

describe("shouldEnsureTailscaleSharing", () => {
  it("publishes the device when a development server has no bundled web root", () => {
    expect(shouldEnsureTailscaleSharing({ SOLOE_WEB_ROOT: "" })).toBe(true);
  });

  it("honors an explicit opt-out", () => {
    expect(shouldEnsureTailscaleSharing({ SOLOE_TAILSCALE_AUTO_SERVE: "0" })).toBe(false);
  });
});
