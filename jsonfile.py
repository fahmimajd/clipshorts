"""Atomic JSON writes for files other requests read while they change.

A job's *_metadata.json is rewritten in place by the job process (after the
clips render) and by several editor endpoints, while the dashboard keeps
reading it (/transcript, /status...). `open(path, 'w')` truncates first, so a
reader landing mid-write saw half a document and the endpoint answered 500
with a JSONDecodeError.

Writing to a temp file in the same directory and `os.replace`-ing it over the
target is atomic on POSIX: a reader opens either the old file or the new one,
never a partial one.
"""
import json
import os
from uuid import uuid4


def write_json_atomic(path, data, **dump_kwargs):
    """json.dump `data` to `path` atomically. `dump_kwargs` go to json.dump.

    The temp file ends in `.tmp`, so neither the `*_metadata.json` globs nor
    the artifact uploader (.json/.mp4) ever pick it up.
    """
    path = os.path.abspath(path)
    try:
        mode = os.stat(path).st_mode & 0o777
    except FileNotFoundError:
        mode = 0o644
    tmp = os.path.join(os.path.dirname(path), f".{os.path.basename(path)}.{uuid4().hex}.tmp")
    # Set the mode at creation so mounts without chmod can still store metadata.
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(data, f, **dump_kwargs)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise
