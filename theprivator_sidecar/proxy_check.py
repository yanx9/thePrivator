"""Profile-scoped proxy check contract for visible S04 proxy proof flows.

The check is deliberately honest about its proof boundary.  It reuses the S02
sidecar-managed local proxy fixture to prove route behavior without contacting
unstable public IP checker services, and it reports external checker pages as
advisory guidance only.  Public payloads are exact, bounded, and redacted for
React/TypeScript consumers.
"""

from __future__ import annotations

import json
import math
import ipaddress
import socket
import threading
from pathlib import Path
from typing import Any, Mapping, Sequence, Union
from urllib.parse import quote

import requests

from .profiles import ProfileStore
from .protocol import JsonObject, PROXY_PROOF_FAILED, SidecarError
from .proxy import (
    CREDENTIAL_STATE_NONE,
    DIRECT_PROXY_MODE,
    FIXED_SERVER_PROXY_MODE,
    PROXY_VERSION,
    normalize_proxy_config,
    public_proxy_summary,
)
from .proxy_proof import PROXY_PROOF_SCHEMA_VERSION, collect_proxy_proof
from .proxy_runtime import build_proxy_runtime_plan

PROXY_CHECK_VERSION = 1
PROXY_CHECK_SCOPE_LOCAL_FIXTURE = "sidecar-managed-local-fixture"
PROXY_CHECK_PUBLIC_CHECKER_STATUS = "advisory-only"
PROXY_CHECK_TIMEOUT_SECONDS = 5.0
# Longest possible textual IPv6 address, including a zone id. Kept under the
# TypeScript client's 64-character bound for this field.
MAX_PUBLIC_EXIT_IP_LENGTH = 45
_PUBLIC_EXIT_LOOKUP_HOST = "ip-api.com"
_PUBLIC_EXIT_LOOKUP_PATH = "/json/?fields=status,message,query,country,regionName,city,timezone,isp"
_PUBLIC_EXIT_LOOKUP_URL = f"http://{_PUBLIC_EXIT_LOOKUP_HOST}{_PUBLIC_EXIT_LOOKUP_PATH}"

_ROUTE_PROOF_KEYS = frozenset(
    {
        "status",
        "basis",
        "scope",
        "protocol",
        "credentialState",
        "durationMs",
        "fixture",
        "target",
        "directFallbackDetected",
        "observationCounts",
    }
)
_IP_HIDING_KEYS = frozenset(
    {
        "status",
        "basis",
        "scope",
        "publicExitIpClaimed",
        "publicExitIp",
        "publicExitLocation",
        "localFixtureConclusion",
    }
)
_PUBLIC_EXIT_LOCATION_KEYS = frozenset({"country", "region", "city", "timezone", "isp"})
_WEBRTC_KEYS = frozenset({"status", "basis", "mode", "policy", "localIpExposure"})
_PUBLIC_CHECKERS_KEYS = frozenset({"status", "basis", "networkDependency", "pages"})
_PUBLIC_CHECKER_PAGE_KEYS = frozenset({"id", "label", "url", "surfaces", "advisory"})
_PUBLIC_RESULT_KEYS = frozenset(
    {
        "proxyCheckVersion",
        "profileId",
        "proxy",
        "routeProof",
        "ipHiding",
        "webRtc",
        "publicCheckers",
    }
)
_ALLOWED_PROOF_KEYS = frozenset(
    {
        "schemaVersion",
        "status",
        "caseLabel",
        "fixtureKind",
        "durationMs",
        "directFallbackDetected",
        "target",
        "navigation",
        "observations",
        "certificateTrust",
    }
)
_PUBLIC_FORBIDDEN_MARKERS = (
    "proxy-authorization",
    "proxy_authorization",
    "proxy password",
    "proxypassword",
    "proxy-password",
    "proxy username",
    "proxyusername",
    "proxy-username",
    "\"credentials\"",
    "\"username\"",
    "\"password\"",
    "--proxy-server",
    "--user-data-dir",
    "--remote-debugging-port",
    "--load-extension",
    "--disable-extensions-except",
    "proxy-auth-extensions",
    "identity-extensions",
    "devtoolsactiveport",
    "ws://",
    "wss://",
    "traceback",
    "private key",
    "proxy-key.pem",
    "proxy-cert.pem",
    "certificateTrust",
    "profile-store/",
)
_PUBLIC_CHECKER_PAGES: tuple[JsonObject, ...] = (
    {
        "id": "cloudflare-trace",
        "label": "Cloudflare trace",
        "url": "https://www.cloudflare.com/cdn-cgi/trace",
        "surfaces": ["ip"],
        "advisory": "External IP guidance only; not used as ThePrivator proof.",
    },
    {
        "id": "aws-checkip",
        "label": "AWS checkip",
        "url": "https://checkip.amazonaws.com/",
        "surfaces": ["ip"],
        "advisory": "External IP guidance only; not used as ThePrivator proof.",
    },
    {
        "id": "webbrowsertools-webrtc",
        "label": "WebRTC leak test",
        "url": "https://webbrowsertools.com/webrtc-leak-test/",
        "surfaces": ["webrtc"],
        "advisory": "WebRTC guidance only; compare with the profile policy shown here.",
    },
)
_PROFILE_LOCKS: dict[str, threading.Lock] = {}
_PROFILE_LOCKS_GUARD = threading.Lock()


