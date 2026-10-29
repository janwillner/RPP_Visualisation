import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { SymbolNotFoundError, type SymbolAccess } from "./symbol-access";

export interface AdsBridgeOptions {
  /** Path to the built AdsBridge.dll (apps/ads-bridge). */
  bridgePath: string;
  targetAmsNetId: string;
  targetAdsPort: number;
  /** Command used to run the bridge; defaults to `dotnet`. */
  dotnet?: string;
}

interface Response {
  id: number;
  ok: boolean;
  value?: unknown;
  error?: string;
  notFound?: boolean;
}

/**
 * ADS adapter for the symbol access seam that delegates to the .NET ADS bridge (Beckhoff's TwinCAT.Ads),
 * which talks to the local AMS router like any TwinCAT application, so no route or TCP loopback is needed.
 * The bridge runs as a child process speaking one JSON request/response per line; it is restarted on demand.
 */
export class AdsBridgeSymbolAccess implements SymbolAccess {
  private child: ChildProcessWithoutNullStreams | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (r: Response) => void; reject: (e: Error) => void }>();

  constructor(private readonly options: AdsBridgeOptions) {}

  async read(path: string): Promise<unknown> {
    return this.request({ op: "read", path }, path);
  }

  async typeOf(path: string): Promise<string | undefined> {
    return ((await this.request({ op: "typeOf", path }, path)) as string | null) ?? undefined;
  }

  async sumRead(paths: readonly string[]): Promise<unknown[]> {
    return (await this.request({ op: "sumRead", paths }, paths.join(", "))) as unknown[];
  }

  close(): void {
    this.child?.kill();
    this.child = undefined;
  }

  private async request(body: Record<string, unknown>, path: string): Promise<unknown> {
    const child = this.ensureChild();
    const id = this.nextId++;
    const response = await new Promise<Response>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ id, ...body })}\n`);
    });
    if (response.ok) return response.value;
    if (response.notFound) throw new SymbolNotFoundError(path);
    throw new Error(response.error ?? "ADS bridge request failed");
  }

  private ensureChild(): ChildProcessWithoutNullStreams {
    if (this.child && this.child.exitCode === null) return this.child;
    const { bridgePath, targetAmsNetId, targetAdsPort, dotnet = "dotnet" } = this.options;
    const child = spawn(dotnet, [bridgePath, "--ams-net-id", targetAmsNetId, "--ads-port", String(targetAdsPort)], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    createInterface({ input: child.stdout }).on("line", (line) => {
      let response: Response;
      try {
        response = JSON.parse(line) as Response;
      } catch {
        return;
      }
      const waiter = this.pending.get(response.id);
      this.pending.delete(response.id);
      waiter?.resolve(response);
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-2000)));
    const fail = (reason: string) => {
      for (const { reject } of this.pending.values()) reject(new Error(reason));
      this.pending.clear();
      if (this.child === child) this.child = undefined;
    };
    child.on("error", (e) => fail(`ADS bridge could not start (${dotnet} ${bridgePath}): ${e.message}`));
    child.on("exit", (code) => fail(`ADS bridge exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`));
    this.child = child;
    return child;
  }
}
