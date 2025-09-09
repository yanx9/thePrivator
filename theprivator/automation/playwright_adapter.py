"""
Playwright adapter for thePrivator automation.
"""

from typing import Dict, Any, List
from .automation_manager import AutomationAdapter, AutomationError


class PlaywrightAdapter(AutomationAdapter):
    """Playwright automation adapter."""
    
    def validate_installation(self) -> bool:
        """Check if Playwright is properly installed."""
        try:
            import playwright
            from playwright.sync_api import sync_playwright
            return True
        except ImportError:
            return False
    
    def get_launch_args(self) -> List[str]:
        """Get additional Chromium launch arguments for Playwright."""
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
            '--disable-features=TranslateUI',
            '--enable-automation=false',
            '--disable-blink-features=AutomationControlled'
        ]
        
        return args
    
    def get_connection_info(self) -> Dict[str, Any]:
        """Get connection information for Playwright."""
        debug_port = self.config.debug_port or 9222
        
        return {
            'framework': 'playwright',
            'debug_port': debug_port,
            'debugging_url': f'http://127.0.0.1:{debug_port}',
            'user_data_dir': self.profile.user_data_dir,
            'connection_method': 'connect_over_cdp',
            'notes': 'Use connect_over_cdp() to connect to existing browser'
        }
    
    def get_example_code(self) -> str:
        """Get example code for Playwright."""
        debug_port = self.config.debug_port or 9222
        
        return f'''
# Playwright Example for Profile: {self.profile.name}
import asyncio
from playwright.async_api import async_playwright
from playwright.sync_api import sync_playwright

# Async version (recommended)
async def playwright_async_example():
    """Async Playwright automation example."""
    async with async_playwright() as p:
        try:
            # Connect to existing browser instance
            print("Connecting to thePrivator profile...")
            browser = await p.chromium.connect_over_cdp("http://127.0.0.1:{debug_port}")
            
            # Get the existing context/page or create new one
            contexts = browser.contexts
            if contexts:
                context = contexts[0]
                pages = context.pages
                page = pages[0] if pages else await context.new_page()
            else:
                context = await browser.new_context(
                    user_agent="{self.profile.user_agent}"
                )
                page = await context.new_page()
            
            # Navigate to a website
            print("Navigating to example.com...")
            await page.goto("https://example.com")
            
            # Wait for load and get title
            await page.wait_for_load_state("networkidle")
            title = await page.title()
            print(f"Page title: {{title}}")
            
            # Find and interact with elements
            h1_text = await page.locator("h1").first.text_content()
            print(f"H1 text: {{h1_text}}")
            
            # Take screenshot
            await page.screenshot(path="thePrivator_playwright_screenshot.png")
            print("Screenshot saved!")
            
            # Example form interaction
            # await page.fill("input[name='search']", "thePrivator automation")
            # await page.press("input[name='search']", "Enter")
            # await page.wait_for_load_state("networkidle")
            
            await asyncio.sleep(3)  # Give time to see the result
            
        except Exception as e:
            print(f"Error during automation: {{e}}")
        finally:
            # Don't close browser - just disconnect
            print("Disconnecting from profile...")

# Sync version (easier for simple scripts)
def playwright_sync_example():
    """Sync Playwright automation example."""
    with sync_playwright() as p:
        try:
            # Connect to existing browser instance
            print("Connecting to thePrivator profile...")
            browser = p.chromium.connect_over_cdp("http://127.0.0.1:{debug_port}")
            
            # Get or create page
            contexts = browser.contexts
            if contexts:
                context = contexts[0]
                pages = context.pages
                page = pages[0] if pages else context.new_page()
            else:
                context = browser.new_context(
                    user_agent="{self.profile.user_agent}"
                )
                page = context.new_page()
            
            # Navigate and interact
            print("Navigating to example.com...")
            page.goto("https://example.com")
            
            page.wait_for_load_state("networkidle")
            title = page.title()
            print(f"Page title: {{title}}")
            
            # Element interactions
            h1_text = page.locator("h1").first.text_content()
            print(f"H1 text: {{h1_text}}")
            
            # Take screenshot
            page.screenshot(path="thePrivator_playwright_sync_screenshot.png")
            print("Screenshot saved!")
            
            import time
            time.sleep(3)
            
        except Exception as e:
            print(f"Error during automation: {{e}}")
        finally:
            print("Disconnecting from profile...")

if __name__ == "__main__":
    # Run async version
    print("Running async version...")
    asyncio.run(playwright_async_example())
    
    # Or run sync version
    # print("Running sync version...")
    # playwright_sync_example()

# Installation: 
# pip install playwright
# playwright install chromium
#
# Note: Make sure to start the profile first via thePrivator API:
# POST /profiles/{self.profile.id}/launch with debug_port: {debug_port}
'''
    
    def get_context_options_code(self) -> str:
        """Get code for setting up Playwright context options."""
        return f'''
# Playwright Context Options for thePrivator Profile
async def get_playwright_context_options():
    """Get context options matching thePrivator profile."""
    return {{
        'user_agent': "{self.profile.user_agent}",
        'viewport': {{'width': 1366, 'height': 768}},
        'locale': 'en-US',
        'timezone_id': 'America/New_York',
        'permissions': ['geolocation'],
        'extra_http_headers': {{
            'Accept-Language': 'en-US,en;q=0.9'
        }}
    }}

# Usage:
# context = await browser.new_context(**await get_playwright_context_options())
'''