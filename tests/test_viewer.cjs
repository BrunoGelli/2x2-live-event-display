/* Actual frontend concurrency with deterministic IO/Plotly substitutes.
 * These tests are not substitutes for the real WebGL browser smoke test. */
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(process.env.LIVE2X2_APP_JS || path.join(__dirname,'../src/live2x2/static/app.js'),'utf8');
const copy=x=>JSON.parse(JSON.stringify(x));
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function manifest(id='a',count=4){
  return {schema:'live2x2.v1',generation:id.repeat(32),demo:false,
    source:{name:`${id}.FLOW.hdf5`,mtime:100},published_at:100,total_events:count,
    sampled_events:count,hit_type:'prompt',completion:'operator_asserted',
    geometry:{bounds:{x:[-65,65],y:[-65,65],z:[-65,65]},boxes:[],source:'test'},
    events:Array.from({length:count},(_,i)=>({event_index:i,event_id:String(i)}))};
}
function event(index){return {event_index:index,event_id:String(index+100),
  hits:{x:[index,2],y:[2,3],z:[3,4],Q:[1,100+index]},
  color:{values:[0,2+index/100],minimum:0,maximum:2+index/100},
  summary:{raw_hits:2,renderable_hits:2,plotted_hits:2,finite_Q_sum:101+index,
    omitted_nonfinite:0,outside_nominal:0,sampled_hits:false}};}
