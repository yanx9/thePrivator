"""Fingerprint generation and validation utilities."""

import random
import sys
from pathlib import Path
from typing import List, Dict, Optional, Any

# Add src to path
src_dir = Path(__file__).parent.parent.absolute()
if str(src_dir) not in sys.path:
    sys.path.insert(0, str(src_dir))

from core.profile_manager import ChromiumProfile, FingerprintConfig
from core.fingerprint_presets import FINGERPRINT_PRESETS, get_preset_names
from utils.logger import get_logger


class FingerprintGenerator:
    """Generates and validates browser fingerprints."""

    def __init__(self):
        self.logger = get_logger(__name__)
        self.presets = FINGERPRINT_PRESETS

    def generate_from_preset(self, preset_name: str, randomize_seeds: bool = True) -> FingerprintConfig:
        """
        Generate fingerprint from preset template.

        Args:
            preset_name: Name of the preset to use
            randomize_seeds: If True, generate random noise seeds

        Returns:
            FingerprintConfig instance

        Raises:
            ValueError: If preset_name is invalid
        """
        if preset_name not in self.presets:
            raise ValueError(f"Unknown preset: {preset_name}. Available: {', '.join(get_preset_names())}")

        preset = self.presets[preset_name]
        config_data = preset["fingerprint"].copy()

        # Create FingerprintConfig from preset data
        config = FingerprintConfig.from_dict(config_data)
        config.preset_name = preset_name

        # Generate unique noise seeds for Canvas/WebGL/Audio
        if randomize_seeds:
            config.canvas_noise_seed = random.randint(1, 1000000)
            config.webgl_noise_seed = random.randint(1, 1000000)
            config.audio_noise_seed = random.randint(1, 1000000)
        else:
            # Use deterministic seeds based on preset name
            seed_base = hash(preset_name) % 1000000
            config.canvas_noise_seed = seed_base
            config.webgl_noise_seed = seed_base + 1
            config.audio_noise_seed = seed_base + 2

        self.logger.debug(f"Generated fingerprint from preset: {preset_name}")
        return config

    def generate_random(self, os_type: str = "windows") -> FingerprintConfig:
        """
        Generate completely random but realistic fingerprint.

        Args:
            os_type: Operating system type ("windows", "macos", "linux", "android")

        Returns:
            FingerprintConfig instance with random but consistent values
        """
        config = FingerprintConfig()

        if os_type.lower() == "windows":
            config.platform = "Win32"
            config.screen_width = random.choice([1920, 1366, 1536, 2560, 3840])
            config.screen_height = random.choice([1080, 768, 864, 1440, 2160])
            config.viewport_width = config.screen_width
            config.viewport_height = config.screen_height - 48  # Browser chrome
            config.timezone_id = random.choice([
                "America/New_York", "America/Chicago", "America/Denver",
                "America/Los_Angeles", "America/Phoenix"
            ])
            config.languages = ["en-US", "en"]
            config.ua_platform = "Windows"
            config.ua_platform_version = "10.0.0"
            config.ua_architecture = "x86"

        elif os_type.lower() == "macos":
            config.platform = "MacIntel"
            config.screen_width = random.choice([1920, 2560, 1440, 1512])
            config.screen_height = random.choice([1080, 1440, 900, 982])
            config.viewport_width = config.screen_width
            config.viewport_height = config.screen_height - 111  # macOS chrome
            config.pixel_ratio = 2.0
            config.timezone_id = random.choice([
                "America/Los_Angeles", "America/New_York", "America/Chicago"
            ])
            config.languages = ["en-US", "en"]
            config.ua_platform = "macOS"
            config.ua_platform_version = random.choice(["13.6.0", "14.2.0"])
            config.ua_architecture = random.choice(["x86", "arm"])

        elif os_type.lower() == "linux":
            config.platform = "Linux x86_64"
            config.screen_width = random.choice([1920, 2560, 1366, 1440])
            config.screen_height = random.choice([1080, 1440, 768, 900])
            config.viewport_width = config.screen_width
            config.viewport_height = config.screen_height - 48
            config.timezone_id = random.choice([
                "America/New_York", "Europe/London", "Europe/Berlin", "America/Los_Angeles"
            ])
            config.languages = ["en-US", "en"]
            config.ua_platform = "Linux"
            config.ua_platform_version = ""
            config.ua_architecture = "x86"

        elif os_type.lower() == "android":
            config.platform = "Linux armv81"
            config.screen_width = random.choice([1080, 1440])
            config.screen_height = random.choice([2400, 3200])
            config.viewport_width = random.choice([412, 360])
            config.viewport_height = random.choice([915, 800])
            config.pixel_ratio = random.choice([2.5, 3.0, 3.5])
            config.timezone_id = "America/New_York"
            config.languages = ["en-US", "en"]
            config.ua_platform = "Android"
            config.ua_platform_version = "13.0.0"
            config.ua_architecture = "arm"
            config.ua_mobile = True

        # Common settings for all OS types
        config.color_depth = 24
        config.locale = "en-US"
        config.hardware_concurrency = random.choice([4, 8, 12, 16])
        config.device_memory = random.choice([4, 8, 16, 32])

        # Generate plausible WebGL strings based on OS
        if config.platform == "Win32":
            config.webgl_vendor = "Google Inc. (NVIDIA)"
            config.webgl_renderer = "ANGLE (NVIDIA, NVIDIA GeForce GTX 1060 Direct3D11 vs_5_0 ps_5_0)"
        elif config.platform == "MacIntel":
            config.webgl_vendor = "Apple"
            config.webgl_renderer = "Apple M1"
        elif config.platform == "Linux x86_64":
            config.webgl_vendor = "Google Inc. (Intel)"
            config.webgl_renderer = "ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL 4.6)"
        elif "arm" in str(config.ua_architecture):
            config.webgl_vendor = "Google Inc. (Qualcomm)"
            config.webgl_renderer = "ANGLE (Qualcomm, Adreno (TM) 660, OpenGL ES 3.2)"
        else:
            config.webgl_vendor = "Google Inc."
            config.webgl_renderer = "Google SwiftShader"

        # Generate random noise seeds
        config.canvas_noise_seed = random.randint(1, 1000000)
        config.webgl_noise_seed = random.randint(1, 1000000)
        config.audio_noise_seed = random.randint(1, 1000000)

        config.mode = "advanced"  # Random generation uses advanced mode

        self.logger.debug(f"Generated random fingerprint for {os_type}")
        return config

    def validate_consistency(self, profile: ChromiumProfile) -> List[str]:
        """
        Validate fingerprint consistency and return warnings.

        Checks for mismatches between:
        - User-Agent and platform
        - Platform and screen resolution
        - Timezone and geolocation (if both set)
        - Hardware specs vs OS

        Args:
            profile: ChromiumProfile to validate

        Returns:
            List of warning messages (empty if no issues)
        """
        warnings = []
        fp = profile.fingerprint

        if not fp or fp.mode == "disabled":
            return warnings

        ua = profile.user_agent.lower()

        # Check UA matches platform
        if "windows" in ua and fp.platform != "Win32":
            warnings.append("⚠️ User-Agent indicates Windows but platform is not Win32")
        elif "macintosh" in ua and fp.platform != "MacIntel":
            warnings.append("⚠️ User-Agent indicates macOS but platform is not MacIntel")
        elif "linux" in ua and not fp.platform.startswith("Linux"):
            warnings.append("⚠️ User-Agent indicates Linux but platform doesn't match")
        elif "android" in ua and not fp.ua_mobile:
            warnings.append("⚠️ User-Agent indicates Android but mobile flag is False")

        # Check screen resolution is realistic
        if fp.screen_width and fp.screen_height:
            aspect_ratio = fp.screen_width / fp.screen_height
            if aspect_ratio < 1.0:  # Portrait on desktop
                if fp.platform in ["Win32", "MacIntel", "Linux x86_64"]:
                    warnings.append("⚠️ Desktop OS with portrait screen orientation (unusual)")

            # Check for common resolutions
            common_resolutions = [
                (1920, 1080), (1366, 768), (2560, 1440), (3840, 2160),
                (1440, 900), (1536, 864), (1280, 1024), (1680, 1050),
                (1920, 1200), (2560, 1600)
            ]
            if fp.platform in ["Win32", "MacIntel", "Linux x86_64"]:
                if (fp.screen_width, fp.screen_height) not in common_resolutions:
                    # Only warn if it's really unusual
                    if fp.screen_width < 1024 or fp.screen_height < 768:
                        warnings.append(f"⚠️ Unusual screen resolution: {fp.screen_width}x{fp.screen_height}")

        # Check viewport makes sense
        if fp.viewport_width and fp.screen_width:
            if fp.viewport_width > fp.screen_width:
                warnings.append("⚠️ Viewport width exceeds screen width")

        if fp.viewport_height and fp.screen_height:
            # Viewport should be less than screen (browser chrome takes space)
            if fp.viewport_height > fp.screen_height:
                warnings.append("⚠️ Viewport height exceeds screen height")
            elif fp.viewport_height == fp.screen_height:
                warnings.append("⚠️ Viewport height equals screen height (no browser chrome)")

        # Check hardware specs
        if fp.hardware_concurrency:
            valid_core_counts = [1, 2, 4, 6, 8, 10, 12, 14, 16, 20, 24, 28, 32, 64]
            if fp.hardware_concurrency not in valid_core_counts:
                warnings.append(f"⚠️ Unusual CPU core count: {fp.hardware_concurrency}")

        if fp.device_memory:
            valid_memory = [2, 4, 8, 16, 32, 64]
            if fp.device_memory not in valid_memory:
                warnings.append(f"⚠️ Unusual device memory: {fp.device_memory}GB")

        # Check timezone vs geolocation consistency (if both set)
        if fp.timezone_id and fp.latitude and fp.longitude:
            timezone_regions = {
                "America/New_York": (40.7128, -74.0060),       # New York
                "America/Chicago": (41.8781, -87.6298),        # Chicago
                "America/Denver": (39.7392, -104.9903),        # Denver
                "America/Los_Angeles": (34.0522, -118.2437),   # Los Angeles
                "America/Phoenix": (33.4484, -112.0740),       # Phoenix
                "Europe/London": (51.5074, -0.1278),           # London
                "Europe/Berlin": (52.5200, 13.4050),           # Berlin
            }

            if fp.timezone_id in timezone_regions:
                expected_lat, expected_lon = timezone_regions[fp.timezone_id]
                # Check if lat/lon are in same general region (within ~10 degrees)
                lat_diff = abs(fp.latitude - expected_lat)
                lon_diff = abs(fp.longitude - expected_lon)

                if lat_diff > 20 or lon_diff > 20:
                    warnings.append(
                        f"⚠️ Timezone '{fp.timezone_id}' doesn't match geolocation "
                        f"({fp.latitude}, {fp.longitude})"
                    )

        # Check pixel ratio
        if fp.pixel_ratio:
            if fp.platform == "MacIntel" and fp.pixel_ratio < 2.0:
                warnings.append("⚠️ macOS devices typically have pixel ratio >= 2.0 (Retina)")

        return warnings

    def fix_inconsistencies(self, profile: ChromiumProfile) -> ChromiumProfile:
        """
        Automatically fix common fingerprint inconsistencies.

        Args:
            profile: ChromiumProfile to fix

        Returns:
            Modified ChromiumProfile with fixes applied
        """
        fp = profile.fingerprint

        if not fp or fp.mode == "disabled":
            return profile

        ua = profile.user_agent.lower()

        # Fix platform based on UA
        if "windows" in ua and fp.platform != "Win32":
            fp.platform = "Win32"
            self.logger.info("Fixed platform to Win32 based on User-Agent")
        elif "macintosh" in ua and fp.platform != "MacIntel":
            fp.platform = "MacIntel"
            self.logger.info("Fixed platform to MacIntel based on User-Agent")
        elif "linux" in ua and "android" not in ua and not fp.platform.startswith("Linux"):
            fp.platform = "Linux x86_64"
            self.logger.info("Fixed platform to Linux x86_64 based on User-Agent")

        # Fix viewport to be smaller than screen
        if fp.viewport_width and fp.screen_width and fp.viewport_width > fp.screen_width:
            fp.viewport_width = fp.screen_width
            self.logger.info("Fixed viewport width to match screen width")

        if fp.viewport_height and fp.screen_height:
            if fp.viewport_height >= fp.screen_height:
                # Leave space for browser chrome
                chrome_height = 111 if fp.platform == "MacIntel" else 48
                fp.viewport_height = fp.screen_height - chrome_height
                self.logger.info(f"Fixed viewport height (subtracted {chrome_height}px for browser chrome)")

        return profile
