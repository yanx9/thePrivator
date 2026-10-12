"""Cross-process coordination between storage commands, servers and encryption."""
from contextlib import contextmanager
import json
import os
from pathlib import Path
from .protocol import SidecarError


def require_unsealed(root):
    path = Path(root) / 'vault.json'
    if not path.exists():
        return
    try:
        if json.loads(path.read_text()).get('phase') == 'active':
            return
    except (OSError, ValueError, AttributeError):
        pass
    raise SidecarError(code='VAULT_LOCKED', message='Unlock ThePrivator before accessing profile data.')


@contextmanager
def activity_lock(root, *, exclusive=False, check=True):
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (root / '.activity.lock').open('a+b') as handle:
        try:
            if os.name == 'nt':
                import ctypes
                import msvcrt
                from ctypes import wintypes
                class Overlapped(ctypes.Structure):
                    _fields_ = [('Internal', ctypes.c_size_t), ('InternalHigh', ctypes.c_size_t),
                                ('Offset', wintypes.DWORD), ('OffsetHigh', wintypes.DWORD), ('hEvent', wintypes.HANDLE)]
                kernel = ctypes.WinDLL('kernel32', use_last_error=True)
                kernel.LockFileEx.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.DWORD, wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(Overlapped)]
                kernel.UnlockFileEx.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(Overlapped)]
                overlapped = Overlapped()
                raw = msvcrt.get_osfhandle(handle.fileno())
                if not kernel.LockFileEx(raw, 1 | (2 if exclusive else 0), 0, 1, 0, ctypes.byref(overlapped)):
                    raise OSError('Storage is busy')
            else:
                import fcntl
                fcntl.flock(handle.fileno(), (fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH) | fcntl.LOCK_NB)
        except OSError:
            raise SidecarError(code='VAULT_BUSY', message='Data is in use by another process. Stop any independently started automation server and retry.') from None
        try:
            if check:
                require_unsealed(root)
            yield
        finally:
            if os.name == 'nt':
                kernel.UnlockFileEx(raw, 0, 1, 0, ctypes.byref(overlapped))
            else:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
