#!/usr/bin/env node
// Private local token bootstrap. Never prints the token or sends it to a browser.
import {randomBytes} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const tokenFile=path.join(root,'.env.signal-link');
let token=process.env.SIGNAL_TOKEN;
if(!token){if(fs.existsSync(tokenFile)){token=fs.readFileSync(tokenFile,'utf8').match(/^SIGNAL_TOKEN=([A-Za-z0-9_-]{24,})\s*$/m)?.[1];}else{token=randomBytes(32).toString('hex');fs.writeFileSync(tokenFile,`SIGNAL_TOKEN=${token}\n`,{mode:0o600,flag:'wx'});}}
if(typeof token!=='string'||token.length<24)throw Error('SIGNAL_TOKEN must contain at least 24 characters. Configure it privately.');
console.log('Signal Scope receiver enabled. Private token is not displayed. Local config: .env.signal-link');
const child=spawn(process.execPath,[path.join(root,'server.mjs')],{cwd:root,env:{...process.env,SIGNAL_TOKEN:token,HOST:process.env.HOST||'0.0.0.0'},stdio:'inherit'});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
child.on('exit',code=>process.exit(code??0));
