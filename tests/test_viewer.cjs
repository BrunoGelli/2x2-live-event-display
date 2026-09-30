/* Exercise the actual frontend with deterministic async IO/Plotly substitutes.
 * These are concurrency tests, NOT a WebGL rendering benchmark. No npm deps. */
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(process.env.LIVE2X2_APP_JS || path.join(__dirname,'../src/live2x2/static/app.js'),'utf8');
const copy = x => JSON.parse(JSON.stringify(x));
function deferred() { let resolve, reject; const promise=new Promise((a,b)=>{resolve=a;reject=b;}); return {promise,resolve,reject}; }
const flush = () => new Promise(resolve => setImmediate(resolve));
function manifest(id='a',count=4) {
  return {schema:'live2x2.v1',generation:id.repeat(32),demo:false,
    source:{name:`${id}.FLOW.hdf5`,mtime:100},published_at:100,total_events:count,
    sampled_events:count,hit_type:'prompt',completion:'operator_asserted',
    geometry:{bounds:{x:[-65,65],y:[-65,65],z:[-65,65]},boxes:[],source:'test'},
    events:Array.from({length:count},(_,i)=>({event_index:i,event_id:String(i)}))};
}
function event(index) { return {event_index:index,event_id:String(index+100),hits:{x:[1,2],y:[2,3],z:[3,4],Q:[1,100]},
  color:{values:[0,2],minimum:0,maximum:2},summary:{raw_hits:2,renderable_hits:2,plotted_hits:2,
    finite_Q_sum:101,omitted_nonfinite:0,outside_nominal:0,sampled_hits:false}}; }
async function harness({slowIndex=null}={}) {
  const nodes=new Map();
  function element(id='') {
    return {id,textContent:'',dataset:{},style:{},hidden:false,open:false,checked:true,value:'',handlers:{},children:[],
      setAttribute(){},replaceChildren(){this.children=[];},append(...n){this.children.push(...n);},
      addEventListener(k,f){this.handlers[k]=f;},on(k,f){this.handlers[k]=f;}};
  }
  const get=id=>{if(!nodes.has(id))nodes.set(id,element(id));return nodes.get(id);};
  get('dwell').value='3';get('dwell').min='1';get('dwell').max='30';
  get('turn').value='12';get('turn').min='4';get('turn').max='120';
  let now=0,token=0;
  const raf=new Map(),timers=new Map(),intervals=new Map(),calls=[],fetches=[],errors=[];
  const state={catalog:manifest(),fetchGates:new Map(),failures:new Set(),reactGate:null,projectionGate:null,cameraGate:null};
  if(slowIndex!==null)state.fetchGates.set(`${state.catalog.generation}/${slowIndex}`,deferred());
  const doc={hidden:false,baseURI:'https://example.test/user/demo/proxy/8000/',
    getElementById:get,createElement:()=>element(),addEventListener(k,f){this[k]=f;}};
  const window={addEventListener(){}};
  const Plotly={
    newPlot:async(node,data,layout)=>{node.data=copy(data);node.layout=copy(layout);},
    react:async(node,data,layout)=>{
      calls.push({type:'react-start',node:node.id,at:now,layout:copy(layout)});
      const gate=node.id==='plot3d'?state.reactGate:state.projectionGate;
      if(gate)await gate.promise;
      node.data=copy(data);node.layout=copy(layout);
      calls.push({type:'react-end',node:node.id,at:now});
    },
    relayout:async(node,update)=>{
      calls.push({type:'camera-start',at:now});
      if(state.cameraGate)await state.cameraGate.promise;
      node.layout.scene.camera=copy(update['scene.camera']);
      calls.push({type:'camera-end',at:now});
    },
    purge(node){node.data=[];},Plots:{resize(){}}
  };
  window.Plotly=Plotly;
  const context={document:doc,window,Plotly,URL,AbortController,Map,Promise,Number,Math,String,Boolean,Object,Array,
    console:{error(...a){errors.push(a);}},performance:{now:()=>now},
    setTimeout:(fn,ms)=>{const id=++token;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id),
    setInterval:(fn,ms)=>{intervals.set(++token,{fn,ms});return token;},clearInterval:id=>intervals.delete(id),
    requestAnimationFrame:fn=>{raf.set(++token,fn);return token;},cancelAnimationFrame:id=>raf.delete(id),
    fetch:async(url,options)=>{
      const pathname=new URL(url).pathname;
      fetches.push({path:pathname,cache:options.cache});
      const match=pathname.match(/generations\/([^/]+)\/events\/(\d+)$/);
      let data;
      if(match){
        const key=`${match[1]}/${match[2]}`;
        if(state.fetchGates.has(key))await state.fetchGates.get(key).promise;
        if(state.failures.has(key))return {ok:false,status:503};
        data=event(Number(match[2]));
      }else if(pathname.endsWith('/api/status')){
        data={server_time:100+now/1000,generation:state.catalog.generation,state:'CURRENT',stale_after_seconds:600,worker_stale:false};
      }else if(pathname.endsWith('/api/catalog'))data=state.catalog;
      else throw new Error('Unexpected fetch '+pathname);
      return {ok:true,json:async()=>copy(data)};
    }
  };
  vm.runInNewContext(source,context,{filename:'app.js'});
  await flush();await flush();
  async function frame(ms=40){now+=ms;const tasks=[...raf.values()];raf.clear();tasks.forEach(fn=>fn(now));await flush();}
  async function frames(n=3){for(let i=0;i<n;i++)await frame();}
  async function poll(){for(const t of intervals.values())if(t.ms===15000)t.fn();await flush();}
  async function autoNext(){const pair=[...timers].find(([,t])=>t.ms===3000);assert.ok(pair,'automatic dwell scheduled');timers.delete(pair[0]);pair[1].fn();await flush();}
  return {get,state,calls,fetches,errors,doc,frame,frames,poll,autoNext,
    cameras:()=>calls.filter(c=>c.type==='camera-start').length,
    reactStarts:()=>calls.filter(c=>c.type==='react-start'&&c.node==='plot3d').length};
}

