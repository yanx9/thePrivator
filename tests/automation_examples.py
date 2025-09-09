#!/usr/bin/env python3
"""
Automation Examples for thePrivator API
Complete examples for Selenium, Playwright, and Puppeteer integration.
"""

import requests
import time
import asyncio
import sys
from typing import Optional


class ThePrivatorAutomationClient:
    """Client for thePrivator automation integration."""
    
    def __init__(self, api_url: str = "http://127.0.0.1:8080"):
        self.api_url = api_url.rstrip('/')
        
    def health_check(self) -> bool:
        """Check if API server is running."""
        try:
            response = requests.get(f"{self.api_url}/health", timeout=5)
            return response.status_code == 200
        except requests.RequestException:
            return False
    
    def get_available_frameworks(self) -> dict:
        """Get available automation frameworks."""
        response = requests.get(f"{self.api_url}/automation/frameworks")
        response.raise_for_status()
        return response.json()
    
    def create_test_profile(self) -> str:
        """Create a test profile for automation."""
        profile_data = {
            "name": f"Automation Test Profile {int(time.time())}",
            "user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "notes": "Created for automation testing"
        }
        response = requests.post(f"{self.api_url}/profiles", json=profile_data)
        response.raise_for_status()
        return response.json()['id']
    
    def launch_profile_for_automation(self, profile_id: str, framework: str, debug_port: int = 9222) -> dict:
        """Launch profile with automation support."""
        launch_data = {
            "headless": False,
            "automation_framework": framework,
            "debug_port": debug_port
        }
        response = requests.post(f"{self.api_url}/profiles/{profile_id}/launch", json=launch_data)
        response.raise_for_status()
        return response.json()
    
    def get_automation_connection_info(self, profile_id: str, framework: str, debug_port: int = 9222) -> dict:
        """Get connection information for automation."""
        connection_data = {
            "framework": framework,
            "debug_port": debug_port
        }
        response = requests.post(f"{self.api_url}/profiles/{profile_id}/automation/connection", json=connection_data)
        response.raise_for_status()
        return response.json()
    
    def get_example_code(self, profile_id: str, framework: str, debug_port: int = 9222) -> str:
        """Get example code for framework."""
        response = requests.get(f"{self.api_url}/profiles/{profile_id}/automation/{framework}/example?debug_port={debug_port}")
        response.raise_for_status()
        return response.json()['example_code']
    
    def terminate_profile(self, profile_id: str) -> bool:
        """Terminate profile."""
        response = requests.post(f"{self.api_url}/profiles/{profile_id}/terminate")
        return response.status_code == 204
    
    def delete_profile(self, profile_id: str) -> bool:
        """Delete profile."""
        response = requests.delete(f"{self.api_url}/profiles/{profile_id}")
        return response.status_code == 204


class SeleniumExample:
    """Selenium automation example."""
    
    def __init__(self, client: ThePrivatorAutomationClient):
        self.client = client
        
    def run_example(self, profile_id: str) -> bool:
        """Run Selenium automation example."""
        try:
            # Import Selenium
            from selenium import webdriver
            from selenium.webdriver.chrome.options import Options
            from selenium.webdriver.common.by import By
            from selenium.webdriver.support.ui import WebDriverWait
            from selenium.webdriver.support import expected_conditions as EC
        except ImportError:
            print("❌ Selenium not installed. Install with: pip install selenium")
            return False
        
        print("🔄 Running Selenium example...")
        
        # Launch profile
        process = self.client.launch_profile_for_automation(profile_id, "selenium")
        print(f"✅ Launched profile, PID: {process['pid']}")
        
        time.sleep(3)  # Wait for browser to start
        
        # Connect Selenium
        options = Options()
        options.add_experimental_option("debuggerAddress", "127.0.0.1:9222")
        options.add_argument("--disable-blink-features=AutomationControlled")
        options.add_experimental_option("excludeSwitches", ["enable-automation"])
        
        try:
            driver = webdriver.Chrome(options=options)
            print("✅ Connected to browser with Selenium")
            
            # Test navigation
            driver.get("https://httpbin.org/user-agent")
            print(f"✅ Page title: {driver.title}")
            
            # Test element interaction
            driver.get("https://example.com")
            wait = WebDriverWait(driver, 10)
            h1_element = wait.until(EC.presence_of_element_located((By.TAG_NAME, "h1")))
            print(f"✅ H1 text: {h1_element.text}")
            
            # Take screenshot
            driver.save_screenshot("selenium_test.png")
            print("✅ Screenshot saved: selenium_test.png")
            
            print("✅ Selenium example completed successfully!")
            return True
            
        except Exception as e:
            print(f"❌ Selenium error: {e}")
            return False