async function harness({slowIndex=null}={}){
  const nodes=[];
  function element(id=''){
    return {id,textContent:'',dataset:{},style:{},hidden:false,open:false,checked:true,value:'',
      handlers:{},children:[],attrs:{},inert:false,
      setAttribute(k,v){this.attrs[k]=v;},replaceChildren(){this.children=[];},append(...n){this.children.push(...n);},
      addEventListener(k,f){this.handlers[k]=f;},on(k,f){this.handlers[k]=f;}};
  }
  // Resolve current IDs, not creation-time IDs: the two real DOM nodes swap roles.
  const get=id=>{let n=nodes.find(n=>n.id===id);if(!n){n=element(id);nodes.push(n);}return n;};
  get('dwell').value='3';get('dwell').min='1';get('dwell').max='30';
  get('turn').value='12';get('turn').min='4';get('turn').max='120';
  let now=0,token=0;
  const raf=new Map(),timers=new Map(),intervals=new Map(),calls=[],fetches=[],errors=[];
  const state={catalog:manifest(),fetchGates:new Map(),failures:new Set(),reactGate:null,
    projectionGate:null,cameraGate:null,syncGate:null,reactFailure:false};
  if(slowIndex!==null)state.fetchGates.set(`${state.catalog.generation}/${slowIndex}`,deferred());
  const doc={hidden:false,baseURI:'https://example.test/user/demo/proxy/8000/',
    getElementById:get,createElement:()=>element(),addEventListener(k,f){this[k]=f;}};
  const window={handlers:{},addEventListener(k,f){this.handlers[k]=f;}};
  const Plotly={
    newPlot:async(node,data,layout)=>{node.data=copy(data);node.layout=copy(layout);calls.push({type:'new',node});},
    react:async(node,data,layout)=>{
      const isProjection=node.id==='plot2d';
      calls.push({type:isProjection?'projection-start':'scene-start',node,at:now,visible:node===get('plot3d')});
      const gate=isProjection?state.projectionGate:state.reactGate;
      if(gate)await gate.promise;
      if(!isProjection && state.reactFailure)throw new Error('simulated buffer draw failure');
      node.data=copy(data);node.layout=copy(layout);
      calls.push({type:isProjection?'projection-end':'scene-end',node,at:now});
    },
    relayout:async(node,update)=>{
      const front=node===get('plot3d');
      calls.push({type:front?'camera-start':'sync-start',node,at:now,pose:copy(update['scene.camera'])});
      const gate=front?state.cameraGate:state.syncGate;
      if(gate)await gate.promise;
      node.layout.scene.camera=copy(update['scene.camera']);
      calls.push({type:front?'camera-end':'sync-end',node,at:now});
    },
    purge(node){node.data=[];},Plots:{resize:async node=>{calls.push({type:'resize',node});}}
  };
  window.Plotly=Plotly;
  const context={document:doc,window,Plotly,URL,AbortController,Map,Promise,Number,Math,String,Boolean,Object,Array,
    console:{error(...a){errors.push(a);},warn(){}},performance:{now:()=>now},
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
  async function fireTimer(ms){const pair=[...timers].find(([,t])=>t.ms===ms);assert.ok(pair,`timer ${ms} scheduled`);timers.delete(pair[0]);pair[1].fn();await flush();await flush();}
  return {get,nodes,state,calls,fetches,errors,doc,window,frame,frames,poll,
    autoNext:()=>fireTimer(3000),warm:()=>fireTimer(200),
    cameras:()=>calls.filter(c=>c.type==='camera-start').length,
    sceneStarts:()=>calls.filter(c=>c.type==='scene-start').length};
}

test('old event rotates and keeps labels while the next event fetch waits',async()=>{
  const h=await harness({slowIndex:1});assert.equal(h.get('event-title').textContent,'Event index 0');
  await h.frames();const before=h.cameras();
  const next=h.get('next').onclick();await flush();await h.frames(6);
  assert.ok(h.cameras()>before);assert.equal(h.get('event-title').textContent,'Event index 0');
  h.state.fetchGates.values().next().value.resolve();await next;
  assert.equal(h.get('event-title').textContent,'Event index 1');
});

test('old scene continues rotating during back-scene rendering, not just network wait',async()=>{
  const h=await harness();await h.frames();const front=h.get('plot3d');
  h.state.reactGate=deferred();await h.warm();
  const n=h.cameras();await h.frames(6);assert.ok(h.cameras()>n);
  assert.equal(h.get('plot3d'),front);assert.equal(h.get('event-title').textContent,'Event index 0');
  assert.ok(h.calls.filter(c=>c.type==='scene-start').every(c=>!c.visible),'never redraw foreground hit arrays');
  h.state.reactGate.resolve();h.state.reactGate=null;await flush();
  const draws=h.sceneStarts();await h.get('next').onclick();
  assert.equal(h.sceneStarts(),draws,'ready handover must not redraw event');
  assert.notEqual(h.get('plot3d'),front);assert.equal(h.get('plot3d').dataset.preRendered,'true');
});

test('handover drains foreground camera and synchronizes prepared scene without overlapping writes',async()=>{
  const h=await harness();await h.warm();await h.frames();
  h.state.cameraGate=deferred();await h.frame();
  h.state.syncGate=deferred();const before=h.calls.filter(c=>c.type==='sync-start').length;
  const next=h.get('next').onclick();await flush();
  assert.equal(h.calls.filter(c=>c.type==='sync-start').length,before);
  h.state.cameraGate.resolve();h.state.cameraGate=null;await flush();
  assert.equal(h.calls.filter(c=>c.type==='sync-start').length,before+1);
  const n=h.cameras();await h.frames(4);assert.equal(h.cameras(),n);
  h.state.syncGate.resolve();h.state.syncGate=null;await next;
  await h.frames();assert.ok(h.cameras()>n);
});

test('pause during automatic slow fetch prevents promotion; manual Next still works',async()=>{
  const h=await harness({slowIndex:1});await h.autoNext();h.get('playback').onclick();
  h.state.fetchGates.values().next().value.resolve();await flush();await flush();
  assert.equal(h.get('event-title').textContent,'Event index 0');
  await h.get('next').onclick();assert.equal(h.get('event-title').textContent,'Event index 1');
});

test('pause during camera synchronization cancels automatic promotion without losing ready scene',async()=>{
  const h=await harness();await h.warm();h.state.syncGate=deferred();await h.autoNext();
  h.get('playback').onclick();h.state.syncGate.resolve();h.state.syncGate=null;await flush();
  assert.equal(h.get('event-title').textContent,'Event index 0');
  await h.get('next').onclick();assert.equal(h.get('event-title').textContent,'Event index 1');
});

test('file metadata remains on displayed generation and newer queued file is not lost',async()=>{
  const h=await harness();h.state.catalog=manifest('b');
  const gate=deferred();h.state.fetchGates.set(`${'b'.repeat(32)}/0`,gate);
  await h.poll();const next=h.get('next').onclick();await flush();await h.frames(3);
  assert.equal(h.get('plot3d').dataset.generation,'a'.repeat(32));
  assert.ok(h.get('metadata').children.some(e=>e.textContent==='a.FLOW.hdf5'));
  h.state.catalog=manifest('c');await h.poll();gate.resolve();await next;
  assert.equal(h.get('plot3d').dataset.generation,'b'.repeat(32));assert.equal(h.get('latest').hidden,false);
  await h.get('latest').onclick();assert.equal(h.get('plot3d').dataset.generation,'c'.repeat(32));
});

test('slow projections cannot block 3D handover or show stale event data',async()=>{
  const h=await harness();h.state.projectionGate=deferred();
  h.get('projection-details').open=true;h.get('projection-details').handlers.toggle();await h.frame();
  await h.get('next').onclick();await h.frames(2);await h.get('next').onclick();await h.frames(2);
  assert.equal(h.get('event-title').textContent,'Event index 2');assert.equal(h.get('plot2d').style.visibility,'hidden');
  const n=h.cameras();await h.frames(2);assert.ok(h.cameras()>n);
  h.state.projectionGate.resolve();h.state.projectionGate=null;await flush();await h.frames(4);
  assert.equal(h.get('plot2d').dataset.eventIndex,'2');assert.equal(h.get('plot2d').style.visibility,'visible');
  assert.equal(h.calls.filter(c=>c.type==='projection-start').length,2);
});

test('failed fetch preserves event and rotation; next click retries',async()=>{
  const h=await harness({slowIndex:1});const key=`${h.state.catalog.generation}/1`;
  h.state.failures.add(key);const next=h.get('next').onclick();h.state.fetchGates.get(key).resolve();await next;
  assert.equal(h.get('event-title').textContent,'Event index 0');const n=h.cameras();await h.frames(3);assert.ok(h.cameras()>n);
  h.state.failures.clear();await h.get('next').onclick();assert.equal(h.get('event-title').textContent,'Event index 1');
});

test('failed back-scene rendering never damages the visible event',async()=>{
  const h=await harness();const front=h.get('plot3d'),oldData=copy(front.data);
  h.state.reactFailure=true;await h.get('next').onclick();
  assert.equal(h.get('plot3d'),front);assert.deepEqual(front.data,oldData);
  assert.equal(h.get('event-title').textContent,'Event index 0');
  h.state.reactFailure=false;await h.get('next').onclick();assert.equal(h.get('event-title').textContent,'Event index 1');
});

test('manual Previous supersedes warming Next without concurrent back writes',async()=>{
  const h=await harness();h.state.reactGate=deferred();await h.warm();const draws=h.sceneStarts();
  const previous=h.get('previous').onclick();await flush();assert.equal(h.sceneStarts(),draws);
  h.state.reactGate.resolve();h.state.reactGate=null;await previous;
  assert.equal(h.get('event-title').textContent,'Event index 3');
  assert.equal(h.get('plot3d').data[0].x[0],3); // Plotly x = detector z.
  assert.equal(h.get('plot3d').data[0].y[0],3); // Detector x identifies event.
});

test('immutable event requests permit HTTP cache while status/catalog remain no-store',async()=>{
  const h=await harness();assert.ok(h.fetches.length>=3);
  assert.ok(h.fetches.filter(f=>f.path.includes('/events/')).every(f=>f.cache==='default'));
  assert.ok(h.fetches.filter(f=>!f.path.includes('/events/')).every(f=>f.cache==='no-store'));
});

test('empty file clears old event/projections while preserving detector frame',async()=>{
  const h=await harness();h.get('projection-details').open=true;h.get('projection-details').handlers.toggle();await h.frames(2);
  h.state.catalog=manifest('b',0);await h.poll();await h.get('latest').onclick();await h.frames(3);
  assert.equal(h.get('event-title').textContent,'Latest FLOW contains no events');
  assert.equal(h.get('plot3d').dataset.eventIndex,undefined);assert.equal(h.get('plot3d').layout.scene.xaxis.autorange,false);
  assert.equal(h.get('plot2d').data.length,0);
});

test('buffers remain bounded at two with current colors and no foreground point redraws',async()=>{
  const h=await harness();
  for(let i=0;i<20;i++){
    await h.warm();const before=h.sceneStarts();await h.get('next').onclick();
    assert.equal(h.sceneStarts(),before);
    const front=h.get('plot3d'),back=h.get('plot3d-buffer'),iEvent=Number(front.dataset.eventIndex);
    assert.equal(front.style.opacity,'1');assert.equal(back.style.opacity,'0');assert.equal(back.inert,true);
    assert.equal(front.data[0].marker.cmax,event(iEvent).color.maximum);
    assert.deepEqual(front.data[0].marker.color,event(iEvent).color.values);
  }
  assert.equal(h.calls.filter(c=>c.type==='new').length,2);
  assert.ok(h.calls.filter(c=>c.type==='scene-start').every(c=>!c.visible));
});

test('manual camera orientation and zoom survive a pre-rendered handover',async()=>{
  const h=await harness();await h.warm();h.get('rotate').checked=false;
  const pose={eye:{x:2.7,y:-.4,z:1.3},center:{x:.1,y:-.2,z:.3},up:{x:0,y:0,z:1}};
  h.get('plot3d').handlers.plotly_relayout({'scene.camera':pose});
  await h.get('next').onclick();assert.deepEqual(h.get('plot3d').layout.scene.camera,pose);
});


test('queued newer-file warming yields to manual navigation after a shared predecessor',async()=>{
  const h=await harness();h.state.reactGate=deferred();await h.warm();
  h.state.catalog=manifest('b');await h.poll();await h.warm();
  const previous=h.get('previous').onclick();await flush();
  const draws=h.sceneStarts();
  h.state.reactGate.resolve();h.state.reactGate=null;await previous;await flush();
  assert.equal(h.sceneStarts(),draws+1,'only manual target may claim the back buffer');
  assert.equal(h.get('event-title').textContent,'Event index 3');
  assert.equal(h.get('plot3d').dataset.generation,'a'.repeat(32));
  assert.equal(h.get('latest').hidden,false,'newer catalog remains queued');
  assert.ok(h.calls.filter(c=>c.type==='scene-start').every(c=>!c.visible));
});
