"""
Automation Manager for thePrivator
Manages browser automation integrations with different frameworks.
"""

import sys
from pathlib import Path
from typing import Dict, Any, Optional, List
from dataclasses import dataclass
from abc import ABC, abstractmethod
import json

# Add src to path
src_dir = Path(__file__).parent.parent.absolute()
if str(src_dir) not in sys.path:
    sys.path.insert(0, str(src_dir))

from utils.logger import get_logger
from utils.exceptions import PrivatorException
from core.profile_manager import ChromiumProfile


class AutomationError(PrivatorException):
    """Automation-related error."""
    pass


@dataclass
class AutomationConfig:
    """Configuration for automation frameworks."""
    
    framework: str  # selenium, playwright, puppeteer
    profile_id: str
    debug_port: Optional[int] = None
    additional_options: Dict[str, Any] = None
    
    def __post_init__(self):
        if self.additional_options is None:
            self.additional_options = {}


class AutomationAdapter(ABC):
    """Base class for automation framework adapters."""
    
    def __init__(self, profile: ChromiumProfile, config: AutomationConfig):
        self.profile = profile
        self.config = config
        self.logger = get_logger(__name__)
        
    @abstractmethod
    def get_connection_info(self) -> Dict[str, Any]:
        """Get connection information for the automation framework."""
        pass
    
    @abstractmethod
    def get_launch_args(self) -> List[str]:
        """Get additional Chromium launch arguments for this framework."""
        pass
    
    @abstractmethod
    def validate_installation(self) -> bool:
        """Check if the automation framework is properly installed."""
        pass
    
    @abstractmethod
    def get_example_code(self) -> str:
        """Get example code for using this automation framework."""
        pass


class AutomationManager:
    """Manages automation framework integrations."""
    
    def __init__(self):
        self.logger = get_logger(__name__)
        self._adapters: Dict[str, type] = {}
        self._register_adapters()
    
    def _register_adapters(self):
        """Register available automation adapters."""
        try:
            from .selenium_adapter import SeleniumAdapter
            self._adapters['selenium'] = SeleniumAdapter
        except ImportError:
            self.logger.debug("Selenium adapter not available")
        
        try:
            from .playwright_adapter import PlaywrightAdapter
            self._adapters['playwright'] = PlaywrightAdapter
        except ImportError:
            self.logger.debug("Playwright adapter not available")
        
        try:
            from .puppeteer_adapter import PuppeteerAdapter
            self._adapters['puppeteer'] = PuppeteerAdapter
        except ImportError:
            self.logger.debug("Puppeteer adapter not available")
    
    def get_available_frameworks(self) -> List[str]:
        """Get list of available automation frameworks."""
        available = []
        for name, adapter_class in self._adapters.items():
            try:
                # Create a dummy config to test validation
                dummy_config = AutomationConfig(framework=name, profile_id="test")
                dummy_profile = ChromiumProfile(
                    id="test",
                    name="test", 
                    user_agent="test"
                )
                adapter = adapter_class(dummy_profile, dummy_config)
                if adapter.validate_installation():
                    available.append(name)
            except Exception:
                pass
        return available
    
    def create_adapter(self, profile: ChromiumProfile, config: AutomationConfig) -> AutomationAdapter:
        """Create an automation adapter for the specified framework."""
        if config.framework not in self._adapters:
            raise AutomationError(f"Unsupported automation framework: {config.framework}")
        
        adapter_class = self._adapters[config.framework]
        adapter = adapter_class(profile, config)
        
        if not adapter.validate_installation():
            raise AutomationError(f"{config.framework} is not properly installed")
        
        return adapter
    
    def get_automation_launch_args(self, profile: ChromiumProfile, framework: str, 
                                 debug_port: Optional[int] = None) -> List[str]:
        """Get additional launch arguments needed for automation."""
        config = AutomationConfig(framework=framework, profile_id=profile.id, debug_port=debug_port)
        adapter = self.create_adapter(profile, config)
        return adapter.get_launch_args()
    
    def get_connection_info(self, profile: ChromiumProfile, framework: str,
                          debug_port: Optional[int] = None) -> Dict[str, Any]:
        """Get connection information for automation framework."""
        config = AutomationConfig(framework=framework, profile_id=profile.id, debug_port=debug_port)
        adapter = self.create_adapter(profile, config)
        return adapter.get_connection_info()
    
    def get_example_code(self, framework: str, profile: ChromiumProfile,
                        debug_port: Optional[int] = None) -> str:
        """Get example code for using the automation framework."""
        config = AutomationConfig(framework=framework, profile_id=profile.id, debug_port=debug_port)
        adapter = self.create_adapter(profile, config)
        return adapter.get_example_code()
    
    def get_framework_info(self) -> Dict[str, Dict[str, Any]]:
        """Get information about all automation frameworks."""
        info = {}
        
        for framework in ['selenium', 'playwright', 'puppeteer']:
            try:
                is_available = framework in self.get_available_frameworks()
                info[framework] = {
                    'available': is_available,
                    'description': self._get_framework_description(framework),
                    'installation_command': self._get_installation_command(framework)
                }
            except Exception as e:
                info[framework] = {
                    'available': False,
                    'error': str(e),
                    'description': self._get_framework_description(framework),
                    'installation_command': self._get_installation_command(framework)
                }
        
        return info
    
    def _get_framework_description(self, framework: str) -> str:
        """Get description for automation framework."""
        descriptions = {
            'selenium': 'WebDriver-based automation framework with broad language support',
            'playwright': 'Modern automation framework with excellent performance and reliability',
            'puppeteer': 'Node.js library for controlling Chrome/Chromium (Python port: pyppeteer)'
        }
        return descriptions.get(framework, 'Unknown framework')
    
    def _get_installation_command(self, framework: str) -> str:
        """Get installation command for automation framework."""
        commands = {
            'selenium': 'pip install selenium',
            'playwright': 'pip install playwright && playwright install chromium',
            'puppeteer': 'pip install pyppeteer'
        }
        return commands.get(framework, 'Unknown installation')