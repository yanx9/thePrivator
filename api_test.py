#!/usr/bin/env python3
"""
API Test Script for thePrivator
Tests basic API functionality.
"""

import requests
import json
import time
from typing import Optional

class ThePrivatorAPIClient:
    """Simple API client for testing."""
    
    def __init__(self, base_url: str = "http://127.0.0.1:8080"):
        self.base_url = base_url.rstrip('/')
        
    def health_check(self) -> bool:
        """Check if API server is running."""
        try:
            response = requests.get(f"{self.base_url}/health", timeout=5)
            return response.status_code == 200
        except requests.RequestException:
            return False
    
    def get_system_info(self) -> dict:
        """Get system information."""
        response = requests.get(f"{self.base_url}/system/info")
        response.raise_for_status()
        return response.json()
    
    def get_stats(self) -> dict:
        """Get system statistics."""
        response = requests.get(f"{self.base_url}/stats")
        response.raise_for_status()
        return response.json()
    
    def list_profiles(self) -> list:
        """List all profiles."""
        response = requests.get(f"{self.base_url}/profiles")
        response.raise_for_status()
        return response.json()
    
    def create_profile(self, name: str, user_agent: str, proxy: Optional[str] = None, notes: str = "") -> dict:
        """Create a new profile."""
        data = {
            "name": name,
            "user_agent": user_agent,
            "proxy": proxy,
            "notes": notes
        }
        response = requests.post(f"{self.base_url}/profiles", json=data)
        response.raise_for_status()
        return response.json()
    
    def get_profile(self, profile_id: str) -> dict:
        """Get profile by ID."""
        response = requests.get(f"{self.base_url}/profiles/{profile_id}")
        response.raise_for_status()
        return response.json()
    
    def update_profile(self, profile_id: str, **kwargs) -> dict:
        """Update profile."""
        response = requests.put(f"{self.base_url}/profiles/{profile_id}", json=kwargs)
        response.raise_for_status()
        return response.json()
    
    def delete_profile(self, profile_id: str) -> bool:
        """Delete profile."""
        response = requests.delete(f"{self.base_url}/profiles/{profile_id}")
        return response.status_code == 204
    
    def launch_profile(self, profile_id: str, headless: bool = True, incognito: bool = False) -> dict:
        """Launch profile."""
        data = {
            "headless": headless,
            "incognito": incognito,
            "additional_args": []
        }
        response = requests.post(f"{self.base_url}/profiles/{profile_id}/launch", json=data)
        response.raise_for_status()
        return response.json()
    
    def terminate_profile(self, profile_id: str, force: bool = False) -> bool:
        """Terminate profile process."""
        params = {"force": force} if force else {}
        response = requests.post(f"{self.base_url}/profiles/{profile_id}/terminate", params=params)
        return response.status_code == 204
    
    def list_processes(self) -> list:
        """List running processes."""
        response = requests.get(f"{self.base_url}/processes")
        response.raise_for_status()
        return response.json()


def run_api_tests():
    """Run API tests."""
    print("🚀 Testing thePrivator API...")
    
    client = ThePrivatorAPIClient()
    
    # Test 1: Health check
    print("\n1. Testing health check...")
    if not client.health_check():
        print("❌ API server is not running!")
        print("Start it with: python -m theprivator --api-port 8080")
        return
    print("✅ API server is running")
    
    # Test 2: System info
    print("\n2. Getting system info...")
    try:
        info = client.get_system_info()
        print(f"✅ System info: {info['name']} v{info['version']}")
        print(f"   Chromium path: {info.get('chromium_path', 'Not found')}")
    except Exception as e:
        print(f"❌ Failed to get system info: {e}")
        return
    
    # Test 3: Statistics
    print("\n3. Getting statistics...")
    try:
        stats = client.get_stats()
        print(f"✅ Stats: {stats['total_profiles']} profiles, {stats['running_processes']} running")
    except Exception as e:
        print(f"❌ Failed to get stats: {e}")
    
    # Test 4: List profiles
    print("\n4. Listing profiles...")
    try:
        profiles = client.list_profiles()
        print(f"✅ Found {len(profiles)} profiles")
        for profile in profiles[:3]:  # Show first 3
            print(f"   - {profile['name']} ({profile['id'][:8]}...)")
    except Exception as e:
        print(f"❌ Failed to list profiles: {e}")
    
    # Test 5: Create test profile
    print("\n5. Creating test profile...")
    test_profile = None
    try:
        test_profile = client.create_profile(
            name=f"API Test Profile {int(time.time())}",
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            notes="Created by API test script"
        )
        print(f"✅ Created profile: {test_profile['name']} ({test_profile['id'][:8]}...)")
    except Exception as e:
        print(f"❌ Failed to create profile: {e}")
        return
    
    # Test 6: Update profile
    print("\n6. Updating test profile...")
    try:
        updated_profile = client.update_profile(
            test_profile['id'],
            notes="Updated by API test script"
        )
        print(f"✅ Updated profile notes")
    except Exception as e:
        print(f"❌ Failed to update profile: {e}")
    
    # Test 7: Launch profile (headless)
    print("\n7. Launching profile (headless)...")
    try:
        process = client.launch_profile(test_profile['id'], headless=True)
        print(f"✅ Launched profile with PID: {process['pid']}")
        
        # Wait a bit
        time.sleep(2)
        
        # Check running processes
        processes = client.list_processes()
        print(f"✅ Found {len(processes)} running processes")
        
        # Terminate the process
        print("\n8. Terminating profile...")
        if client.terminate_profile(test_profile['id']):
            print("✅ Profile terminated successfully")
        else:
            print("❌ Failed to terminate profile")
            
    except Exception as e:
        print(f"❌ Failed to launch profile: {e}")
        print("This might be expected if Chromium is not installed or accessible")
    
    # Test 9: Delete test profile
    print("\n9. Cleaning up test profile...")
    try:
        if client.delete_profile(test_profile['id']):
            print("✅ Test profile deleted successfully")
        else:
            print("❌ Failed to delete test profile")
    except Exception as e:
        print(f"❌ Failed to delete profile: {e}")
    
    print("\n🎉 API tests completed!")
    print("\n📚 API Documentation available at: http://127.0.0.1:8080/docs")


if __name__ == "__main__":
    run_api_tests()