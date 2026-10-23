import assert from "node:assert/strict";
import test from "node:test";
import { NativeEngineClient } from "../native-engine-client.mjs";

function client(code, extra = {}) {
  return new NativeEngineClient(
    process.execPath,
    ["--input-type=module", "-e", code],
    {
      cwd: process.cwd(),
      env: { ...process.env, ...extra },
    },
  );
}

test("native IPC preserves fragmented UTF-8 and routes independent requests", async () => {
  const ipc = client(`
    import readline from 'node:readline';
    const input = readline.createInterface({input:process.stdin});
    input.on('line',line=>{
      const request=JSON.parse(line);
      const data=Buffer.from(JSON.stringify({id:request.id,result:{text:'球球',method:request.method}})+'\\n');
      for(const byte of data) process.stdout.write(Buffer.from([byte]));
    });
  `);
  try {
    const result = await Promise.all([
      ipc.request("first", {}),
      ipc.request("second", {}),
    ]);
    assert.deepEqual(result, [
      { text: "球球", method: "first" },
      { text: "球球", method: "second" },
    ]);
  } finally {
    await ipc.close();
  }
});

test("native crash rejects pending requests and redacts credentials", async () => {
  const ipc = client(
    `
    process.stdin.once('data',()=>{
      process.stderr.write('failed '+process.env.EMBUDDIES_MODEL_API_KEY);
      process.exit(17);
    });
  `,
    { EMBUDDIES_MODEL_API_KEY: "private-test-credential" },
  );
  try {
    await assert.rejects(ipc.request("turn/start", {}), (error) => {
      assert.match(error.message, /17/);
      assert.ok(!error.message.includes("private-test-credential"));
      assert.match(error.message, /redacted/);
      return true;
    });
    assert.equal(ipc.closed, true);
  } finally {
    await ipc.close();
  }
});

test("a timed-out native mutation is sent once and is not automatically replayed", async () => {
  const ipc = client(`
    import readline from 'node:readline';
    let count=0;
    readline.createInterface({input:process.stdin}).on('line',line=>{
      const request=JSON.parse(line);
      if(request.method==='turn/start') count++;
      else process.stdout.write(JSON.stringify({id:request.id,result:count})+'\\n');
    });
  `);
  try {
    await assert.rejects(ipc.request("turn/start", {}, 150), /超时/);
    assert.equal(await ipc.request("count", {}), 1);
  } finally {
    await ipc.close();
  }
});

test("malformed native data closes the connection without losing pending failures", async () => {
  const ipc = client(
    "process.stdin.once('data',()=>process.stdout.write('invalid-json\\n'));",
  );
  try {
    await assert.rejects(ipc.request("initialize", {}), /通信数据无效/);
  } finally {
    await ipc.close();
  }
});
