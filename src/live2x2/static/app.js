/* Browser-only playback. Two reusable 3D buffers, bounded prefetch, no camera websocket. */
"use strict";
(() => {
  const el = id => document.getElementById(id);
  let plot = el("plot3d"), spare = el("plot3d-buffer");
  const projection = el("plot2d");
  const sceneNodes = [plot, spare];
  let prepared = null, warmTimer = null, viewportEpoch = 0;
  // Exactly two scenes, not one scene per event. A prepared back scene has its
  // own hit buffers/colorbar; promotion changes visibility and camera only.
  const config = {responsive: true, displaylogo: false, scrollZoom: true,
    toImageButtonOptions: {format: "png", width: 1920, height: 1080, scale: 1}};
  let catalog = null, pending = null, position = -1, current = null;
  // A pending navigation must not stop the OLD event's camera while fetching.
  // Only plotBusy excludes camera writes during the actual 3D commit.
  let navigationBusy = false, plotBusy = false, pollBusy = false;
  let cycling = true, timer = null, frameId = null;
  let projectionRequest = null, projectionRunning = false;
  let cameraBusy = false, cameraPromise = Promise.resolve(), lastFrame = 0, lastDraw = 0;
  let camera = {eye: {x: 1.45, y: 1.15, z: .8}, center: {x:0,y:0,z:0}, up: {x:0,y:0,z:1}};
  let serverStatus = null, statusAt = 0, offline = false;
  const memo = new Map();
  const api = path => new URL(path, document.baseURI);
  const number = (n, digits=0) => n == null ? "—" : Number(n).toLocaleString(undefined, {maximumFractionDigits:digits});
  const seconds = (id, fallback) => {
    const v = Number(el(id).value);
    return Number.isFinite(v) && v > 0 ? Math.max(Number(el(id).min), Math.min(Number(el(id).max), v)) : fallback;
  };
  const age = s => s < 60 ? `${Math.floor(s)} s` : `${Math.floor(s/60)}m ${Math.floor(s%60)}s`;

  async function fetchJSON(path, immutable=false) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(api(path), {
        signal: controller.signal, cache: immutable ? "default" : "no-store"
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally { clearTimeout(timeout); }
  }
  function eventData(manifest, index) {
    const key = `${manifest.generation}/${index}`;
    if (!memo.has(key)) {
      const promise = fetchJSON(`api/generations/${manifest.generation}/events/${index}`, true)
        .catch(error => { memo.delete(key); throw error; });
      memo.set(key, promise);
      while (memo.size > 3) memo.delete(memo.keys().next().value);
    }
    return memo.get(key);
  }
  function note(text) { el("notice").textContent = text; }
  function statusLabel() {
    if (!serverStatus) return;
    const extra = (performance.now() - statusAt) / 1000;
    const displayedAge = catalog ? Math.max(0,serverStatus.server_time+extra-catalog.source.mtime) : serverStatus.file_age_seconds;
    const state = offline ? "OFFLINE" : catalog?.demo ? "DEMO" : displayedAge != null &&
      displayedAge > serverStatus.stale_after_seconds ? "STALE" : serverStatus.state;
    el("feed-state").textContent = state;
    el("feed-state").dataset.state = state;
    el("feed-age").textContent = displayedAge == null ? "No published FLOW file" : `Displayed FLOW age ${age(displayedAge)}`;
    if (pending) el("feed-age").textContent += " · newer file queued";
    if (!offline && serverStatus.worker_stale && state !== "DEMO") {
      el("feed-age").textContent += " · worker heartbeat overdue";
    }
  }
  function geometryTraces(g) {
    const edges = [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]];
    return g.boxes.map(b => {
      const v = [[b.xmin,b.ymin,b.zmin],[b.xmax,b.ymin,b.zmin],
        [b.xmax,b.ymax,b.zmin],[b.xmin,b.ymax,b.zmin],
        [b.xmin,b.ymin,b.zmax],[b.xmax,b.ymin,b.zmax],
        [b.xmax,b.ymax,b.zmax],[b.xmin,b.ymax,b.zmax]];
      const x=[],y=[],z=[];
      edges.forEach(([i,j]) => { x.push(v[i][2],v[j][2],null); y.push(v[i][0],v[j][0],null); z.push(v[i][1],v[j][1],null); });
      return {type:"scatter3d", mode:"lines", x,y,z, line:{color:"#8395a5",width:2},
        name:`Module ${b.module}`, showlegend:false, hoverinfo:"skip"};
    });
  }
  function marker(event, showscale=true) {
    return {size:3, color:event.color.values, colorscale:"Viridis", showscale,
      cauto:false, cmin:event.color.minimum, cmax:event.color.maximum,
      colorbar:{title:{text:"log10(Q)"},thickness:14,len:.58}};
  }
  function stageKey(manifest, nextPosition) {
    return `${manifest.generation}/${nextPosition < 0 ? "empty" : manifest.events[nextPosition].event_index}`;
  }
  async function prepareScene(manifest, nextPosition, background=false) {
    const key=stageKey(manifest,nextPosition);
    // Multiple newer catalogs can queue while a slow preparation is in flight.
    // Re-check after EVERY await; manual navigation owns the next promotion.
    for (;;) {
      if (background && (navigationBusy || document.hidden)) return null;
      const predecessor=prepared;
      if (!predecessor) break;
      if (predecessor.key===key && predecessor.slot===spare) return predecessor.promise;
      await predecessor.promise.catch(() => {});
      if (background && (navigationBusy || document.hidden)) return null;
      if (prepared===predecessor) { prepared=null; break; }
    }
    const job={key,manifest,nextPosition,slot:spare,ready:false};
    prepared=job;
    job.promise=(async() => {
      const fetchStart=performance.now();
      job.event=nextPosition<0 ? null : await eventData(manifest,manifest.events[nextPosition].event_index);
      job.fetchMs=performance.now()-fetchStart;
      if (job.slot===plot) throw new Error("Refusing to redraw the visible scene during preparation");
      const layout=baseLayout(manifest);
      const event=job.event;
      const traces=geometryTraces(manifest.geometry);
      if (event) {
        const h=event.hits;
        traces.unshift({type:"scatter3d",mode:"markers",x:h.z,y:h.x,z:h.y,
          marker:marker(event),customdata:h.Q,name:"Charge hits",showlegend:false,
          hovertemplate:"z=%{x:.2f} cm<br>x=%{y:.2f} cm<br>y=%{z:.2f} cm<br>Q=%{customdata:.4g}<extra></extra>"});
      }
      layout.annotations = event?.summary.plotted_hits ? [] : [{
        text:event ? "No renderable hits in this random event" : "This completed FLOW file contains no event rows",
        xref:"paper",yref:"paper",x:.5,y:.5,showarrow:false
      }];
      job.epoch=viewportEpoch;
      job.slot.dataset.preparedReady="false";
      const start=performance.now();
      await Plotly.react(job.slot,traces,layout,config);
      job.prepareMs=performance.now()-start;
      job.ready=true;
      job.slot.dataset.preparedReady="true";
      job.slot.dataset.preparedKey=key;
      return job;
    })().catch(error => {
      if (prepared===job) prepared=null;
      throw error;
    });
    return job.promise;
  }
  function scheduleWarm() {
    clearTimeout(warmTimer);
    // Let the committed event paint before preparing another WebGL scene.
    // Plotly's work still shares the main thread; this is not a worker renderer.
    warmTimer=setTimeout(() => {
      if (navigationBusy || document.hidden || !catalog) return;
      const target=pending || catalog;
      const nextPosition=target.events.length ?
        (target.generation!==catalog.generation ? 0 : (position+1)%target.events.length) : -1;
      if (!target.events.length && target===catalog) return;
      prepareScene(target,nextPosition,true).catch(error => {
        console.warn("live2x2 next-scene preparation; retry on navigation",error);
      });
    },200);
  }
  async function commit3D(job, automatic=false) {
    if (job.slot!==spare || !job.ready) throw new Error("Prepared scene is no longer the back buffer");
    // Resizing a ready back scene happens while the old scene can still rotate.
    if (job.epoch!==viewportEpoch) {
      await Plotly.Plots.resize(job.slot);
      job.epoch=viewportEpoch;
    }
    plotBusy=true;
    const waitStart=performance.now();
    try {
      await cameraPromise;
      if (automatic && (!cycling || document.hidden)) return null;
      const swapStart=performance.now();
      // Synchronize the already-rendered scene to the LAST visible pose. Never
      // reset to the orientation used when pre-rendering several seconds ago.
      const pose={eye:{...camera.eye},center:{...camera.center},up:{...camera.up}};
      await Plotly.relayout(job.slot,{"scene.camera":pose});
      if (automatic && (!cycling || document.hidden)) return null;
      // No crossfade/morph: unrelated detector events must not be blended.
      const old=plot;
      plot=job.slot;
      spare=old;
      spare.id="plot3d-buffer";
      plot.id="plot3d";
      spare.style.opacity="0";
      spare.style.pointerEvents="none";
      spare.setAttribute("aria-hidden","true");spare.inert=true;
      plot.style.opacity="1";
      plot.style.pointerEvents="auto";
      plot.setAttribute("aria-hidden","false");plot.inert=false;
      if (prepared===job) prepared=null;
      return {camera_wait_ms:swapStart-waitStart,plot_ms:performance.now()-swapStart,
        prepare_ms:job.prepareMs,pre_rendered:job.preRendered};
    } finally {
      plotBusy=false;
      lastDraw=lastFrame=0;
    }
  }
  function baseLayout(manifest) {
    const b = manifest.geometry.bounds;
    const length = a => b[a][1]-b[a][0];
    const unit = Math.max(length("x"),length("y"),length("z"));
    const axis = a => ({title:{text:`${a} [cm]`},range:b[a],autorange:false,
      backgroundcolor:"#f8fafc",gridcolor:"#dce4ea",showbackground:true});
    return {autosize:true,margin:{l:0,r:85,t:15,b:0},paper_bgcolor:"white",
      uirevision:manifest.generation,
      scene:{xaxis:axis("z"),yaxis:axis("x"),zaxis:axis("y"),camera,
        aspectmode:"manual",aspectratio:{x:length("z")/unit,y:length("x")/unit,z:length("y")/unit}}};
  }
  async function render(job, automatic) {
    const {event,manifest,nextPosition,fetchMs}=job;
    const g=manifest.geometry;
    const timing=await commit3D(job,automatic);
    if (!timing) return false;
    // Commit visible state only after Plotly succeeds; a fetch failure/slow fetch
    // must not change the filename, file age, position or projections underneath it.
    current = event;
    catalog = manifest;
    position = nextPosition;
    const s = event.summary;
    el("event-title").textContent = `Event index ${event.event_index}`;
    el("event-detail").textContent = `ID ${event.event_id} · ${position+1} / ${manifest.sampled_events} sampled · ${manifest.hit_type} hits`;
    el("event-metrics").textContent = `${number(s.raw_hits)} raw hits · ΣQ ${number(s.finite_Q_sum,2)}`;
    el("counts").textContent = `Plotted ${number(s.plotted_hits)} / ${number(s.renderable_hits)} finite hits` +
      ` · ${number(s.omitted_nonfinite)} nonfinite omitted · ${number(s.outside_nominal)} finite hits outside nominal module boxes` +
      (s.sampled_hits ? " · DISPLAY SUBSAMPLE (not an event-selection cut)" : "");
    el("metadata").replaceChildren();
    const rows = {"FLOW filename":manifest.source.name,"FLOW modified":new Date(manifest.source.mtime*1000).toISOString(),
      "Cache published":new Date(manifest.published_at*1000).toISOString(),"Generation":manifest.generation,
      "File event count":manifest.total_events,"Sampling":"Uniform event rows without replacement",
      "Cleaning":"None (raw calibrated hits)","Completion evidence":manifest.completion,
      "Charge scale":"Per event, log10(Q); input units","Geometry":g.source,
      "Transition mode":"Two-scene pre-rendered handover",
      "Next scene ready at navigation":timing.pre_rendered ? "Yes" : "No; prepared while old event remained visible",
      "Last transition (ms)":`Fetch ${number(fetchMs,1)} · preparation ${number(timing.prepare_ms,1)} · camera settle ${number(timing.camera_wait_ms,1)} · handover ${number(timing.plot_ms,1)}`};
    Object.entries(rows).forEach(([key,value]) => {
      const dt=document.createElement("dt"),dd=document.createElement("dd");
      dt.textContent=key;dd.textContent=String(value);el("metadata").append(dt,dd);
    });
    plot.dataset.generation=manifest.generation;plot.dataset.eventIndex=event.event_index;
    plot.dataset.fetchMs=String(fetchMs);
    plot.dataset.renderMs=String(timing.plot_ms);
    plot.dataset.prepareMs=String(timing.prepare_ms);
    plot.dataset.preRendered=String(timing.pre_rendered);
    requestProjections(); // Never extend the 3D lock/dwell with a projection draw.
    return true;
  }
  async function renderProjections(event, manifest) {
    const b=manifest.geometry.bounds,h=event.hits;
    const pairs=[["x","y"],["x","z"],["y","z"]];
    const layout={margin:{l:45,r:35,t:30,b:45},showlegend:false,autosize:true};
    const traces=pairs.map(([a,c],i) => {
      const suffix=i===0?"":String(i+1);
      layout[`xaxis${suffix}`]={title:{text:`${a} [cm]`},domain:[i/3+.02,(i+1)/3-.04],range:b[a],autorange:false,anchor:`y${suffix}`};
      layout[`yaxis${suffix}`]={title:{text:`${c} [cm]`},range:b[c],autorange:false,anchor:`x${suffix}`};
      return {type:"scattergl",mode:"markers",x:h[a],y:h[c],xaxis:`x${suffix}`,yaxis:`y${suffix}`,
        marker:marker(event,false),showlegend:false,customdata:h.Q,
        hovertemplate:`${a}=%{x:.2f}<br>${c}=%{y:.2f}<br>Q=%{customdata:.4g}<extra></extra>`};
    });
    await Plotly.react(projection,traces,layout,config);
  }
  function requestProjections() {
    if (!el("projection-details").open) { projectionRequest=null; return; }
    // Preserve container dimensions, but never show an old event under new labels.
    projection.style.visibility="hidden";
    el("projection-status").textContent=current ? "Updating projections…" : "No event to project.";
    projectionRequest={event:current,manifest:catalog};
    if (!projectionRunning) void drainProjections();
  }
  async function drainProjections() {
    projectionRunning=true;
    try {
      while (projectionRequest) {
        const request=projectionRequest;
        projectionRequest=null;
        const matches=() => request.event===current && request.manifest===catalog && el("projection-details").open;
        try {
          // Yield so the new 3D view and event labels can be painted first.
          await new Promise(resolve => requestAnimationFrame(resolve));
          if (!matches()) continue;
          if (!request.event) { Plotly.purge(projection); continue; }
          await renderProjections(request.event,request.manifest);
          if (matches()) {
            projection.dataset.eventIndex=String(request.event.event_index);
            projection.dataset.generation=request.manifest.generation;
            projection.style.visibility="visible";
            el("projection-status").textContent="";
          }
        } catch (error) {
          if (matches()) {
            el("projection-status").textContent=`Projection update failed: ${error.message}. See the browser console; 3D playback continues.`;
            console.error("live2x2 projections",error);
          }
        }
      }
    } finally { projectionRunning=false; }
  }
  function schedule() {
    clearTimeout(timer);
    if (cycling && !document.hidden && !navigationBusy) {
      timer=setTimeout(() => move(1,{automatic:true}),seconds("dwell",3)*1000);
    }
  }
  async function move(step, {usePending=true, automatic=false}={}) {
    if (navigationBusy) return;
    clearTimeout(timer);
    clearTimeout(warmTimer);
    const target=(usePending && pending) || catalog;
    if (!target) { schedule(); return; }
    const switching=target.generation!==catalog?.generation;
    const nextPosition=target.events.length ?
      (switching ? 0 : (position+step+target.events.length)%target.events.length) : -1;
    navigationBusy=true; // Guards duplicate Next clicks, NOT the camera.
    try {
      const preRendered=prepared?.key===stageKey(target,nextPosition) && prepared.ready && prepared.slot===spare;
      const job=await prepareScene(target,nextPosition);
      job.preRendered=Boolean(preRendered);
      const data=job.event;
      // Pausing during a slow automatic fetch means stay on the inspected event.
      // The already-prefetched payload remains usable on manual Next or Resume.
      if (automatic && (!cycling || document.hidden)) return;
      if (!data) {
        if (!await commit3D(job,automatic)) return;
        catalog=target;position=-1;current=null;
        el("event-title").textContent="Latest FLOW contains no events";
        el("event-detail").textContent=target.source.name;
        el("event-metrics").textContent="";el("counts").textContent="";
        el("metadata").replaceChildren();
        delete plot.dataset.eventIndex;
        plot.dataset.generation=target.generation;
        requestProjections();
        note("No event rows to sample. Waiting for a newer completed file.");
      } else {
        if (!await render(job,automatic)) return;
        note(target.demo ? "SYNTHETIC DEMO — not detector data." :
          (serverStatus?.worker?.error_code ? "Worker reports an error; showing the last published sample." : ""));
        const next=target.events[(nextPosition+1)%target.events.length].event_index;
        eventData(target,next).catch(() => {});
      }
      // A still-newer catalog can arrive during this fetch. Do not discard it.
      if (pending?.generation===target.generation) pending=null;
      el("latest").hidden=!pending;
      statusLabel();
    } catch (error) {
      el("latest").hidden=!pending;
      note(`Cannot load next event (${error.message}); keeping the current event and retrying.`);
    } finally { navigationBusy=false; schedule(); scheduleWarm(); }
  }
  async function poll() {
    if (pollBusy) return;
    pollBusy=true;
    try {
      serverStatus=await fetchJSON("api/status");statusAt=performance.now();offline=false;statusLabel();
      if (serverStatus.generation && serverStatus.generation!==catalog?.generation && serverStatus.generation!==pending?.generation) {
        const candidate=await fetchJSON("api/catalog");
        if (candidate.schema!=="live2x2.v1") throw new Error("Unsupported cache schema");
        pending=candidate;el("latest").hidden=false;
        if (candidate.events.length) eventData(candidate,candidate.events[0].event_index).catch(() => {});
        if (!catalog) await move(1);
        else if (!navigationBusy) scheduleWarm();
      }
    } catch (error) {
      offline=true;
      if (!serverStatus) serverStatus={state:"OFFLINE",file_age_seconds:null};
      statusLabel();note(`Cache service unavailable (${error.message}); keeping the current event.`);
    } finally { pollBusy=false; }
  }
  function animation(now) {
    frameId=requestAnimationFrame(animation);
    const dt=lastFrame ? Math.min(.1,(now-lastFrame)/1000) : 0;lastFrame=now;
    if (!current || !el("rotate").checked || plotBusy || document.hidden || cameraBusy || now-lastDraw<1000/30) return;
    // Wall-clock angle, with at most one relayout in flight. No request pile-up.
    const elapsed=lastDraw ? Math.min(.15,(now-lastDraw)/1000) : dt;lastDraw=now;
    const angle=2*Math.PI*elapsed/seconds("turn",12);
    const eye=camera.eye,cs=Math.cos(angle),sn=Math.sin(angle);
    camera={...camera,eye:{x:eye.x*cs-eye.y*sn,y:eye.x*sn+eye.y*cs,z:eye.z}};
    cameraBusy=true;
    cameraPromise=Promise.resolve().then(() => Plotly.relayout(plot,{"scene.camera":camera})).catch(error => {
      el("rotate").checked=false;note(`Camera rotation paused: ${error.message}`);
    }).finally(() => { cameraBusy=false; });
  }
  function pauseRotation() { el("rotate").checked=false;lastDraw=0; }
  el("previous").onclick=() => move(-1,{usePending:false});
  el("next").onclick=() => move(1);
  el("latest").onclick=() => move(1);
  el("playback").onclick=() => { cycling=!cycling;el("playback").textContent=cycling?"Pause cycling":"Resume cycling";
    el("playback").setAttribute("aria-pressed",String(!cycling));schedule(); };
  el("dwell").onchange=schedule;
  el("rotate").onchange=() => {lastDraw=0;};
  for (const node of sceneNodes) {
    node.addEventListener("pointerdown",() => {if (node===plot) pauseRotation();});
    node.addEventListener("wheel",() => {if (node===plot) pauseRotation();},{passive:true});
  }
  el("projection-details").addEventListener("toggle",requestProjections);
  document.addEventListener("visibilitychange",() => {
    lastDraw=lastFrame=0;schedule();
    if (!document.hidden) {poll();scheduleWarm();}
    else clearTimeout(warmTimer);
  });
  window.addEventListener("resize",() => {
    viewportEpoch++;
    if (current && !plotBusy && !cameraBusy) Plotly.Plots.resize(plot);
  });
  window.addEventListener("pagehide",() => {clearTimeout(timer);clearTimeout(warmTimer);cancelAnimationFrame(frameId);});
  async function start() {
    if (!window.Plotly) { note("Plotly.js is missing. Run live2x2 assets before serving.");return; }
    for (const node of sceneNodes) {
      await Plotly.newPlot(node,[],{scene:{camera},margin:{t:0}},config);
      node.on("plotly_relayout",event => {
        if (node===plot && !cameraBusy && !plotBusy && event["scene.camera"]) camera=event["scene.camera"];
      });
    }
    spare.style.opacity="0";spare.style.pointerEvents="none";
    spare.setAttribute("aria-hidden","true");spare.inert=true;
    await poll();setInterval(poll,15000);setInterval(statusLabel,1000);schedule();
    frameId=requestAnimationFrame(animation);
  }
  start().catch(error => note(`Viewer startup failed: ${error.message}`));
})();
