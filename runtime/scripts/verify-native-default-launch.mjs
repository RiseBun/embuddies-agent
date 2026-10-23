import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { _electron } from "playwright";
const candidate=process.env.EMBUDDIES_TEST_CANDIDATE;
assert.ok(candidate,"Select an immutable candidate");
const artifact=process.env.EMBUDDIES_ARTIFACT_DIR||"E:/embuddies-build/verification/candidate-default-launch";
await fs.mkdir(artifact,{recursive:true});
const localRoot=await fs.mkdtemp(path.join(artifact,"local-"));
const env={...process.env,LOCALAPPDATA:localRoot};
for(const name of ["EMBUDDIES_DATA_DIR","EMBUDDIES_NATIVE_EXECUTABLE","EMBUDDIES_BUNDLE_ROOT","EMBUDDIES_RUNTIME_ROOT","EMBUDDIES_UI_ROOT"])delete env[name];
env.PATH=[path.join(process.env.SystemRoot,"System32"),process.env.SystemRoot,path.join(process.env.SystemRoot,"System32/WindowsPowerShell/v1.0")].join(path.delimiter);
const exe=path.join(candidate,"embuddies.exe");
const report={ok:false,candidate,localRoot,cases:[],errors:[]};
let app;
try {
 app=await _electron.launch({executablePath:exe,chromiumSandbox:true,args:[],env,timeout:45000});
 const page=await app.firstWindow();page.on("pageerror",e=>report.errors.push(e.message));
 await page.getByRole("textbox",{name:"消息",exact:true}).waitFor();
 const deadline=Date.now()+45000;
 while(Date.now()<deadline){if((await page.evaluate(()=>window.EMBUDDIES_DESKTOP.runtimeStatus())).state==="ready")break;await new Promise(r=>setTimeout(r,100));}
 assert.equal((await page.evaluate(()=>window.EMBUDDIES_DESKTOP.runtimeStatus())).state,"ready");
 const profile=await app.evaluate(({app})=>app.getPath("userData"));
 assert.equal(profile,path.join(localRoot,"embuddies-candidate/profile"));
 const health=await page.evaluate(()=>window.EMBUDDIES_DESKTOP.request({method:"GET",path:"/health"}));
 assert.equal(health.ok,true);assert.equal(health.authConfigured,false);
 report.cases.push("double-click-equivalent-without-node-cli-profile-flags-or-api-port");
 const created=await page.evaluate(()=>window.EMBUDDIES_DESKTOP.request({method:"POST",path:"/workspaces/create",body:{name:"首次启动"}}));
 assert.equal(created.ok,true);
 assert.ok(created.workspace.executionRoot.startsWith(path.join(localRoot,"embuddies-candidate/data/projects")));
 await fs.access(path.join(localRoot,"embuddies-candidate/data/embuddies.sqlite"));
 await assert.rejects(fs.access(path.join(localRoot,"embuddies/data")),{code:"ENOENT"});
 report.cases.push("default-candidate-profile-data-and-project-isolated-from-installed-release");
 const code=await new Promise((resolve,reject)=>{const second=spawn(exe,[],{env,windowsHide:true,stdio:"ignore"});const timeout=setTimeout(()=>{second.kill();reject(Error("Second instance did not exit"));},15000);second.once("error",reject);second.once("exit",code=>{clearTimeout(timeout);resolve(code);});});
 assert.equal(code,0);assert.equal((await page.evaluate(()=>window.EMBUDDIES_DESKTOP.runtimeStatus())).state,"ready");
 report.cases.push("second-instance-focuses-existing-candidate-and-exits");
 report.ok=report.errors.length===0;
}catch(error){report.failure=error.stack;throw error;}
finally{await app?.close().catch(()=>{});await fs.writeFile(path.join(artifact,"report.json"),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
