import assert from 'node:assert/strict'; import {test} from 'node:test'; import {SessionPageStateStore,StaleRefError,preflightRef} from '../../src/browser/session-page-state.js';

test('recordSnapshot then resolveRef round-trip',()=>{const s=new SessionPageStateStore();s.recordSnapshot('ns', 'https://a.example', [{ref:'@e1',role:'button',name:'Submit'}]);const ref=s.resolveRef('ns','@e1');assert.equal(ref.role,'button');assert.equal(ref.name,'Submit');});

test('resolveRef throws StaleRefError for unknown ref',()=>{const s=new SessionPageStateStore();s.recordSnapshot('ns','https://a.example',[{ref:'@e1'}]);assert.throws(()=>s.resolveRef('ns','@e99'),StaleRefError);});

test('invalidate clears snapshot; previously-valid ref now throws',()=>{const s=new SessionPageStateStore();s.recordSnapshot('ns','https://a.example',[{ref:'@e1'}]);assert.equal(s.resolveRef('ns','@e1').ref,'@e1');s.invalidate('ns','navigation');assert.throws(()=>s.resolveRef('ns','@e1'),StaleRefError);assert.equal(s.snapshot('ns'),undefined);});

test('stale update rejection via expectedPriorToken',()=>{const s=new SessionPageStateStore();const firstToken=s.currentToken('ns');s.recordSnapshot('ns','https://a.example',[{ref:'@e1'}]);const second=s.recordSnapshot('ns','https://b.example',[{ref:'@e2'}]);const result=s.recordSnapshot('ns','https://c.example',[{ref:'@e3'}],firstToken);assert.equal(result!.token,second!.token);assert.equal(result!.url,'https://b.example');assert.throws(()=>s.resolveRef('ns','@e3'),StaleRefError);assert.equal(s.resolveRef('ns','@e2').ref,'@e2');});

test('in-flight snapshot after navigation invalidate is dropped, never resurrected',()=>{const s=new SessionPageStateStore();s.recordSnapshot('ns','https://a.example',[{ref:'@e1'}]);const inFlightToken=s.currentToken('ns');s.invalidate('ns','navigation');assert.equal(s.snapshot('ns'),undefined);const result=s.recordSnapshot('ns','https://a.example',[{ref:'@e1-stale'}],inFlightToken);assert.equal(result,undefined);assert.equal(s.snapshot('ns'),undefined);assert.throws(()=>s.resolveRef('ns','@e1-stale'),StaleRefError);assert.throws(()=>s.resolveRef('ns','@e1'),StaleRefError);});

test('invalidate bumps token so prior resolutions go stale',()=>{const s=new SessionPageStateStore();s.recordSnapshot('ns','https://a.example',[{ref:'@e1'}]);const tokenBefore=s.currentToken('ns');const snapToken=s.snapshot('ns')!.token;s.invalidate('ns','navigation');assert.ok(s.currentToken('ns')>tokenBefore);s.recordSnapshot('ns','https://b.example',[{ref:'@e1'}]);assert.throws(()=>s.resolveRef('ns','@e1',snapToken),StaleRefError);assert.equal(s.resolveRef('ns','@e1').ref,'@e1');});

test('token-gated preflightRef rejects superseded snapshot',()=>{const s=new SessionPageStateStore();s.recordSnapshot('ns','https://a.example',[{ref:'@e1',role:'button',name:'Submit'}]);const firstToken=s.snapshot('ns')!.token;s.invalidate('ns','navigation');s.recordSnapshot('ns','https://b.example',[{ref:'@e1',role:'link',name:'Other'}]);assert.throws(()=>preflightRef(s,'ns','@e1',firstToken),StaleRefError);assert.equal(preflightRef(s,'ns','@e1')?.name,'Other');});

test('setActiveTab/getActiveTab/pinTab round-trip',()=>{const s=new SessionPageStateStore();assert.equal(s.getActiveTab('ns'),undefined);const tab={tabId:'t1',url:'https://a.example',pinned:false};s.setActiveTab('ns',tab);assert.deepEqual(s.getActiveTab('ns'),tab);s.pinTab('ns','t1');assert.equal(s.getActiveTab('ns')?.pinned,true);});

