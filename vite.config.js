import { defineConfig } from 'vite';
import fs from 'node:fs';
const tls = fs.existsSync('certs/key.pem') && fs.existsSync('certs/cert.pem');
export default defineConfig({server:{host:'0.0.0.0',port:5173,https:tls?{key:fs.readFileSync('certs/key.pem'),cert:fs.readFileSync('certs/cert.pem')}:undefined,proxy:{'/eeg':{target:'ws://127.0.0.1:8765',ws:true}}}});
