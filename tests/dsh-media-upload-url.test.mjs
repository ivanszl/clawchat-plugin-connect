import {describe,it,expect} from 'bun:test';
import {mediaUploadUrlFor,repairMediaUploadUrl} from '../platform/deepseek-harness/media-upload-url.mjs';
describe('DSH mediaUploadUrl from the platform media origin',()=>{
 it.each([
  ['https://app.clawling.com','https://app.clawling.com/media/upload'],
  ['https://app.clawling.com/','https://app.clawling.com/media/upload'],
  ['https://company.newbaselab.com:39003','https://company.newbaselab.com:39003/media/upload'],
  [' http://127.0.0.1:8080 ','http://127.0.0.1:8080/media/upload'],
 ])('turns the origin %s into the upload endpoint',(origin,expected)=>{expect(mediaUploadUrlFor(origin)).toBe(expected);});
 it.each(['https://app.clawling.com/media/upload','https://cdn.example.com/custom/upload','https://app.clawling.com/?x=1','not a url','ftp://app.clawling.com'])('keeps the explicit value %s',value=>{
  expect(mediaUploadUrlFor(value)).toBe(value);
 });
 it('repairs an existing config written from the bare origin and leaves the rest alone',()=>{
  const config={baseUrl:'https://app.clawling.com',mediaUploadUrl:'https://app.clawling.com',agents:{dsh:{}}};
  expect(repairMediaUploadUrl(config)).toBe(true);
  expect(config).toEqual({baseUrl:'https://app.clawling.com',mediaUploadUrl:'https://app.clawling.com/media/upload',agents:{dsh:{}}});
  expect(repairMediaUploadUrl(config)).toBe(false);
 });
 it('does not touch a correct, custom or missing value',()=>{
  for(const config of [{mediaUploadUrl:'https://app.clawling.com/media/upload'},{mediaUploadUrl:'https://cdn.example.com/up'},{},null]){
   const before=JSON.stringify(config);expect(repairMediaUploadUrl(config)).toBe(false);expect(JSON.stringify(config)).toBe(before);
  }
 });
});

// End to end through the packaged runtime cli: a fake Connect records its calls and keeps config.json like the real one.
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,cpSync,chmodSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
function runInit(prepare,env={}){
 const root=mkdtempSync(join(tmpdir(),'dsh-media-url-'));
 try{
  cpSync(new URL('../platform/deepseek-harness',import.meta.url).pathname,join(root,'release/runtime'),{recursive:true});
  mkdirSync(join(root,'release/official-plugins'));
  const fake=join(root,'release/clawchat-connect');
  writeFileSync(fake,`#!${process.execPath}
const fs=require('fs');const a=process.argv.slice(2);const c=a[a.indexOf('--config')+1];
fs.appendFileSync(process.env.FAKE_CONNECT_LOG,JSON.stringify(a.slice(0,a.indexOf('--config')))+'\\n');
const read=()=>JSON.parse(fs.readFileSync(c,'utf8'));const write=v=>fs.writeFileSync(c,JSON.stringify(v));
if(a[0]==='init'){fs.mkdirSync(require('path').dirname(c),{recursive:true});write({baseUrl:'https://app.clawling.com',mediaUploadUrl:'https://app.clawling.com/media/upload',agents:{}});}
else if(a[0]==='config'&&a[1]==='set'){const v=read();v[a[2]]=a[3];write(v);}
else if(a[0]==='agent'&&a[1]==='add'){const v=read();v.agents={...v.agents,dsh:{}};write(v);}
`);chmodSync(fake,0o755);
  const home=join(root,'home');mkdirSync(join(home,'.clawchat-dsh'),{recursive:true});
  writeFileSync(join(home,'.clawchat-dsh/config.json'),JSON.stringify({models:{providers:{fixture:{apiKey:'k',models:[{id:'m'}]}}},agents:{defaults:{model:{primary:'fixture/m'}}}}));
  const config=join(home,'.clawchat-connect/config.json');prepare(config);
  const log=join(root,'calls.log');writeFileSync(log,'');
  const result=spawnSync(process.execPath,[join(root,'release/runtime/cli.mjs'),'init'],{encoding:'utf8',env:{...process.env,...env,HOME:home,FAKE_CONNECT_LOG:log}});
  return {result,config:existsSync(config)?JSON.parse(readFileSync(config,'utf8')):null,calls:readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l))};
 }finally{rmSync(root,{recursive:true,force:true});}
}
describe('DSH runtime init writes a usable mediaUploadUrl',()=>{
 it('sets the upload endpoint, not the bare CLAWCHAT_MEDIA_URL origin, on a new instance',()=>{
  const {result,config,calls}=runInit(()=>{},{CLAWCHAT_BASE_URL:'https://app.clawling.com',CLAWCHAT_MEDIA_URL:'https://app.clawling.com'});
  expect(result.status).toBe(0);
  expect(calls).toContainEqual(['config','set','mediaUploadUrl','https://app.clawling.com/media/upload']);
  expect(config.mediaUploadUrl).toBe('https://app.clawling.com/media/upload');
 });
 it('repairs an instance initialized by an earlier release on the next start',()=>{
  const {result,config}=runInit(file=>{mkdirSync(join(file,'..'),{recursive:true});writeFileSync(file,JSON.stringify({baseUrl:'https://company.newbaselab.com:39003',mediaUploadUrl:'https://company.newbaselab.com:39003',agents:{dsh:{runtimeConfig:{profile:'sdk'}}}}));});
  expect(result.status).toBe(0);
  expect(config).toEqual({baseUrl:'https://company.newbaselab.com:39003',mediaUploadUrl:'https://company.newbaselab.com:39003/media/upload',agents:{dsh:{runtimeConfig:{profile:'sdk'}}}});
 });
});
