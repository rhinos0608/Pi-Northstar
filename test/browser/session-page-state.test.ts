import assert from 'node:assert/strict'; import {test} from 'node:test'; import {SessionPageStateStore,StaleRefError,preflightRef} from '../../src/browser/session-page-state.js';

test('recordSnapshot then resolveRef round-trip',()=>{const s=new SessionPageStateStore();s.recordSnapshot('ns', 'https://a.example', [{ref:'@e1',role:'button',name:'Submit'}]);const ref=s.resolveRef('ns','@e1');assert.equal(ref.role,'button');assert.equal(ref.name,'Submit');});

test('resolveRef throws StaleRefError for unknown ref',()=>{const s=new SessionPageStateStore();s.recordSnapshot('ns','https://a.example',[{ref:'@e1'}]);assert.throws(()=>s.resolveRef('ns','@e99'),StaleRefError);});

test('invalidate clears snapshot; previously-valid ref now throws',()=>{const s=new SessionPageStateStore();s.recordSnapshot('ns','https://a.example',[{ref:'@e1'}]);assert.equal(s.resolveRef('ns','@e1').ref,'@e1');s.invalidate('ns','navigation');assert.throws(()=>s.resolveRef('ns','@e1'),StaleRefError);assert.equal(s.snapshot('ns'),undefined);});

test('stale update rejection via expectedPriorToken',()=>{const s=new SessionPageStateStore();const firstToken=s.currentToken('ns');s.recordSnapshot('ns','https://a.example',[{ref:'@e1'}]);const second=s.recordSnapshot('ns','https://b.example',[{ref:'@e2'}]);const result=s.recordSnapshot('ns','https://c.example',[{ref:'@e3'}],firstToken);assert.equal(result.token,second.token);assert.equal(result.url,'https://b.example');assert.throws(()=>s.resolveRef('ns','@e3'),StaleRefError);assert.equal(s.resolveRef('ns','@e2').ref,'@e2');});

test('setActiveTab/getActiveTab/pinTab round-trip',()=>{const s=new SessionPageStateStore();assert.equal(s.getActiveTab('ns'),undefined);const tab={tabId:'t1',url:'https://a.example',pinned:false};s.setActiveTab('ns',tab);assert.deepEqual(s.getActiveTab('ns'),tab);s.pinTab('ns','t1');assert.equal(s.getActiveTab('ns')?.pinned,true);});

test('namespace isolation',()=>{const s=new SessionPageStateStore();s.recordSnapshot('ns1','https://a.example',[{ref:'@e1',name:'a'}]);s.recordSnapshot('ns2','https://b.example',[{ref:'@e1',name:'b'}]);assert.equal(s.resolveRef('ns1','@e1').name,'a');assert.equal(s.resolveRef('ns2','@e1').name,'b');s.invalidate('ns1','navigation');assert.throws(()=>s.resolveRef('ns1','@e1'),StaleRefError);assert.equal(s.resolveRef('ns2','@e1').name,'b');});

test('clear removes all state for exactly the given namespace',()=>{const s=new SessionPageStateStore();s.recordSnapshot('ns1','https://a.example',[{ref:'@e1'}]);s.setActiveTab('ns1',{tabId:'t1',url:'https://a.example',pinned:false});s.recordSnapshot('ns2','https://b.example',[{ref:'@e1'}]);s.clear('ns1');assert.equal(s.snapshot('ns1'),undefined);assert.equal(s.getActiveTab('ns1'),undefined);assert.equal(s.currentToken('ns1'),0);assert.equal(s.snapshot('ns2')!.url,'https://b.example');});

test('preflightRef returns undefined for a plain CSS selector regardless of store state',()=>{const s=new SessionPageStateStore();assert.equal(preflightRef(s,'ns','#submit'),undefined);s.recordSnapshot('ns','https://a.example',[{ref:'@e1'}]);assert.equal(preflightRef(s,'ns','#submit'),undefined);});

test('preflightRef returns the PageRef for a ref present in the current snapshot',()=>{const s=new SessionPageStateStore();s.recordSnapshot('ns','https://a.example',[{ref:'@e1',role:'button',name:'Submit'}]);const ref=preflightRef(s,'ns','@e1');assert.equal(ref?.ref,'@e1');assert.equal(ref?.name,'Submit');});

test('preflightRef throws StaleRefError for a ref-shaped selector with no snapshot recorded',()=>{const s=new SessionPageStateStore();assert.throws(()=>preflightRef(s,'ns','@e9'),StaleRefError);});

test('preflightRef throws StaleRefError for a ref-shaped selector once its snapshot is invalidated',()=>{const s=new SessionPageStateStore();s.recordSnapshot('ns','https://a.example',[{ref:'@e1'}]);assert.equal(preflightRef(s,'ns','@e1')?.ref,'@e1');s.invalidate('ns','navigation');assert.throws(()=>preflightRef(s,'ns','@e1'),StaleRefError);});
