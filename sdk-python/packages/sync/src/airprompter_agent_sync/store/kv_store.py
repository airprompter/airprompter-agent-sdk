"""The storage primitive under the release datastore (T40): a key-value store with four operations every backend
already has — ``get`` (the value and an opaque version), a CONDITIONAL ``put`` (``if_absent=True``, or
``if_version=`` the version last read), ``list`` by prefix, and ``delete``. No transaction is ever asked for:
``kv_release_datastore`` orders its writes instead (``protocol/datastore-format.md``). ``airprompter-datastore-s3``,
``-postgres`` and ``-redis`` ship three adapters; ``check_kv_store`` is the suite an adapter runs against a live
backend to show it keeps the contract. The same contract as ``kvStore.ts``.

Example::

    kv = MemoryKvStore()                                  # or FileKvStore(dir), or an adapter over your backend
    kv.put("a/b.json", "{}", if_absent=True)              # True: written; False: it was already there
    entry = kv.get("a/b.json")                            # KvEntry(value, version)
    kv.put("a/b.json", "[]", if_version=entry.version)    # False when someone wrote in between
    report = check_kv_store(kv)                           # KvStoreReport(ok, passed, failures)
"""

from __future__ import annotations

import hashlib
import json
import os
import secrets
import threading
from dataclasses import dataclass, field
from typing import Callable, Optional, Protocol, Union


@dataclass(frozen=True)
class KvEntry:
    value: str
    #: Opaque: whatever the backend compares for ``if_version`` (an ETag, a row version, a content hash).
    version: str


class KvStore(Protocol):
    def get(self, key: str) -> Optional[KvEntry]: ...

    def put(self, key: str, value: str, *, if_absent: bool = False, if_version: Optional[str] = None) -> bool:
        """Write only when the condition holds (exactly one of ``if_absent`` / ``if_version``); ``False`` — never a
        raise — when it does not: someone else wrote first."""
        ...

    def list(self, prefix: str) -> list[str]:
        """Every key starting with ``prefix``, exactly (no character in it is a wildcard), in any order."""
        ...

    def delete(self, key: str) -> None:
        """Removes the key; a key that is not there is not an error."""
        ...


def check_condition(if_absent: bool, if_version: Optional[str]) -> None:
    """For adapters: exactly one condition, always — an unconditional write is not part of the contract."""
    if if_absent == (if_version is not None):
        raise ValueError("put takes exactly one condition: if_absent=True or if_version=<the version read>")


class MemoryKvStore:
    """A ``KvStore`` in memory: tests and dev loops. Versions are a counter; one lock makes every write atomic."""

    def __init__(self) -> None:
        self._entries: dict[str, KvEntry] = {}
        self._counter = 0
        self._lock = threading.Lock()

    def get(self, key: str) -> Optional[KvEntry]:
        with self._lock:
            return self._entries.get(key)

    def put(self, key: str, value: str, *, if_absent: bool = False, if_version: Optional[str] = None) -> bool:
        check_condition(if_absent, if_version)
        with self._lock:
            current = self._entries.get(key)
            if (current is not None) if if_absent else (current is None or current.version != if_version):
                return False
            self._counter += 1
            self._entries[key] = KvEntry(value, str(self._counter))
            return True

    def list(self, prefix: str) -> list[str]:
        with self._lock:
            return [key for key in self._entries if key.startswith(prefix)]

    def delete(self, key: str) -> None:
        with self._lock:
            self._entries.pop(key, None)