def check_profile_proxy(store_root: Union[str, Path], profile_id: str) -> JsonObject:
    """Return the public-safe proxy-check result for one saved profile.

    Fixed-server profiles are checked through a sidecar-managed deterministic
    local fixture with the same proxy protocol/auth requirements.  This proves
    ThePrivator's local route behavior but intentionally does not claim the
    user's exact provider exit IP.  Direct profiles are represented as a
    successful not-run/not-proven state instead of an application failure.
    """
    with _lock_for_profile(profile_id):
        profile = ProfileStore(store_root).get(profile_id)
        public_proxy = public_proxy_summary(profile.proxy)
        web_rtc = _web_rtc_result(profile.identity)
        public_checkers = _public_checkers_result()

        if public_proxy["mode"] == DIRECT_PROXY_MODE:
            result = {
                "proxyCheckVersion": PROXY_CHECK_VERSION,
                "profileId": profile.id,
                "proxy": public_proxy,
                "routeProof": _not_run_route_proof(public_proxy),
                "ipHiding": _not_proven_ip_hiding("direct-profile"),
                "webRtc": web_rtc,
                "publicCheckers": public_checkers,
            }
            return _public_result(result)

        if public_proxy["mode"] != FIXED_SERVER_PROXY_MODE:
            raise _proof_failure()

        normalized_proxy = normalize_proxy_config(profile.proxy)
        # Surface the launch-time verdict before the proof runs. A configuration
        # Chromium could never be launched with -- SOCKS4 carrying credentials,
        # which the protocol has no mechanism for -- should say so, rather than
        # reaching collect_proxy_proof and failing as an invalid proof case.
        build_proxy_runtime_plan(normalized_proxy)
        proof = collect_proxy_proof(
            store_root,
            {
                "label": "profiles.proxy.check",
                "proxy": profile.proxy,
                "managedFixture": True,
            },
            timeout_seconds=PROXY_CHECK_TIMEOUT_SECONDS,
        )
        proof_summary = _validated_proof_summary(proof, expected_protocol=normalized_proxy["protocol"])
        public_exit = _collect_public_exit_observation(profile.proxy)
        result = {
            "proxyCheckVersion": PROXY_CHECK_VERSION,
            "profileId": profile.id,
            "proxy": public_proxy,
            "routeProof": _proved_route_proof(public_proxy, proof_summary),
            "ipHiding": _proved_ip_hiding(public_exit),
            "webRtc": web_rtc,
            "publicCheckers": public_checkers,
        }
        return _public_result(result)


