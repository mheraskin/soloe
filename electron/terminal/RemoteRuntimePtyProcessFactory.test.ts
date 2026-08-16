import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { terminalControlProof } from "../../shared/types/terminal.js";
import type {
  RuntimeProcess,
  RuntimeProcessFactory,
} from "@soloe/runtime";
import { resolveRuntimeEndpoint, RuntimeHost } from "@soloe/runtime";
import { RemoteRuntimePtyProcessFactory } from "./RemoteRuntimePtyProcessFactory.js";

class HostedProcess extends EventEmitter implements RuntimeProcess {
  readonly pid = 9123;
  readonly writes: string[] = [];
  readonly resizes: Array<{ cols: number; rows: number }> = [];
  killed = false;

  write(data: string): void {
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }

  kill(): void {
    this.killed = true;
    this.emit("exit", { exitCode: 0, signal: null });
  }
}

describe("RemoteRuntimePtyProcessFactory", () => {
  it("waits for a supervised Environment Runtime that is still starting", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "soloe-runtime-startup-"));
    const endpoint = resolveRuntimeEndpoint({
      dataDirectory: directory,
      userIdentity: `runtime-startup-test-${process.pid}`,
    });
    const runtime = new RuntimeHost({
      endpoint,
      processFactory: { spawn: () => new HostedProcess() },
    });
    let remoteFactory: RemoteRuntimePtyProcessFactory | undefined;

    try {
      const connection = RemoteRuntimePtyProcessFactory.connect(endpoint, {
        timeoutMs: 1_000,
        retryDelayMs: 10,
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      await runtime.listen();

      remoteFactory = await connection;

      await expect(remoteFactory.listRunning()).resolves.toEqual([]);
    } finally {
      await remoteFactory?.dispose();
      await runtime.shutdown();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("disconnects without terminating runtime-owned PTYs", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "soloe-remote-pty-"));
    const endpoint = resolveRuntimeEndpoint({
      dataDirectory: directory,
      userIdentity: `remote-pty-test-${process.pid}`,
    });
    const hostedProcess = new HostedProcess();
    const processFactory: RuntimeProcessFactory = { spawn: () => hostedProcess };
    const runtime = new RuntimeHost({ endpoint, processFactory });
    let remoteFactory: RemoteRuntimePtyProcessFactory | undefined;

    try {
      await runtime.listen();
      remoteFactory = await RemoteRuntimePtyProcessFactory.connect(endpoint);
      const remoteProcess = await remoteFactory.spawn({
        terminalId: "electron-terminal",
        sessionId: "electron-session",
        spec: {
          file: "test-shell",
          args: [],
          cwd: directory,
          env: {},
          description: "test",
        },
        cols: 90,
        rows: 30,
        env: {},
      });
      const data = new Promise<string>((resolve) => remoteProcess.onData(resolve));

      hostedProcess.emit("data", "runtime output");
      expect(await data).toBe("runtime output");
      remoteProcess.write("electron input");
      remoteProcess.resize(100, 40);
      await remoteFactory.flush();
      expect(hostedProcess.writes).toEqual(["electron input"]);
      expect(hostedProcess.resizes).toEqual([{ cols: 100, rows: 40 }]);
      const inputLease = await remoteFactory.currentInputLease("electron-terminal");
      expect(inputLease).toEqual(expect.objectContaining({
        terminalId: "electron-terminal",
        controllerDeviceId: expect.stringMatching(/^desktop-/),
      }));
      await expect(remoteFactory.releaseInputLease(
        "electron-terminal",
        terminalControlProof(inputLease!),
      )).resolves.toBe(true);
      await expect(remoteFactory.currentInputLease("electron-terminal")).resolves.toBeNull();

      await remoteFactory.dispose();
      remoteFactory = undefined;
      expect(hostedProcess.killed).toBe(false);

      remoteFactory = await RemoteRuntimePtyProcessFactory.connect(endpoint);
      const [running] = await remoteFactory.listRunning();
      expect(running).toEqual(
        expect.objectContaining({
          terminalId: "electron-terminal",
          sessionId: "electron-session",
          pid: 9123,
        }),
      );
      const reattachedProcess = remoteFactory.attach(running!);
      const reattachedData = new Promise<string>((resolve) => reattachedProcess.onData(resolve));
      hostedProcess.emit("data", "output after Electron restart");
      expect(await reattachedData).toBe("output after Electron restart");
    } finally {
      await remoteFactory?.dispose();
      await runtime.shutdown();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
