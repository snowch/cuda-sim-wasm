"""Fetch the original Volta traces and extract the two selected workloads."""

import hashlib
from pathlib import Path
import shutil
import sys
import tarfile
from urllib.request import urlopen

URL = "https://engineering.purdue.edu/tgrogers/accel-sim/traces/tesla-v100/latest/rodinia_2.0-ft.tgz"
SHA256 = "aeb7de478785856e4ac834d12be0e71ab0df297f43fc02650e2ca90dea66d8b1"
WORKLOADS = {
    "lud": "_v__b__i___data_64_dat",
    "nw": "128_10___data_result_128_10_txt",
}


def main(work):
    archive = work / "rodinia_2.0-ft.tgz"
    if not archive.exists():
        incoming = archive.with_suffix(".partial")
        with urlopen(URL, timeout=30) as response, incoming.open("wb") as output:
            shutil.copyfileobj(response, output)
        verify(incoming)
        incoming.replace(archive)
    else:
        verify(archive)

    fixture = work / "fixture" / "hardware"
    with tarfile.open(archive, "r:gz") as traces:
        for name, case in WORKLOADS.items():
            prefix = f"./rodinia_2.0-ft/9.1/{name}-rodinia-2.0-ft/{case}/traces/"
            dest = fixture / name
            dest.mkdir(parents=True, exist_ok=True)
            for member in traces.getmembers():
                filename = member.name.removeprefix(prefix)
                if filename == member.name or "/" in filename or not member.isfile():
                    continue
                if filename == "kernelslist.g" or filename.endswith(".traceg"):
                    write_if_changed(dest / filename, traces.extractfile(member).read())

    # Keep the original input copy followed by the first recorded launch.
    launch_list = (fixture / "lud" / "kernelslist.g").read_bytes().splitlines(keepends=True)
    write_if_changed(fixture / "lud" / "first.g", b"".join(launch_list[:2]))


def verify(path):
    if hashlib.sha256(path.read_bytes()).hexdigest() != SHA256:
        raise ValueError(f"Trace archive checksum mismatch for {path}")


def write_if_changed(path, content):
    if not path.exists() or path.read_bytes() != content:
        path.write_bytes(content)


if __name__ == "__main__":
    main(Path(sys.argv[1]))
