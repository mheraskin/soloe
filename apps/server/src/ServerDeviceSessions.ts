import path from "node:path";
import { hostname } from "node:os";
import type { DeviceDescriptor } from "../../../shared/types/devices.js";
import type {
  ConnectionSnapshot,
  MachineConnection,
  ShortDnsInfo,
} from "../../../shared/types/connections.js";
import { ConnectionRegistry } from "../../../electron/connections/ConnectionRegistry.js";
import {
  TailscaleDiscovery,
  type TailscaleDiscoveryResult,
} from "../../../electron/connections/TailscaleDiscovery.js";
import {
  DeviceDnsSetup,
  resolveDeviceDnsHelperPath,
} from "../../../electron/connections/DeviceDnsSetup.js";
import {
  describeSoloeEndpoint,
  probeSoloeEndpoint,
} from "../../../electron/connections/SoloeEndpointProbe.js";
import { RemoteSessionDevice } from "../../../electron/devices/RemoteSessionDevice.js";
import {
  MultiDeviceSessions,
  type SessionDevice,
} from "../../../electron/sessions/MultiDeviceSessions.js";
import { isSessionDeviceConnection } from "../../../electron/sessions/session-device-connection.js";

const MAX_SESSION_DEVICES = 10;

export interface ServerDeviceSessionsOptions {
  dataDirectory: string;
  localDescriptor: DeviceDescriptor;
  localEndpoint: string;
  localToken: string;
  fetchImpl?: typeof fetch;
  discover?: {
    discover(port?: number): Promise<TailscaleDiscoveryResult>;
  };
}

/**
 * Server-owned Device aggregation shared by browser and server-backed desktop
 * clients. Device stores and runtimes remain authoritative; this module owns
 * only discovery, inventory projection, and composite request routing.
 */
export class ServerDeviceSessions {
  readonly connections: ConnectionRegistry;
  private readonly fetchImpl: typeof fetch;
  private readonly discover: {
    discover(port?: number): Promise<TailscaleDiscoveryResult>;
  };
  private records = new Map<string, { key: string; device: SessionDevice }>();
  private detachConnections: (() => void) | null = null;
  private reconcileQueue: Promise<void> = Promise.resolve();
  private initialized = false;
  private disposed = false;
  private sessionsValue: MultiDeviceSessions | null = null;

  constructor(private readonly options: ServerDeviceSessionsOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.discover = options.discover ?? new TailscaleDiscovery();
    this.connections = new ConnectionRegistry({
      filePath: path.join(options.dataDirectory, "connections.json"),
      localName: hostname().trim() || "This device",
      discover: (port) => this.discover.discover(port),
      probe: (endpoint) => probeSoloeEndpoint(endpoint, this.fetchImpl),
      describe: (endpoint) =>
        describeSoloeEndpoint(endpoint, this.fetchImpl, {
          bootstrapTailscale: true,
        }),
      shortDns: new DeviceDnsSetup({
        helperPath: resolveDeviceDnsHelperPath(),
      }),
      remoteShortDns: {
        setup: (machine) => this.runRemoteShortDns(machine, "setup"),
        remove: (machine) => this.runRemoteShortDns(machine, "remove"),
      },
    });
  }

  get sessions(): MultiDeviceSessions {
    if (!this.sessionsValue) {
      throw new Error("Server Device Sessions have not been initialized.");
    }
    return this.sessionsValue;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    await this.connections.init();
    await this.connections.bindLocalDescriptor(this.options.localDescriptor);
    const snapshot = await this.connections.refresh().catch(() => this.connections.get());
    this.sessionsValue = new MultiDeviceSessions({
      devices: this.resolveDevices(snapshot),
    });
    this.detachConnections = this.connections.onChange((next) => {
      this.reconcileQueue = this.reconcileQueue
        .catch(() => undefined)
        .then(async () => {
          if (this.disposed || !this.sessionsValue) return;
          await this.sessionsValue.reconcileDevices(this.resolveDevices(next));
        })
        .catch((error) => {
          console.warn("[server] failed to reconcile Soloe Devices", error);
        });
    });
    await this.sessionsValue.refresh();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.detachConnections?.();
    this.detachConnections = null;
    await this.reconcileQueue.catch(() => undefined);
    await this.sessionsValue?.dispose();
    this.sessionsValue = null;
    this.records.clear();
  }

  private runRemoteShortDns(
    machine: MachineConnection,
    operation: "setup" | "remove",
  ): Promise<ShortDnsInfo> {
    if (!machine.deviceId) {
      throw new Error("The selected Device has no trusted identity.");
    }
    return operation === "setup"
      ? this.sessions.setupShortDns(machine.deviceId)
      : this.sessions.removeShortDns(machine.deviceId);
  }

  private resolveDevices(snapshot: ConnectionSnapshot): SessionDevice[] {
    const next = new Map<string, { key: string; device: SessionDevice }>();
    const localKey = `local:${this.options.localEndpoint}`;
    next.set(this.options.localDescriptor.deviceId, {
      key: localKey,
      device:
        this.records.get(this.options.localDescriptor.deviceId)?.key === localKey
          ? this.records.get(this.options.localDescriptor.deviceId)!.device
          : new RemoteSessionDevice({
              deviceId: this.options.localDescriptor.deviceId,
              displayName: this.options.localDescriptor.name,
              endpoint: this.options.localEndpoint,
              local: true,
              token: this.options.localToken,
              fetchImpl: this.fetchImpl,
            }),
    });

    for (const machine of snapshot.machines) {
      if (
        !isSessionDeviceConnection(machine) ||
        next.has(machine.deviceId) ||
        next.size >= MAX_SESSION_DEVICES
      ) {
        continue;
      }
      const key = `remote:${machine.endpoint}`;
      next.set(machine.deviceId, {
        key,
        device:
          this.records.get(machine.deviceId)?.key === key
            ? this.records.get(machine.deviceId)!.device
            : new RemoteSessionDevice({
                deviceId: machine.deviceId,
                displayName: machine.name,
                endpoint: machine.endpoint,
                fetchImpl: this.fetchImpl,
                bootstrapTailscale: true,
              }),
      });
    }
    this.records = next;
    return [...next.values()].map(({ device }) => device);
  }
}
