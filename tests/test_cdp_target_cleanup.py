"""Regression coverage for ownership during page endpoint discovery failures."""

import pytest

from theprivator_sidecar.cdp import CdpEndpoint, create_page_target_endpoint
from theprivator_sidecar.protocol import SidecarError


@pytest.mark.parametrize("cleanup_fails", [False, True])
def test_created_target_is_closed_when_endpoint_discovery_fails(cleanup_fails):
    commands = []

    class Client:
        def __init__(self, url, *, timeout_seconds):
            self.url = url

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def command(self, method, params, *, timeout_seconds):
            commands.append((self.url, method, params))
            if method == "Target.createTarget":
                return {"targetId": "bot-target"}
            assert method == "Target.closeTarget"
            if cleanup_fails:
                raise RuntimeError("private cleanup endpoint")
            return {"success": True}

    class MissingTargetResponse:
        def json(self):
            return []

    endpoint = CdpEndpoint(45678, "/devtools/browser/browser-id", "ws://127.0.0.1:45678/devtools/browser/browser-id")
    with pytest.raises(SidecarError) as failure:
        create_page_target_endpoint(
            endpoint,
            client_factory=Client,
            timeout_seconds=0,
            http_get=lambda *args, **kwargs: MissingTargetResponse(),
        )

    assert commands == [
        (endpoint.web_socket_debugger_url, "Target.createTarget", {"url": "about:blank"}),
        (endpoint.web_socket_debugger_url, "Target.closeTarget", {"targetId": "bot-target"}),
    ]
    assert failure.value.message == "Identity CDP operation failed."
    assert isinstance(failure.value.__cause__, ValueError)
    assert str(failure.value.__cause__) == "page target was not found"
