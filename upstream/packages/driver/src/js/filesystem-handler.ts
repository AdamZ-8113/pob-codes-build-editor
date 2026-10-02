import * as zenfs from "@zenfs/core";
import { isLocalUserStorageOperation, markEnvironmentError } from "./error.ts";
import type { RpcResult } from "./rpc.ts";

const FILESYSTEM_OPERATIONS = new Set([
  "readdir",
  "lstat",
  "stat",
  "fstat",
  "open",
  "close",
  "read",
  "write",
  "mkdir",
  "unlink",
  "rmdir",
  "rename",
  "truncate",
  "ftruncate",
]);

export class FilesystemRpcHandler {
  private localUserFds = new Set<number>();
  private cloudDirectory: string | undefined;
  private traceEnabled = false;
  private payloadGate: { ensurePath(path: string): Promise<void>; packageIdForPath(path: string): string | undefined } | undefined;
  private readonly rootPaths = new Map<string, number>();
  private readonly operations: Record<string, number> = {};
  private readonly writeNamespaces = { root: 0, user: 0 };
  private readonly fdNamespaces = new Map<number, "root" | "user">();

  profile() {
    this.traceEnabled = true;
    return {
      operations: { ...this.operations },
      packagedPaths: [...this.rootPaths],
      writes: { ...this.writeNamespaces },
    };
  }

  reset(cloudDirectory?: string) {
    this.localUserFds.clear();
    this.cloudDirectory = cloudDirectory;
    this.rootPaths.clear();
    this.fdNamespaces.clear();
    this.writeNamespaces.root = 0;
    this.writeNamespaces.user = 0;
    this.payloadGate = undefined;
  }

  setPayloadGate(gate?: { ensurePath(path: string): Promise<void>; packageIdForPath(path: string): string | undefined }) {
    this.payloadGate = gate;
  }

  handles(operation: string): boolean {
    return FILESYSTEM_OPERATIONS.has(operation);
  }

  async handle(operation: string, args: unknown[], data?: Uint8Array): Promise<RpcResult> {
    this.operations[operation] = (this.operations[operation] ?? 0) + 1;
    try {
      const result = await this.handleOperation(operation, args, data);
      // Only successful immutable payload lookups; never user paths or contents.
      const path = args[0];
      if (this.traceEnabled && ["open", "stat", "lstat", "readdir"].includes(operation)
        && typeof path === "string" && path.startsWith("/root/") && !path.split("/").includes("..")
        && (this.rootPaths.has(path) || this.rootPaths.size < 4096)) {
        this.rootPaths.set(path, (this.rootPaths.get(path) ?? 0) + 1);
      }
      return result;
    } catch (error) {
      if (isLocalUserStorageOperation(operation, args, this.localUserFds, this.cloudDirectory)) {
        throw markEnvironmentError(error, "storage");
      }
      throw error;
    }
  }

  private async handleOperation(operation: string, args: unknown[], data?: Uint8Array): Promise<RpcResult> {
    const fs = zenfs.fs;
    switch (operation) {
      case "readdir": {
        const entries = await fs.promises.readdir(args[0] as string, { withFileTypes: true });
        return { value: entries.map((entry) => [entry.name, entry.isFile() ? 1 : entry.isDirectory() ? 2 : 3]) };
      }
      case "lstat":
        return { value: this.serializeStat(await fs.promises.lstat(args[0] as string), args[0] as string) };
      case "stat":
        return { value: this.serializeStat(await fs.promises.stat(args[0] as string), args[0] as string) };
      case "fstat":
        return {
          value: serializeStat(
            await new Promise<zenfs.Stats>((resolve, reject) =>
              fs.fstat(args[0] as number, (error, value) => error ? reject(error) : resolve(value!))
            ),
          ),
        };
      case "open": {
        const path = args[0] as string;
        if (path.startsWith("/root/") && this.payloadGate?.packageIdForPath(path)) {
          await this.payloadGate.ensurePath(path);
        }
        const fd = (await fs.promises.open(args[0] as string, args[1] as string, args[2] as number | undefined)).fd;
        const namespace = path.startsWith("/root/") ? "root" : path.startsWith("/user/") ? "user" : undefined;
        if (namespace) this.fdNamespaces.set(fd, namespace);
        if (namespace && /[wa+]/.test(args[1] as string)) this.writeNamespaces[namespace]++;
        if (isLocalUserStorageOperation(operation, args, this.localUserFds, this.cloudDirectory)) {
          this.localUserFds.add(fd);
        }
        return { value: fd };
      }
      case "close":
        await new Promise<void>((resolve, reject) =>
          fs.close(args[0] as number, (error) => error ? reject(error) : resolve())
        );
        this.localUserFds.delete(args[0] as number);
        this.fdNamespaces.delete(args[0] as number);
        return { value: 0 };
      case "read": {
        const buffer = new Uint8Array(args[1] as number);
        const bytesRead = await new Promise<number>((resolve, reject) =>
          fs.read(
            args[0] as number,
            buffer,
            0,
            buffer.length,
            args[2] as number,
            (error, count) => error ? reject(error) : resolve(count ?? 0),
          )
        );
        return { value: bytesRead, data: buffer.subarray(0, bytesRead) };
      }
      case "write": {
        const namespace = this.fdNamespaces.get(args[0] as number);
        if (namespace) this.writeNamespaces[namespace]++;
        const written = await new Promise<number>((resolve, reject) =>
          fs.write(
            args[0] as number,
            data!,
            0,
            data!.length,
            args[1] as number,
            (error, count) => error ? reject(error) : resolve(count ?? 0),
          )
        );
        return { value: written };
      }
      case "mkdir":
        this.recordPathWrite(args[0]);
        await fs.promises.mkdir(args[0] as string, args[1] as number);
        return { value: 0 };
      case "unlink":
        this.recordPathWrite(args[0]);
        await fs.promises.unlink(args[0] as string);
        return { value: 0 };
      case "rmdir":
        this.recordPathWrite(args[0]);
        await fs.promises.rmdir(args[0] as string);
        return { value: 0 };
      case "rename":
        this.recordPathWrite(args[0]);
        this.recordPathWrite(args[1]);
        await fs.promises.rename(args[0] as string, args[1] as string);
        return { value: 0 };
      case "truncate":
        this.recordPathWrite(args[0]);
        await fs.promises.truncate(args[0] as string, args[1] as number);
        return { value: 0 };
      case "ftruncate":
        if (this.fdNamespaces.has(args[0] as number)) this.writeNamespaces[this.fdNamespaces.get(args[0] as number)!]++;
        await new Promise<void>((resolve, reject) =>
          fs.ftruncate(args[0] as number, args[1] as number, (error) => error ? reject(error) : resolve())
        );
        return { value: 0 };
      default:
        throw new Error(`Unknown filesystem operation: ${operation}`);
    }
  }

  private serializeStat(stat: zenfs.Stats, path?: string) {
    const mode = path && this.cloudDirectory &&
        (path === this.cloudDirectory || path.startsWith(`${this.cloudDirectory}/`))
      ? stat.mode | 0o777
      : stat.mode;
    return { mode, size: stat.size };
  }

  private recordPathWrite(value: unknown) {
    if (typeof value !== "string") return;
    if (value.startsWith("/root/")) this.writeNamespaces.root++;
    else if (value.startsWith("/user/")) this.writeNamespaces.user++;
  }
}

function serializeStat(stat: zenfs.Stats) {
  return { mode: stat.mode, size: stat.size };
}