def _not_run_route_proof(public_proxy: Mapping[str, Any]) -> JsonObject:
    return _exact_keys(
        {
            "status": "not-run",
            "basis": "direct-profile",
            "scope": "not-applicable",
            "protocol": None,
            "credentialState": public_proxy.get("credentialState", CREDENTIAL_STATE_NONE),
            "durationMs": 0,
            "fixture": None,
            "target": None,
            "directFallbackDetected": False,
            "observationCounts": {"proxy": 0, "target": 0},
        },
        _ROUTE_PROOF_KEYS,
    )


def _proved_route_proof(public_proxy: Mapping[str, Any], proof: Mapping[str, Any]) -> JsonObject:
    observations = proof["observations"]
    return _exact_keys(
        {
            "status": "proved",
            "basis": PROXY_CHECK_SCOPE_LOCAL_FIXTURE,
            "scope": "local-fixture",
            "protocol": public_proxy.get("protocol"),
            "credentialState": public_proxy.get("credentialState", CREDENTIAL_STATE_NONE),
            "durationMs": proof["durationMs"],
            "fixture": {"kind": proof["fixtureKind"], "managed": True},
            "target": dict(proof["target"]),
            "directFallbackDetected": proof["directFallbackDetected"],
            "observationCounts": {
                "proxy": observations["proxyCount"],
                "target": observations["targetCount"],
            },
        },
        _ROUTE_PROOF_KEYS,
    )


def _not_proven_ip_hiding(basis: str) -> JsonObject:
    return _exact_keys(
        {
            "status": "not-proven",
            "basis": basis,
            "scope": "not-applicable",
            "publicExitIpClaimed": False,
            "publicExitIp": None,
            "publicExitLocation": None,
            "localFixtureConclusion": "not-run",
        },
        _IP_HIDING_KEYS,
    )


def _proved_ip_hiding(public_exit: Mapping[str, Any] | None) -> JsonObject:
    public_ip = public_exit.get("ip") if isinstance(public_exit, Mapping) else None
    location = public_exit.get("location") if isinstance(public_exit, Mapping) else None
    if not isinstance(public_ip, str) or not public_ip:
        public_ip = None
        location = None
    return _exact_keys(
        {
            "status": "proved",
            "basis": "route-proof-succeeded",
            "scope": "local-fixture",
            "publicExitIpClaimed": public_ip is not None,
            "publicExitIp": public_ip,
            "publicExitLocation": _public_exit_location(location) if public_ip is not None else None,
            "localFixtureConclusion": "direct target IP hidden from the proof target by the managed fixture",
        },
        _IP_HIDING_KEYS,
    )


def _public_exit_location(location: Any) -> JsonObject:
    if not isinstance(location, Mapping):
        location = {}
    return _exact_keys(
        {
            "country": _optional_safe_text(location.get("country")),
            "region": _optional_safe_text(location.get("region")),
            "city": _optional_safe_text(location.get("city")),
            "timezone": _optional_safe_text(location.get("timezone")),
            "isp": _optional_safe_text(location.get("isp")),
        },
        _PUBLIC_EXIT_LOCATION_KEYS,
    )


def _optional_safe_text(value: Any, *, max_length: int = 128) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text or len(text) > max_length or any(ord(character) < 32 or ord(character) == 127 for character in text):
        return None
    return text


def _collect_public_exit_observation(proxy: Mapping[str, Any]) -> JsonObject | None:
    """Best-effort public exit lookup through the saved proxy.

    This returns only public IP/location metadata. It must never raise for
    transient public-network failures because the local fixture proof remains
    the deterministic app-side proof boundary.
    """
    try:
        if not isinstance(proxy, Mapping) or proxy.get("mode") != FIXED_SERVER_PROXY_MODE:
            return None
        host = proxy.get("host")
        if isinstance(host, str) and host.casefold().endswith(".invalid"):
            return None
        protocol = proxy.get("protocol")
        if protocol in {"http", "https"}:
            payload = _public_exit_via_requests(proxy)
        elif protocol == "socks5":
            payload = _public_exit_via_socks5(proxy)
        else:
            return None
        return _public_exit_from_payload(payload)
    except Exception:
        return None


