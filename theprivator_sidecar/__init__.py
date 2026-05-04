"""ThePrivator sidecar package."""

from .protocol import PROTOCOL_VERSION, SIDECAR_VERSION

__version__ = SIDECAR_VERSION

__all__ = ["PROTOCOL_VERSION", "SIDECAR_VERSION", "__version__"]