class FileKvStore:
    """A ``KvStore`` over a directory: a key is a relative path under it, the version is the content's SHA-256. Writes
    go to a temp file and are renamed into place, so a reader never sees half a value. The check-then-write is atomic
    within one process only: give a directory ONE writer (the puller); any number of runtimes may read it."""

    def __init__(self, directory: str) -> None:
        self.directory = directory
        self._lock = threading.Lock()

    def _path(self, key: str) -> str:
        parts = key.split("/")
        if not key or key.startswith("/") or any(part in ("", ".", "..") or "\\" in part for part in parts):
            raise ValueError(f"not a relative key: {key!r}")
        return os.path.join(self.directory, *parts)

    def get(self, key: str) -> Optional[KvEntry]:
        path = self._path(key)
        try:
            with open(path, "rb") as handle:
                data = handle.read()
        except FileNotFoundError:
            return None
        return KvEntry(data.decode("utf-8"), hashlib.sha256(data).hexdigest())

    def put(self, key: str, value: str, *, if_absent: bool = False, if_version: Optional[str] = None) -> bool:
        check_condition(if_absent, if_version)
        path = self._path(key)
        with self._lock:
            current = self.get(key)
            if (current is not None) if if_absent else (current is None or current.version != if_version):
                return False
            os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
            temp = f"{path}.{secrets.token_hex(4)}.tmp"
            fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "wb") as handle:
                handle.write(value.encode("utf-8"))
            os.replace(temp, path)
            return True

    def list(self, prefix: str) -> list[str]:
        slash = prefix.rfind("/")
        dir_part = prefix[: slash + 1] if slash != -1 else ""
        root = os.path.join(self.directory, *[p for p in dir_part.split("/") if p]) if dir_part else self.directory
        out: list[str] = []
        if not os.path.isdir(root):
            return out
        for base, _dirs, files in os.walk(root):
            for name in files:
                relative = os.path.relpath(os.path.join(base, name), root).replace(os.sep, "/")
                key = dir_part + relative
                if key.startswith(prefix) and not key.endswith(".tmp"):
                    out.append(key)
        return out

    def delete(self, key: str) -> None:
        try:
            os.remove(self._path(key))
        except FileNotFoundError:
            pass


@dataclass
class KvStoreReport:
    ok: bool
    passed: list[str] = field(default_factory=list)
    failures: list[str] = field(default_factory=list)


