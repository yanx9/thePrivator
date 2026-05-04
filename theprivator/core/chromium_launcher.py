"""Chromium launcher with fixed profile isolation."""

import subprocess
import shutil
import platform
import os
import json
import time
import random
import threading
from pathlib import Path
from typing import List, Optional, Dict, Any
from dataclasses import dataclass
from datetime import datetime
import sys

# Add src to path
src_dir = Path(__file__).parent.parent.absolute()
if str(src_dir) not in sys.path:
    sys.path.insert(0, str(src_dir))

# Optional imports
try:
    import psutil
    HAS_PSUTIL = True
except ImportError:
    psutil = None
    HAS_PSUTIL = False

try:
    import websocket
    HAS_WEBSOCKET = True
except ImportError:
    websocket = None
    HAS_WEBSOCKET = False

try:
    import requests
    HAS_REQUESTS = True
except ImportError:
    requests = None
    HAS_REQUESTS = False

from utils.logger import get_logger
from utils.exceptions import LaunchError
from core.profile_manager import ChromiumProfile
from core.extension_manager import ExtensionManager


@dataclass
class ChromiumProcess:
    """Represents a running Chromium process."""
    
    pid: int
    profile_id: str
    profile_name: str
    command: List[str]
    started_at: str
    
    @property
    def uptime(self) -> str:
        """Returns process uptime."""
        try:
            started = datetime.fromisoformat(self.started_at)
            delta = datetime.now() - started
            hours, remainder = divmod(int(delta.total_seconds()), 3600)
            minutes, seconds = divmod(remainder, 60)
            return f"{hours:02d}:{minutes:02d}:{seconds:02d}"
        except:
            return "N/A"


