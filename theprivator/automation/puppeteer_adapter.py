"""
Puppeteer/pyppeteer adapter for thePrivator automation.
"""

from typing import Dict, Any, List
from .automation_manager import AutomationAdapter, AutomationError


class PuppeteerAdapter(AutomationAdapter):
    """Puppeteer (pyppeteer) automation adapter."""
    
    def validate_installation(self) -> bool:
        """Check if pyppeteer is properly installed."""
        try:
            import pyppeteer
            return True
        except ImportError:
            return False
    
    def get_launch_args(self) -> List[str]:
        """Get additional Chromium launch arguments for Puppeteer."""
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
            '--disable-web-security',
            '--disable-features=VizDisplayCompositor'
        ]
        
        return args
    
    def get_connection_info(self) -> Dict[str, Any]:
        """Get connection information for Puppeteer."""
        debug_port = self.config.debug_port or 9222
        
        return {
            'framework': 'puppeteer',
            'debug_port': debug_port, 
            'debugging_url': f'http://127.0.0.1:{debug_port}',
            'user_data_dir': self.profile.user_data_dir,
            'connection_method': 'connect_to_browser',
            'notes': 'Use connect() to connect to existing browser instance'
        }
    
    def get_example_code(self) -> str:
        """Get example code for Puppeteer/pyppeteer."""
        debug_port = self.config.debug_port or 9222
        
        return f'''
# Pyppeteer Example for Profile: {self.profile.name}
import asyncio
import pyppeteer
from pyppeteer import connect

async def puppeteer_example():
    """Pyppeteer automation example."""
    browser = None
    try:
        # Connect to existing browser instance
        print("Connecting to thePrivator profile...")
        browser = await connect({{
            'browserURL': 'http://127.0.0.1:{debug_port}',
            'ignoreHTTPSErrors': True
        }})
        
        # Get existing pages or create new one
        pages = await browser.pages()
        if pages:
            page = pages[0]
        else:
            page = await browser.newPage()
        
        # Set user agent to match profile
        await page.setUserAgent("{self.profile.user_agent}")
        
        # Set viewport
        await page.setViewport({{'width': 1366, 'height': 768}})
        
        # Navigate to website
        print("Navigating to example.com...")
        await page.goto("https://example.com", {{'waitUntil': 'networkidle2'}})
        
        # Get page title
        title = await page.title()
        print(f"Page title: {{title}}")
        
        # Find elements and get text
        h1_element = await page.querySelector('h1')
        if h1_element:
            h1_text = await page.evaluate('(element) => element.textContent', h1_element)
            print(f"H1 text: {{h1_text}}")
        
        # Take screenshot
        await page.screenshot({{'path': 'thePrivator_puppeteer_screenshot.png'}})
        print("Screenshot saved!")
        
        # Example form interaction
        # search_input = await page.querySelector('input[name="search"]')
        # if search_input:
        #     await page.type('input[name="search"]', 'thePrivator automation')
        #     await page.keyboard.press('Enter')
        #     await page.waitForNavigation()
        
        # Wait to see result
        await asyncio.sleep(3)
        
    except Exception as e:
        print(f"Error during automation: {{e}}")
    finally:
        if browser:
            # Don't close browser - just disconnect
            print("Disconnecting from profile...")
            await browser.disconnect()

# Alternative: Direct CDP connection
async def puppeteer_cdp_example():
    """Example using Chrome DevTools Protocol directly."""
    try:
        # Connect using CDP
        browser = await pyppeteer.connect({{
            'browserURL': 'http://127.0.0.1:{debug_port}',
            'ignoreHTTPSErrors': True,
            'slowMo': 100  # Add delay for better observation
        }})
        
        # Create new page with specific settings
        page = await browser.newPage()
        
        # Enhanced stealth settings
        await page.evaluateOnNewDocument('''() => {{
            Object.defineProperty(navigator, 'webdriver', {{
                get: () => undefined,
            }});
        }}''')
        
        await page.setUserAgent("{self.profile.user_agent}")
        await page.setExtraHTTPHeaders({{'Accept-Language': 'en-US,en;q=0.9'}})
        
        # Navigate with advanced waiting
        print("Navigating with advanced options...")
        await page.goto("https://httpbin.org/user-agent", {{
            'waitUntil': 'networkidle0',
            'timeout': 30000
        }})
        
        # Get and display user agent info
        content = await page.content()
        print("User agent verification:")
        print(content)
        
        await browser.disconnect()
        
    except Exception as e:
        print(f"CDP example error: {{e}}")

if __name__ == "__main__":
    # Run main example
    print("Running pyppeteer example...")
    asyncio.run(puppeteer_example())
    
    # Run CDP example
    print("\\nRunning CDP example...")
    asyncio.run(puppeteer_cdp_example())

# Installation: pip install pyppeteer
# 
# Note: Make sure to start the profile first via thePrivator API:
# POST /profiles/{self.profile.id}/launch with debug_port: {debug_port}
# 
# For headless mode, add "headless": true to launch request
'''
    
    def get_stealth_options_code(self) -> str:
        """Get code for stealth options with pyppeteer."""
        return f'''
# Pyppeteer Stealth Options for thePrivator
import pyppeteer

async def setup_stealth_page(page):
    """Configure page for stealth automation."""
    
    # Remove webdriver property
    await page.evaluateOnNewDocument('''() => {{
        Object.defineProperty(navigator, 'webdriver', {{
            get: () => undefined,
        }});
        
        // Mock plugins
        Object.defineProperty(navigator, 'plugins', {{
            get: () => [1, 2, 3, 4, 5],
        }});
        
        // Mock languages
        Object.defineProperty(navigator, 'languages', {{
            get: () => ['en-US', 'en'],
        }});
    }}''')
    
    # Set realistic headers
    await page.setExtraHTTPHeaders({{
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-User': '?1'
    }})
    
    # Set user agent
    await page.setUserAgent("{self.profile.user_agent}")
    
    return page

# Usage:
# page = await browser.newPage()
# page = await setup_stealth_page(page)
'''