def _public_exit_via_requests(proxy: Mapping[str, Any]) -> Mapping[str, Any]:
    protocol = proxy.get("protocol")
    host = proxy.get("host")
    port = proxy.get("port")
    if not isinstance(protocol, str) or not isinstance(host, str) or not isinstance(port, int):
        raise ValueError("invalid proxy")
    proxy_url = f"{protocol}://{_proxy_authority(proxy)}{host}:{port}"
    response = requests.get(
        _PUBLIC_EXIT_LOOKUP_URL,
        proxies={"http": proxy_url},
        timeout=PROXY_CHECK_TIMEOUT_SECONDS,
    )
    response.raise_for_status()
    payload = response.json()
    if not isinstance(payload, Mapping):
        raise ValueError("invalid public exit payload")
    return payload


def _public_exit_via_socks5(proxy: Mapping[str, Any]) -> Mapping[str, Any]:
    host = proxy.get("host")
    port = proxy.get("port")
    if not isinstance(host, str) or not isinstance(port, int):
        raise ValueError("invalid SOCKS5 proxy")
    credentials = proxy.get("credentials") if isinstance(proxy.get("credentials"), Mapping) else None
    with socket.create_connection((host, port), timeout=PROXY_CHECK_TIMEOUT_SECONDS) as sock:
        sock.settimeout(PROXY_CHECK_TIMEOUT_SECONDS)
        if isinstance(credentials, Mapping):
            sock.sendall(b"\x05\x02\x00\x02")
        else:
            sock.sendall(b"\x05\x01\x00")
        greeting = _read_exact(sock, 2)
        if greeting == b"\x05\x02":
            _socks5_send_username_password(sock, credentials)
        elif greeting != b"\x05\x00":
            raise ValueError("SOCKS5 authentication failed")

        target = _PUBLIC_EXIT_LOOKUP_HOST.encode("ascii")
        sock.sendall(b"\x05\x01\x00\x03" + bytes([len(target)]) + target + (80).to_bytes(2, "big"))
        _read_socks5_connect_response(sock)
        request = (
            f"GET {_PUBLIC_EXIT_LOOKUP_PATH} HTTP/1.1\r\n"
            f"Host: {_PUBLIC_EXIT_LOOKUP_HOST}\r\n"
            "Connection: close\r\n"
            "User-Agent: ThePrivatorProxyCheck/1\r\n\r\n"
        )
        sock.sendall(request.encode("ascii"))
        raw = _read_http_response(sock)
    header, _, body = raw.partition(b"\r\n\r\n")
    if b" 200 " not in header.split(b"\r\n", 1)[0]:
        raise ValueError("public exit lookup failed")
    payload = json.loads(body.decode("utf-8"))
    if not isinstance(payload, Mapping):
        raise ValueError("invalid public exit payload")
    return payload


def _socks5_send_username_password(sock: socket.socket, credentials: Any) -> None:
    if not isinstance(credentials, Mapping):
        raise ValueError("SOCKS5 credentials required")
    username = credentials.get("username")
    password = credentials.get("password")
    if not isinstance(username, str) or not isinstance(password, str):
        raise ValueError("SOCKS5 credentials invalid")
    username_bytes = username.encode("utf-8")
    password_bytes = password.encode("utf-8")
    if len(username_bytes) > 255 or len(password_bytes) > 255:
        raise ValueError("SOCKS5 credentials too long")
    sock.sendall(b"\x01" + bytes([len(username_bytes)]) + username_bytes + bytes([len(password_bytes)]) + password_bytes)
    if _read_exact(sock, 2) != b"\x01\x00":
        raise ValueError("SOCKS5 credentials rejected")


def _read_socks5_connect_response(sock: socket.socket) -> None:
    header = _read_exact(sock, 4)
    if header[:2] != b"\x05\x00":
        raise ValueError("SOCKS5 connect failed")
    atyp = header[3]
    if atyp == 1:
        _read_exact(sock, 4)
    elif atyp == 3:
        length = _read_exact(sock, 1)[0]
        _read_exact(sock, length)
    elif atyp == 4:
        _read_exact(sock, 16)
    else:
        raise ValueError("SOCKS5 connect response malformed")
    _read_exact(sock, 2)


