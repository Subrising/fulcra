import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { SessionResources, ORPHAN_INTERVAL_MS, type ResourceProcess, type SimulatorTable } from "./session-resources.js";
import { createTestLogger } from "../../test-utils/test-logger.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((dir) => rm(dir, {recursive: true, force: true}))); });
const root: ResourceProcess = {pid: 100, ppid: 1, birth: "10000", groupId: 100, detached: true, zombie: false, command: "/bin/provider", rssKiB: 10};
const child: ResourceProcess = {...root, pid: 101, ppid: 100, birth: "20000", command: "/bin/node"};
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "review-resources-")); directories.push(directory);
  let rows = [root, child], live = true, now = 0;
  const stopped: number[] = [];
  const options = {file: join(directory, "resources.json"), logger: createTestLogger(), roots: () => live ? [{agentId: "owner", instanceId: "generation", pid: 100}] : [], ownerState: (id: string) => id === "other" ? "live" as const : live ? "live" as const : "inactive" as const, readProcesses: async () => rows, now: () => now, gracefulTimeoutMs: 0, signal: (pid: number) => {stopped.push(pid); rows = rows.filter((row) => row.pid !== pid);} };
  return {directory, options, stopped, setRows: (value: ResourceProcess[]) => {rows=value;}, close: () => {live=false;now=ORPHAN_INTERVAL_MS+1;} };
}
test("H1 rejects a reused session root before adopting unrelated children", async () => {
  const f=await fixture(), tracker=new SessionResources(f.options);
  await tracker.sample();
  f.setRows([{...root,birth:"30000"},{...child,pid:102,birth:"40000"}]);
  await tracker.sample(); f.close(); f.setRows([{...child,pid:102,ppid:1,birth:"40000"}]);
  await tracker.sweep(); expect(f.stopped).toEqual([]);
});
test("H1 rejects a Windows child whose stale parent PID is newer than it", async () => {
  const f=await fixture();f.setRows([root,{...child,birth:"9999"}]);
  const tracker=new SessionResources(f.options);await tracker.sample();f.close();await tracker.sweep();expect(f.stopped).toEqual([]);
});
test("H1 keeps a recorded child when its current parent identity has been reused", async () => {
  const f=await fixture(), tracker=new SessionResources(f.options);await tracker.sample();f.close();
  f.setRows([{...root,birth:"30000"},child]);await tracker.sweep();expect(f.stopped).toEqual([]);
});
test("H2 keeps EPERM targets and continues with later sweep records", async () => {
  const f=await fixture();f.setRows([root,child,{...child,pid:102}]);
  const signal=(pid:number) => { if(pid===102) throw Object.assign(new Error("denied"),{code:"EPERM"}); f.options.signal(pid); };
  const tracker=new SessionResources({...f.options,signal});await tracker.sample();f.close();
  await expect(tracker.sweep()).resolves.toBeUndefined();expect(f.stopped).toEqual([101]);
  expect(await readFile(f.options.file,"utf8")).toContain('"pid": 102');
});
test("H2 quarantines corrupt proof without stopping unknown processes", async () => {
  const f=await fixture();await writeFile(f.options.file,"invalid ledger");
  const tracker=new SessionResources(f.options);await expect(tracker.sample()).resolves.toBeUndefined();
  expect((await readdir(f.directory)).some((name)=>name.includes(".corrupt-"))).toBe(true);expect(f.stopped).toEqual([]);
});
test("off mode performs no collection, signals or simulator operations", async () => {
  const f=await fixture(), read=vi.fn(f.options.readProcesses);
  const tracker=new SessionResources({...f.options, mode:"off", readProcesses:read});
  tracker.start();await tracker.sample();await tracker.sweep();await tracker.closeOwner("owner","generation",()=>true);await tracker.stop();
  expect(read).not.toHaveBeenCalled();expect(f.stopped).toEqual([]);
});
test("dry-run logs the decision and preserves the owned process", async () => {
  const f=await fixture(), tracker=new SessionResources({...f.options,mode:"dry-run"});await tracker.sample();f.close();await tracker.sweep();
  expect(f.stopped).toEqual([]);expect(await readFile(f.options.file+".stops.jsonl","utf8")).toContain("dry-run-stop");
});
test("an unrelated tool event does not wait behind the cleanup queue", async () => {
  const f=await fixture();let release!:()=>void;const blocked=new Promise<void>((resolve)=>{release=resolve;});
  const tracker=new SessionResources({...f.options,readProcesses:async()=>{await blocked;return [root,child];}});
  const sample=tracker.sample();
  try { await Promise.race([tracker.observeTool({agentId:"owner",instanceId:"generation",pid:100},item("echo hello")), new Promise((_,reject)=>setTimeout(()=>reject(new Error("tool event blocked")),50))]); }
  finally {release();await sample;}
});
test("a missing ancestor keeps an otherwise recorded process", async () => {
  const f=await fixture(), tracker=new SessionResources(f.options);await tracker.sample();f.close();f.setRows([{...child,ppid:999}]);await tracker.sweep();expect(f.stopped).toEqual([]);
});
test("the daemon process as an ancestor keeps a recorded process", async () => {
  const f=await fixture(), tracker=new SessionResources(f.options);await tracker.sample();f.close();
  f.setRows([{...root,pid:process.pid,birth:"10000"},{...child,ppid:process.pid}]);await tracker.sweep();expect(f.stopped).toEqual([]);
});
const uuid="00000000-0000-4000-8000-000000000001";
function item(command:string,status:"running"|"completed"="running") {return {type:"tool_call" as const,callId:command,name:"Bash",status,error:null,detail:{type:"shell" as const,command,exitCode:status==="completed"?0:null}};}
for(const use of [`xcodebuild test -destination 'platform=iOS Simulator,id=${uuid}'`,"xcrun simctl spawn booted log stream","flutter run","cap run ios"]) {
  test(`keeps a simulator used through ${use}`,async()=>{
    const f=await fixture();let booted=false;const shutdown=vi.fn(async()=>{});
    const simulators:SimulatorTable={inspect:async()=>({booted,pid:500,birth:"sim"}),shutdown};
    const tracker=new SessionResources({...f.options,simulators}), owner={agentId:"owner",instanceId:"generation",pid:100};
    await tracker.observeTool(owner,item(`xcrun simctl boot ${uuid}`));booted=true;await tracker.observeTool(owner,item(`xcrun simctl boot ${uuid}`,"completed"));
    await tracker.observeTool({...owner,agentId:"other"},item(use));await tracker.closeOwner("owner","generation",()=>true);expect(shutdown).not.toHaveBeenCalled();
  });
}
test.each(["dry-run","on"] as const)("keeps simulator GUI users and logs dry-run without shutdown: %s",async(mode)=>{
 const f=await fixture();let booted=false;const shutdown=vi.fn(async()=>{});const simulators={inspect:async()=>({booted,pid:500,birth:"sim"}),shutdown,inUse:async()=>mode==="on"};
 const tracker=new SessionResources({...f.options,mode,simulators}),owner={agentId:"owner",instanceId:"generation",pid:100};await tracker.observeTool(owner,item(`xcrun simctl boot ${uuid}`));booted=true;await tracker.observeTool(owner,item(`xcrun simctl boot ${uuid}`,"completed"));await tracker.closeOwner("owner","generation",()=>true);expect(shutdown).not.toHaveBeenCalled();
});
