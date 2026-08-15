import { describe, it, expect, beforeAll } from "vitest";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installCanvasPolyfill, makeCoverJpeg } from "../node-canvas";

const exec = promisify(execFile);
const BUNDLE = join(process.cwd(), "dist-mcp", "server.mjs");

/**
 * The MCP server, driven the way a real client drives it: spawn the process,
 * speak JSON-RPC over stdio, read the replies.
 *
 * Deliberately an integration test rather than calling the handlers directly.
 * The failure this guards against is not "does the embed function work" -- that
 * is covered elsewhere -- but "does an agent actually get a working tool", and
 * every interesting way that breaks lives in the parts a unit test skips:
 * bundling, the stdio transport, the polyfill installing before the encoder
 * loads, and crypto being present on globalThis.
 */
async function rpc(requests: object[], timeoutMs = 300_000): Promise<Record<number, any>> {
  const child = spawn("node", [BUNDLE], { stdio: ["pipe", "pipe", "pipe"] });
  const out: Record<number, any> = {};
  const waiters = new Map<number, (m: any) => void>();
  let buf = "";

  child.stdout.on("data", (c) => {
    buf += c.toString();
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (typeof msg.id === "number") {
          out[msg.id] = msg;
          waiters.get(msg.id)?.(msg);
          waiters.delete(msg.id);
        }
      } catch { /* not JSON-RPC */ }
    }
  });

  try {
    // One at a time, waiting for each reply. A real client does this, and it
    // matters here: tool calls are not independent -- detect reads the file
    // embed writes, so pipelining them races the filesystem and fails for a
    // reason that has nothing to do with the code under test.
    for (const r of requests) {
      const id = (r as { id: number }).id;
      const reply = new Promise<any>((res, rej) => {
        waiters.set(id, res);
        setTimeout(() => rej(new Error(`timed out waiting for id ${id}`)), timeoutMs);
      });
      child.stdin.write(JSON.stringify(r) + "\n");
      await reply;
    }
  } finally {
    child.kill();
  }
  return out;
}

const init = {
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } },
};
const call = (id: number, name: string, args: object) =>
  ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

let dir: string;
let cover: string;

beforeAll(async () => {
  // Build the bundle the test drives, so this never passes against a stale one.
  await exec("npx", [
    "esbuild", "src/mcp-server.ts", "--bundle", "--platform=node", "--format=esm",
    "--target=node18", "--outfile=dist-mcp/server.mjs", "--external:@napi-rs/canvas",
  ], { cwd: process.cwd() });

  installCanvasPolyfill();
  dir = await mkdtemp(join(tmpdir(), "stegstr-mcp-"));
  cover = join(dir, "cover.jpg");
  await writeFile(cover, makeCoverJpeg(2400, 1800, 11));
}, 240_000);

describe("MCP server", () => {
  it("advertises its tools to a client", async () => {
    const res = await rpc([init, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }]);
    expect(res[1].result.serverInfo.name).toBe("stegstr");
    const names = res[2].result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("stegstr_embed");
    expect(names).toContain("stegstr_detect");
    expect(names).toContain("stegstr_platforms");
  }, 240_000);

  it("hides a message and reads it back", async () => {
    const out = join(dir, "out.jpg");
    const secret = "The drop is at the north gate, 0900.";
    const res = await rpc([
      init,
      call(2, "stegstr_embed", { image_path: cover, message: secret, output_path: out, platform: "universal" }),
      call(3, "stegstr_detect", { image_path: out }),
    ]);
    expect(res[2].result.isError).toBeFalsy();
    expect(res[2].result.content[0].text).toContain("verified");
    expect(res[3].result.content[0].text).toContain(secret);
  }, 600_000);

  it("reports a cover with no texture rather than embedding into it", async () => {
    // A flat cover has nothing to hide data in (§10.6): it fails the
    // round-trip outright. An agent must be told that, not handed an image
    // that looks fine and carries nothing.
    const flat = join(dir, "flat.jpg");
    await writeFile(flat, makeCoverJpeg(1200, 900, 0));
    const res = await rpc([init, call(2, "stegstr_inspect_cover", { image_path: flat })]);
    expect(res[2].result.content[0].text).toMatch(/detail score/i);
  }, 240_000);

  it("refuses an unknown platform instead of silently picking one", async () => {
    const res = await rpc([
      init,
      call(2, "stegstr_embed", {
        image_path: cover, message: "x", output_path: join(dir, "never.jpg"), platform: "myspace",
      }),
    ]);
    expect(res[2].result.isError).toBe(true);
    expect(res[2].result.content[0].text).toMatch(/unknown platform/i);
  }, 240_000);

  it("says so plainly when an image carries nothing", async () => {
    const plain = join(dir, "plain.jpg");
    await writeFile(plain, makeCoverJpeg(800, 600, 3));
    const res = await rpc([init, call(2, "stegstr_detect", { image_path: plain })]);
    const text = res[2].result.content[0].text;
    expect(text).toMatch(/no hidden stegstr content/i);
    // And explains the usual cause rather than leaving the agent guessing.
    expect(text).toMatch(/resized|screenshot/i);
  }, 300_000);
});
