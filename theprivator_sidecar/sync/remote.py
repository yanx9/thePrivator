"""The storage contract the sync engine talks to.

Only one backend exists today -- a directory some other program keeps in step
across machines. The Protocol is here anyway, and shaped the way it is, so that
a native Drive or S3 backend is a new class rather than a rewrite of the engine:
``expected_etag`` maps onto ``If-Match`` for anything that offers conditional
writes, and every method already reports the losing case rather than raising.

What the folder backend genuinely cannot provide, and what the engine must
therefore never assume:

* **No atomic compare-and-swap.** ``put`` checks the etag it read a moment ago,
  which narrows the window but does not close it. Two devices can still both
  believe they won.
* **No real locks.** A lock here is a file that says who is working. It has to
  be treated as advice, because the machine that wrote it may never come back.
* **No ordering.** Files arrive when the syncing client gets to them, in
  whatever order it likes, and it may leave conflicted copies behind.

Everything above is why payloads are content-addressed and immutable, and why
exactly one small file per profile is ever rewritten.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, Protocol, Sequence


@dataclass(frozen=True)
class RemoteEntry:
    """One object in the remote store.

    ``etag`` is whatever the backend can offer as "this is the version I read":
    a content hash here, an HTTP ETag elsewhere. It is never a timestamp -- see
    the note on clocks in ``folder_store``.
    """

    key: str
    size: int
    etag: str


@dataclass(frozen=True)
class RemoteHealth:
    reachable: bool
    writable: bool
    detail: str


@dataclass(frozen=True)
class WriteOutcome:
    """The result of a conditional write.

    ``ok`` false with ``current_etag`` set means someone else wrote first and
    the caller is holding a stale read. That is an ordinary, expected outcome on
    a shared folder, not an error, so it is returned rather than raised.
    """

    ok: bool
    etag: Optional[str]
    current_etag: Optional[str]


@dataclass(frozen=True)
class RemoteLock:
    """Who claims to be working on something, and since when.

    ``device_label`` is chosen by the user; the hostname never appears here.
    Releasing someone else's lock requires typing this label back, so it has to
    be something a person recognises rather than something a machine generated.
    """

    device_id: str
    device_label: str
    acquired_at: str
    nonce: str


class RemoteStore(Protocol):
    """The operations the sync engine needs from a shared location."""

    def health(self) -> RemoteHealth:
        """Report whether the location can be read and written right now."""

    def list(self, prefix: str) -> Sequence[RemoteEntry]:
        """Every object under a prefix.

        A key returned here may already be gone by the time it is read: another
        device can delete while this listing is in flight, and a syncing client
        can present a name whose contents have not arrived. Callers must treat a
        missing object as ordinary.
        """

    def get(self, key: str) -> Optional[bytes]:
        """Read one object, or None when it is absent."""

    def put(self, key: str, data: bytes, *, expected_etag: Optional[str]) -> WriteOutcome:
        """Write one object.

        ``expected_etag`` None means "only if it does not exist yet"; a value
        means "only if it still reads as this". Neither is atomic on a plain
        directory, which is why the engine keeps the contested surface to one
        small file.
        """

    def delete(self, key: str) -> bool:
        """Remove one object. False when it was not there."""

    def read_lock(self, key: str) -> Optional[RemoteLock]:
        """Read a lock claim, or None when nothing holds it."""

    def write_lock(self, key: str, lock: RemoteLock) -> bool:
        """Claim a lock. False when someone else already holds it."""

    def clear_lock(self, key: str, *, device_id: Optional[str] = None) -> bool:
        """Release a lock.

        With ``device_id`` the release only happens if that device still holds
        it, so a slow device cannot clear a claim that has since moved on.
        Without it the release is unconditional, which is what a deliberate
        takeover does after the user has confirmed the device label.
        """
