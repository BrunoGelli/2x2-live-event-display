import h5py
import numpy as np
import pytest


@pytest.fixture
def flow(tmp_path):
    """Shuffled, noncontiguous event refs with a genuine empty event."""
    path = tmp_path / "example.FLOW.hdf5"
    hits = np.zeros(9, dtype=[(x, "f8") for x in ("x", "y", "z", "Q")])
    hits["x"], hits["y"], hits["z"] = 20, 15, 25
    hits["Q"] = [-2, 0, 1, 10, 100, 1000, 5, 7, 11]
    hits["x"][6] = 5000
    hits["Q"][7] = np.nan
    regions = np.array([(0,3),(3,3),(3,5),(5,8)], dtype=[("start","i8"),("stop","i8")])
    pairs = np.array([[0,8],[0,0],[0,3],[2,5],[2,2],[3,7],[3,6],[3,4]], dtype="i8")
    with h5py.File(path, "w") as f:
        f["charge/events/data"] = np.array([(81,),(92,),(900,),(104,)],dtype=[("id","i8")])
        f["charge/calib_prompt_hits/data"] = hits
        base="charge/events/ref/charge/calib_prompt_hits"
        f[base+"/ref"] = pairs
        f[base+"/ref_region"] = regions
    return path
