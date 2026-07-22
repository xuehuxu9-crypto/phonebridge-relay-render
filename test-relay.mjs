import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";

const child = spawn(process.execPath, ["server.mjs"], {
  cwd: new URL(".", import.meta.url),
  env: { ...process.env, PORT: "18787" },
  stdio: ["ignore", "pipe", "inherit"],
});

function nextMessage(socket) {
  return new Promise((resolve, reject) => {
    socket.once("message", (data, isBinary) => resolve({ data, isBinary }));
    socket.once("error", reject);
  });
}

try {
  await delay(500);
  const host = new WebSocket("ws://127.0.0.1:18787/ws");
  await new Promise((resolve, reject) => { host.once("open", resolve); host.once("error", reject); });
  host.send(JSON.stringify({ type: "host" }));
  const ready = JSON.parse((await nextMessage(host)).data.toString());
  assert.equal(ready.type, "host_ready");
  assert.match(ready.code, /^\d{6}$/);

  const abandonedController = new WebSocket("ws://127.0.0.1:18787/ws");
  await new Promise((resolve, reject) => { abandonedController.once("open", resolve); abandonedController.once("error", reject); });
  abandonedController.send(JSON.stringify({ type: "controller", code: ready.code, name: "Abandoned iPhone" }));
  const abandonedJoin = JSON.parse((await nextMessage(host)).data.toString());
  assert.equal(abandonedJoin.type, "join_request");
  assert.equal(JSON.parse((await nextMessage(abandonedController)).data.toString()).type, "join_pending");
  const cancellationPromise = nextMessage(host);
  abandonedController.close();
  const cancellation = JSON.parse((await cancellationPromise).data.toString());
  assert.equal(cancellation.type, "join_cancelled");
  assert.equal(cancellation.requestId, abandonedJoin.requestId);

  const controller = new WebSocket("ws://127.0.0.1:18787/ws");
  await new Promise((resolve, reject) => { controller.once("open", resolve); controller.once("error", reject); });
  controller.send(JSON.stringify({ type: "controller", code: ready.code, name: "iPhone" }));
  const join = JSON.parse((await nextMessage(host)).data.toString());
  assert.equal(join.type, "join_request");
  assert.equal(JSON.parse((await nextMessage(controller)).data.toString()).type, "join_pending");
  host.send(JSON.stringify({ type: "approve", requestId: join.requestId, allow: true }));
  assert.equal(JSON.parse((await nextMessage(host)).data.toString()).type, "controller_connected");
  const connected = JSON.parse((await nextMessage(controller)).data.toString());
  assert.equal(connected.type, "controller_connected");
  assert.match(connected.resumeToken, /^[0-9a-f-]{36}$/i);

  const controlPromise = nextMessage(host);
  controller.send(JSON.stringify({ type: "control", action: "tap", x: 4, y: 0.75 }));
  const control = JSON.parse((await controlPromise).data.toString());
  assert.equal(control.action, "tap");
  assert.equal(control.x, 1);

  const framePromise = nextMessage(controller);
  host.send(Buffer.from([1, 2, 3]));
  const frame = await framePromise;
  assert.equal(frame.isBinary, true);
  assert.deepEqual([...frame.data], [1, 2, 3]);

  const disconnectedPromise = nextMessage(host);
  controller.close();
  assert.equal(JSON.parse((await disconnectedPromise).data.toString()).type, "controller_disconnected");

  const resumedController = new WebSocket("ws://127.0.0.1:18787/ws");
  await new Promise((resolve, reject) => { resumedController.once("open", resolve); resumedController.once("error", reject); });
  const hostResumedPromise = nextMessage(host);
  resumedController.send(JSON.stringify({
    type: "controller",
    code: ready.code,
    name: "iPhone",
    resumeToken: connected.resumeToken,
  }));
  assert.equal(JSON.parse((await hostResumedPromise).data.toString()).type, "controller_connected");
  const resumed = JSON.parse((await nextMessage(resumedController)).data.toString());
  assert.equal(resumed.type, "controller_connected");
  assert.equal(resumed.resumed, true);
  assert.notEqual(resumed.resumeToken, connected.resumeToken);

  host.close();
  resumedController.close();
  console.log("relay integration test passed");
} finally {
  child.kill();
}
