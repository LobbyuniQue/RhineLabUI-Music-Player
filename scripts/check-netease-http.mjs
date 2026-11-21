import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { createAccountMiddleware } from "./lib/netease-account-http.mjs";
import { onRequest } from "../functions/api/netease/playlist.js";

test("public Pages endpoint handles invalid inputs without an account or upstream call", async () => {
  const url = "https://rhine.example/api/netease/playlist?source=invalid";
  const invalid = await onRequest({ request: new Request(url) });
  assert.equal(invalid.status, 400);
  assert.ok((await invalid.json()).error);
  assert.equal(invalid.headers.get("cache-control"), "no-store");
  const post = await onRequest({ request: new Request(url, { method: "POST" }) });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("allow"), "GET");
});

test("account actions are local and same-origin, and private responses are never cached", async t => {
  let invocations = 0;
  const middleware = createAccountMiddleware({
    status: () => { invocations++; return { state: "signed-out" }; },
    tracks: ({ id, offset }) => { invocations++; return { id, offset }; },
    quality: () => { invocations++; return { levels: [] }; },
  });
  const server = createServer((req, res) => middleware(req, res, () => res.writeHead(404).end()));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const headers = { origin, "content-type": "application/json", "x-rhine-account": "1" };
  const post = (action, body = {}, extra = {}) => fetch(origin + "/api/netease/account/" + action, {
    method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(body),
  });
  assert.equal((await post("status", {}, { origin: "https://example.org" })).status, 403);
  assert.equal((await post("status", {}, { "x-rhine-account": "" })).status, 403);
  assert.equal((await fetch(origin + "/api/netease/account/status")).status, 405);
  assert.equal((await post("tracks", { id: "123", offset: -1 })).status, 400);
  assert.equal((await post("quality", { id: "123" })).status, 400);
  assert.equal((await post("unknown")).status, 404);
  assert.equal(invocations, 0);
  const status = await post("status");
  assert.equal(status.status, 200);
  assert.equal(status.headers.get("cache-control"), "no-store");
  assert.equal((await status.json()).state, "signed-out");
  assert.deepEqual(await (await post("tracks", { id: "123", offset: 20 })).json(), { id: "123", offset: 20 });
  assert.deepEqual(await (await post("quality", { id: "ab".repeat(16) })).json(), { levels: [] });
  assert.equal(invocations, 3);
});
