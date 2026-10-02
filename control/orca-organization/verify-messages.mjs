// Execute the shared validator on the supplied native JS engine, not just its compiler.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
const require = createRequire(import.meta.url),
  { build } = require("esbuild");
const engine = process.argv[2];
if (!engine || !path.isAbsolute(engine)) throw Error("Supply the native Hermes executable");
const root = import.meta.dirname,
  output = path.join(root, "runtime/work-messages-hermes.js");
fs.mkdirSync(path.dirname(output), { recursive: true });
await build({
  stdin: {
    resolveDir: root,
    contents: `
 import {validateMessages,projectMessages} from './shared/work-messages.mjs';
 const ok=(v,n)=>{if(!v)throw Error(n);};
 const row=(seq,type,text)=>({seqStart:seq,item:{type,text}});
 const source=[row(1,'user_message','Review receipts.'),row(2,'thinking','PRIVATE'),row(3,'tool_call','PRIVATE'),row(4,'assistant_message','Guide ready 😀')];
 const projected=projectMessages(source);ok(projected.length===2&&projected[1].text==='Guide ready 😀','Message projection');
 const clipped=projectMessages([row(1,'assistant_message','x'.repeat(1999)+'😀')])[0];ok(clipped.text.length===1999&&clipped.truncated,'Unicode boundary');
 const valid={id:'1',role:'agent',text:'Report',truncated:false};
 for(const messages of [[{...valid,text:String.fromCharCode(0xd800)}],[valid,valid],[{...valid,role:'thinking'}],[{...valid,text:'x'.repeat(2001)}]]){let refused=false;try{validateMessages(messages);}catch{refused=true;}ok(refused,'Malformed excerpt accepted');}
 print('PASS native Hermes message projection, validation and Unicode bounds');
 `,
  },
  bundle: true,
  platform: "neutral",
  format: "iife",
  outfile: output,
});
process.stdout.write(execFileSync(engine, [output], { encoding: "utf8", timeout: 10000 }));
