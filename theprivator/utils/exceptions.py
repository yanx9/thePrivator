"""Custom exceptions for thePrivator."""

class PrivatorException(Exception):
    """Base exception for thePrivator."""
    pass

class ProfileError(PrivatorException):
    """Profile-related errors."""
    pass

class ValidationError(PrivatorException):
    """Validation errors."""
    pass

class LaunchError(PrivatorException):
    """Chromium launch errors."""
    pass

class ConfigError(PrivatorException):
    """Configuration errors."""
    pass