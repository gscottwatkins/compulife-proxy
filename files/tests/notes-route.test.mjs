import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
const source=fs.readFileSync(new URL('../server.js',import.meta.url),'utf8');
const block=source.slice(source.indexOf('app.get("/ghl/contacts/:id/notes"'),source.indexOf('app.post("/ghl/contacts/:id/notes"'));
let handler; const calls=[]; let loc='loc',upstreamOk=true;
new Function('app','ghlFetch','GHL_LOCATION_ID',block)({get:(_,fn)=>handler=fn},async(method,path)=>{calls.push(path);return path.endsWith('/notes')?{_ok:upstreamOk,_status:upstreamOk?200:503,notes:[{body:'saved workup'}]}:{_ok:true,contact:{locationId:loc}}},'loc');
function response(){return{code:200,status(c){this.code=c;return this},json(data){this.data=data;return this}}}
test('saved notes read preserves data and provider failure',async()=>{let r=response();await handler({params:{id:'test'}},r);assert.equal(r.code,200);assert.equal(r.data.notes[0].body,'saved workup');upstreamOk=false;r=response();await handler({params:{id:'test'}},r);assert.equal(r.code,503)});
test('cross-location notes are rejected before note read',async()=>{loc='other';calls.length=0;let r=response();await handler({params:{id:'test'}},r);assert.equal(r.code,403);assert.equal(calls.length,1)});