def _proxy_authority(proxy: Mapping[str, Any]) -> str:
    credentials = proxy.get("credentials")
    if not isinstance(credentials, Mapping):
        return ""
    username = credentials.get("username")
    password = credentials.get("password")
    if not isinstance(username, str) or not isinstance(password, str):
        return ""
    return f"{quote(username, safe='')}:{quote(password, safe='')}@"


def _public_exit_from_payload(payload: Mapping[str, Any]) -> JsonObject | None:
    """Extract the advisory public exit observation, or None.

    This lookup runs as plain HTTP through the user's own proxy, so the response
    is attacker-controlled by any tampering middlebox. The exit IP must therefore
    be validated as an actual address rather than merely stripped: the TypeScript
    client hard-rejects unsafe text and would fail the entire proxy check -- and
    the deterministic local route proof it would discard is the part that
    actually proves anything. The advisory half fails soft, by design.
    """
    if payload.get("status") not in {None, "success"}:
        return None
    public_ip = payload.get("query")
    if not isinstance(public_ip, str):
        return None
    candidate = public_ip.strip()
    if not candidate or len(candidate) > MAX_PUBLIC_EXIT_IP_LENGTH:
        return None
    try:
        ipaddress.ip_address(candidate)
    except ValueError:
        return None
    return {
        "ip": candidate,
        "location": _public_exit_location(
            {
                "country": payload.get("country"),
                "region": payload.get("regionName"),
                "city": payload.get("city"),
                "timezone": payload.get("timezone"),
                "isp": payload.get("isp"),
            }
        ),
    }


def _read_exact(sock: socket.socket, length: int) -> bytes:
    chunks: list[bytes] = []
    remaining = length
    while remaining > 0:
        chunk = sock.recv(remaining)
        if not chunk:
            raise ValueError("socket closed")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def _read_http_response(sock: socket.socket) -> bytes:
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = sock.recv(4096)
        if not chunk:
            break
        chunks.append(chunk)
        total += len(chunk)
        if total > 65536:
            raise ValueError("public exit response too large")
    return b"".join(chunks)



def _web_rtc_result(identity: Mapping[str, Any]) -> JsonObject:
    web_rtc = identity.get("webrtc") if isinstance(identity, Mapping) else None
    mode = web_rtc.get("mode") if isinstance(web_rtc, Mapping) else "real"
    policy = web_rtc.get("policy") if isinstance(web_rtc, Mapping) else "real"
    if mode == "real" and policy == "real":
        status = "baseline-real"
        exposure = "real-local-ip-baseline"
    elif policy == "block":
        status = "restricted"
        exposure = "blocked"
    elif policy == "disableNonProxiedUdp":
        status = "restricted"
        exposure = "non-proxied-udp-disabled"
    else:
        raise _proof_failure()
    return _exact_keys(
        {
            "status": status,
            "basis": "profile-identity-policy",
            "mode": mode,
            "policy": policy,
            "localIpExposure": exposure,
        },
        _WEBRTC_KEYS,
    )


def _public_checkers_result() -> JsonObject:
    pages = [_public_checker_page(page) for page in _PUBLIC_CHECKER_PAGES]
    return _exact_keys(
        {
            "status": PROXY_CHECK_PUBLIC_CHECKER_STATUS,
            "basis": "fixed-https-allowlist",
            "networkDependency": "user-driven-external-pages",
            "pages": pages,
        },
        _PUBLIC_CHECKERS_KEYS,
    )


def _public_checker_page(page: Mapping[str, Any]) -> JsonObject:
    result = _exact_keys(dict(page), _PUBLIC_CHECKER_PAGE_KEYS)
    url = result.get("url")
    surfaces = result.get("surfaces")
    if not isinstance(url, str) or not url.startswith("https://"):
        raise _proof_failure()
    if not isinstance(surfaces, list) or not surfaces or any(surface not in {"ip", "webrtc"} for surface in surfaces):
        raise _proof_failure()
    return result


