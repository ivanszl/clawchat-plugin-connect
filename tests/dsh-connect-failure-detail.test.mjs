import {it,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,cpSync,chmodSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {connectFailureMessage,redactConnectOutput} from '../platform/deepseek-harness/lib.mjs';

it('redacts credentials and bounds the child stderr to about 2 KB',()=>{
 const message=connectFailureMessage(['plugin','setup','--select','x'],{stderr:'x'.repeat(5000)+'\nfetch https://user:pw@example.test/p?token=abc123&a=1 Authorization: Bearer abc.def-1\n'});
 expect(message.startsWith('ClawChat Connect command failed: plugin/setup\n')).toBe(true);
 expect(message).not.toContain('pw@');
 expect(message).not.toContain('abc123');
 expect(message).not.toContain('abc.def-1');
 expect(message).toContain('[redacted]');
 expect(message.length).toBeLessThan(2048+200);
 expect(redactConnectOutput('{"apiKey":"k","token":"sekret"}')).not.toContain('sekret');
});

it('keeps the plain message when the child printed nothing',()=>{
 expect(connectFailureMessage(['init'],{})).toBe('ClawChat Connect command failed: init');
});

it('runtime cli surfaces the failing Connect command stderr',()=>{
 const root=mkdtempSync(join(tmpdir(),'dsh-cli-fail-'));
 try{
  cpSync(new URL('../platform/deepseek-harness',import.meta.url).pathname,join(root,'release/runtime'),{recursive:true});
  const fake=join(root,'release/clawchat-connect');
  writeFileSync(fake,'#!/bin/sh\necho "entry artifact does not match the release-pinned integrity https://u:p@h/x?token=SECRET" >&2\nexit 1\n');chmodSync(fake,0o755);
  const home=join(root,'home');mkdirSync(join(home,'.clawchat-dsh'),{recursive:true});
  writeFileSync(join(home,'.clawchat-dsh/config.json'),JSON.stringify({models:{providers:{fixture:{apiKey:'k',models:[{id:'m'}]}}},agents:{defaults:{model:{primary:'fixture/m'}}}}));
  const result=spawnSync(process.execPath,[join(root,'release/runtime/cli.mjs'),'init'],{encoding:'utf8',env:{...process.env,HOME:home}});
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('ClawChat Connect command failed: init');
  expect(result.stderr).toContain('release-pinned integrity');
  expect(result.stderr).not.toContain('SECRET');
 }finally{rmSync(root,{recursive:true,force:true});}
});
