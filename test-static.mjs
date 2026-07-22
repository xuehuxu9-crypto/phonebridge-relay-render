import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("./public/index.html", import.meta.url), "utf8");
assert.match(html, /<meta charset="utf-8">/);
assert.match(html, /自动重连/);
assert.match(html, /resumeToken/);

const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
assert.equal(scripts.length, 1);
new Function(scripts[0]);

console.log("controller page syntax test passed");
