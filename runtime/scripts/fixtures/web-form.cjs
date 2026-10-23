const { app, BrowserWindow } = require("electron");
const http = require("node:http");
const fs = require("node:fs");
const assert = require("node:assert/strict");
const { BrowserRuntime } = require("../../../desktop/browser-runtime.cjs");
const { StructuredUi } = require("../../../desktop/structured-ui.cjs");

const fields = Array.from(
  { length: 60 },
  (_, i) => `<label>Field ${i}<input id="field${i}" required></label>`,
).join("");
const html = `<!doctype html><meta charset="utf-8"><title>Web form fixture</title>
<form>${fields}<label>Country<select id="country"><option value="">Choose</option><option value="CN">China</option><option value="US" disabled>USA</option></select></label>
<label>Notes<textarea id="notes"></textarea></label><label>Date<input id="date" type="date"></label>
<label>Agree<input type="checkbox" id="agree"></label><label>Choice<input type="radio" id="choice"></label>
<label>Password<input type="password" value="fixture-secret"></label><label>Readonly<input readonly value="fixed"></label>
<input type="hidden" value="hidden-secret"><button type="submit">Submit</button><p role="status" id="status">Not submitted</p></form>
<iframe title="Nested form" src="/frame"></iframe>
<script>document.querySelector('form').onsubmit=e=>{e.preventDefault();document.querySelector('#status').textContent='Submitted'};
document.querySelector('#field0').addEventListener('input',e=>{if(e.target.value==='DYNAMIC') document.querySelector('#field1').disabled=true});</script>`;
const server = http.createServer((request, response) => {
  if (request.url === "/react-fixture.js") {
    response.writeHead(200, { "content-type": "text/javascript" });
    response.end(fs.readFileSync(process.env.EMBUDDIES_FORM_REACT_BUNDLE));
    return;
  }
  if (request.url === "/react") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      '<title>React form fixture</title><div id="root"></div><script src="/react-fixture.js"></script>',
    );
    return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(
    request.url === "/frame"
      ? '<label>Inside frame<input id="nested"></label>'
      : html.replace(
          'src="/frame"',
          `src="http://localhost:${server.address().port}/frame"`,
        ),
  );
});
let browser, window;
app
  .whenReady()
  .then(async () => {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    window = new BrowserWindow({ show: false });
    browser = new BrowserRuntime({
      getWindow: () => null,
      broadcast: () => {},
    });
    const ui = new StructuredUi({ browser });
    const workspaceId = "fixture";
    const started = performance.now();
    let snapshot = await browser.command(
      {
        workspaceId,
        action: "navigate",
        url: `http://127.0.0.1:${server.address().port}/`,
      },
      true,
    );
    const scope = { workspaceId, tabId: snapshot.tabId };
    assert.ok(!JSON.stringify(snapshot).includes("fixture-secret"));
    assert.ok(!JSON.stringify(snapshot).includes("hidden-secret"));
    assert.equal(
      snapshot.elements.find(
        (item) => item.name === "Password" && item.role === "textbox",
      ).password,
      true,
    );
    assert.deepEqual(
      snapshot.elements.find(
        (item) => item.name === "Readonly" && item.role === "textbox",
      ).actions,
      [],
    );
    const fieldPlan = Array.from({ length: 60 }, (_, i) => ({
      ref: snapshot.elements.find(
        (item) =>
          item.name === `Field ${i}` && item.actions.includes("set_value"),
      ).ref,
      value: `Value ${i}`,
    }));
    const country = snapshot.elements.find(
      (item) => item.name === "Country" && item.role === "combobox",
    );
    assert.ok(country.options.some((option) => option.value === "CN"));
    const date = snapshot.elements.find((item) => item.automationId === "date");
    assert.ok(date.actions.includes("set_value"), JSON.stringify(date));
    fieldPlan.push(
      { ref: country.ref, value: "CN" },
      { ref: date.ref, value: "2026-10-16" },
      {
        ref: snapshot.elements.find(
          (item) => item.name === "Notes" && item.role === "textbox",
        ).ref,
        value: "Line one\n第二行",
      },
    );
    const coldMs = performance.now() - started;
    const filling = performance.now();
    let remaining = fieldPlan,
      count = 0;
    while (remaining.length) {
      const result = await ui.command({
        ...scope,
        action: "fill",
        version: snapshot.version,
        fields: remaining,
      });
      assert.ok(result.completed.length > 0, JSON.stringify(result));
      assert.ok(
        result.completed.every((item) => item.verified),
        JSON.stringify(result.completed),
      );
      if (!result.complete) assert.match(result.error, /时间上限/);
      snapshot = result.snapshot;
      count += result.completed.length;
      remaining = remaining.filter((item) =>
        result.remaining.includes(item.ref),
      );
    }
    const fillMs = performance.now() - filling;
    await assert.rejects(
      ui.command({
        ...scope,
        action: "act",
        version: 0,
        ref: fieldPlan[0].ref,
        operation: "set_value",
        value: "stale",
      }),
      /过期/,
    );
    const checkbox = snapshot.elements.find(
      (item) => item.name === "Agree" && item.role === "checkbox",
    );
    let result = await ui.command({
      ...scope,
      action: "act",
      version: snapshot.version,
      ref: checkbox.ref,
      operation: "toggle",
      expected: { checked: true },
    });
    assert.equal(result.verified, true, JSON.stringify(result));
    snapshot = result.snapshot;
    const nested = snapshot.elements.find(
      (item) => item.name === "Inside frame" && item.role === "textbox",
    );
    assert.ok(nested);
    assert.ok(
      browser.workspace(workspaceId).tabs.get(snapshot.tabId).frameSessions
        .size > 0,
      "Cross-origin iframe must run in a separate renderer",
    );
    result = await ui.command({
      ...scope,
      action: "fill",
      version: snapshot.version,
      fields: [{ ref: nested.ref, value: "iframe filled" }],
    });
    assert.equal(result.verified, true, JSON.stringify(result));
    snapshot = result.snapshot;
    assert.ok(
      snapshot.elements.some((item) => item.name === "Not submitted"),
      "Filling never submits automatically",
    );
    const submit = snapshot.elements.find(
      (item) => item.role === "button" && item.name === "Submit",
    );
    result = await ui.command({
      ...scope,
      action: "act",
      version: snapshot.version,
      ref: submit.ref,
      operation: "invoke",
    });
    assert.equal(result.complete, true);
    snapshot = result.snapshot;
    assert.ok(snapshot.elements.some((item) => item.name === "Submitted"));
    result = await ui.command({
      ...scope,
      action: "fill",
      version: snapshot.version,
      fields: [
        { ref: fieldPlan[0].ref, value: "DYNAMIC" },
        { ref: fieldPlan[1].ref, value: "must not write" },
      ],
    });
    assert.equal(result.complete, false);
    assert.equal(result.completed.length, 1);
    assert.equal(
      result.snapshot.elements.find((item) => item.ref === fieldPlan[1].ref)
        .value,
      "Value 1",
    );
    await browser.command({ ...scope, action: "takeover", manual: true });
    await assert.rejects(
      ui.command({ ...scope, action: "observe" }),
      /手动接管/,
    );
    await browser.command({ ...scope, action: "takeover", manual: false });
    snapshot = await browser.command(
      {
        ...scope,
        action: "navigate",
        url: `http://127.0.0.1:${server.address().port}/react`,
      },
      true,
    );
    snapshot = await browser.command(
      { ...scope, action: "wait", text: "React state incomplete" },
      true,
    );
    const reactFields = Array.from({ length: 12 }, (_, i) => ({
      ref: snapshot.elements.find(
        (item) => item.name === "React field " + i && item.role === "textbox",
      ).ref,
      value: "React " + i,
    }));
    reactFields.push({
      ref: snapshot.elements.find(
        (item) => item.name === "React country" && item.role === "combobox",
      ).ref,
      value: "CN",
    });
    result = await ui.command({
      ...scope,
      action: "fill",
      version: snapshot.version,
      fields: reactFields,
    });
    assert.equal(result.verified, true, result.error);
    snapshot = result.snapshot;
    assert.ok(
      snapshot.elements.some((item) => item.name === "React state ready"),
      "React state must receive input/change events",
    );
    const reactSubmit = snapshot.elements.find(
      (item) => item.role === "button" && item.name === "React submit",
    );
    result = await ui.command({
      ...scope,
      action: "act",
      version: snapshot.version,
      ref: reactSubmit.ref,
      operation: "invoke",
    });
    snapshot = result.snapshot;
    assert.ok(snapshot.elements.some((item) => item.name === "React saved"));
    result = await ui.command({
      ...scope,
      action: "fill",
      version: snapshot.version,
      fields: [
        { ref: reactFields[0].ref, value: "normalize" },
        { ref: reactFields[1].ref, value: "must not write" },
      ],
    });
    assert.equal(result.complete, false);
    assert.equal(result.completed[0].verified, false);
    assert.equal(
      result.snapshot.elements.find((item) => item.ref === reactFields[0].ref)
        .value,
      "NORMALIZED",
    );
    assert.equal(
      result.snapshot.elements.find((item) => item.ref === reactFields[1].ref)
        .value,
      "React 1",
    );
    console.log(
      JSON.stringify({
        ok: true,
        source: "browser-ax-dom",
        fields: count,
        coldMs: Math.round(coldMs),
        fillMs: Math.round(fillMs),
        checkbox: true,
        select: true,
        date: true,
        iframe: true,
        crossOriginIframe: true,
        reactControlledFields: 13,
        reactStateAndSubmit: true,
        normalizationStopped: true,
        passwordRedacted: true,
        dynamicStopped: true,
        staleRejected: true,
        manualTakeover: true,
        submissionSeparate: true,
      }),
    );
  })
  .catch((error) => {
    console.error(error.stack);
    process.exitCode = 1;
  })
  .finally(() => {
    browser?.close();
    window?.destroy();
    server.close();
    app.exit(process.exitCode || 0);
  });
