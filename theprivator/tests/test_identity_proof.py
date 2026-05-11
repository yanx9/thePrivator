"""Tests for the internal S02 local identity proof collector."""

import json
from typing import Any

import pytest
import requests

from theprivator_sidecar.cdp import CdpEndpoint, CdpPageEndpoint
from theprivator_sidecar.identity_proof import (
    IdentityProofServer,
    collect_identity_proof,
    collect_identity_proof_for_user_data_dir,
    validate_identity_observation,
)
from theprivator_sidecar.protocol import IDENTITY_CDP_FAILED, IDENTITY_PROOF_FAILED, SidecarError


def valid_observation() -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "browser": {
            "userAgent": "Mozilla/5.0 proof UA",
            "userAgentData": {
                "supported": True,
                "brands": [],
                "mobile": False,
                "platform": "Linux",
                "highEntropy": {"architecture": "x86", "platformVersion": ""},
            },
        },
        "navigator": {
            "platform": "Linux x86_64",
            "hardwareConcurrency": 8,
            "deviceMemory": 8,
        },
        "locale": {
            "language": "en-US",
            "languages": ["en-US", "en"],
            "timezone": "America/New_York",
        },
        "viewport": {
            "innerWidth": 1920,
            "innerHeight": 1032,
            "devicePixelRatio": 1,
            "screen": {"width": 1920, "height": 1080, "colorDepth": 24},
        },
        "canvas": {"supported": True, "signature": "data:image/png;base64,abc"},
        "webgl": {"supported": True, "vendor": "Google Inc.", "renderer": "ANGLE"},
        "audio": {"supported": True, "sample": [0, 0.125, -0.25]},
        "webrtc": {"supported": True, "icePolicy": "all", "errorName": None},
    }


class FakeProofClient:
    def __init__(self, url: str, *, observation: dict[str, Any] | None = None, fail_method: str | None = None) -> None:
        self.url = url
        self.observation = observation or valid_observation()
        self.fail_method = fail_method
        self.commands: list[tuple[str, dict[str, Any]]] = []
        self.closed = False

    def __enter__(self) -> "FakeProofClient":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.close()

    def close(self) -> None:
        self.closed = True

    def command(self, method: str, params: dict[str, Any] | None = None, **kwargs: Any) -> dict[str, Any]:
        payload = params or {}
        self.commands.append((method, payload))
        if self.fail_method == method:
            raise SidecarError(
                code=IDENTITY_CDP_FAILED,
                message="CDP failed on ws://127.0.0.1:45678/devtools/browser/secret",
            )
        if method == "Page.enable":
            return {}
        if method == "Page.navigate":
            assert payload["url"].startswith("http://127.0.0.1:")
            return {"frameId": "frame-1"}
        if method == "Runtime.evaluate":
            assert "navigator.userAgentData" in payload["expression"]
            assert payload["awaitPromise"] is True
            assert payload["returnByValue"] is True
            return {"result": {"type": "object", "value": self.observation}}
        raise AssertionError(f"unexpected command {method}")


def assert_sidecar_error(
    exc_info: pytest.ExceptionInfo[SidecarError],
    code: str = IDENTITY_PROOF_FAILED,
    *,
    forbidden: tuple[str, ...] = (),
) -> SidecarError:
    error = exc_info.value
    assert error.code == code
    assert error.recoverable is True
    assert error.detail_ref.startswith("sidecar-")
    assert error.message
    combined = json.dumps(error.to_dict(), ensure_ascii=False)
    for marker in (
        "45678",
        "9222",
        "ws://",
        "DevToolsActivePort",
        "remote-debugging-port",
        "Traceback",
        *forbidden,
    ):
        assert marker not in combined
    return error


def test_proof_server_binds_loopback_ephemeral_port_and_serves_local_page():
    with IdentityProofServer() as server:
        assert server.url.startswith("http://127.0.0.1:")
        assert not server.url.startswith("http://127.0.0.1:0")
        response = requests.get(server.url, timeout=1)

    assert response.status_code == 200
    assert "theprivator identity proof" in response.text
    assert "public checker" not in response.text.lower()


def test_collect_identity_proof_navigates_local_page_and_returns_bounded_observation():
    created: list[FakeProofClient] = []

    def client_factory(url: str, **kwargs: Any) -> FakeProofClient:
        client = FakeProofClient(url)
        created.append(client)
        return client

    proof = collect_identity_proof(
        "ws://127.0.0.1:45678/devtools/browser/browser-id",
        client_factory=client_factory,
        timeout_seconds=1,
    )

    assert proof == valid_observation()
    assert len(created) == 1
    assert created[0].closed is True
    assert [method for method, _params in created[0].commands] == [
        "Page.enable",
        "Page.navigate",
        "Runtime.evaluate",
    ]
    assert len(json.dumps(proof, ensure_ascii=False)) < 8192


