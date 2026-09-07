// Isolated callback tests: no live Pi session, network, or host configuration writes.
import { readFile, writeFile, mkdir, mkdtemp, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const source = await readFile(join(repo, 'extensions/artifact-guard/index.ts'), 'utf8');
const hash = text => createHash('sha256').update(text).digest('hex');
const scratch = await mkdtemp(join(tmpdir(), 'artifact-guard-test-'));
// Preserve all guard logic. Stub only external registration/type helpers, not guards.
let executable = source
  .replace('import { homedir, tmpdir } from "node:os";', 'import { tmpdir } from "node:os"; const homedir = () => ' + JSON.stringify(scratch) + ';')
  .replace(/import \{ StringEnum \} from "@earendil-works\/pi-ai";/, 'const StringEnum = values => ({enum: values});')
  .replace(/import \{[\s\S]*?\} from "@earendil-works\/pi-coding-agent";/, match => {
    // This regex starts at the first import; keep preceding built-in imports.
    const start = match.lastIndexOf('import {');
    return match.slice(0, start) + 'const isToolCallEventType = (name, event) => event.toolName === name;';
  })
  .replace(/import \{ Type \} from "typebox";/, 'const Type = new Proxy({}, {get: (_, name) => (...args) => ({name,args})});');
const module = await import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(executable)).toString('base64'));
let count = 0;
const variants = ['baseline', 'without_prompt_kernel', 'without_write_gate', 'without_shell_gate', 'without_finalize_warning'];
const observations = [];

async function instance(variant = 'baseline', {enforce=true, git=false, marker={}} = {}) {
  const dir = join(scratch, String(++count));
  await mkdir(dir);
  await mkdir(join(dir, 'allowed'));
  await mkdir(join(dir, 'outside'));
  if (git) await mkdir(join(dir, '.git'));
  if (enforce) await writeFile(join(dir, '.artifact-guard.json'), JSON.stringify({allow_scratch:false,...marker}));
  const handlers = new Map(), tools = new Map(), calls=[];
  const ctx = {cwd:dir, sessionManager:{getSessionId:()=> 'probe-owner'}, ui:{notify:()=>{}}};
  module.default({
    on(name, fn) {
      if (variant==='without_prompt_kernel' && name==='before_agent_start') {
        handlers.set(name, async (e,c) => {
          const result = await fn(e,c);
          return {...result,systemPrompt:e.systemPrompt};
        });
        return;
      }
      if (variant==='without_write_gate' && name==='tool_call') return;
      if (variant==='without_finalize_warning' && name==='message_end') return;
      handlers.set(name, variant==='without_shell_gate' && name==='tool_call'
        ? (e,c) => e.toolName==='bash' ? undefined : fn(e,c) : fn);
    },
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand() {},
    async exec(bin,args,opts) {
      calls.push(args.at(-1));
      const r = spawnSync(bin,args,{cwd:opts.cwd,encoding:'utf8',timeout:3000});
      return {code:r.status,stdout:r.stdout??'',stderr:r.stderr??'',killed:!!r.error};
    }
  });
  const emit = async (name,e={}) => handlers.get(name)?.(e,ctx);
  await emit('session_start');
  const root = join(dir,'allowed');
  const call = async (name,input) => (await tools.get(name).execute('test',input,undefined,undefined,ctx)).details;
  const establish = extras => call('contract_check',{mode:'write',allowed_write_roots:[root],...extras});
  const finalize = extras => call('artifact_finalize',{deterministic_regeneration:{required:false},...extras});
  const gate = (toolName,input) => emit('tool_call',{toolName,input});
  return {dir,root,emit,establish,finalize,gate,calls};
}

