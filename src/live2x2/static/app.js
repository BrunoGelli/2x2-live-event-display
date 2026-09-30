/* Browser-only playback. One 3D plot, bounded prefetch, no camera websocket. */
"use strict";
(() => {
  const el = id => document.getElementById(id);
  const plot = el("plot3d"), projection = el("plot2d");
  const config = {responsive: true, displaylogo: false, scrollZoom: true,
    toImageButtonOptions: {format: "png", width: 1920, height: 1080, scale: 1}};
  let catalog = null, pending = null, position = -1, current = null;
  let busy = false, pollBusy = false, cycling = true, timer = null, frameId = null;
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

  async function fetchJSON(path) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(api(path), {signal: controller.signal, cache: "no-store"});
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally { clearTimeout(timeout); }
  }
  function eventData(manifest, index) {
    const key = `${manifest.generation}/${index}`;
    if (!memo.has(key)) {
      const promise = fetchJSON(`api/generations/${manifest.generation}/events/${index}`)
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
  async function render(event, manifest) {
    const hits = event.hits, g = manifest.geometry, b = g.bounds;
    const trace = {type:"scatter3d",mode:"markers",x:hits.z,y:hits.x,z:hits.y,
      marker:marker(event),customdata:hits.Q, name:"Charge hits",showlegend:false,
      hovertemplate:"z=%{x:.2f} cm<br>x=%{y:.2f} cm<br>y=%{z:.2f} cm<br>Q=%{customdata:.4g}<extra></extra>"};
    const length = a => b[a][1]-b[a][0];
    const unit = Math.max(length("x"),length("y"),length("z"));
    const axis = (a) => ({title:{text:`${a} [cm]`},range:b[a],autorange:false,
      backgroundcolor:"#f8fafc",gridcolor:"#dce4ea",showbackground:true});
    const layout = {autosize:true,margin:{l:0,r:85,t:15,b:0},paper_bgcolor:"white",
      uirevision:manifest.generation,
      scene:{xaxis:axis("z"),yaxis:axis("x"),zaxis:axis("y"),camera,
        aspectmode:"manual",aspectratio:{x:length("z")/unit,y:length("x")/unit,z:length("y")/unit}},
      annotations: event.summary.plotted_hits ? [] : [{text:"No renderable hits in this random event",xref:"paper",yref:"paper",x:.5,y:.5,showarrow:false}]};
    await cameraPromise;
    await Plotly.react(plot, [trace,...geometryTraces(g)], layout, config);
    current = event;
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
      "Charge scale":"Per event, log10(Q); input units","Geometry":g.source};
    Object.entries(rows).forEach(([key,value]) => {
      const dt=document.createElement("dt"),dd=document.createElement("dd");
      dt.textContent=key;dd.textContent=String(value);el("metadata").append(dt,dd);
    });
    plot.dataset.generation=manifest.generation;plot.dataset.eventIndex=event.event_index;
    if (el("projection-details").open) await renderProjections();
  }
  async function renderProjections() {
    if (!current || !catalog) return;
    const b=catalog.geometry.bounds,h=current.hits;
    const pairs=[["x","y"],["x","z"],["y","z"]];
    const layout={margin:{l:45,r:35,t:30,b:45},showlegend:false,autosize:true};
    const traces=pairs.map(([a,c],i) => {
      const suffix=i===0?"":String(i+1);
      layout[`xaxis${suffix}`]={title:{text:`${a} [cm]`},domain:[i/3+.02,(i+1)/3-.04],range:b[a],autorange:false,anchor:`y${suffix}`};
      layout[`yaxis${suffix}`]={title:{text:`${c} [cm]`},range:b[c],autorange:false,anchor:`x${suffix}`};
      return {type:"scattergl",mode:"markers",x:h[a],y:h[c],xaxis:`x${suffix}`,yaxis:`y${suffix}`,
        marker:marker(current,false),showlegend:false,customdata:h.Q,
        hovertemplate:`${a}=%{x:.2f}<br>${c}=%{y:.2f}<br>Q=%{customdata:.4g}<extra></extra>`};
    });
    await Plotly.react(projection,traces,layout,config);
  }
  function schedule() {
    clearTimeout(timer);
    if (cycling && !document.hidden) timer=setTimeout(() => move(1),seconds("dwell",3)*1000);
  }
  async function move(step, usePending=true) {
    if (busy) return;
    const oldCatalog=catalog,oldPosition=position;
    let switching=false;
    if (usePending && pending) { catalog=pending;pending=null;position=-1;switching=true;el("latest").hidden=true; }
    if (!catalog) { schedule();return; }
    busy=true;
    try {
      if (!catalog.events.length) {
        await Plotly.react(plot,geometryTraces(catalog.geometry),{scene:{camera},margin:{t:0}},config);
        current=null;el("event-title").textContent="Latest FLOW contains no events";
        el("event-detail").textContent=catalog.source.name;
        el("event-metrics").textContent="";el("counts").textContent="";
        note("No event rows to sample. Waiting for a newer completed file.");
        return;
      }
      position=(position+step+catalog.events.length)%catalog.events.length;
      const data=await eventData(catalog,catalog.events[position].event_index);
      await render(data,catalog);
      note(catalog.demo ? "SYNTHETIC DEMO — not detector data." :
        (serverStatus?.worker?.error_code ? "Worker reports an error; showing the last published sample." : ""));
      const next=catalog.events[(position+1)%catalog.events.length].event_index;
      eventData(catalog,next).catch(() => {}); // Bounded prefetch; failure retried on display.
    } catch (error) {
      if (switching && !pending) pending=catalog;
      catalog=oldCatalog;position=oldPosition;
      el("latest").hidden=!pending;
      note(`Cannot load next event (${error.message}); retaining the last visible event and retrying.`);
    } finally { busy=false;schedule(); }
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
        if (!catalog) await move(1);
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
    if (!current || !el("rotate").checked || busy || document.hidden || cameraBusy || now-lastDraw<1000/30) return;
    // Wall-clock angle, with at most one relayout in flight. No request pile-up.
    const elapsed=lastDraw ? Math.min(.15,(now-lastDraw)/1000) : dt;lastDraw=now;
    const angle=2*Math.PI*elapsed/seconds("turn",12);
    const eye=camera.eye,cs=Math.cos(angle),sn=Math.sin(angle);
    camera={...camera,eye:{x:eye.x*cs-eye.y*sn,y:eye.x*sn+eye.y*cs,z:eye.z}};
    cameraBusy=true;
    cameraPromise=Promise.resolve(Plotly.relayout(plot,{"scene.camera":camera})).catch(error => {
      el("rotate").checked=false;note(`Camera rotation paused: ${error.message}`);
    }).finally(() => { cameraBusy=false; });
  }
  function pauseRotation() { el("rotate").checked=false;lastDraw=0; }
  el("previous").onclick=() => move(-1,false);
  el("next").onclick=() => move(1);
  el("latest").onclick=() => move(1);
  el("playback").onclick=() => { cycling=!cycling;el("playback").textContent=cycling?"Pause cycling":"Resume cycling";
    el("playback").setAttribute("aria-pressed",String(!cycling));schedule(); };
  el("dwell").onchange=schedule;
  el("rotate").onchange=() => {lastDraw=0;};
  plot.addEventListener("pointerdown",pauseRotation);
  plot.addEventListener("wheel",pauseRotation,{passive:true});
  el("projection-details").addEventListener("toggle",() => {
    if (el("projection-details").open) renderProjections().catch(error => note(error.message));
  });
  document.addEventListener("visibilitychange",() => {lastDraw=lastFrame=0;schedule();if (!document.hidden) poll();});
  window.addEventListener("resize",() => {if(current) Plotly.Plots.resize(plot);});
  window.addEventListener("pagehide",() => {clearTimeout(timer);cancelAnimationFrame(frameId);});
  async function start() {
    if (!window.Plotly) { note("Plotly.js is missing. Run live2x2 assets before serving.");return; }
    await Plotly.newPlot(plot,[],{scene:{camera},margin:{t:0}},config);
    plot.on("plotly_relayout",event => {if (!cameraBusy && event["scene.camera"]) camera=event["scene.camera"];});
    await poll();setInterval(poll,15000);setInterval(statusLabel,1000);schedule();
    frameId=requestAnimationFrame(animation);
  }
  start().catch(error => note(`Viewer startup failed: ${error.message}`));
})();
