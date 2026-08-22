import { createConnection } from "node:net";
import type { ClipboardImageWriter } from "../files/FileService.js";

const MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;

interface TrayClipboardResponse {
  ok: boolean;
  error?: string;
}

export class TrayClipboardImageWriter implements ClipboardImageWriter {
  constructor(
    private readonly endpoint: string,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  writeImage(image: { mimeType: string; data: Buffer }): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = createConnection({ path: this.endpoint });
      let settled = false;
      let response = Buffer.alloc(0);
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (error) reject(error);
        else resolve();
      };

      socket.setTimeout(this.timeoutMs);
      socket.once("connect", () => {
        socket.end(`${JSON.stringify({
          version: 1,
          type: "write_image",
          mimeType: image.mimeType,
          dataBase64: image.data.toString("base64"),
        })}\n`);
      });
      socket.on("data", (chunk: Buffer) => {
        response = Buffer.concat([response, chunk]);
        if (response.length > MAX_RESPONSE_BYTES) {
          finish(new Error("Tray Host clipboard response exceeded its size limit"));
          return;
        }
        const newline = response.indexOf(0x0a);
        if (newline < 0) return;
        try {
          const result = JSON.parse(
            response.subarray(0, newline).toString("utf8"),
          ) as TrayClipboardResponse;
          if (result.ok === true) finish();
          else {
            finish(new Error(
              result.error?.trim() || "Tray Host rejected the clipboard image",
            ));
          }
        } catch (error) {
          finish(new Error(
            "Tray Host returned an invalid clipboard response",
            { cause: error },
          ));
        }
      });
      socket.once("timeout", () => {
        finish(new Error("Tray Host clipboard request timed out"));
      });
      socket.once("error", (error) => finish(error));
      socket.once("end", () => {
        if (!settled) {
          finish(new Error(
            "Tray Host closed the clipboard request without a response",
          ));
        }
      });
    });
  }
}