class PlaywrightExample:
    """Playwright automation example."""
    
    def __init__(self, client: ThePrivatorAutomationClient):
        self.client = client
        
    async def run_example(self, profile_id: str) -> bool:
        """Run Playwright automation example."""
        try:
            from playwright.async_api import async_playwright
        except ImportError:
            print("❌ Playwright not installed. Install with: pip install playwright && playwright install chromium")
            return False
        
        print("🔄 Running Playwright example...")
        
        # Launch profile
        process = self.client.launch_profile_for_automation(profile_id, "playwright")
        print(f"✅ Launched profile, PID: {process['pid']}")
        
        await asyncio.sleep(3)  # Wait for browser to start
        
        async with async_playwright() as p:
            try:
                # Connect to browser
                browser = await p.chromium.connect_over_cdp("http://127.0.0.1:9222")
                print("✅ Connected to browser with Playwright")
                
                # Get or create page
                contexts = browser.contexts
                if contexts:
                    context = contexts[0]
                    pages = context.pages
                    page = pages[0] if pages else await context.new_page()
                else:
                    context = await browser.new_context()
                    page = await context.new_page()
                
                # Test navigation
                await page.goto("https://httpbin.org/user-agent")
                await page.wait_for_load_state("networkidle")
                title = await page.title()
                print(f"✅ Page title: {title}")
                
                # Test element interaction
                await page.goto("https://example.com")
                h1_text = await page.locator("h1").first.text_content()
                print(f"✅ H1 text: {h1_text}")
                
                # Take screenshot
                await page.screenshot(path="playwright_test.png")
                print("✅ Screenshot saved: playwright_test.png")
                
                print("✅ Playwright example completed successfully!")
                return True
                
            except Exception as e:
                print(f"❌ Playwright error: {e}")
                return False


class PuppeteerExample:
    """Puppeteer (pyppeteer) automation example."""
    
    def __init__(self, client: ThePrivatorAutomationClient):
        self.client = client
        
    async def run_example(self, profile_id: str) -> bool:
        """Run Puppeteer automation example."""
        try:
            import pyppeteer
        except ImportError:
            print("❌ Pyppeteer not installed. Install with: pip install pyppeteer")
            return False
        
        print("🔄 Running Puppeteer example...")
        
        # Launch profile
        process = self.client.launch_profile_for_automation(profile_id, "puppeteer")
        print(f"✅ Launched profile, PID: {process['pid']}")
        
        await asyncio.sleep(3)  # Wait for browser to start
        
        try:
            # Connect to browser
            browser = await pyppeteer.connect({
                'browserURL': 'http://127.0.0.1:9222',
                'ignoreHTTPSErrors': True
            })
            print("✅ Connected to browser with Puppeteer")
            
            # Get or create page
            pages = await browser.pages()
            if pages:
                page = pages[0]
            else:
                page = await browser.newPage()
            
            # Configure page
            await page.setViewport({'width': 1366, 'height': 768})
            
            # Test navigation
            await page.goto("https://httpbin.org/user-agent", {'waitUntil': 'networkidle2'})
            title = await page.title()
            print(f"✅ Page title: {title}")
            
            # Test element interaction
            await page.goto("https://example.com")
            h1_element = await page.querySelector('h1')
            if h1_element:
                h1_text = await page.evaluate('(element) => element.textContent', h1_element)
                print(f"✅ H1 text: {h1_text}")
            
            # Take screenshot
            await page.screenshot({'path': 'puppeteer_test.png'})
            print("✅ Screenshot saved: puppeteer_test.png")
            
            await browser.disconnect()
            print("✅ Puppeteer example completed successfully!")
            return True
            
        except Exception as e:
            print(f"❌ Puppeteer error: {e}")
            return False


