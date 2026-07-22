import assert from "node:assert/strict";
import { WebSocket } from "ws";

const baseUrl = process.argv[2];
if (!baseUrl) throw new Error("Pass a wss://.../ws URL");

function openSocket() {
  const socket = new WebSocket(baseUrl);
  return new Promise((resolve, reject) => {
    socket.once("open", () => resolve(socket));
    socket.once("unexpected-response", (_request, response) => {
      reject(new Error(`unexpected HTTP ${response.statusCode}`));
    });
    socket.once("error", reject);
  });
}

function nextMessage(socket) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.off("message", onMessage);
      socket.off("error", onError);
    };
    const onMessage = (data, isBinary) => {
      cleanup();
      resolve({ data, isBinary });
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    socket.once("message", onMessage);
    socket.once("error", onError);
  });
}

const host = await openSocket();
host.send(JSON.stringify({ type: "host" }));
const ready = JSON.parse((await nextMessage(host)).data.toString());
assert.match(ready.code, /^\d{6}$/);

const controller = await openSocket();
const joinPromise = nextMessage(host);
const pendingPromise = nextMessage(controller);
controller.send(JSON.stringify({ type: "controller", code: ready.code, name: "iPhone test" }));
const join = JSON.parse((await joinPromise).data.toString());
assert.equal(JSON.parse((await pendingPromise).data.toString()).type, "join_pending");
const hostConnectedPromise = nextMessage(host);
const controllerConnectedPromise = nextMessage(controller);
host.send(JSON.stringify({ type: "approve", requestId: join.requestId, allow: true }));
assert.equal(JSON.parse((await hostConnectedPromise).data.toString()).type, "controller_connected");
assert.equal(JSON.parse((await controllerConnectedPromise).data.toString()).type, "controller_connected");

const controlPromise = nextMessage(host);
controller.send(JSON.stringify({ type: "control", action: "tap", x: 0.2, y: 0.8 }));
assert.equal(JSON.parse((await controlPromise).data.toString()).action, "tap");

const framePromise = nextMessage(controller);
host.send(Buffer.from([9, 8, 7]));
const frame = await framePromise;
assert.equal(frame.isBinary, true);
assert.deepEqual([...frame.data], [9, 8, 7]);

host.close();
controller.close();
console.log(`public relay test passed; code ${ready.code}`);
