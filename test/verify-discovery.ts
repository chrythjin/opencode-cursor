/**
 * Direct verification: call Cursor's GetUsableModels with the user's real OAuth
 * token and print everything — raw count, normalized list.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  GetUsableModelsRequestSchema,
  GetUsableModelsResponseSchema,
} from "../src/proto/agent_pb";
import { callCursorUnaryRpc } from "../src/proxy";
import { getCursorModels, clearModelCache } from "../src/models";

const authPath = join(homedir(), ".local", "share", "opencode", "auth.json");
const auth = JSON.parse(readFileSync(authPath, "utf8"));
const token: string = auth.cursor?.access;
if (!token) {
  console.error("No cursor access token in auth.json");
  process.exit(1);
}

console.log("[verify] token length:", token.length);

const reqBytes = toBinary(GetUsableModelsRequestSchema, create(GetUsableModelsRequestSchema, {}));
const t0 = Date.now();
const resp = await callCursorUnaryRpc({
  accessToken: token,
  rpcPath: "/agent.v1.AgentService/GetUsableModels",
  requestBody: reqBytes,
});
const dt = Date.now() - t0;
console.log("[verify] RPC took", dt, "ms");
console.log("[verify] timedOut:", resp.timedOut, "exitCode:", resp.exitCode, "bodyLen:", resp.body.length);

if (resp.body.length === 0) {
  console.error("[verify] empty body");
  process.exit(2);
}

let decoded: any = null;
try {
  decoded = fromBinary(GetUsableModelsResponseSchema, resp.body);
  console.log("[verify] decoded as raw protobuf");
} catch (e) {
  console.log("[verify] raw decode failed:", (e as Error).message);
  if (resp.body.length >= 5) {
    const flags = resp.body[0]!;
    const view = new DataView(resp.body.buffer, resp.body.byteOffset, resp.body.byteLength);
    const msgLen = view.getUint32(1, false);
    console.log("[verify] frame flags:", flags, "msgLen:", msgLen);
    if (5 + msgLen <= resp.body.length) {
      const inner = resp.body.subarray(5, 5 + msgLen);
      decoded = fromBinary(GetUsableModelsResponseSchema, inner);
      console.log("[verify] decoded after stripping connect frame");
    }
  }
}

if (!decoded) {
  console.error("[verify] could not decode response");
  console.log("[verify] first 64 bytes hex:", Buffer.from(resp.body.subarray(0, 64)).toString("hex"));
  process.exit(3);
}

const rawModels = decoded.models ?? [];
console.log("\n=== RAW models from Cursor API:", rawModels.length, "===");
for (const m of rawModels) {
  console.log(JSON.stringify({
    modelId: m.modelId,
    displayName: m.displayName,
    displayNameShort: m.displayNameShort,
    displayModelId: m.displayModelId,
    aliases: m.aliases,
    hasThinking: Boolean(m.thinkingDetails),
  }));
}

console.log("\n=== Normalized via getCursorModels() ===");
clearModelCache();
const normalized = await getCursorModels(token);
console.log("count:", normalized.length);
for (const m of normalized) {
  console.log(`  ${m.id}  (${m.name})  reasoning=${m.reasoning}`);
}

process.exit(0);
