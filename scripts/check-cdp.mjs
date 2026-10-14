import assert from "node:assert/strict";
import { Cdp } from "./lib/cdp.mjs";
import { CdpTimeoutError } from "./lib/archive-return.mjs";

function fixture(options) {
  const messages = [];
  const socket = {
    addEventListener(type, listener) { if (type === "message") this.receive = listener; },
    send(value) { messages.push(JSON.parse(value)); },
    reply(value) { this.receive({ data: JSON.stringify(value) }); },
  };
  return { cdp: new Cdp(socket, options), socket, messages };
}
let passed = 0;
const check = async (name, work) => { await work(); passed++; console.log(`PASS ${name}`); };

await check("each harness preserves its default deadline and console policy", async () => {
  const browser = fixture(), native = fixture({ timeoutMs: 60000, recordConsole: false, evaluateFallback: "evaluate failed" });
  assert.equal(browser.cdp.timeoutMs, 90000); assert.equal(native.cdp.timeoutMs, 60000);
  const consoleMessage = { method: "Runtime.consoleAPICalled", params: {
    type: "log", args: [{ value: "message" }, { description: "description" }, { type: "undefined" }],
  } };
  browser.socket.reply(consoleMessage); native.socket.reply(consoleMessage);
  const exception = { method: "Runtime.exceptionThrown", params: { exceptionDetails: { exception: { description: "page broke" } } } };
  browser.socket.reply(exception); native.socket.reply(exception);
  assert.deepEqual(browser.cdp.logs, ["log: message description undefined", "exception: page broke"]);
  assert.deepEqual(native.cdp.logs, []);
  browser.socket.reply({ ...consoleMessage, params: { type: "log", args: [{ value: "x".repeat(400) }] } });
  assert.equal(browser.cdp.logs.at(-1).length, 300);
});
await check("responses resolve the matching request even when delivered out of order", async () => {
  const { cdp, socket, messages } = fixture();
  const first = cdp.send("First", { value: 1 }), second = cdp.send("Second");
  assert.deepEqual(messages, [{ id: 1, method: "First", params: { value: 1 } }, { id: 2, method: "Second", params: {} }]);
  socket.reply({ id: 2, result: "second" }); socket.reply({ id: 1, result: "first" });
  assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
  assert.equal(cdp.pending.size, 0);
});
await check("protocol errors reject without becoming retryable timeouts", async () => {
  const { cdp, socket } = fixture();
  const request = cdp.send("Invalid");
  socket.reply({ id: 1, error: { code: -32601, message: "Unknown method" } });
  await assert.rejects(request, error => !(error instanceof CdpTimeoutError) && /Unknown method/.test(error.message));
  assert.equal(cdp.pending.size, 0);
});
await check("explicit request deadline yields the existing typed timeout and ignores late replies", async () => {
  const { cdp, socket } = fixture();
  await assert.rejects(cdp.send("Runtime.evaluate", {}, 5), error => error instanceof CdpTimeoutError && error.method === "Runtime.evaluate");
  assert.equal(cdp.pending.size, 0);
  socket.reply({ id: 1, result: { result: { value: "late" } } });
  assert.equal(cdp.pending.size, 0);
});
await check("evaluate keeps awaitPromise, user gesture and caller result values", async () => {
  const { cdp, socket, messages } = fixture();
  const value = { tracks: 3, ready: true }, request = cdp.evaluate("library()", false);
  assert.deepEqual(messages[0].params, { expression: "library()", awaitPromise: false, returnByValue: true, userGesture: true });
  socket.reply({ id: 1, result: { result: { value } } });
  assert.deepEqual(await request, value);
});
await check("page exceptions retain description and each harness's fallback", async () => {
  const { cdp, socket } = fixture();
  const described = cdp.evaluate("broken()");
  socket.reply({ id: 1, result: { exceptionDetails: { exception: { description: "TypeError: broken" } } } });
  await assert.rejects(described, /TypeError: broken/);
  const details = { text: "page error" }, fallback = cdp.evaluate("broken()");
  socket.reply({ id: 2, result: { exceptionDetails: details } });
  await assert.rejects(fallback, error => error.message === JSON.stringify(details));
  const native = fixture({ timeoutMs: 60000, recordConsole: false, evaluateFallback: "evaluate failed" });
  const nativeError = native.cdp.evaluate("broken()");
  native.socket.reply({ id: 1, result: { exceptionDetails: details } });
  await assert.rejects(nativeError, /evaluate failed/);
});
await check("synchronous send failure clears pending requests immediately", async () => {
  const { cdp, socket } = fixture();
  socket.send = () => { throw new Error("socket closed"); };
  await assert.rejects(cdp.send("Page.navigate"), /socket closed/);
  assert.equal(cdp.pending.size, 0);
});
await check("synchronous reply has a timer registered before transport delivery", async () => {
  const { cdp, socket } = fixture();
  socket.send = value => { const { id } = JSON.parse(value); socket.reply({ id, result: "instant" }); };
  assert.equal(await cdp.send("Immediate"), "instant");
  assert.equal(cdp.pending.size, 0);
});
console.log(`${passed}/${passed} CDP checks passed.`);
