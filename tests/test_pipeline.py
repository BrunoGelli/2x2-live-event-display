import hashlib
import json
import os
from pathlib import Path
import time

import numpy as np
import pytest
from fastapi.testclient import TestClient

from live2x2.cache import heartbeat, latest, publish, read_json, writer_lock
from live2x2.cli import parser
from live2x2.producer import Sampling, build, sample_indices
from live2x2.watcher import Watcher
from live2x2.web import create_app


def test_roundtrip_shuffled_refs_raw_empty_readonly(flow, tmp_path):
    before=hashlib.sha256(flow.read_bytes()).hexdigest()
    cache=tmp_path/"cache"
    with writer_lock(cache):
        result=build(flow,cache,Sampling(sample_size=60),"operator_asserted")
    assert result["sampled_events"] == 4
    assert result["total_events"] == 4
    assert result["cleaning"] == "none"
    root=cache/"generations"/result["generation"]
    e0=read_json(root/"event-0.json")
    assert e0["hits"]["Q"] == [11,-2,10]
    assert e0["event_id"] == "81"
    e1=read_json(root/"event-1.json")
    assert e1["summary"]["raw_hits"] == 0  # No silent selection of nonempty events.
    e3=read_json(root/"event-3.json")
    assert e3["summary"]["omitted_nonfinite"] == 1
    assert e3["summary"]["outside_nominal"] == 1
    assert 5000 in e3["hits"]["x"]  # Display limits never alter coordinates.
    assert hashlib.sha256(flow.read_bytes()).hexdigest() == before
    assert str(flow.parent) not in json.dumps(result)
    assert "NaN" not in (root/"event-3.json").read_text()


def test_deterministic_sample():
    values=sample_indices(1000,60,13)
    assert values==sample_indices(1000,60,13)
    assert len(values)==len(set(values))==60
    assert values!=sample_indices(1000,60,14)
    assert sample_indices(0,60,13)==[]


def test_reads_only_selected_events(flow,tmp_path):
    from ucd2x2.core.hot_pixels import EventHitReader
    from ucd2x2.core.geometry import module_boxes_cm
    calls=[]
    class Counted(EventHitReader):
        def get(self,index):
            calls.append(index)
            return super().get(index)
    with writer_lock(tmp_path/"cache"):
        build(flow,tmp_path/"cache",Sampling(sample_size=2),"asserted",
              reader_factory=Counted,boxes_factory=module_boxes_cm)
    assert len(calls)==2


def test_repeated_build_same_sample(flow,tmp_path):
    with writer_lock(tmp_path/"cache"):
        a=build(flow,tmp_path/"cache",Sampling(sample_size=2),"asserted")
        b=build(flow,tmp_path/"cache",Sampling(sample_size=2),"asserted")
    assert a["generation"]!=b["generation"]
    assert a["source_key"]==b["source_key"]
    assert a["events"]==b["events"]


def test_cap_is_not_event_selection(flow,tmp_path):
    with writer_lock(tmp_path/"cache"):
        result=build(flow,tmp_path/"cache",Sampling(sample_size=60,max_hits=1),"asserted")
    assert result["sampled_events"]==4
    assert all(e["summary"]["plotted_hits"]<=1 for e in result["events"])
    assert any(e["summary"]["sampled_hits"] for e in result["events"])


def test_failed_publish_keeps_last_good(flow,tmp_path):
    cache=tmp_path/"cache"
    with writer_lock(cache):
        good=build(flow,cache,Sampling(),"asserted")
        def bad():
            raise RuntimeError("changed source")
        with pytest.raises(RuntimeError):
            build(flow,cache,Sampling(),"asserted",final_check=bad)
    assert latest(cache)["generation"]==good["generation"]
    assert not list((cache/"generations").glob(".building-*"))


def test_single_writer(tmp_path):
    with writer_lock(tmp_path):
        with pytest.raises(RuntimeError,match="Another worker"):
            with writer_lock(tmp_path):
                pass


def test_marker_wait_and_restart(flow,tmp_path):
    cache=tmp_path/"cache"
    with writer_lock(cache):
        watcher=Watcher(flow.parent,cache,Sampling())
        assert watcher.tick(now=0) is None
        Path(str(flow)+".done").touch()
        good=watcher.tick(now=15)
        assert good["sampled_events"]==4
        assert Watcher(flow.parent,cache,Sampling()).tick(now=0) is None
        assert latest(cache)["generation"]==good["generation"]


def test_stability_waits_after_change(flow,tmp_path):
    cache=tmp_path/"cache"
    with writer_lock(cache):
        w=Watcher(flow.parent,cache,Sampling(),completion="stable",stable_seconds=30)
        assert w.tick(now=0) is None
        assert w.tick(now=29) is None
        os.utime(flow,(time.time(),time.time()+1))
        assert w.tick(now=30) is None
        assert w.tick(now=59) is None
        assert w.tick(now=61)["sampled_events"]==4