const tests = {
  async blocks_write_without_contract(v) {const s=await instance(v); return !!(await s.gate('write',{path:join(s.root,'x')}))?.block;},
  async allows_scoped_write(v) {const s=await instance(v); await s.establish(); return !(await s.gate('write',{path:join(s.root,'x')}))?.block;},
  async blocks_outside_write(v) {const s=await instance(v); await s.establish(); return !!(await s.gate('write',{path:join(s.dir,'outside/x')}))?.block;},
  async blocks_outside_shell_redirect(v) {const s=await instance(v); await s.establish(); return !!(await s.gate('bash',{command:`echo x > ${s.dir}/outside/x`}))?.block;},
  async allows_readonly_command(v) {const s=await instance(v); return !(await s.gate('bash',{command:'pwd'}))?.block;},
  async blocks_symlink_escape(v) {const s=await instance(v); await symlink(join(s.dir,'outside'),join(s.root,'link')); await s.establish(); return !!(await s.gate('write',{path:join(s.root,'link/x')}))?.block;},
  async rejects_overlapping_roots(v) {const s=await instance(v); return (await s.establish({allowed_write_roots:[s.root,s.root]})).status==='FAIL';},
  async rejects_conflicting_owners(v) {const s=await instance(v); return (await s.establish({concepts:[{name:'x',schema_owner:'a'},{name:'x',schema_owner:'b'}]})).status==='FAIL';},
  async rejects_required_forbidden_overlap(v) {const s=await instance(v); return (await s.establish({required_outputs:[join(s.root,'x')],forbidden_outputs:[join(s.root,'x')]})).status==='FAIL';},
  async rejects_bad_input_hash(v) {const s=await instance(v); const p=join(s.root,'input'); await writeFile(p,'baseline'); return (await s.establish({immutable_inputs:[{path:p,sha256:'0'.repeat(64)}]})).status==='FAIL';},
  async blocks_changed_immutable_input(v) {const s=await instance(v); const p=join(s.root,'input'); await writeFile(p,'baseline'); await s.establish({immutable_inputs:[{path:p,sha256:hash('baseline')}]}); await writeFile(p,'changed'); return !!(await s.gate('write',{path:join(s.root,'x')}))?.block;},
  async rejects_live_foreign_lease(v) {const s=await instance(v,{marker:{lease_markers:['lease.json']}}); await writeFile(join(s.root,'lease.json'),JSON.stringify({owner:'other',exclusive:true,active:true})); return (await s.establish()).status==='FAIL';},
  async rejects_missing_output(v) {const s=await instance(v); const p=join(s.root,'out'); await s.establish({required_outputs:[p]}); return (await s.finalize({required_outputs:[p]})).status==='FAIL';},
  async rejects_failed_supplied_qa(v) {const s=await instance(v); await s.establish(); return (await s.finalize({qa_commands:['exit 7']})).status==='FAIL';},
  async accepts_successful_supplied_qa(v) {const s=await instance(v); await s.establish(); return (await s.finalize({qa_commands:['true']})).status==='PASS' && s.calls.length===1;},
  async rejects_changed_regeneration(v) {const s=await instance(v); const p=join(s.root,'out'); await writeFile(p,'before'); await s.establish({required_outputs:[p],deterministic_regeneration_required:true}); return (await s.finalize({required_outputs:[p],deterministic_regeneration:{required:true,command:`printf after > ${p}`}})).status==='FAIL';},
  async emits_completion_warning(v) {const s=await instance(v); await s.establish(); await s.gate('write',{path:join(s.root,'x')}); const r=await s.emit('message_end',{message:{role:'assistant',content:[{type:'text',text:'implementation complete'}]}}); return JSON.stringify(r??{}).includes('artifact-guard warning');},
  async rejects_omitted_required_qa(v) {const s=await instance(v); await s.establish({behavioral_checks:['true']}); return (await s.finalize()).status==='FAIL' && s.calls.length===0;},
  async accepts_all_required_qa(v) {const s=await instance(v); await s.establish({behavioral_checks:['true','exit 0']}); return (await s.finalize({qa_commands:['true','exit 0']})).status==='PASS' && s.calls.length===2;},
  async rejects_partial_required_qa(v) {const s=await instance(v); await s.establish({behavioral_checks:['true','exit 0']}); return (await s.finalize({qa_commands:['true']})).status==='FAIL';},
  async rejects_unrelated_qa_without_executing_it(v) {const s=await instance(v); await s.establish({behavioral_checks:['true']}); return (await s.finalize({qa_commands:['exit 0']})).status==='FAIL' && s.calls.length===0;},
  async rejects_legacy_prose_without_executing_it(v) {const s=await instance(v); await s.establish({behavioral_checks:['Run all behavioral tests']}); return (await s.finalize()).status==='FAIL' && s.calls.length===0;},
  async negative_commands_do_not_replace_required_qa(v) {const s=await instance(v); await s.establish({behavioral_checks:['true']}); return (await s.finalize({negative_checks:['true']})).status==='FAIL';},
  async rejects_failing_required_qa(v) {const s=await instance(v); await s.establish({behavioral_checks:['exit 7']}); return (await s.finalize({qa_commands:['exit 7']})).status==='FAIL' && s.calls.length===1;},
  async accepts_trimmed_required_qa(v) {const s=await instance(v); await s.establish({behavioral_checks:[' true ']}); return (await s.finalize({qa_commands:[' true ']})).status==='PASS';},
  async rejects_output_removed_by_qa(v) {const s=await instance(v);const p=join(s.root,'out');await writeFile(p,'x');await s.establish({required_outputs:[p]});return (await s.finalize({required_outputs:[p],qa_commands:[`"${process.execPath}" -e "require('fs').unlinkSync('${p}')"`]})).status==='FAIL';},
  async rejects_output_removed_by_negative_check(v) {const s=await instance(v);const p=join(s.root,'out');await writeFile(p,'x');await s.establish({required_outputs:[p]});return (await s.finalize({required_outputs:[p],negative_checks:[`"${process.execPath}" -e "require('fs').unlinkSync('${p}')"`]})).status==='FAIL';},
  async rejects_output_replaced_by_directory(v) {const s=await instance(v);const p=join(s.root,'out');await writeFile(p,'x');await s.establish({required_outputs:[p]});return (await s.finalize({required_outputs:[p],qa_commands:[`"${process.execPath}" -e "const f=require('fs');f.unlinkSync('${p}');f.mkdirSync('${p}')"`]})).status==='FAIL';},
  async rejects_output_retargeted_symlink(v) {const s=await instance(v);const p=join(s.root,'out'),q=join(s.root,'other');await writeFile(p,'x');await writeFile(q,'x');await s.establish({required_outputs:[p]});return (await s.finalize({required_outputs:[p],qa_commands:[`"${process.execPath}" -e "const f=require('fs');f.unlinkSync('${p}');f.symlinkSync('${q}','${p}')"`]})).status==='FAIL';},
  async accepts_preserved_output_with_required_qa(v) {const s=await instance(v);const p=join(s.root,'out');await writeFile(p,'x');await s.establish({required_outputs:[p],behavioral_checks:['true']});return (await s.finalize({required_outputs:[p],qa_commands:['true']})).status==='PASS';},
  async allows_artifact_contract_without_behavioral_commands(v) {const s=await instance(v);await s.establish();return (await s.finalize()).status==='PASS';}
};
try {
for (const v of variants) {
  const results={};
  for (const [name,fn] of Object.entries(tests)) results[name]=await fn(v);
  const s=await instance(v);
  const prompt=await s.emit('before_agent_start',{systemPrompt:'BASE'});
  const inserted=prompt?.systemPrompt?.slice(4)??'';
  observations.push({variant:v,results,passing:Object.values(results).filter(Boolean).length,total:Object.keys(results).length,prompt_characters:inserted.length});
}

assert(Object.values(observations[0].results).every(Boolean), 'guard regression suite failed');
assert.deepEqual(observations[1].results, observations[0].results, 'prompt ablation changed deterministic checks');
assert.equal(observations[2].passing, 25, 'write-gate ablation sensitivity changed');
assert.equal(observations[3].passing, 30, 'shell-gate ablation sensitivity changed');
assert.equal(observations[4].passing, 30, 'warning ablation sensitivity changed');
console.log(JSON.stringify({
  method: 'Pi callbacks mocked; filesystem, hash, and explicit shell checks real; not a live Pi or LLM test',
  checks: observations[0].passing,
  total: observations[0].total,
  variants: observations.map(({variant, passing, total}) => ({variant, passing, total}))
}, null, 2));
} finally {
  await rm(scratch, {recursive: true});
}