async def run_automation_tests():
    """Run all automation tests."""
    print("🚀 Testing thePrivator Automation Integration...")
    
    client = ThePrivatorAutomationClient()
    
    # Check API health
    if not client.health_check():
        print("❌ API server is not running!")
        print("Start it with: python -m theprivator --api-port 8080")
        return
    print("✅ API server is running")
    
    # Check available frameworks
    try:
        frameworks_info = client.get_available_frameworks()
        available = frameworks_info['available_frameworks']
        framework_info = frameworks_info['framework_info']
        
        print(f"\n📋 Available frameworks: {available}")
        for fw, info in framework_info.items():
            status = "✅ Available" if info['available'] else "❌ Not installed"
            print(f"  {fw}: {status}")
            if not info['available']:
                print(f"    Install: {info['installation_command']}")
    except Exception as e:
        print(f"❌ Failed to get framework info: {e}")
        return
    
    # Create test profile
    try:
        profile_id = client.create_test_profile()
        print(f"\n✅ Created test profile: {profile_id[:8]}...")
    except Exception as e:
        print(f"❌ Failed to create test profile: {e}")
        return
    
    # Run tests for each available framework
    results = {}
    
    # Selenium test
    if 'selenium' in available:
        print("\n" + "="*50)
        print("SELENIUM TEST")
        print("="*50)
        selenium_example = SeleniumExample(client)
        results['selenium'] = selenium_example.run_example(profile_id)
        client.terminate_profile(profile_id)
        time.sleep(2)
    
    # Playwright test
    if 'playwright' in available:
        print("\n" + "="*50)
        print("PLAYWRIGHT TEST")
        print("="*50)
        playwright_example = PlaywrightExample(client)
        results['playwright'] = await playwright_example.run_example(profile_id)
        client.terminate_profile(profile_id)
        await asyncio.sleep(2)
    
    # Puppeteer test
    if 'puppeteer' in available:
        print("\n" + "="*50)
        print("PUPPETEER TEST")
        print("="*50)
        puppeteer_example = PuppeteerExample(client)
        results['puppeteer'] = await puppeteer_example.run_example(profile_id)
        client.terminate_profile(profile_id)
        await asyncio.sleep(2)
    
    # Clean up test profile
    try:
        client.delete_profile(profile_id)
        print(f"\n🧹 Cleaned up test profile")
    except Exception as e:
        print(f"❌ Failed to clean up test profile: {e}")
    
    # Print summary
    print("\n" + "="*50)
    print("TEST RESULTS SUMMARY")
    print("="*50)
    
    for framework, success in results.items():
        status = "✅ PASSED" if success else "❌ FAILED"
        print(f"{framework.upper()}: {status}")
    
    total_tests = len(results)
    passed_tests = sum(results.values())
    print(f"\nOverall: {passed_tests}/{total_tests} tests passed")
    
    if passed_tests == total_tests:
        print("🎉 All automation tests completed successfully!")
    else:
        print("⚠️  Some tests failed - check framework installations and dependencies")


def demo_api_endpoints():
    """Demonstrate automation API endpoints."""
    print("🔍 Demonstrating Automation API Endpoints...")
    
    client = ThePrivatorAutomationClient()
    
    if not client.health_check():
        print("❌ API server not running")
        return
    
    try:
        # Create test profile
        profile_id = client.create_test_profile()
        print(f"✅ Created test profile: {profile_id[:8]}...")
        
        # Get framework info
        frameworks = client.get_available_frameworks()
        print(f"✅ Available frameworks: {frameworks['available_frameworks']}")
        
        # Get connection info
        if frameworks['available_frameworks']:
            framework = frameworks['available_frameworks'][0]
            conn_info = client.get_automation_connection_info(profile_id, framework)
            print(f"✅ Connection info for {framework}:")
            print(f"  Debug port: {conn_info['debug_port']}")
            print(f"  Method: {conn_info['connection_method']}")
            
            # Get example code
            example_code = client.get_example_code(profile_id, framework)
            print(f"✅ Retrieved example code ({len(example_code)} characters)")
        
        # Clean up
        client.delete_profile(profile_id)
        print("🧹 Cleaned up test profile")
        
    except Exception as e:
        print(f"❌ API demo failed: {e}")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--demo-api":
        demo_api_endpoints()
    else:
        asyncio.run(run_automation_tests())