import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";

export type ServiceName = "runtime" | "server";

export interface ServiceInfo {
  service: ServiceName;
  pid: number;
  startedAt: string;
  ownerId?: string;
  endpoint?: string;
  address?: string;
  token?: string;
  deviceId?: string;
}

export async function loadOrCreateServerToken(dataDirectory: string): Promise<string> {
  await mkdir(dataDirectory, { recursive: true });
  const file = path.join(dataDirectory, "server-token");
  try {
    const existing = (await readFile(file, "utf8")).trim();
    if (existing) return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const token = randomBytes(32).toString("base64url");
  try {
    await writeFile(file, `${token}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return (await readFile(file, "utf8")).trim();
  }
}

export function serviceInfoPath(dataDirectory: string, service: ServiceName): string {
  return path.join(dataDirectory, `${service}.json`);
}

export async function writeServiceInfo(
  dataDirectory: string,
  info: ServiceInfo,
): Promise<void> {
  await mkdir(dataDirectory, { recursive: true });
  const destination = serviceInfoPath(dataDirectory, info.service);
  const temporary = `${destination}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(info, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, destination);
}

export async function removeServiceInfo(
  dataDirectory: string,
  service: ServiceName,
  ownerPid: number,
  ownerId?: string,
): Promise<void> {
  const file = serviceInfoPath(dataDirectory, service);
  try {
    const current = JSON.parse(await readFile(file, "utf8")) as ServiceInfo;
    if (current.pid !== ownerPid) return;
    if (ownerId !== undefined && current.ownerId !== ownerId) return;
    await rm(file, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