def test_validate_observation_reports_absent_user_agent_data_as_unsupported():
    observation = valid_observation()
    observation["browser"]["userAgentData"] = {"supported": False}

    validated = validate_identity_observation(observation)

    assert validated["browser"]["userAgentData"] == {"supported": False}


def test_collect_identity_proof_discovers_page_target_from_browser_endpoint(monkeypatch):
    created: list[FakeProofClient] = []
    endpoint = CdpEndpoint(
        port=45678,
        browser_target_path="/devtools/browser/browser-id",
        web_socket_debugger_url="ws://127.0.0.1:45678/devtools/browser/browser-id",
    )

    def fake_discover_page_target_endpoint(received_endpoint, **kwargs: Any) -> CdpPageEndpoint:
        assert received_endpoint == endpoint
        return CdpPageEndpoint("ws://127.0.0.1:45678/devtools/page/page-id")

    def client_factory(url: str, **kwargs: Any) -> FakeProofClient:
        assert url == "ws://127.0.0.1:45678/devtools/page/page-id"
        client = FakeProofClient(url)
        created.append(client)
        return client

    monkeypatch.setattr(
        "theprivator_sidecar.identity_proof.discover_page_target_endpoint",
        fake_discover_page_target_endpoint,
    )

    proof = collect_identity_proof(endpoint, client_factory=client_factory, timeout_seconds=1)

    assert proof == valid_observation()
    assert len(created) == 1
    assert created[0].closed is True


def test_collect_identity_proof_for_user_data_dir_wraps_discovery_and_collects(monkeypatch, tmp_path):
    endpoint = CdpEndpoint(
        port=45678,
        browser_target_path="/devtools/browser/browser-id",
        web_socket_debugger_url="ws://127.0.0.1:45678/devtools/browser/browser-id",
    )

    def fake_discover_devtools_endpoint(user_data_dir, **kwargs: Any) -> CdpEndpoint:
        assert user_data_dir == tmp_path
        return endpoint

    def fake_discover_page_target_endpoint(received_endpoint, **kwargs: Any) -> CdpPageEndpoint:
        assert received_endpoint == endpoint
        return CdpPageEndpoint("ws://127.0.0.1:45678/devtools/page/page-id")

    def client_factory(url: str, **kwargs: Any) -> FakeProofClient:
        assert url == "ws://127.0.0.1:45678/devtools/page/page-id"
        return FakeProofClient(url)

    monkeypatch.setattr(
        "theprivator_sidecar.identity_proof.discover_devtools_endpoint",
        fake_discover_devtools_endpoint,
    )
    monkeypatch.setattr(
        "theprivator_sidecar.identity_proof.discover_page_target_endpoint",
        fake_discover_page_target_endpoint,
    )

    proof = collect_identity_proof_for_user_data_dir(
        tmp_path,
        client_factory=client_factory,
        discovery_timeout_seconds=1,
        proof_timeout_seconds=1,
    )

    assert proof == valid_observation()


@pytest.mark.parametrize("missing_key", ["browser", "navigator", "locale", "viewport", "canvas", "webgl", "audio", "webrtc"])
def test_validate_observation_rejects_missing_required_surfaces_with_redacted_error(missing_key):
    observation = valid_observation()
    observation.pop(missing_key)

    with pytest.raises(SidecarError) as exc_info:
        validate_identity_observation(observation)

    assert_sidecar_error(exc_info)


def test_collect_identity_proof_wraps_navigation_failures_as_proof_errors():
    def client_factory(url: str, **kwargs: Any) -> FakeProofClient:
        return FakeProofClient(url, fail_method="Page.navigate")

    with pytest.raises(SidecarError) as exc_info:
        collect_identity_proof(
            "ws://127.0.0.1:45678/devtools/browser/browser-id",
            client_factory=client_factory,
            timeout_seconds=1,
        )

    assert_sidecar_error(exc_info)


def test_collect_identity_proof_rejects_malformed_runtime_payloads():
    observation = valid_observation()
    observation["canvas"] = {"supported": True}

    def client_factory(url: str, **kwargs: Any) -> FakeProofClient:
        return FakeProofClient(url, observation=observation)

    with pytest.raises(SidecarError) as exc_info:
        collect_identity_proof(
            "ws://127.0.0.1:45678/devtools/browser/browser-id",
            client_factory=client_factory,
            timeout_seconds=1,
        )

    assert_sidecar_error(exc_info)