test('old event rotates and keeps its labels while the next event fetch waits',async()=>{
  const h=await harness({slowIndex:1});
  assert.equal(h.get('event-title').textContent,'Event index 0');
  await h.frames();const before=h.cameras();
  const next=h.get('next').onclick();await flush();await h.frames(6);
  assert.ok(h.cameras()>before,'network wait must not freeze camera');
  assert.equal(h.get('event-title').textContent,'Event index 0');
  h.state.fetchGates.values().next().value.resolve();await next;
  assert.equal(h.get('event-title').textContent,'Event index 1');
});

test('camera and 3D commit never overlap, then rotation resumes',async()=>{
  const h=await harness();await h.frames();
  h.state.cameraGate=deferred();await h.frame();
  h.state.reactGate=deferred();const oldStarts=h.reactStarts();
  const next=h.get('next').onclick();await flush();
  assert.equal(h.reactStarts(),oldStarts,'commit must wait for pending camera');
  h.state.cameraGate.resolve();h.state.cameraGate=null;await flush();
  assert.equal(h.reactStarts(),oldStarts+1);
  const n=h.cameras();await h.frames(5);assert.equal(h.cameras(),n,'camera must wait during commit');
  h.state.reactGate.resolve();h.state.reactGate=null;await next;
  await h.frames();assert.ok(h.cameras()>n);
});

test('pause during an automatic slow fetch prevents the queued event commit',async()=>{
  const h=await harness({slowIndex:1});
  await h.autoNext();h.get('playback').onclick();
  h.state.fetchGates.values().next().value.resolve();await flush();await flush();
  assert.equal(h.get('event-title').textContent,'Event index 0');
  await h.get('next').onclick();assert.equal(h.get('event-title').textContent,'Event index 1');
});

test('file metadata remains on displayed generation and a newer queued file is not lost',async()=>{
  const h=await harness();
  h.state.catalog=manifest('b');const gate=deferred();h.state.fetchGates.set(`${'b'.repeat(32)}/0`,gate);
  await h.poll();const next=h.get('next').onclick();await flush();await h.frames(3);
  assert.equal(h.get('plot3d').dataset.generation,'a'.repeat(32));
  assert.ok(h.get('metadata').children.some(e=>e.textContent==='a.FLOW.hdf5'));
  h.state.catalog=manifest('c');await h.poll();
  gate.resolve();await next;
  assert.equal(h.get('plot3d').dataset.generation,'b'.repeat(32));assert.equal(h.get('latest').hidden,false);
  await h.get('latest').onclick();assert.equal(h.get('plot3d').dataset.generation,'c'.repeat(32));
});

test('slow projections cannot freeze 3D playback or show stale event data',async()=>{
  const h=await harness();h.state.projectionGate=deferred();
  h.get('projection-details').open=true;h.get('projection-details').handlers.toggle();await h.frame();
  await h.get('next').onclick();await h.frames(2);
  await h.get('next').onclick();await h.frames(2);
  assert.equal(h.get('event-title').textContent,'Event index 2');
  assert.equal(h.get('plot2d').style.visibility,'hidden');
  const n=h.cameras();await h.frames(2);assert.ok(h.cameras()>n);
  h.state.projectionGate.resolve();h.state.projectionGate=null;await flush();await h.frames(4);
  assert.equal(h.get('plot2d').dataset.eventIndex,'2');
  assert.equal(h.get('plot2d').style.visibility,'visible');
  assert.equal(h.calls.filter(c=>c.type==='react-start'&&c.node==='plot2d').length,2,'skip obsolete intermediate projections');
});

test('failed fetch preserves event and rotation; next click retries',async()=>{
  const h=await harness({slowIndex:1});const key=`${h.state.catalog.generation}/1`;
  h.state.failures.add(key);const next=h.get('next').onclick();h.state.fetchGates.get(key).resolve();await next;
  assert.equal(h.get('event-title').textContent,'Event index 0');
  const n=h.cameras();await h.frames(3);assert.ok(h.cameras()>n);
  h.state.failures.clear();await h.get('next').onclick();
  assert.equal(h.get('event-title').textContent,'Event index 1');
});

test('immutable event requests permit HTTP cache while status/catalog remain no-store',async()=>{
  const h=await harness();assert.ok(h.fetches.length>=3);
  assert.ok(h.fetches.filter(f=>f.path.includes('/events/')).every(f=>f.cache==='default'));
  assert.ok(h.fetches.filter(f=>!f.path.includes('/events/')).every(f=>f.cache==='no-store'));
});

test('empty file commit clears old event/projections without relaxing detector frame',async()=>{
  const h=await harness();h.get('projection-details').open=true;
  h.get('projection-details').handlers.toggle();await h.frames(2);
  h.state.catalog=manifest('b',0);await h.poll();await h.get('latest').onclick();await h.frames(3);
  assert.equal(h.get('event-title').textContent,'Latest FLOW contains no events');
  assert.equal(h.get('plot3d').dataset.eventIndex,undefined);
  assert.equal(h.get('plot3d').layout.scene.xaxis.autorange,false);
  assert.equal(h.get('plot2d').data.length,0);
});
