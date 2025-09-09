"""
Selenium adapter for thePrivator automation.
"""

import platform
from typing import Dict, Any, List
from .automation_manager import AutomationAdapter, AutomationError


class SeleniumAdapter(AutomationAdapter):
    """Selenium WebDriver adapter."""
    
    def validate_installation(self) -> bool:
        """Check if Selenium is properly installed."""
        try:
            import selenium
            from selenium import webdriver
            from selenium.webdriver.chrome.options import Options
            return True
        except ImportError:
            return False
    
    def get_launch_args(self) -> List[str]:
        """Get additional Chromium launch arguments for Selenium."""
        debug_port = self.config.debug_port or 9222
        
        args = [
            f'--remote-debugging-port={debug_port}',
            '--no-first-run',
            '--disable-default-apps',
            '--disable-popup-blocking',
            '--disable-translate',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            '--disable-features=TranslateUI,BlinkGenPropertyTrees'
        ]
        
        return args
    
    def get_connection_info(self) -> Dict[str, Any]:
        """Get connection information for Selenium."""
        debug_port = self.config.debug_port or 9222
        
        return {
            'framework': 'selenium',
            'debug_port': debug_port,
            'debugging_url': f'http://127.0.0.1:{debug_port}',
            'user_data_dir': self.profile.user_data_dir,
            'connection_method': 'webdriver_options',
            'notes': 'Use Chrome options to connect to existing session'
        }
    
    def get_example_code(self) -> str:
        """Get example code for Selenium."""
        debug_port = self.config.debug_port or 9222
        
        return f'''
# Selenium WebDriver Example for Profile: {self.profile.name}
import time
from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC

def connect_to_profile():
    """Connect to the running thePrivator profile."""
    
    # Chrome options for connecting to existing session
    options = Options()
    options.add_experimental_option("debuggerAddress", "127.0.0.1:{debug_port}")
    
    # Additional options to match profile settings
    if "{self.profile.user_agent}":
        options.add_argument("--user-agent={self.profile.user_agent}")
    
    # Connect to the existing browser instance
    driver = webdriver.Chrome(options=options)
    return driver

def automation_example():
    """Example automation script."""
    driver = None
    try:
        # Connect to the profile
        print("Connecting to thePrivator profile...")
        driver = connect_to_profile()
        
        # Navigate to a website
        print("Navigating to example.com...")
        driver.get("https://example.com")
        
        # Wait for page to load and find element
        wait = WebDriverWait(driver, 10)
        title_element = wait.until(
            EC.presence_of_element_located((By.TAG_NAME, "h1"))
        )
        
        print(f"Page title: {{driver.title}}")
        print(f"H1 text: {{title_element.text}}")
        
        # Take a screenshot
        driver.save_screenshot("thePrivator_selenium_screenshot.png")
        print("Screenshot saved!")
        
        # Example form interaction
        # search_box = driver.find_element(By.NAME, "search")
        # search_box.send_keys("thePrivator automation")
        # search_box.submit()
        
        time.sleep(3)  # Give time to see the result
        
    except Exception as e:
        print(f"Error during automation: {{e}}")
    finally:
        if driver:
            # Don't quit() - this would close the profile browser
            # Just disconnect from it
            print("Disconnecting from profile...")
            
if __name__ == "__main__":
    automation_example()

# Installation: pip install selenium
# Note: Make sure to start the profile first via thePrivator API:
# POST /profiles/{self.profile.id}/launch with debug_port: {debug_port}
'''
    
    def get_webdriver_options_code(self) -> str:
        """Get code for setting up WebDriver options."""
        debug_port = self.config.debug_port or 9222
        
        return f'''
from selenium.webdriver.chrome.options import Options

def get_chrome_options():
    """Get Chrome options for connecting to thePrivator profile."""
    options = Options()
    
    # Connect to existing browser instance
    options.add_experimental_option("debuggerAddress", "127.0.0.1:{debug_port}")
    
    # Match profile settings
    options.add_argument("--user-agent={self.profile.user_agent}")
    
    # Additional useful options
    options.add_argument("--disable-blink-features=AutomationControlled")
    options.add_experimental_option("excludeSwitches", ["enable-automation"])
    options.add_experimental_option('useAutomationExtension', False)
    
    return options
'''