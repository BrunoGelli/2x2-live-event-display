"""Synthetic data for verifying web/deployment without FLOW or a detector feed."""
import math
from pathlib import Path
import time

from .cache import heartbeat, publish


def generate(cache: Path, count=60):
    # Deliberately synthetic boxes. Real geometry is supplied by the upstream reader.
    boxes = [{"module": str(i), "xmin": x, "xmax": x+57,
              "ymin": -60, "ymax": 60, "zmin": z, "zmax": z+57}
             for i, (x, z) in enumerate([(-60,-60), (-60,3), (3,-60), (3,3)])]
    catalog = dict(source_key="demo", source={"name": "SYNTHETIC DEMO (not detector data)",
                   "mtime": time.time(), "size_bytes": 0}, total_events=count,
                   hit_type="synthetic", selection={"type": "random", "requested": count},
                   cleaning="none", completion="synthetic", demo=True,
                   geometry={"units": "cm", "source": "synthetic geometry",
                             "bounds": {k: [-62, 62] for k in "xyz"}, "boxes": boxes})

    def events():
        for index in range(count):
            n = 240
            x = [-52 + 104*j/(n-1) for j in range(n)]
            y = [50*math.sin(index*.17) + .12*t for t in x]
            z = [48*math.cos(index*.25)*t/52 for t in x]
            q = [10**(1+1.5*(1+math.sin(j*.13+index))/2) for j in range(n)]
            yield dict(schema="live2x2.v1", event_index=index, event_id=str(1000+index),
                       hits=dict(x=x, y=y, z=z, Q=q),
                       color=dict(label="log10(Q), synthetic", values=[math.log10(v) for v in q],
                                  minimum=1, maximum=2.5),
                       summary=dict(raw_hits=n, renderable_hits=n, plotted_hits=n,
                                    omitted_nonfinite=0, outside_nominal=0,
                                    sampled_hits=False, finite_Q_sum=sum(q), nonfinite_Q=0))
    result = publish(cache, catalog, events())
    heartbeat(cache, "demo")
    return result
