import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import semver from 'semver';
const p=JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url),'utf8'));
for(const version of ['0.2.1-rc.2','0.2.1-rc.3','0.2.1-rc.4','0.2.1','0.2.2-alpha.2']){
 test('DSH '+version+' passes the installation gate and runtime peers',()=>{
  // Match DSH's plugin-compatibility evaluator, which includes prereleases.
  assert.ok(semver.satisfies(version,p.engines.dsh,{includePrerelease:true}),p.engines.dsh);
  // npm/pnpm use standard semver for peers, so alpha needs an explicit arm.
  for(const [name,range] of Object.entries(p.peerDependencies)){
   if(name==='@deepseek-ai/dsh'||name==='@deepseek-ai/dsh-llm')assert.ok(semver.satisfies(version,range),name+': '+range);
  }
 });
}
test('unvalidated DSH release lines remain outside the gate',()=>{
 for(const version of ['0.1.6','0.3.0'])assert.equal(semver.satisfies(version,p.engines.dsh,{includePrerelease:true}),false);
});
if(p.peerDependencies['@deepseek-ai/cordis'])test('Cordis peers admit stable and alpha DSH hosts',()=>{
 for(const version of ['4.0.5','4.0.6-alpha.1'])assert.ok(semver.satisfies(version,p.peerDependencies['@deepseek-ai/cordis']));
});
