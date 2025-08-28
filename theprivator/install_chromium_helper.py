"""
Chromium installation and configuration helper.
"""

import platform
import subprocess
import webbrowser
from pathlib import Path


def check_chromium_installation():
    """Checks Chromium installation and provides instructions."""
    
    system = platform.system()
    print(f"🔍 Checking Chromium installation on {system}...")
    
    # Check paths
    if system == "Windows":
        possible_paths = [
            "C:/Program Files/Google/Chrome/Application/chrome.exe",
            "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
            "C:/Program Files/Chromium/Application/chromium.exe",
        ]
        
        for path in possible_paths:
            if Path(path).exists():
                print(f"✅ Found Chromium: {path}")
                return True
                
        print("❌ Chromium not found in standard locations")
        print("\n🔧 Installation instructions:")
        print("1. Download Google Chrome: https://www.google.com/chrome/")
        print("2. Or download Chromium: https://www.chromium.org/getting-involved/download-chromium/")
        print("3. Install and restart thePrivator")
        
    elif system == "Darwin":  # macOS
        possible_paths = [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ]
        
        for path in possible_paths:
            if Path(path).exists():
                print(f"✅ Found Chromium: {path}")
                return True
                
        print("❌ Chromium not found")
        print("\n🔧 Installation instructions:")
        print("brew install --cask google-chrome")
        print("# or")
        print("brew install --cask chromium")
        
    else:  # Linux
        import shutil
        chromium_commands = ['chromium-browser', 'chromium', 'google-chrome']
        
        for cmd in chromium_commands:
            if shutil.which(cmd):
                print(f"✅ Found Chromium: {shutil.which(cmd)}")
                return True
                
        print("❌ Chromium not found")
        print("\n🔧 Installation instructions:")
        print("# Ubuntu/Debian:")
        print("sudo apt update && sudo apt install chromium-browser")
        print("# or")
        print("sudo apt install google-chrome-stable")
        print("\n# Fedora:")
        print("sudo dnf install chromium")
        print("\n# Arch:")
        print("sudo pacman -S chromium")
        
    return False


def auto_install_chromium():
    """Attempts to automatically install Chromium."""
    system = platform.system()
    
    if system == "Windows":
        print("🌐 Opening Chrome download page...")
        webbrowser.open("https://www.google.com/chrome/")
        
    elif system == "Darwin":
        try:
            print("🍺 Attempting installation via Homebrew...")
            result = subprocess.run(["brew", "--version"], capture_output=True)
            if result.returncode == 0:
                print("Installing Google Chrome...")
                subprocess.run(["brew", "install", "--cask", "google-chrome"])
            else:
                print("Homebrew not found. Opening download page...")
                webbrowser.open("https://www.google.com/chrome/")
        except:
            webbrowser.open("https://www.google.com/chrome/")
            
    else:  # Linux
        try:
            # Auto-detect package manager
            managers = [
                (["apt", "--version"], ["sudo", "apt", "update", "&&", "sudo", "apt", "install", "chromium-browser"]),
                (["dnf", "--version"], ["sudo", "dnf", "install", "chromium"]),
                (["pacman", "--version"], ["sudo", "pacman", "-S", "chromium"]),
                (["zypper", "--version"], ["sudo", "zypper", "install", "chromium"]),
            ]
            
            for check_cmd, install_cmd in managers:
                try:
                    result = subprocess.run(check_cmd, capture_output=True)
                    if result.returncode == 0:
                        print(f"🐧 Found package manager. Suggested command:")
                        print(" ".join(install_cmd))
                        return
                except:
                    continue
                    
            print("🌐 Opening download page...")
            webbrowser.open("https://www.chromium.org/getting-involved/download-chromium/")
            
        except:
            print("🌐 Opening download page...")
            webbrowser.open("https://www.chromium.org/getting-involved/download-chromium/")


def main():
    """Main function."""
    print("🌐 thePrivator - Chromium Installation Helper")
    print("=" * 50)
    
    if not check_chromium_installation():
        response = input("\n❓ Do you want to open Chromium download page? (y/n): ")
        if response.lower() in ['y', 'yes']:
            auto_install_chromium()
    
    print("\n✨ Done! Restart thePrivator after installing Chromium.")


if __name__ == "__main__":
    main()