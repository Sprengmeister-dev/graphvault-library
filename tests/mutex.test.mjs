import assert from "node:assert/strict";
import { AsyncMutex } from "../dist/concurrency/mutex.js";

const mutex = new AsyncMutex();
const events = [];

const taskA = mutex.runExclusive(async () => {
  events.push("a-start");
  await new Promise((resolve) => setTimeout(resolve, 40));
  events.push("a-end");
  return "a";
});

const taskB = mutex.runExclusive(async () => {
  events.push("b-start");
  await new Promise((resolve) => setTimeout(resolve, 10));
  events.push("b-end");
  return "b";
});

const result = await Promise.all([taskA, taskB]);
assert.deepEqual(result, ["a", "b"]);
assert.deepEqual(events, ["a-start", "a-end", "b-start", "b-end"]);

const mutex2 = new AsyncMutex();
let failed = false;
await Promise.allSettled([
  mutex2.runExclusive(async () => {
    await Promise.resolve().then(() => {
      throw new Error("fail");
    });
  }),
  mutex2.runExclusive(() => "ok"),
]).then(([first, second]) => {
  failed = first.status === "rejected";
  assert.equal(second.status, "fulfilled");
  assert.equal(second.value, "ok");
  assert.equal(first.reason.message, "fail");
});
assert.equal(failed, true);
