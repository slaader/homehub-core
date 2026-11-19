// Kill the real updater at a durable transaction boundary without adding a production fault flag.
import path from 'node:path';
import {pathToFileURL} from 'node:url';

export const powerLossPoints=['backup-verified','target-start-intent','restore-prepare-mid','restore-all-prepared','restore-old-renamed','restore-new-renamed'];

export function invokeWithCheckpoint(execute,node,script,args,point){
 const cli=pathToFileURL(script).href;
 const implementation=pathToFileURL(path.resolve(path.dirname(script),'../server/update-apply.mjs')).href;
 const code=`
  import {main} from ${JSON.stringify(cli)};
  import {realContext} from ${JSON.stringify(implementation)};
  const ctx=realContext({checkpoint:name=>{
   if(name===${JSON.stringify(point)})process.kill(process.pid,'SIGKILL');
  }});
  process.exitCode=await main(${JSON.stringify(args)},{ctx});
 `;
 return execute(node,['--input-type=module','-e',code]);
}
