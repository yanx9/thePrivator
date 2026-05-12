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
import threading
from pathlib import Path
from typing import Any, Mapping, Sequence, Union

from .profiles import ProfileStore
from .protocol import JsonObject, PROXY_PROOF_FAILED, SidecarError
from .proxy import (
    CREDENTIAL_STATE_NONE,
    DIRECT_PROXY_MODE,
    FIXED_SERVER_PROXY_MODE,
    PROXY_VERSION,
    public_proxy_summary,
)
from .proxy_proof import PROXY_PROOF_SCHEMA_VERSION, collect_proxy_proof
from .proxy_runtime import build_proxy_runtime_plan

PROXY_CHECK_VERSION = 1
PROXY_CHECK_SCOPE_LOCAL_FIXTURE = "sidecar-managed-local-fixture"
PROXY_CHECK_PUBLIC_CHECKER_STATUS = "advisory-only"
PROXY_CHECK_TIMEOUT_SECONDS = 5.0

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
        "localFixtureConclusion",
    }
)
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

        runtime_plan = build_proxy_runtime_plan(profile.proxy)
        proof = collect_proxy_proof(
            store_root,
            {
                "label": "profiles.proxy.check",
                "proxy": profile.proxy,
                "managedFixture": True,
            },
            timeout_seconds=PROXY_CHECK_TIMEOUT_SECONDS,
        )
        proof_summary = _validated_proof_summary(proof, expected_protocol=runtime_plan.protocol)
        result = {
            "proxyCheckVersion": PROXY_CHECK_VERSION,
            "profileId": profile.id,
            "proxy": public_proxy,
            "routeProof": _proved_route_proof(public_proxy, proof_summary),
            "ipHiding": _proved_ip_hiding(),
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
            "localFixtureConclusion": "not-run",
        },
        _IP_HIDING_KEYS,
    )


def _proved_ip_hiding() -> JsonObject:
    return _exact_keys(
        {
            "status": "proved",
            "basis": "route-proof-succeeded",
            "scope": "local-fixture",
            "publicExitIpClaimed": False,
            "publicExitIp": None,
            "localFixtureConclusion": "direct target IP hidden from the proof target by the managed fixture",
        },
        _IP_HIDING_KEYS,
    )


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
