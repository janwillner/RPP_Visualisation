import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { SymbolNotFoundError, type SumReadOptions, type SymbolAccess, type SymbolWrite } from "./symbol-access";

export interface AdsBridgeOptions {
  /** The self-contained AdsBridge.exe (packaged) or the built AdsBridge.dll (apps/ads-bridge, run through `dotnet`). */
  bridgePath: string;
  targetAmsNetId: string;
  targetAdsPort: number;
  /** Command used to run a bridge dll; defaults to `dotnet`. */
  dotnet?: string;
}

/** The command line that starts the bridge: an exe runs directly, a dll through `dotnet`. */
export function bridgeLaunch(options: AdsBridgeOptions): { command: string; args: string[] } {
  const { bridgePath, targetAmsNetId, targetAdsPort, dotnet = "dotnet" } = options;
  const target = ["--ams-net-id", targetAmsNetId, "--ads-port", String(targetAdsPort)];
  return bridgePath.toLowerCase().endsWith(".exe")
    ? { command: bridgePath, args: target }
    : { command: dotnet, args: [bridgePath, ...target] };
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
  /** Open requests with the bridge process they went to: a bridge that ends fails only its own. */
  private readonly pending = new Map<
    number,
    { child: ChildProcessWithoutNullStreams; resolve: (r: Response) => void; reject: (e: Error) => void }
  >();

  constructor(private readonly options: AdsBridgeOptions) {}

  async read(path: string): Promise<unknown> {
    return this.request({ op: "read", path }, path);
  }

  async typeOf(path: string): Promise<string | undefined> {
    return ((await this.request({ op: "typeOf", path }, path)) as string | null) ?? undefined;
  }

  async sumRead(paths: readonly string[], options: SumReadOptions = {}): Promise<unknown[]> {
    const changes = options.changes === undefined ? {} : { changes: options.changes };
    return (await this.request({ op: "sumRead", paths, ...changes }, paths.join(", "))) as unknown[];
  }

  async sumWrite(writes: readonly SymbolWrite[]): Promise<void> {
    await this.request({ op: "sumWrite", writes }, writes.map((w) => w.path).join(", "));
  }

  close(): void {
    this.child?.kill();
    this.child = undefined;
  }

  private async request(body: Record<string, unknown>, path: string): Promise<unknown> {
    const child = this.ensureChild();
    const id = this.nextId++;
    const response = await new Promise<Response>((resolve, reject) => {
      this.pending.set(id, { child, resolve, reject });
      // A bridge that has just died fails the write (EPIPE); the request fails, the next one starts a new bridge.
      child.stdin.write(`${JSON.stringify({ id, ...body })}\n`, (error) => {
        if (!error || !this.pending.delete(id)) return;
        reject(new Error(`ADS bridge is not reachable: ${error.message}`));
      });
    });
    if (response.ok) return response.value;
    if (response.notFound) throw new SymbolNotFoundError(path);
    // A failed request starts a new bridge for the next one. TwinCAT.Ads cannot recover in the same process once it
    // started before the AMS router was ready (the service at boot): every new AdsClient fails to register its port.
    if (this.child === child) this.close();
    throw new Error(response.error ?? "ADS bridge request failed");
  }

  private ensureChild(): ChildProcessWithoutNullStreams {
    if (this.child && this.child.exitCode === null) return this.child;
    const { command, args } = bridgeLaunch(this.options);
    const child = spawn(command, args, {
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
      for (const [id, waiter] of this.pending) {
        if (waiter.child !== child) continue;
        this.pending.delete(id);
        waiter.reject(new Error(reason));
      }
      if (this.child === child) this.child = undefined;
    };
    // Without a listener a failed write to a dead bridge (EPIPE) would end the whole gateway.
    child.stdin.on("error", (e) => {
      fail(`ADS bridge input failed: ${e.message}`);
      child.kill();
    });
    child.on("error", (e) => fail(`ADS bridge could not start (${[command, ...args].join(" ")}): ${e.message}`));
    child.on("exit", (code) => fail(`ADS bridge exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`));
    this.child = child;
    return child;
  }
}