def check_kv_store(kv: KvStore, *, prefix: str = "airprompter-kv-check/", large_value_bytes: int = 512 * 1024, racers: int = 8, glob_characters: bool = True) -> KvStoreReport:
    """The contract every ``KvStore`` must keep, run against a live backend: conditional writes (absent, version,
    stale version, absent key), exact prefix listing (no ``%``, ``_``, ``*``, ``?`` or ``[`` is a wildcard), round
    trips of non-ASCII and large values, deletes, and racing writers on threads — of N concurrent ``if_absent`` puts,
    or N puts on one version, exactly one wins. Writes only under a random sub-prefix of ``prefix`` and removes it.
    ``glob_characters=False`` for a store over a Windows filesystem, which cannot name a file ``*``, ``?`` or ``[``."""
    root = f"{prefix}{secrets.token_hex(6)}/"
    passed: list[str] = []
    failures: list[str] = []
    written: set[str] = set()

    def check(name: str, body: Callable[[], Union[bool, str]]) -> None:
        try:
            result = body()
        except Exception as error:  # noqa: BLE001 — a raise is a failure of the contract, reported, never propagated
            failures.append(f"{name}: raised {error!r}")
            return
        if result is True:
            passed.append(name)
        else:
            failures.append(name if result is False else f"{name}: {result}")

    def put(key: str, value: str, **condition: object) -> bool:
        written.add(key)
        return kv.put(key, value, **condition)  # type: ignore[arg-type]

    a = f"{root}a.json"
    state: dict[str, Optional[KvEntry]] = {}
    check("get of a missing key is None", lambda: kv.get(a) is None)
    check("if_absent writes a missing key", lambda: put(a, "one", if_absent=True) is True)

    def read_first() -> Union[bool, str]:
        state["first"] = kv.get(a)
        first = state["first"]
        return True if first is not None and first.value == "one" and isinstance(first.version, str) and first.version else repr(first)

    check("get returns the value and a version", read_first)
    check("if_absent refuses a present key and leaves it", lambda: put(a, "two", if_absent=True) is False and kv.get(a).value == "one")  # type: ignore[union-attr]

    def cas() -> Union[bool, str]:
        wrote = put(a, "three", if_version=state["first"].version)  # type: ignore[union-attr]
        state["second"] = kv.get(a)
        second = state["second"]
        return True if wrote and second is not None and second.value == "three" and second.version != state["first"].version else repr(second)  # type: ignore[union-attr]

    check("if_version writes on the version read, and the version changes", cas)
    check("if_version refuses a stale version and leaves the value", lambda: put(a, "four", if_version=state["first"].version) is False and kv.get(a).value == "three")  # type: ignore[union-attr]
    check("if_version refuses a missing key", lambda: put(f"{root}missing.json", "x", if_version=(state.get("second") or KvEntry("", "1")).version) is False and kv.get(f"{root}missing.json") is None)

    specials = ("a%b", "a*b", "a?b", "a[b]") if glob_characters else ("a%b",)
    listed = [f"{root}l/a_b/1.json", f"{root}l/a_b/2.json", f"{root}l/aXb/1.json", *(f"{root}l/{special}/1.json" for special in specials), f"{root}l/a_b-other.json"]
    for key in listed:
        put(key, "{}", if_absent=True)

    def exact_list() -> Union[bool, str]:
        got = sorted(kv.list(f"{root}l/a_b/"))
        return True if got == [f"{root}l/a_b/1.json", f"{root}l/a_b/2.json"] else repr(got)

    def no_wildcards() -> Union[bool, str]:
        for special in specials:
            got = kv.list(f"{root}l/{special}/")
            if got != [f"{root}l/{special}/1.json"]:
                return f"{special}: {got!r}"
        return True

    check("list returns exactly the keys under a prefix", exact_list)
    check("no character in a prefix is a wildcard", no_wildcards)
    check("list of an empty prefix is empty", lambda: kv.list(f"{root}nothing/") == [])

    def utf8() -> bool:
        value = json.dumps({"text": "zürich — 東京 — 🚀", "nul": "a\u0000b"}, ensure_ascii=False)
        put(f"{root}utf8.json", value, if_absent=True)
        entry = kv.get(f"{root}utf8.json")
        return entry is not None and entry.value == value

    def large() -> bool:
        value = "x" * large_value_bytes
        put(f"{root}large.json", value, if_absent=True)
        entry = kv.get(f"{root}large.json")
        return entry is not None and entry.value == value

    check("non-ASCII values round-trip", utf8)
    check("large values round-trip", large)

    def race(key: str, condition_of: Callable[[int], dict[str, object]]) -> Union[bool, str]:
        results: list[Optional[bool]] = [None] * racers
        barrier = threading.Barrier(racers)

        def racer(i: int) -> None:
            barrier.wait()
            results[i] = kv.put(key, f"racer-{i}", **condition_of(i))  # type: ignore[arg-type]

        threads = [threading.Thread(target=racer, args=(i,)) for i in range(racers)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        winners = [i for i, result in enumerate(results) if result]
        entry = kv.get(key)
        return True if len(winners) == 1 and entry is not None and entry.value == f"racer-{winners[0]}" else f"{len(winners)} winners, value {entry.value if entry else None!r}"

    race_absent = f"{root}race-absent.json"
    written.add(race_absent)
    check(f"of {racers} racing if_absent writes exactly one wins", lambda: race(race_absent, lambda _i: {"if_absent": True}))

    def race_on_version() -> Union[bool, str]:
        key = f"{root}race-version.json"
        put(key, "base", if_absent=True)
        base = kv.get(key)
        assert base is not None
        return race(key, lambda _i: {"if_version": base.version})

    check(f"of {racers} racing writes on one version exactly one wins", race_on_version)

    def deletes() -> bool:
        kv.delete(a)
        kv.delete(f"{root}never-written.json")
        return kv.get(a) is None and a not in kv.list(root)

    check("delete removes a key; deleting a missing key is not an error", deletes)
    check("a deleted key can be written with if_absent again", lambda: put(a, "again", if_absent=True) is True)
    for key in written:
        try:
            kv.delete(key)
        except Exception:  # noqa: BLE001
            pass
    check("everything written is gone", lambda: True if kv.list(root) == [] else repr(kv.list(root)))
    return KvStoreReport(ok=not failures, passed=passed, failures=failures)
