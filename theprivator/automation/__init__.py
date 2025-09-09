"""
Automation support for thePrivator
Provides integration with popular browser automation frameworks.
"""

from .automation_manager import AutomationManager, AutomationConfig
from .selenium_adapter import SeleniumAdapter
from .playwright_adapter import PlaywrightAdapter
from .puppeteer_adapter import PuppeteerAdapter

__all__ = [
    'AutomationManager',
    'AutomationConfig', 
    'SeleniumAdapter',
    'PlaywrightAdapter',
    'PuppeteerAdapter'
]