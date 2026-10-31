import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import path from 'node:path';
import os from 'node:os';

const filename = path.resolve('scripts/switch-local-brc.ps1');
const source = readFileSync(filename,'utf8');
const functionSource = source.match(/^function Find-LegacyProcesses \{[\s\S]*?^\}/m)?.[0];
assert.ok(functionSource,'Cutover script must define legacy-process detection');
const pwsh = path.join(os.homedir(),'scoop','apps','pwsh','current','pwsh.exe');
function execute(sourceText) {
 const result = spawnSync(pwsh,['-NoProfile','-NonInteractive','-Command',sourceText],
   {windowsHide:true,encoding:'utf8',timeout:15000});
 assert.equal(result.error,undefined,result.error?.message);
 return result;
}
test('cutover PowerShell script parses before touching any services',()=>{
 const result=execute('$e=$null;[System.Management.Automation.Language.Parser]::ParseFile('+
 JSON.stringify(filename)+', [ref]$null, [ref]$e)|Out-Null;if($e){throw $e[0]}');
 assert.equal(result.status,0,result.stderr);
});
test('cutover resumes when both legacy processes have stopped',()=>{
 const result=execute('function Get-CimInstance { return @() };'+functionSource+
   ';$result=Find-LegacyProcesses;if($null -ne $result){throw "Expected empty legacy state"}');
 assert.equal(result.status,0,result.stderr);
});
test('cutover resumes when only the legacy Relay remains',()=>{
 const fake = String.raw`[pscustomobject]@{Name='node.exe';CommandLine='C:\node_modules\brc-relay\dist\cli.js';ProcessId=123}`;
 const result=execute('function Get-CimInstance { return '+fake+' };'+functionSource+
   ';$r=Find-LegacyProcesses;if($null -eq $r.Relay -or $null -ne $r.Agent){throw "Incorrect resume state"}');
 assert.equal(result.status,0,result.stderr);
});
test('cutover refuses ambiguous duplicate legacy processes',()=>{
 const fake = String.raw`[pscustomobject]@{Name='node.exe';CommandLine='C:\node_modules\brc-relay\dist\cli.js';ProcessId=123}`;
 const result=execute('function Get-CimInstance { return @('+fake+','+fake+') };'+functionSource+
   ';try {Find-LegacyProcesses | Out-Null;exit 3}catch{exit 0}');
 assert.equal(result.status,0,result.stderr);
});