test('namespace isolation',()=>{const s=new SessionPageStateStore();s.recordSnapshot('ns1','https://a.example',[{ref:'@e1',name:'a'}]);s.recordSnapshot('ns2','https://b.example',[{ref:'@e1',name:'b'}]);assert.equal(s.resolveRef('ns1','@e1').name,'a');assert.equal(s.resolveRef('ns2','@e1').name,'b');s.invalidate('ns1','navigation');assert.throws(()=>s.resolveRef('ns1','@e1'),StaleRefError);assert.equal(s.resolveRef('ns2','@e1').name,'b');});

test('clear removes all state for exactly the given namespace',()=>{const s=new SessionPageStateStore();s.recordSnapshot('ns1','https://a.example',[{ref:'@e1'}]);s.setActiveTab('ns1',{tabId:'t1',url:'https://a.example',pinned:false});const tokenBefore=s.currentToken('ns1');s.recordSnapshot('ns2','https://b.example',[{ref:'@e1'}]);s.clear('ns1');assert.equal(s.snapshot('ns1'),undefined);assert.equal(s.getActiveTab('ns1'),undefined);assert.ok(s.currentToken('ns1')>tokenBefore);assert.equal(s.snapshot('ns2')!.url,'https://b.example');});

test('preflightRef returns undefined for a plain CSS selector regardless of store state',()=>{const s=new SessionPageStateStore();assert.equal(preflightRef(s,'ns','#submit'),undefined);s.recordSnapshot('ns','https://a.example',[{ref:'@e1'}]);assert.equal(preflightRef(s,'ns','#submit'),undefined);});

test('preflightRef returns the PageRef for a ref present in the current snapshot',()=>{const s=new SessionPageStateStore();s.recordSnapshot('ns','https://a.example',[{ref:'@e1',role:'button',name:'Submit'}]);const ref=preflightRef(s,'ns','@e1');assert.equal(ref?.ref,'@e1');assert.equal(ref?.name,'Submit');});

test('preflightRef throws StaleRefError for a ref-shaped selector with no snapshot recorded',()=>{const s=new SessionPageStateStore();assert.throws(()=>preflightRef(s,'ns','@e9'),StaleRefError);});

test('preflightRef throws StaleRefError for a ref-shaped selector once its snapshot is invalidated',()=>{const s=new SessionPageStateStore();s.recordSnapshot('ns','https://a.example',[{ref:'@e1'}]);assert.equal(preflightRef(s,'ns','@e1')?.ref,'@e1');s.invalidate('ns','navigation');assert.throws(()=>preflightRef(s,'ns','@e1'),StaleRefError);});

test('late snapshot with pre-clear token never resurrects after clear (close race)',()=>{const s=new SessionPageStateStore();const preToken=s.currentToken('ns');s.recordSnapshot('ns','https://a.example',[{ref:'@e1'}]);s.clear('ns');assert.equal(s.snapshot('ns'),undefined);const result=s.recordSnapshot('ns','https://a.example',[{ref:'@e1-stale'}],preToken);assert.equal(result,undefined);assert.equal(s.snapshot('ns'),undefined);assert.throws(()=>s.resolveRef('ns','@e1-stale'),StaleRefError);assert.throws(()=>s.resolveRef('ns','@e1'),StaleRefError);});

test('recording an empty snapshot supersedes prior refs',()=>{const s=new SessionPageStateStore();s.recordSnapshot('ns','https://a.example',[{ref:'@e1'}]);assert.equal(s.resolveRef('ns','@e1').ref,'@e1');const token=s.currentToken('ns');const record=s.recordSnapshot('ns','https://a.example',[],token);assert.ok(record!==undefined);assert.equal(record!.refs.size,0);assert.throws(()=>s.resolveRef('ns','@e1'),StaleRefError);});