def test_watch_failure_retries_keeps_feed(flow,tmp_path):
    cache=tmp_path/"cache"
    attempts=[]
    def fail(*args,**kw):
        attempts.append(1)
        raise ValueError("private /absolute/path")
    with writer_lock(cache):
        good=build(flow,cache,Sampling(),"asserted")
        # Force a different source key through settings, not by damaging test input.
        w=Watcher(flow.parent,cache,Sampling(seed=1),builder=fail,retry_seconds=30)
        Path(str(flow)+".done").touch()
        w.tick(now=0);w.tick(now=10);w.tick(now=31)
        assert len(attempts)==2
        assert latest(cache)["generation"]==good["generation"]
        assert "/absolute/path" not in (cache/"worker.json").read_text()


def test_web_generation_pinning_privacy_and_status(flow,tmp_path):
    cache=tmp_path/"cache"
    with writer_lock(cache):
        a=build(flow,cache,Sampling(),"asserted")
        b=build(flow,cache,Sampling(),"asserted")
        heartbeat(cache,"idle")
    client=TestClient(create_app(cache))
    assert client.get("/api/catalog").json()["generation"]==b["generation"]
    assert client.get(f"/api/generations/{a['generation']}/events/0").json()["event_id"]=="81"
    assert client.get(f"/api/generations/{b['generation']}/events/100").status_code==404
    assert client.get("/api/generations/not-a-generation/events/0").status_code==404
    assert client.get("/api/file",params={"path":str(flow)}).status_code==404
    assert client.post("/api/catalog").status_code==405
    assert client.get("/api/catalog").headers["cache-control"]=="no-store"
    assert client.get("/api/status").json()["state"]=="CURRENT"
    assert str(flow.parent) not in client.get("/api/catalog").text
    # A fresh cache of old FLOW must not be presented as fresh detector data.
    a["source"]["mtime"]=time.time()-10000
    from live2x2.cache import write_json
    write_json(cache/"latest.json",a)
    assert client.get("/api/status").json()["state"]=="STALE"


def test_missing_cache_healthy_but_not_ready(tmp_path):
    client=TestClient(create_app(tmp_path))
    assert client.get("/healthz").status_code==200
    assert client.get("/readyz").status_code==503
    assert client.get("/api/status").json()["state"]=="WAITING"
    assert client.get("/api/catalog").status_code==503
    assert client.get("/").status_code==200


def test_cli_requires_completion_assertion():
    with pytest.raises(SystemExit):
        parser().parse_args(["once","file.h5","--cache","cache"])
    args=parser().parse_args(["once","file.h5","--cache","cache","--assume-complete"])
    assert args.assume_complete


@pytest.mark.parametrize("kwargs",[{"sample_size":0},{"max_hits":0},{"seed":-1},{"hit_type":"packet"}])
def test_invalid_sampling(kwargs):
    with pytest.raises(ValueError):
        Sampling(**kwargs)


def test_plot_cap_does_not_change_sample_membership(flow,tmp_path):
    with writer_lock(tmp_path/"cache"):
        a=build(flow,tmp_path/"cache",Sampling(sample_size=2,max_hits=1),"asserted")
        b=build(flow,tmp_path/"cache",Sampling(sample_size=2,max_hits=1000),"asserted")
    assert [e["event_index"] for e in a["events"]]==[e["event_index"] for e in b["events"]]


def test_zero_event_file(tmp_path):
    import h5py
    path=tmp_path/"empty.FLOW.hdf5"
    with h5py.File(path,"w") as f:
        f["charge/events/data"]=np.empty(0,dtype=[("id","i8")])
        f["charge/calib_prompt_hits/data"]=np.empty(0,dtype=[(v,"f8") for v in ("x","y","z","Q")])
        f["charge/events/ref/charge/calib_prompt_hits/ref"]=np.empty((0,2),dtype="i8")
        f["charge/events/ref/charge/calib_prompt_hits/ref_region"]=np.empty(0,dtype=[("start","i8"),("stop","i8")])
    with writer_lock(tmp_path/"cache"):
        data=build(path,tmp_path/"cache",Sampling(),"asserted")
    assert data["events"]==[] and data["total_events"]==0


def test_web_does_not_import_worker():
    import subprocess,sys
    subprocess.run([sys.executable,"-c",
        "import sys; before=set(sys.modules); from live2x2.web import create_app; create_app(); "
        "assert not {'h5py','numpy','panel','ucd2x2'} & (sys.modules.keys()-before)"],check=True)


def test_prefixed_api_route(tmp_path):
    from live2x2.demo import generate
    with writer_lock(tmp_path):
        generate(tmp_path,2)
    client=TestClient(create_app(tmp_path,root_path="/user/demo/proxy/8000"))
    assert client.get("/user/demo/proxy/8000/api/status").status_code==200
    assert client.get("/user/demo/proxy/8000/static/app.js").status_code==200


def test_newest_ready_wins_but_incomplete_newest_does_not_hide_ready(flow,tmp_path):
    cache=tmp_path/"cache"
    newer=tmp_path/"newer.FLOW.hdf5"
    newer.write_bytes(flow.read_bytes())
    base=time.time()-10
    os.utime(flow,(base,base));os.utime(newer,(base+2,base+2))
    Path(str(flow)+".done").touch()
    with writer_lock(cache):
        w=Watcher(tmp_path,cache,Sampling())
        a=w.tick(now=0)
        assert a["source"]["name"]==flow.name
        Path(str(newer)+".done").touch()
        b=w.tick(now=15)
        assert b["source"]["name"]==newer.name
