import {it,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';

function generatePatch(models){
 const home=mkdtempSync(join(tmpdir(),'dsh-input-'));
 try{
  mkdirSync(join(home,'.clawchat-dsh'));
  writeFileSync(join(home,'.clawchat-dsh/config.json'),JSON.stringify({models:{providers:{fixture:{apiKey:'k',models}}},agents:{defaults:{model:{primary:'fixture/'+models[0].id}}}}));
  const script=`import {nativeModel} from ${JSON.stringify(new URL('../platform/deepseek-harness/lib.mjs',import.meta.url).href)}; nativeModel();`;
  const result=spawnSync(process.execPath,['--eval',script],{encoding:'utf8',env:{...process.env,HOME:home}});
  expect(result.status).toBe(0);
  const patch=JSON.parse(readFileSync(join(home,'.clawchat-dsh/models.patch.yml'),'utf8'));
  return Object.fromEntries(patch.find(p=>p.id==='llm-pi-ai').config.providers.fixture.models.map(m=>[m.id,m]));
 }finally{rmSync(home,{recursive:true});}
}

// Mirrors @deepseek-ai/dsh-llm-pi-ai: a model entry without `input` defaults to ["text"].
const resolveModelInfo=(entry)=>({inputModalities:entry.input??['text']});

it('keeps image input in the generated models patch and leaves text-only models text-only',()=>{
 const models=generatePatch([
  {id:'vision',input:['text','image']},
  {id:'plain',input:['text']},
  {id:'missing'},
  {id:'odd',input:['audio','image','video']},
 ]);
 expect(models.vision.input).toEqual(['text','image']);
 expect(models.plain.input).toEqual(['text']);
 expect(models.missing.input).toEqual(['text']);
 expect(models.odd.input).toEqual(['image']);
 // The bridge accepts image input only when resolveModelInfo reports it.
 expect(resolveModelInfo(models.vision).inputModalities.includes('image')).toBe(true);
 expect(resolveModelInfo(models.plain).inputModalities.includes('image')).toBe(false);
 expect(resolveModelInfo(models.missing).inputModalities.includes('image')).toBe(false);
});
