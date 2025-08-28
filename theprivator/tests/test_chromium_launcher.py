"""Tests for ChromiumLauncher."""

import pytest
from unittest.mock import Mock, patch, MagicMock
import subprocess

from theprivator.core.chromium_launcher import ChromiumLauncher, ChromiumProcess
from theprivator.core.profile_manager import ChromiumProfile
from theprivator.utils.exceptions import LaunchError


class TestChromiumLauncher:
    """Test class for ChromiumLauncher."""
    
    def setup_method(self):
        """Setup for each test method."""
        self.launcher = ChromiumLauncher()
        self.test_profile = ChromiumProfile(
            id="test-id",
            name="Test Profile",
            user_agent="Mozilla/5.0 (Test) Chrome/100.0",
            user_data_dir="/tmp/test-profile"
        )
        
    @patch('shutil.which')
    def test_find_chromium_executable(self, mock_which):
        """Test finding Chromium executable."""
        mock_which.return_value = "/usr/bin/chromium"
        
        launcher = ChromiumLauncher()
        assert launcher._chromium_path == "/usr/bin/chromium"
        
    @patch('shutil.which')
    def test_chromium_not_found(self, mock_which):
        """Test when Chromium is not found."""
        mock_which.return_value = None
        
        launcher = ChromiumLauncher()
        assert launcher._chromium_path is None
        
    def test_build_chromium_args(self):
        """Test building Chromium arguments."""
        self.launcher._chromium_path = "/usr/bin/chromium"
        
        args = self.launcher._build_chromium_args(
            self.test_profile,
            ["--additional-arg"],
            headless=True,
            incognito=True
        )
        
        assert "/usr/bin/chromium" in args
        assert "--user-data-dir" in args
        assert "/tmp/test-profile" in args
        assert "--user-agent" in args
        assert "--headless" in args
        assert "--incognito" in args
        assert "--additional-arg" in args
        
    @patch('subprocess.Popen')
    @patch('psutil.pid_exists')
    def test_launch_profile_success(self, mock_pid_exists, mock_popen):
        """Test successful profile launch."""
        # Setup mocks
        mock_process = Mock()
        mock_process.pid = 12345
        mock_popen.return_value = mock_process
        mock_pid_exists.return_value = True
        
        self.launcher._chromium_path = "/usr/bin/chromium"
        
        # Launch profile
        result = self.launcher.launch_profile(self.test_profile)
        
        assert isinstance(result, ChromiumProcess)
        assert result.pid == 12345
        assert result.profile_id == "test-id"
        assert result.profile_name == "Test Profile"
        
    def test_launch_profile_no_executable(self):
        """Test launching profile when Chromium not found."""
        self.launcher._chromium_path = None
        
        with pytest.raises(LaunchError):
            self.launcher.launch_profile(self.test_profile)
            
    @patch('psutil.pid_exists')
    def test_launch_profile_already_running(self, mock_pid_exists):
        """Test launching profile that's already running."""
        mock_pid_exists.return_value = True
        
        # Add fake running process
        fake_process = ChromiumProcess(
            pid=12345,
            profile_id="test-id",
            profile_name="Test Profile",
            command=[],
            started_at="2023-01-01T00:00:00"
        )
        self.launcher.running_processes["test-id"] = fake_process
        
        with pytest.raises(LaunchError):
            self.launcher.launch_profile(self.test_profile)
            
    @patch('psutil.Process')
    @patch('psutil.pid_exists')
    def test_terminate_profile_success(self, mock_pid_exists, mock_process_class):
        """Test successful profile termination."""
        # Setup mocks
        mock_pid_exists.return_value = True
        mock_process = Mock()
        mock_process.children.return_value = []
        mock_process_class.return_value = mock_process
        
        # Add fake running process
        fake_process = ChromiumProcess(
            pid=12345,
            profile_id="test-id",
            profile_name="Test Profile",
            command=[],
            started_at="2023-01-01T00:00:00"
        )
        self.launcher.running_processes["test-id"] = fake_process
        
        # Terminate profile
        result = self.launcher.terminate_profile("test-id")
        
        assert result is True
        assert "test-id" not in self.launcher.running_processes
        
    def test_terminate_profile_not_running(self):
        """Test terminating profile that's not running."""
        result = self.launcher.terminate_profile("non-existent")
        assert result is False
        
    @patch('psutil.pid_exists')
    def test_is_profile_running(self, mock_pid_exists):
        """Test checking if profile is running."""
        mock_pid_exists.return_value = True
        
        # Add fake running process
        fake_process = ChromiumProcess(
            pid=12345,
            profile_id="test-id",
            profile_name="Test Profile",
            command=[],
            started_at="2023-01-01T00:00:00"
        )
        self.launcher.running_processes["test-id"] = fake_process
        
        assert self.launcher.is_profile_running("test-id") is True
        assert self.launcher.is_profile_running("non-existent") is False
        
    @patch('psutil.pid_exists')
    def test_cleanup_orphaned_processes(self, mock_pid_exists):
        """Test cleaning up orphaned processes."""
        mock_pid_exists.return_value = False  # Process doesn't exist
        
        # Add fake orphaned process
        fake_process = ChromiumProcess(
            pid=12345,
            profile_id="test-id",
            profile_name="Test Profile",
            command=[],
            started_at="2023-01-01T00:00:00"
        )
        self.launcher.running_processes["test-id"] = fake_process
        
        cleaned = self.launcher.cleanup_orphaned_processes()
        
        assert cleaned == 1
        assert "test-id" not in self.launcher.running_processes


class TestChromiumProcess:
    """Test class for ChromiumProcess."""
    
    def test_uptime_calculation(self):
        """Test uptime calculation."""
        from datetime import datetime, timedelta
        
        # Create process started 1 hour ago
        start_time = datetime.now() - timedelta(hours=1, minutes=30, seconds=45)
        
        process = ChromiumProcess(
            pid=12345,
            profile_id="test-id",
            profile_name="Test",
            command=[],
            started_at=start_time.isoformat()
        )
        
        uptime = process.uptime
        # Should be approximately "01:30:45"
        assert "01:30:" in uptime