def _validated_proof_summary(proof: Any, *, expected_protocol: Any) -> JsonObject:
    if not isinstance(proof, Mapping):
        raise _proof_failure()
    if frozenset(proof.keys()) - _ALLOWED_PROOF_KEYS:
        raise _proof_failure()
    required = _ALLOWED_PROOF_KEYS - {"certificateTrust"}
    if not required <= frozenset(proof.keys()):
        raise _proof_failure()
    _assert_safe_payload(proof, forbid_certificate_trust=False)

    if proof.get("schemaVersion") != PROXY_PROOF_SCHEMA_VERSION:
        raise _proof_failure()
    if proof.get("status") != "ok":
        raise _proof_failure()
    fixture_kind = proof.get("fixtureKind")
    if fixture_kind != expected_protocol:
        raise _proof_failure()
    duration_ms = proof.get("durationMs")
    if isinstance(duration_ms, bool) or not isinstance(duration_ms, (int, float)) or not math.isfinite(duration_ms) or duration_ms < 0:
        raise _proof_failure()
    if proof.get("directFallbackDetected") is not False:
        raise _proof_failure()

    target = proof.get("target")
    if not isinstance(target, Mapping) or frozenset(target.keys()) != {"host", "port"}:
        raise _proof_failure()
    if not isinstance(target.get("host"), str) or not target["host"]:
        raise _proof_failure()
    if isinstance(target.get("port"), bool) or not isinstance(target.get("port"), int) or target["port"] <= 0:
        raise _proof_failure()

    observations = proof.get("observations")
    if not isinstance(observations, Mapping):
        raise _proof_failure()
    proxy_count = observations.get("proxyCount")
    target_count = observations.get("targetCount")
    if isinstance(proxy_count, bool) or not isinstance(proxy_count, int) or proxy_count <= 0:
        raise _proof_failure()
    if isinstance(target_count, bool) or not isinstance(target_count, int) or target_count <= 0:
        raise _proof_failure()

    return dict(proof)


def _public_result(result: Mapping[str, Any]) -> JsonObject:
    public = _exact_keys(dict(result), _PUBLIC_RESULT_KEYS)
    _assert_safe_payload(public)
    return public


def _exact_keys(payload: JsonObject, keys: frozenset[str]) -> JsonObject:
    if frozenset(payload.keys()) != keys:
        raise _proof_failure()
    return payload


def _assert_safe_payload(payload: Any, *, forbid_certificate_trust: bool = True) -> None:
    try:
        encoded = json.dumps(payload, ensure_ascii=False, allow_nan=False, sort_keys=True)
    except (TypeError, ValueError) as exc:
        raise _proof_failure() from exc
    lowered = encoded.casefold()
    forbidden_markers = _PUBLIC_FORBIDDEN_MARKERS
    if not forbid_certificate_trust:
        forbidden_markers = tuple(
            marker for marker in _PUBLIC_FORBIDDEN_MARKERS if marker != "certificateTrust"
        )
    if any(marker.casefold() in lowered for marker in forbidden_markers):
        raise _proof_failure()


def _lock_for_profile(profile_id: str) -> threading.Lock:
    key = profile_id if isinstance(profile_id, str) and profile_id.strip() else "<invalid>"
    with _PROFILE_LOCKS_GUARD:
        lock = _PROFILE_LOCKS.get(key)
        if lock is None:
            lock = threading.Lock()
            _PROFILE_LOCKS[key] = lock
        return lock


def _proof_failure() -> SidecarError:
    return SidecarError(
        code=PROXY_PROOF_FAILED,
        message="Proxy check proof could not be completed.",
    )


__all__ = [
    "PROXY_CHECK_PUBLIC_CHECKER_STATUS",
    "PROXY_CHECK_SCOPE_LOCAL_FIXTURE",
    "PROXY_CHECK_TIMEOUT_SECONDS",
    "PROXY_CHECK_VERSION",
    "check_profile_proxy",
]
