"""Chrome extension management for fingerprint protection."""

import json
import shutil
import sys
from pathlib import Path
from typing import Optional

# Add src to path
src_dir = Path(__file__).parent.parent.absolute()
if str(src_dir) not in sys.path:
    sys.path.insert(0, str(src_dir))

from core.profile_manager import ChromiumProfile
from utils.logger import get_logger
from utils.exceptions import ProfileError


class ExtensionManager:
    """Manages Chrome extension deployment for fingerprint protection."""

    def __init__(self, base_dir: Path):
        """
        Initialize Extension Manager.

        Args:
            base_dir: Base directory for thePrivator data (typically ~/.theprivator)
        """
        self.logger = get_logger(__name__)
        self.base_dir = Path(base_dir)
        self.extension_template_dir = Path(__file__).parent.parent / "extension"
        self.profiles_extension_dir = self.base_dir / "extensions"

        # Create extensions directory if it doesn't exist
        self.profiles_extension_dir.mkdir(parents=True, exist_ok=True)

        # Verify extension template exists
        if not self.extension_template_dir.exists():
            self.logger.warning(
                f"Extension template directory not found: {self.extension_template_dir}"
            )

    def prepare_extension_for_profile(self, profile: ChromiumProfile) -> Optional[Path]:
        """
        Creates profile-specific extension copy with config.

        This method:
        1. Creates a copy of the extension template
        2. Writes profile-specific config.json
        3. Returns path to the prepared extension

        Args:
            profile: ChromiumProfile with fingerprint configuration

        Returns:
            Path to prepared extension directory, or None if fingerprint disabled

        Raises:
            ProfileError: If extension preparation fails
        """
        try:
            # Check if fingerprinting is disabled
            if not profile.fingerprint or profile.fingerprint.mode == "disabled":
                self.logger.debug(f"Fingerprinting disabled for profile: {profile.name}")
                return None

            # Check if extension template exists
            if not self.extension_template_dir.exists():
                raise ProfileError(
                    f"Extension template not found at {self.extension_template_dir}. "
                    "Please ensure the extension directory is properly installed."
                )

            # Create profile-specific extension directory
            profile_ext_dir = self.profiles_extension_dir / profile.id

            # Remove existing extension if present
            if profile_ext_dir.exists():
                shutil.rmtree(profile_ext_dir)

            # Copy extension template
            shutil.copytree(self.extension_template_dir, profile_ext_dir)
            self.logger.debug(f"Copied extension template to: {profile_ext_dir}")

            # Write profile-specific config.json
            config_data = self._generate_extension_config(profile)
            config_file = profile_ext_dir / "config.json"

            with open(config_file, 'w', encoding='utf-8') as f:
                json.dump(config_data, f, indent=2)

            self.logger.info(
                f"Prepared fingerprint extension for profile '{profile.name}' at {profile_ext_dir}"
            )

            return profile_ext_dir

        except Exception as e:
            raise ProfileError(f"Failed to prepare extension for profile: {e}")

    def _generate_extension_config(self, profile: ChromiumProfile) -> dict:
        """
        Generate extension config.json from profile fingerprint.

        Args:
            profile: ChromiumProfile with fingerprint settings

        Returns:
            Dictionary with extension configuration
        """
        fp = profile.fingerprint

        config = {
            # Canvas protection
            "canvas_enabled": fp.canvas_enabled,
            "canvas_noise_seed": fp.canvas_noise_seed or 42,

            # WebGL protection
            "webgl_enabled": fp.webgl_enabled,
            "webgl_noise_seed": fp.webgl_noise_seed or 42,

            # Audio protection
            "audio_enabled": fp.audio_enabled,
            "audio_noise_seed": fp.audio_noise_seed or 42,

            # WebRTC protection
            "webrtc_protection": fp.webrtc_protection or "disabled",

            # Platform/hardware (for navigator overrides if needed)
            "platform": fp.platform or "Win32",
            "hardware_concurrency": fp.hardware_concurrency or 8,
            "device_memory": fp.device_memory or 8,

            # Metadata
            "profile_id": profile.id,
            "profile_name": profile.name,
            "mode": fp.mode,
            "preset_name": fp.preset_name or "custom",
        }

        return config

    def cleanup_extension(self, profile_id: str) -> None:
        """
        Remove extension for specific profile.

        Args:
            profile_id: ID of the profile
        """
        try:
            profile_ext_dir = self.profiles_extension_dir / profile_id

            if profile_ext_dir.exists():
                shutil.rmtree(profile_ext_dir)
                self.logger.info(f"Removed extension for profile: {profile_id}")
            else:
                self.logger.debug(f"No extension found for profile: {profile_id}")

        except Exception as e:
            self.logger.warning(f"Failed to cleanup extension: {e}")

    def cleanup_all_extensions(self) -> None:
        """Remove all profile extensions (useful for maintenance)."""
        try:
            if self.profiles_extension_dir.exists():
                for ext_dir in self.profiles_extension_dir.iterdir():
                    if ext_dir.is_dir():
                        shutil.rmtree(ext_dir)
                self.logger.info("Cleaned up all profile extensions")

        except Exception as e:
            self.logger.warning(f"Failed to cleanup all extensions: {e}")

    def verify_extension_template(self) -> bool:
        """
        Verify extension template is valid.

        Returns:
            True if extension template exists and has required files
        """
        if not self.extension_template_dir.exists():
            self.logger.error(f"Extension template directory not found: {self.extension_template_dir}")
            return False

        required_files = [
            "manifest.json",
            "injector.js",
            "canvas_protector.js",
            "webgl_protector.js",
            "audio_protector.js",
            "background.js",
        ]

        missing_files = []
        for file_name in required_files:
            file_path = self.extension_template_dir / file_name
            if not file_path.exists():
                missing_files.append(file_name)

        if missing_files:
            self.logger.error(
                f"Extension template is missing required files: {', '.join(missing_files)}"
            )
            return False

        self.logger.debug("Extension template verified successfully")
        return True

    def get_extension_path(self, profile_id: str) -> Optional[Path]:
        """
        Get path to prepared extension for profile.

        Args:
            profile_id: ID of the profile

        Returns:
            Path to extension if it exists, None otherwise
        """
        profile_ext_dir = self.profiles_extension_dir / profile_id

        if profile_ext_dir.exists():
            return profile_ext_dir

        return None
