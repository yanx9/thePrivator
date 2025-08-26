"""Chromium launcher with fixed profile isolation."""

import subprocess
import shutil
import platform
import os
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

from utils.logger import get_logger
from utils.exceptions import LaunchError
from core.profile_manager import ChromiumProfile


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
    
    def __init__(self):
        self.logger = get_logger(__name__)
        self.running_processes: Dict[str, ChromiumProcess] = {}
        self._chromium_path = self._find_chromium_executable()
        
        if not HAS_PSUTIL:
            self.logger.warning("psutil not available - limited process management functionality")
        
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
                    
            # Build arguments
            args = self._build_chromium_args(profile, additional_args or [], headless, incognito)
            
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
        """Cleans up orphaned processes."""
        cleaned = 0
        for profile_id in list(self.running_processes.keys()):
            if not self._is_process_running(self.running_processes[profile_id].pid):
                del self.running_processes[profile_id]
                cleaned += 1
                
        if cleaned > 0:
            self.logger.info(f"Cleaned up {cleaned} orphaned processes")
            
        return cleaned
        
    def _find_chromium_executable(self) -> Optional[str]:
        """Finds Chromium executable path."""
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
                           headless: bool = False, incognito: bool = False) -> List[str]:
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
        """Checks if process is running."""
        try:
            if HAS_PSUTIL:
                return psutil.pid_exists(pid) and psutil.Process(pid).is_running()
            else:
                # Fallback without psutil
                if platform.system() == "Windows":
                    result = subprocess.run(
                        ["tasklist", "/FI", f"PID eq {pid}"],
                        capture_output=True,
                        text=True
                    )
                    return str(pid) in result.stdout
                else:
                    result = subprocess.run(
                        ["kill", "-0", str(pid)],
                        capture_output=True
                    )
                    return result.returncode == 0
        except:
            return False