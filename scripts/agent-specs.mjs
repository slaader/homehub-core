#!/usr/bin/env node
// The watch list of one device as its push agent's specs.txt (docs/agent.md → The watch list). Run on the hub:
//
//   node scripts/agent-specs.mjs <device> [--platform macos|linux|windows] > specs.txt
//
// It prints specsFileText(registry, device) (server/systems-data.mjs) from the hub's current software watch list:
// one "id|kind|a|b|label" line each, "\n" after each line, an empty list an empty file. The hub hashes the same bytes,
// so the agent's `SPECS <sha256>` record tells whether a device's list differs from the hub's. The lines are checked
// with validateSpecs and the agent's path rules (specsPathErrors) for the device's platform (from site.json →
// devices[].platform, else --platform, else macos). For Windows (the PowerShell agent, docs/agent.md → Windows: PowerShell
// only) validateSpecs has no kinds, so the lines are checked by validateWindowsSpecs (scripts/agent/windows/specs.mjs:
// validateSpecs's own id and label rules, the winreg kind), as the Windows agent checks them at every start;
// a list that fails is not printed (exit 1, the reasons on stderr), because the agent would refuse to start with it.
// Take the file to the device and pass it to scripts/install-host-agent.mjs --core --specs (Windows:
// scripts/agent/windows/install-agent.ps1 -Specs), which prints every line for the person installing to confirm.
import {fileURLToPath} from 'node:url';
import {specsFileText} from '../server/systems-data.mjs';
import {readWatch} from '../server/software-watch.mjs';
import {loadSite} from '../server/site-config.mjs';
import {validateSpecs,SPEC_KINDS} from '../server/agent-report.mjs';
import {specsPathErrors} from './agent/config.mjs';
import {validateWindowsSpecs} from './agent/windows/specs.mjs';

const PLATFORMS=[...Object.keys(SPEC_KINDS),'windows'];

/** → {ok, text, errors}: the file (specsFileText, server/systems-data.mjs), checked as the installer and the agent will check it. */
export function agentSpecs({registry,device,platform}){
 const text=specsFileText(registry,device);
 if(platform==='windows'){const check=validateWindowsSpecs(text);return {ok:check.ok,text,errors:check.errors};}
 const check=validateSpecs(text,{platform});
 const errors=check.ok?specsPathErrors(text):check.errors;
 return {ok:errors.length===0,text,errors};
}

if(process.argv[1]===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2);
 const fail=(m,code=2)=>{console.error(m);process.exit(code);};
 let device=null,platform=null;
 for(let i=0;i<args.length;i++){
  if(args[i]==='--platform'){platform=args[++i];if(!PLATFORMS.includes(platform||''))fail('--platform is macos, linux or windows');}
  else if(args[i]==='--help'){console.log('node scripts/agent-specs.mjs <device> [--platform macos|linux|windows] > specs.txt');process.exit(0);}
  else if(!args[i].startsWith('--')&&!device)device=args[i];
  else fail(`Unknown: ${args[i]}`);
 }
 if(!device||!/^[a-z][a-z0-9_-]{1,31}$/.test(device))fail('Say which device: node scripts/agent-specs.mjs <device id> > specs.txt');
 let site=null;try{site=loadSite();}catch(e){fail(`site.json: ${e.message}`);}
 const fromSite=site?.devices?.find(m=>m.id===device)?.platform;
 platform=platform||(PLATFORMS.includes(fromSite||'')?fromSite:'macos');
 const watch=await readWatch().catch(e=>fail(e.message));
 const r=agentSpecs({registry:watch.registry,device,platform});
 if(!r.ok)fail(`The watch list of ${device} does not pass the agent's check for ${platform}; fix it on the hub first:\n${r.errors.map(e=>`  line ${e.line}: ${e.reason}`).join('\n')}`,1);
 process.stdout.write(r.text);
 console.error(`${r.text?r.text.split('\n').length-1:0} line(s) for ${device} (${platform})`);
}
