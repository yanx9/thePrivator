"""Fingerprint presets for common OS/browser combinations."""

# Comprehensive list of realistic fingerprint presets
# Each preset should have consistent values (UA → platform → screen → timezone → etc.)

FINGERPRINT_PRESETS = {
    "Windows 10 Chrome 120": {
        "description": "Windows 10 with Chrome 120 (1920x1080)",
        "user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "fingerprint": {
            "mode": "simple",
            "platform": "Win32",
            "screen_width": 1920,
            "screen_height": 1080,
            "viewport_width": 1920,
            "viewport_height": 1032,
            "color_depth": 24,
            "pixel_ratio": 1.0,
            "timezone_id": "America/New_York",
            "languages": ["en-US", "en"],
            "locale": "en-US",
            "hardware_concurrency": 8,
            "device_memory": 8,
            "ua_platform": "Windows",
            "ua_platform_version": "10.0.0",
            "ua_architecture": "x86",
            "ua_mobile": False,
            "webgl_vendor": "Google Inc. (NVIDIA)",
            "webgl_renderer": "ANGLE (NVIDIA, NVIDIA GeForce GTX 1060 Direct3D11 vs_5_0 ps_5_0)",
        }
    },

    "Windows 11 Chrome 121": {
        "description": "Windows 11 with Chrome 121 (2560x1440)",
        "user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
        "fingerprint": {
            "mode": "simple",
            "platform": "Win32",
            "screen_width": 2560,
            "screen_height": 1440,
            "viewport_width": 2560,
            "viewport_height": 1372,
            "color_depth": 24,
            "pixel_ratio": 1.0,
            "timezone_id": "America/Chicago",
            "languages": ["en-US", "en"],
            "locale": "en-US",
            "hardware_concurrency": 16,
            "device_memory": 16,
            "ua_platform": "Windows",
            "ua_platform_version": "10.0.0",
            "ua_architecture": "x86",
            "ua_mobile": False,
            "webgl_vendor": "Google Inc. (NVIDIA)",
            "webgl_renderer": "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0)",
        }
    },

    "Windows 10 Edge 120": {
        "description": "Windows 10 with Microsoft Edge 120",
        "user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0",
        "fingerprint": {
            "mode": "simple",
            "platform": "Win32",
            "screen_width": 1920,
            "screen_height": 1080,
            "viewport_width": 1920,
            "viewport_height": 1032,
            "color_depth": 24,
            "pixel_ratio": 1.0,
            "timezone_id": "America/Los_Angeles",
            "languages": ["en-US", "en"],
            "locale": "en-US",
            "hardware_concurrency": 12,
            "device_memory": 16,
            "ua_platform": "Windows",
            "ua_platform_version": "10.0.0",
            "ua_architecture": "x86",
            "ua_mobile": False,
            "webgl_vendor": "Google Inc. (Intel)",
            "webgl_renderer": "ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0)",
        }
    },

    "Windows 10 Firefox 121": {
        "description": "Windows 10 with Firefox 121",
        "user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
        "fingerprint": {
            "mode": "simple",
            "platform": "Win32",
            "screen_width": 1920,
            "screen_height": 1080,
            "viewport_width": 1920,
            "viewport_height": 1032,
            "color_depth": 24,
            "pixel_ratio": 1.0,
            "timezone_id": "America/Denver",
            "languages": ["en-US", "en"],
            "locale": "en-US",
            "hardware_concurrency": 8,
            "device_memory": 8,
            "ua_platform": "Windows",
            "ua_platform_version": "10.0",
            "ua_architecture": "x86",
            "ua_mobile": False,
            "webgl_vendor": "Google Inc. (NVIDIA)",
            "webgl_renderer": "ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 Ti Direct3D11 vs_5_0 ps_5_0)",
        }
    },

    "macOS Sonoma Safari 17": {
        "description": "macOS 14 Sonoma with Safari 17",
        "user_agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2.1 Safari/605.1.15",
        "fingerprint": {
            "mode": "simple",
            "platform": "MacIntel",
            "screen_width": 2560,
            "screen_height": 1440,
            "viewport_width": 2560,
            "viewport_height": 1310,
            "color_depth": 24,
            "pixel_ratio": 2.0,
            "timezone_id": "America/Los_Angeles",
            "languages": ["en-US", "en"],
            "locale": "en-US",
            "hardware_concurrency": 10,
            "device_memory": 16,
            "ua_platform": "macOS",
            "ua_platform_version": "14.2.0",
            "ua_architecture": "x86",
            "ua_mobile": False,
            "webgl_vendor": "Apple",
            "webgl_renderer": "Apple M2",
        }
    },

    "macOS Ventura Chrome 120": {
        "description": "macOS 13 Ventura with Chrome 120",
        "user_agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "fingerprint": {
            "mode": "simple",
            "platform": "MacIntel",
            "screen_width": 1920,
            "screen_height": 1080,
            "viewport_width": 1920,
            "viewport_height": 969,
            "color_depth": 24,
            "pixel_ratio": 2.0,
            "timezone_id": "America/New_York",
            "languages": ["en-US", "en"],
            "locale": "en-US",
            "hardware_concurrency": 8,
            "device_memory": 8,
            "ua_platform": "macOS",
            "ua_platform_version": "13.6.0",
            "ua_architecture": "x86",
            "ua_mobile": False,
            "webgl_vendor": "Google Inc. (Apple)",
            "webgl_renderer": "ANGLE (Apple, Apple M1 Pro, OpenGL 4.1)",
        }
    },

    "macOS Monterey Firefox 121": {
        "description": "macOS 12 Monterey with Firefox 121",
        "user_agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:121.0) Gecko/20100101 Firefox/121.0",
        "fingerprint": {
            "mode": "simple",
            "platform": "MacIntel",
            "screen_width": 1440,
            "screen_height": 900,
            "viewport_width": 1440,
            "viewport_height": 789,
            "color_depth": 24,
            "pixel_ratio": 2.0,
            "timezone_id": "America/Chicago",
            "languages": ["en-US", "en"],
            "locale": "en-US",
            "hardware_concurrency": 8,
            "device_memory": 16,
            "ua_platform": "macOS",
            "ua_platform_version": "12.7.0",
            "ua_architecture": "x86",
            "ua_mobile": False,
            "webgl_vendor": "Google Inc. (Apple)",
            "webgl_renderer": "ANGLE (Apple, Apple M1, OpenGL 4.1)",
        }
    },

    "Ubuntu Linux Chrome 120": {
        "description": "Ubuntu 22.04 Linux with Chrome 120",
        "user_agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "fingerprint": {
            "mode": "simple",
            "platform": "Linux x86_64",
            "screen_width": 1920,
            "screen_height": 1080,
            "viewport_width": 1920,
            "viewport_height": 1032,
            "color_depth": 24,
            "pixel_ratio": 1.0,
            "timezone_id": "America/New_York",
            "languages": ["en-US", "en"],
            "locale": "en-US",
            "hardware_concurrency": 8,
            "device_memory": 8,
            "ua_platform": "Linux",
            "ua_platform_version": "",
            "ua_architecture": "x86",
            "ua_mobile": False,
            "webgl_vendor": "Google Inc. (Intel)",
            "webgl_renderer": "ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL 4.6)",
        }
    },

    "Ubuntu Linux Firefox 121": {
        "description": "Ubuntu 22.04 Linux with Firefox 121",
        "user_agent": "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0",
        "fingerprint": {
            "mode": "simple",
            "platform": "Linux x86_64",
            "screen_width": 2560,
            "screen_height": 1440,
            "viewport_width": 2560,
            "viewport_height": 1372,
            "color_depth": 24,
            "pixel_ratio": 1.0,
            "timezone_id": "Europe/London",
            "languages": ["en-US", "en-GB", "en"],
            "locale": "en-US",
            "hardware_concurrency": 16,
            "device_memory": 16,
            "ua_platform": "Linux",
            "ua_platform_version": "",
            "ua_architecture": "x86",
            "ua_mobile": False,
            "webgl_vendor": "Google Inc. (AMD)",
            "webgl_renderer": "ANGLE (AMD, AMD Radeon RX 580 (POLARIS10, DRM 3.42.0, 5.15.0-91-generic, LLVM 12.0.0), OpenGL 4.6)",
        }
    },

    "Android Chrome 120": {
        "description": "Android 13 with Chrome 120 Mobile",
        "user_agent": "Mozilla/5.0 (Linux; Android 13; SM-G998B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
        "fingerprint": {
            "mode": "simple",
            "platform": "Linux armv81",
            "screen_width": 1080,
            "screen_height": 2400,
            "viewport_width": 412,
            "viewport_height": 915,
            "color_depth": 24,
            "pixel_ratio": 3.5,
            "timezone_id": "America/New_York",
            "languages": ["en-US", "en"],
            "locale": "en-US",
            "hardware_concurrency": 8,
            "device_memory": 8,
            "ua_platform": "Android",
            "ua_platform_version": "13.0.0",
            "ua_architecture": "arm",
            "ua_mobile": True,
            "webgl_vendor": "Google Inc. (Qualcomm)",
            "webgl_renderer": "ANGLE (Qualcomm, Adreno (TM) 660, OpenGL ES 3.2)",
        }
    },

    "Windows 10 Chrome 120 (1366x768)": {
        "description": "Windows 10 Chrome 120 - Laptop Display",
        "user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "fingerprint": {
            "mode": "simple",
            "platform": "Win32",
            "screen_width": 1366,
            "screen_height": 768,
            "viewport_width": 1366,
            "viewport_height": 700,
            "color_depth": 24,
            "pixel_ratio": 1.0,
            "timezone_id": "America/Phoenix",
            "languages": ["en-US", "en"],
            "locale": "en-US",
            "hardware_concurrency": 4,
            "device_memory": 8,
            "ua_platform": "Windows",
            "ua_platform_version": "10.0.0",
            "ua_architecture": "x86",
            "ua_mobile": False,
            "webgl_vendor": "Google Inc. (Intel)",
            "webgl_renderer": "ANGLE (Intel, Intel(R) HD Graphics 620 Direct3D11 vs_5_0 ps_5_0)",
        }
    },

    "Windows 11 Chrome 120 (4K)": {
        "description": "Windows 11 Chrome 120 - 4K Display",
        "user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "fingerprint": {
            "mode": "simple",
            "platform": "Win32",
            "screen_width": 3840,
            "screen_height": 2160,
            "viewport_width": 3840,
            "viewport_height": 2092,
            "color_depth": 24,
            "pixel_ratio": 1.0,
            "timezone_id": "America/Los_Angeles",
            "languages": ["en-US", "en"],
            "locale": "en-US",
            "hardware_concurrency": 16,
            "device_memory": 32,
            "ua_platform": "Windows",
            "ua_platform_version": "10.0.0",
            "ua_architecture": "x86",
            "ua_mobile": False,
            "webgl_vendor": "Google Inc. (NVIDIA)",
            "webgl_renderer": "ANGLE (NVIDIA, NVIDIA GeForce RTX 4090 Direct3D11 vs_5_0 ps_5_0)",
        }
    },

    "macOS Apple Silicon Chrome 120": {
        "description": "macOS 14 on Apple Silicon (M1/M2) with Chrome 120",
        "user_agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "fingerprint": {
            "mode": "simple",
            "platform": "MacIntel",
            "screen_width": 1512,
            "screen_height": 982,
            "viewport_width": 1512,
            "viewport_height": 871,
            "color_depth": 30,
            "pixel_ratio": 2.0,
            "timezone_id": "America/Los_Angeles",
            "languages": ["en-US", "en"],
            "locale": "en-US",
            "hardware_concurrency": 10,
            "device_memory": 16,
            "ua_platform": "macOS",
            "ua_platform_version": "14.2.0",
            "ua_architecture": "arm",
            "ua_mobile": False,
            "webgl_vendor": "Google Inc. (Apple)",
            "webgl_renderer": "ANGLE (Apple, Apple M2 Max, OpenGL 4.1)",
        }
    },

    "Debian Linux Chrome 120": {
        "description": "Debian 12 Linux with Chrome 120",
        "user_agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "fingerprint": {
            "mode": "simple",
            "platform": "Linux x86_64",
            "screen_width": 1920,
            "screen_height": 1200,
            "viewport_width": 1920,
            "viewport_height": 1132,
            "color_depth": 24,
            "pixel_ratio": 1.0,
            "timezone_id": "Europe/Berlin",
            "languages": ["en-US", "en", "de"],
            "locale": "en-US",
            "hardware_concurrency": 12,
            "device_memory": 16,
            "ua_platform": "Linux",
            "ua_platform_version": "",
            "ua_architecture": "x86",
            "ua_mobile": False,
            "webgl_vendor": "Google Inc. (Intel)",
            "webgl_renderer": "ANGLE (Intel, Mesa Intel(R) HD Graphics 530 (SKL GT2), OpenGL 4.6)",
        }
    },

    "iPad Pro Safari 17": {
        "description": "iPad Pro 12.9-inch with Safari 17",
        "user_agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15",
        "fingerprint": {
            "mode": "simple",
            "platform": "MacIntel",
            "screen_width": 1024,
            "screen_height": 1366,
            "viewport_width": 1024,
            "viewport_height": 1255,
            "color_depth": 24,
            "pixel_ratio": 2.0,
            "timezone_id": "America/New_York",
            "languages": ["en-US", "en"],
            "locale": "en-US",
            "hardware_concurrency": 8,
            "device_memory": 8,
            "ua_platform": "iPad",
            "ua_platform_version": "17.2.0",
            "ua_architecture": "arm",
            "ua_mobile": False,  # iPadOS reports as desktop
            "webgl_vendor": "Apple",
            "webgl_renderer": "Apple GPU",
        }
    },
}


def get_preset_names() -> list:
    """Returns list of preset names."""
    return list(FINGERPRINT_PRESETS.keys())


def get_preset(name: str) -> dict:
    """Returns preset configuration by name."""
    return FINGERPRINT_PRESETS.get(name)


def get_presets_by_os(os_type: str) -> list:
    """Returns list of presets for specific OS type."""
    os_keywords = {
        "windows": ["Windows"],
        "macos": ["macOS", "Mac OS"],
        "linux": ["Linux", "Ubuntu", "Debian"],
        "android": ["Android"],
        "ios": ["iPad", "iPhone"]
    }

    keywords = os_keywords.get(os_type.lower(), [])
    return [
        name for name, preset in FINGERPRINT_PRESETS.items()
        if any(keyword in preset["description"] for keyword in keywords)
    ]