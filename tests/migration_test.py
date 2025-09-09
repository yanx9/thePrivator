#!/usr/bin/env python3
"""
Test script to verify migration tool works correctly
Creates sample old profiles and tests migration
"""

import json
import tempfile
from pathlib import Path
import shutil
import os

def create_test_profiles():
    """Creates sample old profile structure for testing."""
    # Create temporary directory for test
    test_dir = Path(".")
    profiles_dir = test_dir / "Profiles"
    profiles_dir.mkdir()
    
    # Sample profiles
    test_profiles = [
        {
            "folder": "profile_1",
            "config": {
                "name": "Work Profile",
                "chromium_version": "116",
                "user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
                "proxy_flag": 1,
                "proxy_url": "proxy.company.com",
                "proxy_user": "myuser",
                "proxy_pass": "mypass",
                "auth_flag": 1,
                "proxy_port": "8080",
                "rc_port": 9222
            }
        },
        {
            "folder": "profile_2", 
            "config": {
                "name": "Personal Profile",
                "chromium_version": "116",
                "user_agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
                "proxy_flag": 0,
                "proxy_url": "",
                "proxy_user": "",
                "proxy_pass": "",
                "auth_flag": 0,
                "proxy_port": "",
                "rc_port": 9223
            }
        },
        {
            "folder": "profile_3",
            "config": {
                "name": "Testing Profile",
                "chromium_version": "116", 
                "user_agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
                "proxy_flag": 1,
                "proxy_url": "localhost",
                "proxy_user": "",
                "proxy_pass": "",
                "auth_flag": 0,
                "proxy_port": "30022",
                "rc_port": 9224
            }
        }
    ]
    
    # Create test profiles
    for profile_data in test_profiles:
        profile_dir = profiles_dir / profile_data["folder"]
        profile_dir.mkdir()
        
        # Create config.json
        config_file = profile_dir / "config.json"
        with open(config_file, 'w') as f:
            json.dump(profile_data["config"], f, indent=2)
        
        # Create user-data directory with some dummy files
        user_data_dir = profile_dir / "user-data"
        user_data_dir.mkdir()
        
        # Create some dummy chromium files
        (user_data_dir / "Default").mkdir(exist_ok=True)
        (user_data_dir / "Default" / "Preferences").write_text('{"test": "dummy chromium data"}')
        (user_data_dir / "Local State").write_text('{"test": "local state"}')
        
    print(f"✅ Created test profiles in: {test_dir}")
    print(f"📁 Profiles directory: {profiles_dir}")
    
    # List created profiles
    print("\n📋 Created profiles:")
    for profile_data in test_profiles:
        config = profile_data["config"]
        proxy_info = ""
        if config["proxy_flag"] == 1:
            if config["proxy_user"]:
                proxy_info = f" | proxy: {config['proxy_user']}:***@{config['proxy_url']}:{config['proxy_port']}"
            else:
                proxy_info = f" | proxy: {config['proxy_url']}:{config['proxy_port']}"
        
        # Show user agent info
        ua_info = f" | UA: {config['user_agent'][:30]}..."
        
        print(f"  - {config['name']}{ua_info}{proxy_info}")
    
    
    print(f"\n🧪 To test migration, run:")
    print(f"python migrate_profiles.py \"{profiles_dir}\" --dry-run")
    print(f"python migrate_profiles.py \"{profiles_dir}\"")
    
    print(f"\n🗑️  To cleanup test data:")
    print(f"rmdir /s \"{test_dir}\"  # Windows")
    print(f"rm -rf \"{test_dir}\"     # Linux/Mac")
    
    return test_dir, profiles_dir

def test_migration_logic():
    """Tests the core migration logic."""
    print("🧪 Testing migration logic...")
    
    # Test proxy string building
    test_cases = [
        # With auth
        {"proxy_flag": 1, "proxy_url": "proxy.com", "proxy_port": "8080", "proxy_user": "user", "proxy_pass": "pass", "expected": "user:pass@proxy.com:8080"},
        # Without auth  
        {"proxy_flag": 1, "proxy_url": "localhost", "proxy_port": "3128", "proxy_user": "", "proxy_pass": "", "expected": "localhost:3128"},
        # Proxy disabled
        {"proxy_flag": 0, "proxy_url": "proxy.com", "proxy_port": "8080", "proxy_user": "user", "proxy_pass": "pass", "expected": ""},
        # Missing port
        {"proxy_flag": 1, "proxy_url": "proxy.com", "proxy_port": "", "proxy_user": "", "proxy_pass": "", "expected": ""},
    ]
    
    for i, case in enumerate(test_cases):
        # Simulate the proxy building logic from migration tool
        proxy = ""
        if case.get("proxy_flag") == 1:
            proxy_url = case.get("proxy_url", "")
            proxy_port = case.get("proxy_port", "")
            proxy_user = case.get("proxy_user", "")
            proxy_pass = case.get("proxy_pass", "")
            
            if proxy_url and proxy_port:
                if proxy_user and proxy_pass:
                    proxy = f"{proxy_user}:{proxy_pass}@{proxy_url}:{proxy_port}"
                else:
                    proxy = f"{proxy_url}:{proxy_port}"
        
        expected = case["expected"]
        if proxy == expected:
            print(f"  ✅ Test {i+1}: {proxy if proxy else '(empty)'}")
        else:
            print(f"  ❌ Test {i+1}: Expected '{expected}', got '{proxy}'")
    
    print("✅ Migration logic tests completed")

def main():
    """Main test function."""
    print("🧪 thePrivator Migration Tool Test")
    print("="*50)
    
    # Test migration logic
    test_migration_logic()
    print()
    
    # Create test profiles
    test_dir, profiles_dir = create_test_profiles()
    
    return test_dir

if __name__ == "__main__":
    main()