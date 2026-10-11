const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");
const { getVodStatus } = require("../scripts/live-smoke.cjs");

function status(video, text = "") {
  return vm.runInNewContext(`(${getVodStatus.toString()})()`, {
    document: { body: { innerText: text }, querySelector: () => video }
  });
}

test("live smoke waits for playable media rather than a transient video element", () => {
  assert.equal(status(null), null);
  assert.equal(status({ readyState: 0, duration: NaN }), null);
  assert.equal(status({ readyState: 2, duration: 120 }), null);
  assert.equal(status({ readyState: 4, duration: Infinity }), null);
  assert.equal(status({ readyState: 4, duration: 0 }), null);
  assert.equal(status({ readyState: 3, duration: 120 }), "playable");
});

test("live smoke recognizes a removed VOD even if Twitch briefly creates a video", () => {
  const message = "Sorry. Unless you've got a time machine, that content is unavailable.";
  assert.equal(status(null, message), "unavailable");
  assert.equal(status({ readyState: 3, duration: 120 }, message), "unavailable");
});
