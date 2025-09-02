"""Utilities for downloading and serving User-Agent strings."""

from __future__ import annotations

import json
import random
import ssl
import threading
import time
from typing import Callable, List, Optional
from urllib.request import Request, urlopen

UA_LIST_URL = "https://jnrbsn.github.io/user-agents/user-agents.json"

# Simple in-memory cache with TTL
_UA_CACHE: List[str] = []
_LAST_FETCH: float = 0.0
_TTL_SECONDS: int = 24 * 60 * 60  # 24 hours


def _download_user_agents(timeout: float = 12.0) -> List[str]:
    """Fetches the UA list from the internet."""
    req = Request(UA_LIST_URL, headers={"User-Agent": "thePrivator/2.0"})
    ctx = ssl.create_default_context()
    with urlopen(req, timeout=timeout, context=ctx) as resp:
        raw = resp.read()
    data = json.loads(raw.decode("utf-8", "ignore"))
    uas = [s.strip() for s in data if isinstance(s, str) and s.strip()]
    # De-duplicate while preserving order
    return list(dict.fromkeys(uas))


def get_user_agents(force_refresh: bool = False, timeout: float = 12.0) -> List[str]:
    """Returns a cached list of UAs (fetches if empty/expired or force_refresh)."""
    global _UA_CACHE, _LAST_FETCH
    now = time.time()
    if not force_refresh and _UA_CACHE and (now - _LAST_FETCH) < _TTL_SECONDS:
        return _UA_CACHE.copy()

    try:
        uas = _download_user_agents(timeout=timeout)
        _UA_CACHE = uas
        _LAST_FETCH = now
    except Exception:
        # If download fails, return what we have (possibly empty).
        pass
    return _UA_CACHE.copy()


def get_random_user_agent(force_refresh: bool = False, timeout: float = 12.0) -> Optional[str]:
    """Returns a random UA from the cache (fetches if needed)."""
    uas = get_user_agents(force_refresh=force_refresh, timeout=timeout)
    return random.choice(uas) if uas else None


def get_user_agents_async(
    callback: Callable[[List[str]], None],
    *,
    force_refresh: bool = False,
    timeout: float = 12.0,
) -> threading.Thread:
    """
    Fetches UAs in a background thread and calls `callback(list_of_uas)` when done.
    Returns the Thread (already started).
    """
    def worker():
        result = get_user_agents(force_refresh=force_refresh, timeout=timeout)
        try:
            callback(result)
        except Exception:
            # Don't let callback exceptions kill the thread
            pass

    t = threading.Thread(target=worker, daemon=True)
    t.start()
    return t