class ChromiumLauncher:
    """Launches and manages Chromium instances."""
    
    def __init__(self, config_manager=None):
        self.logger = get_logger(__name__)
        self.running_processes: Dict[str, ChromiumProcess] = {}
        self.config_manager = config_manager
        self._chromium_path = self._find_chromium_executable()

        if not HAS_PSUTIL:
            self.logger.warning("psutil not available - limited process management functionality")

        if not HAS_WEBSOCKET:
            self.logger.warning("websocket-client not installed - CDP fingerprint overrides disabled")

        if not HAS_REQUESTS:
            self.logger.warning("requests not installed - CDP fingerprint overrides disabled")
        
    def launch_profile(self, profile: ChromiumProfile, additional_args: Optional[List[str]] = None,
                      headless: bool = False, incognito: bool = False) -> ChromiumProcess:
        """Launches Chromium profile."""
        try:
            if not self._chromium_path:
                raise LaunchError("Chromium executable not found")

            # Check if profile is already running
            if profile.id in self.running_processes:
                if self._is_process_running(self.running_processes[profile.id].pid):
                    raise LaunchError(f"Profile '{profile.name}' is already running")
                else:
                    # Process doesn't exist, remove from list
                    del self.running_processes[profile.id]

            # Prepare extension if fingerprinting is enabled
            extension_path = None
            debug_port = None
            if profile.fingerprint and profile.fingerprint.mode != "disabled":
                try:
                    ext_manager = ExtensionManager(self.config_dir)
                    extension_path = ext_manager.prepare_extension_for_profile(profile)
                    debug_port = 9222  # TODO: Use random port per profile to avoid conflicts
                    self.logger.info(f"Fingerprint protection enabled for '{profile.name}'")
                except Exception as e:
                    self.logger.warning(f"Failed to prepare fingerprint extension: {e}")
                    # Continue without fingerprint protection

            # Build arguments
            args = self._build_chromium_args(profile, additional_args or [], headless, incognito,
                                            extension_path, debug_port)

            # Launch process
            self.logger.info(f"Launching profile: {profile.name}")
            self.logger.debug(f"Arguments: {' '.join(args)}")

            # Platform-specific process launch
            if platform.system() == "Windows":
                creation_flags = subprocess.CREATE_NEW_PROCESS_GROUP
                start_new_session = False
            else:
                creation_flags = 0
                start_new_session = True

            process = subprocess.Popen(
                args,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=creation_flags,
                start_new_session=start_new_session
            )

            # Register process
            chromium_process = ChromiumProcess(
                pid=process.pid,
                profile_id=profile.id,
                profile_name=profile.name,
                command=args,
                started_at=datetime.now().isoformat()
            )

            self.running_processes[profile.id] = chromium_process

            # Apply CDP overrides in background thread (if enabled and dependencies available)
            if debug_port and HAS_WEBSOCKET and HAS_REQUESTS:
                threading.Thread(
                    target=self._apply_cdp_overrides,
                    args=(profile, debug_port),
                    daemon=True,
                    name=f"CDP-{profile.name}"
                ).start()
                self.logger.debug("Started CDP override thread")
            elif debug_port and (not HAS_WEBSOCKET or not HAS_REQUESTS):
                self.logger.warning(
                    "CDP fingerprint overrides disabled - install websocket-client and requests"
                )

            self.logger.info(f"Launched profile '{profile.name}' (PID: {process.pid})")
            return chromium_process

        except Exception as e:
            raise LaunchError(f"Error launching profile: {e}")
            
    def terminate_profile(self, profile_id: str, force: bool = False) -> bool:
        """Terminates profile process."""
        if profile_id not in self.running_processes:
            return False
            
        process_info = self.running_processes[profile_id]
        
        try:
            if HAS_PSUTIL and self._is_process_running(process_info.pid):
                try:
                    parent = psutil.Process(process_info.pid)
                    children = parent.children(recursive=True)
                    
                    if force:
                        # Force termination
                        for child in children:
                            child.kill()
                        parent.kill()
                        psutil.wait_procs([parent] + children, timeout=3)
                    else:
                        # Graceful termination
                        for child in children:
                            child.terminate()
                        parent.terminate()
                        
                        # Wait for termination
                        gone, alive = psutil.wait_procs([parent] + children, timeout=10)
                        
                        # If some processes are still alive, kill them
                        for p in alive:
                            p.kill()
                            
                except psutil.NoSuchProcess:
                    # Process already doesn't exist
                    pass
            else:
                # Fallback without psutil
                try:
                    if platform.system() == "Windows":
                        subprocess.run(["taskkill", "/F", "/PID", str(process_info.pid)], 
                                     capture_output=True)
                    else:
                        subprocess.run(["kill", "-9", str(process_info.pid)], 
                                     capture_output=True)
                except:
                    pass
                    
            del self.running_processes[profile_id]
            self.logger.info(f"Terminated profile '{process_info.profile_name}'")
            return True
            
        except Exception as e:
            self.logger.error(f"Error terminating process: {e}")
            return False
            
    def terminate_all_profiles(self) -> int:
        """Terminates all running profiles."""
        terminated_count = 0
        profile_ids = list(self.running_processes.keys())
        
        for profile_id in profile_ids:
            if self.terminate_profile(profile_id):
                terminated_count += 1
                
        return terminated_count
        
    def get_running_profiles(self) -> List[ChromiumProcess]:
        """Gets list of running profiles."""
        # Clean up inactive processes
        inactive_profiles = []
        for profile_id, process_info in self.running_processes.items():
            if not self._is_process_running(process_info.pid):
                inactive_profiles.append(profile_id)
                
        for profile_id in inactive_profiles:
            del self.running_processes[profile_id]
            
        return list(self.running_processes.values())
        
    def get_profile_process(self, profile_id: str) -> Optional[ChromiumProcess]:
        """Gets process information for profile."""
        if profile_id in self.running_processes:
            if self._is_process_running(self.running_processes[profile_id].pid):
                return self.running_processes[profile_id]
            else:
                del self.running_processes[profile_id]
        return None
        
    def is_profile_running(self, profile_id: str) -> bool:
        """Checks if profile is running."""
        return self.get_profile_process(profile_id) is not None
        
    def get_process_stats(self, profile_id: str) -> Optional[Dict[str, Any]]:
        """Gets process statistics."""
        process_info = self.get_profile_process(profile_id)
        if not process_info:
            return None
            
        try:
            if HAS_PSUTIL:
                process = psutil.Process(process_info.pid)
                return {
                    'pid': process_info.pid,
                    'name': process.name(),
                    'status': process.status(),
                    'cpu_percent': process.cpu_percent(),
                    'memory_info': process.memory_info()._asdict(),
                    'num_threads': process.num_threads(),
                    'create_time': process.create_time(),
                    'uptime': process_info.uptime
                }
            else:
                return {
                    'pid': process_info.pid,
                    'uptime': process_info.uptime
                }
        except (psutil.NoSuchProcess if HAS_PSUTIL else Exception):
            return None
        except Exception as e:
            self.logger.warning(f"Error getting process stats: {e}")
            return None
            
    def cleanup_orphaned_processes(self) -> int:
        """Cleans up orphaned processes more efficiently."""
        cleaned = 0
        to_remove = []
        
        for profile_id, process_info in self.running_processes.items():
            if not self._is_process_running(process_info.pid):
                to_remove.append(profile_id)
                cleaned += 1
        
        # Remove outside of iteration to avoid dict size change during iteration
        for profile_id in to_remove:
            del self.running_processes[profile_id]
        
        if cleaned > 0:
            self.logger.info(f"Cleaned up {cleaned} orphaned processes")
            
        return cleaned
        
    def _find_chromium_executable(self) -> Optional[str]:
        """Finds Chromium executable path."""
        # Check for custom chromium path first
        if self.config_manager:
            custom_path = self.config_manager.get('custom_chromium_path', '').strip()
            if custom_path:
                if Path(custom_path).exists():
                    self.logger.info(f"Using custom Chromium path: {custom_path}")
                    return custom_path
                else:
                    self.logger.warning(f"Custom Chromium path not found: {custom_path}")
        
        system = platform.system()
        
        if system == "Windows":
            possible_paths = [
                "C:/Program Files/Google/Chrome/Application/chrome.exe",
                "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
                f"C:/Users/{os.getenv('USERNAME', '')}/AppData/Local/Google/Chrome/Application/chrome.exe",
                "C:/Program Files/Chromium/Application/chromium.exe",
            ]
            
            # Check paths directly
            for path in possible_paths:
                if Path(path).exists():
                    self.logger.info(f"Found Chromium: {path}")
                    return path
                    
        # Check in PATH
        possible_names = [
            'chromium-browser',
            'chromium',
            'google-chrome',
            'google-chrome-stable',
            'chrome'
        ]
        
        for name in possible_names:
            path = shutil.which(name)
            if path:
                self.logger.info(f"Found Chromium: {path}")
                return path
                
        self.logger.warning("Chromium executable not found")
        return None
        
    def _build_chromium_args(self, profile: ChromiumProfile, additional_args: List[str],
                           headless: bool = False, incognito: bool = False,
                           extension_path: Optional[Path] = None,
                           debug_port: Optional[int] = None) -> List[str]:
        """Builds Chromium arguments with proper profile isolation."""
        args = [self._chromium_path]

        # CRITICAL FIX: Ensure user data directory is absolute and properly formatted
        if profile.user_data_dir and not incognito:
            # Convert to absolute path
            user_data_path = Path(profile.user_data_dir).absolute()

            # Ensure directory exists
            user_data_path.mkdir(parents=True, exist_ok=True)

            # Use the absolute path string
            user_data_str = str(user_data_path)

            # On Windows, ensure proper formatting
            if platform.system() == "Windows":
                user_data_str = user_data_str.replace('/', '\\')

            args.append(f'--user-data-dir={user_data_str}')

            # Also set profile directory name (usually Default)
            args.append('--profile-directory=Default')

            self.logger.info(f"Using user data directory: {user_data_str}")
        else:
            self.logger.warning(f"No user data directory for profile: {profile.name}")

        # User-Agent
        if profile.user_agent:
            args.append(f'--user-agent={profile.user_agent}')

        # Proxy
        if profile.proxy:
            args.append(f'--proxy-server={profile.proxy}')

        # Extension for fingerprint protection
        if extension_path:
            extension_str = str(extension_path.absolute())
            if platform.system() == "Windows":
                extension_str = extension_str.replace('/', '\\')
            args.append(f'--load-extension={extension_str}')
            self.logger.debug(f"Loading extension from: {extension_str}")

        # Remote debugging port for CDP
        if debug_port:
            args.append(f'--remote-debugging-port={debug_port}')
            args.append('--remote-allow-origins=*')  # Allow CDP connection from localhost
            self.logger.debug(f"Remote debugging enabled on port {debug_port}")

        # Incognito mode
        if incognito:
            args.append('--incognito')

        # Headless mode
        if headless:
            args.extend(['--headless', '--disable-gpu'])
            
        # Standard security and privacy arguments
        security_args = [
            '--no-first-run',
            '--disable-default-apps',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            '--disable-background-networking',
            '--disable-sync',
            '--disable-translate',
            '--disable-features=TranslateUI',
            '--disable-ipc-flooding-protection',
            '--memory-pressure-off',
            '--max_old_space_size=4096',
            '--no-default-browser-check'
        ]
        
        args.extend(security_args)
        
        # System-specific arguments
        if platform.system() == "Linux":
            args.extend([
                '--no-sandbox',  # Often needed on Linux
                '--disable-dev-shm-usage'
            ])
            
        # Additional arguments
        args.extend(additional_args)
        
        return args
        
    def _is_process_running(self, pid: int) -> bool:
        """Checks if process is running more efficiently."""
        try:
            if HAS_PSUTIL:
                # Quick check if process exists
                if not psutil.pid_exists(pid):
                    return False
                try:
                    proc = psutil.Process(pid)
                    # Check if it's actually running (not zombie)
                    return proc.status() != psutil.STATUS_ZOMBIE
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    return False
            else:
                # Fallback without psutil
                if platform.system() == "Windows":
                    result = subprocess.run(
                        ["tasklist", "/FI", f"PID eq {pid}"],
                        capture_output=True,
                        text=True,
                        timeout=1  # Add timeout to prevent hanging
                    )
                    return str(pid) in result.stdout
                else:
                    try:
                        os.kill(pid, 0)  # More efficient than subprocess
                        return True
                    except OSError:
                        return False
        except Exception as e:
            self.logger.debug(f"Error checking process {pid}: {e}")
            return False

    @property
    def config_dir(self) -> Path:
        """Get config directory for thePrivator."""
        if self.config_manager:
            custom_dir = self.config_manager.get('custom_data_directory', '').strip()
            if custom_dir:
                return Path(custom_dir)
        return Path.home() / ".theprivator"

    def _apply_cdp_overrides(self, profile: ChromiumProfile, debug_port: int):
        """
        Applies CDP-based fingerprint overrides after browser launch.
        """
        time.sleep(3)  # Wait for browser and initial page to load

        try:
            # 1. Get targets list to find a page
            resp = requests.get(f"http://localhost:{debug_port}/json", timeout=5)
            targets = resp.json()
            
            # Find the first 'page' target
            page_target = next((t for t in targets if t.get('type') == 'page'), None)
            
            if not page_target:
                self.logger.warning("No page target found for CDP overrides")
                return

            ws_url = page_target.get('webSocketDebuggerUrl')
            if not ws_url:
                self.logger.warning("No WebSocket URL for page target")
                return

            # Connect to Page CDP via WebSocket
            ws = websocket.create_connection(ws_url, timeout=5)
            fp = profile.fingerprint

            # Apply overrides...

            # Apply timezone override
            if fp.timezone_id:
                self._send_cdp(ws, "Emulation.setTimezoneOverride", {
                    "timezoneId": fp.timezone_id
                })
                self.logger.debug(f"Applied timezone: {fp.timezone_id}")

            # Apply geolocation override
            if fp.latitude is not None and fp.longitude is not None:
                self._send_cdp(ws, "Emulation.setGeolocationOverride", {
                    "latitude": fp.latitude,
                    "longitude": fp.longitude,
                    "accuracy": fp.accuracy or 10
                })
                self.logger.debug(f"Applied geolocation: {fp.latitude}, {fp.longitude}")

            # Apply locale override
            if fp.locale:
                self._send_cdp(ws, "Emulation.setLocaleOverride", {
                    "locale": fp.locale
                })
                self.logger.debug(f"Applied locale: {fp.locale}")

            # Apply User-Agent Client Hints
            if fp.ua_platform:
                ua_metadata = {
                    "platform": fp.ua_platform,
                    "platformVersion": fp.ua_platform_version or "10.0.0",
                    "architecture": fp.ua_architecture or "x86",
                    "model": "",
                    "mobile": fp.ua_mobile
                }

                # Extract Chrome version from UA for brands
                brands = self._extract_ua_brands(profile.user_agent)

                if brands:
                    ua_metadata["brands"] = brands
                    ua_metadata["fullVersion"] = self._extract_chrome_version(profile.user_agent)

                self._send_cdp(ws, "Network.setUserAgentOverride", {
                    "userAgent": profile.user_agent,
                    "acceptLanguage": ",".join(fp.languages),
                    "platform": fp.ua_platform,
                    "userAgentMetadata": ua_metadata
                })
                self.logger.debug("Applied User-Agent client hints")

            ws.close()
            self.logger.info(f"CDP fingerprint overrides applied for '{profile.name}'")

        except Exception as e:
            self.logger.warning(f"Failed to apply CDP overrides: {e}")

    def _send_cdp(self, ws, method: str, params: dict) -> dict:
        """
        Send CDP command via WebSocket.

        Args:
            ws: WebSocket connection
            method: CDP method name (e.g., "Emulation.setTimezoneOverride")
            params: Method parameters

        Returns:
            Response from CDP
        """
        command_id = random.randint(1, 100000)
        message = json.dumps({
            "id": command_id,
            "method": method,
            "params": params
        })

        ws.send(message)
        result = ws.recv()
        response = json.loads(result)

        if "error" in response:
            self.logger.warning(f"CDP error for {method}: {response['error']}")

        return response

    def _extract_ua_brands(self, user_agent: str) -> list:
        """Extract browser brands from User-Agent for Client Hints."""
        brands = []

        if "Chrome" in user_agent:
            # Extract Chrome version
            import re
            match = re.search(r'Chrome/([\d.]+)', user_agent)
            if match:
                version = match.group(1).split('.')[0]  # Major version
                brands.append({"brand": "Google Chrome", "version": version})
                brands.append({"brand": "Chromium", "version": version})
                brands.append({"brand": "Not=A?Brand", "version": "8"})  # Anti-fingerprinting

        if "Edg" in user_agent:
            import re
            match = re.search(r'Edg/([\d.]+)', user_agent)
            if match:
                version = match.group(1).split('.')[0]
                brands.append({"brand": "Microsoft Edge", "version": version})

        return brands

    def _extract_chrome_version(self, user_agent: str) -> str:
        """Extract full Chrome version from User-Agent."""
        import re
        match = re.search(r'Chrome/([\d.]+)', user_agent)
        if match:
            return match.group(1)
        return "120.0.0.0"