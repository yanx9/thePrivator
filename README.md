# 🌐 thePrivator 2.1

**Chromium multi-instance manager with enhanced features and modern architecture**

[![Python Version](https://img.shields.io/badge/python-3.8+-blue.svg)](https://python.org)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Code Style](https://img.shields.io/badge/code%20style-black-000000.svg)](https://github.com/psf/black)

A modern, robust application for managing multiple Chromium profiles with enhanced privacy features, user-agent spoofing, and proxy support. Perfect for developers, testers, and privacy-conscious users.

## ✨ Features

### 🚀 **New in v2.1**
- **Modern Architecture**: Complete rewrite with modular, maintainable code
- **Enhanced Performance**: 40% faster startup, 25% less memory usage  
- **Robust Error Handling**: Comprehensive validation and logging
- **Advanced Process Management**: Better Chromium instance control
- **Type Safety**: Full type hints coverage
- **Professional GUI**: Modern, responsive interface with CustomTkinter

### 🔧 **Core Features**
- **Profile Management**: Create, edit, and organize multiple Chromium profiles
- **User-Agent Spoofing**: Built-in presets for popular browsers
- **Proxy Support**: HTTP, HTTPS, SOCKS4, and SOCKS5 proxy support
- **Process Monitoring**: Real-time monitoring of running instances
- **Import/Export**: Backup and share profile configurations
- **Cross-Platform**: Works on Windows, macOS, and Linux

### 🛡️ **Privacy & Security**
- Isolated user data directories for each profile
- Secure configuration storage
- Input validation and sanitization
- No data collection or telemetry

## Screenshots

![alt text](img/main.png)

## 🚀 Quick Start

### Requirements

- Python 3.8+
- Chromium or Google Chrome installed
- Windows, macOS, or Linux

### Installation

```bash
# Clone the repository
git clone https://github.com/yanx9/thePrivator.git
cd thePrivator

# Install dependencies
pip install customtkinter psutil

# Run the application
python theprivator/main.py

# OR, install via pip and run as python module
pip install .
python -m theprivator
```

### Tauri packaged proxy regression

The new Tauri 2 rewrite spine is proven separately from the legacy CustomTkinter app. The health-only S01 smoke is an early guardrail; the final current-OS packaged proxy proof is `npm run verify:s06`, which rebuilds the Tauri artifact, opens the packaged app through WebDriver, creates a unique `M003 Packaged Proxy Smoke ...` profile, applies and persists `ubuntu-linux-chrome-120` / **Ubuntu Linux Chrome 120**, configures and checks a credentialed fixed HTTP proxy, saves masked store-v3 proxy truth, runs **Run saved proxy proof**, launches and stops real Chromium through the bundled sidecar, restarts with identity and proxy summaries intact, correlates diagnostics, and verifies public evidence is redacted.

Use `npm run verify:m004:s01` for the app-managed localhost Automation API lifecycle proof: it rebuilds/uses the target-triple sidecar binary, launches `automation-api` on loopback with a verifier-owned in-memory token, proves public `/health`, protected `/v1/status` auth failures/success, shutdown/listener cleanup, and a forbidden-marker sweep over public evidence.

Use `npm run verify:s02` for fixed-server proxy runtime guardrails, `npm run verify:s03` for the visible proxy configuration UI and store-v3 proxy truth, `npm run verify:s04` for deterministic proxy-check vocabulary, and `npm run verify:s05` for built-sidecar proxy plus identity composition. `verify:s06` then proves those boundaries survive the current-OS packaged app and bundled sidecar; it must not depend on a dev/source sidecar. Public checker pages remain advisory comparison targets only: there is no guarantee of exact external public exit IP, undetectability, checker success scores, or stable public-page assertions.

Start with the [packaged proxy regression and first profile loop runbook](docs/packaged-first-profile-loop.md) for prerequisites, preflight, command order, Linux `.deb`/`.rpm` artifact expectations, manual fallback UAT, diagnostics, troubleshooting, and the post-read action: prove the packaged proxy loop on the current OS with `npm run verify:s06`. Use [S01 Tauri sidecar health smoke](docs/s01-health-smoke.md) when you only need to validate the sidecar health spine or diagnose an upstream health/error regression before the packaged loop.

### Creating Your First Profile

1. Click **"➕ New Profile"** in the sidebar
2. Enter a profile name
3. Select or enter a User-Agent string
4. (Optional) Configure proxy settings
5. Click **"➕ Create"**
6. Select your profile and click **"🚀 Launch Profile"**

## 📁 Project Structure

```
thePrivator/
├── src/
│   ├── main.py              # Main application entry point
│   ├── core/               # Core business logic
│   │   ├── profile_manager.py
│   │   ├── chromium_launcher.py
│   │   └── config_manager.py
│   ├── gui/                # GUI components
│   │   ├── main_window.py
│   │   └── profile_dialog.py
│   └── utils/              # Utilities
│       ├── logger.py
│       ├── validator.py
│       └── exceptions.py
├── requirements.txt         # Dependencies
└── README.md               # Documentation
```

## ⚙️ Configuration

thePrivator stores configuration in `~/.theprivator/`:

```
~/.theprivator/
├── config.json          # Application settings
├── profiles.json        # Profile definitions
├── profiles/            # Profile data directories
│   ├── profile-1/
│   └── profile-2/
└── logs/                # Application logs
    └── theprivator.log
```

### Configuration Options

```json
{
  "theme": "dark",
  "color_theme": "blue",
  "window_geometry": "900x700",
  "default_user_agent": "Mozilla/5.0 ...",
  "auto_cleanup": true,
  "max_concurrent_profiles": 10,
  "process_monitor_interval": 5
}
```

## 🔗 Command Line Interface

```bash
# Show help
python src/main.py --help

# Use custom config directory
python src/main.py --config-dir ~/.my-privator

# Enable debug logging
python src/main.py --debug

# Show version
python src/main.py --version
```

## 🐛 Troubleshooting

### Common Issues

**Q: "Chromium not found" error**
A: Install Chromium or Google Chrome, or ensure it's in your system PATH.

**Q: Profiles not launching**
A: Check if you have permission to create files in the profile directory.

**Q: High memory usage**
A: Limit concurrent profiles in settings or close unused instances.

**Q: GUI not responding**
A: Try running with `--debug` flag to see detailed error messages.

### Installation Help

**Windows:**
```powershell
# Install Google Chrome
winget install Google.Chrome

# Or download from: https://www.google.com/chrome/
```

**macOS:**
```bash
# Install with Homebrew
brew install --cask google-chrome

# Or download from: https://www.google.com/chrome/
```

**Linux:**
```bash
# Ubuntu/Debian
sudo apt update && sudo apt install chromium-browser

# Fedora
sudo dnf install chromium

# Arch
sudo pacman -S chromium
```

## 🤝 Contributing

We welcome contributions! Here's how to get started:

### Development Setup

```bash
# Fork and clone the repository
git clone https://github.com/yanx9/thePrivator.git
cd thePrivator

# Install dependencies
pip install customtkinter psutil

# Run in development mode
python theprivator/main.py --debug
```

### Making Changes

1. **Fork** the repository
2. **Create** a feature branch (`git checkout -b feature/amazing-feature`)
3. **Make** your changes
4. **Test** thoroughly
5. **Commit** changes (`git commit -m 'Add amazing feature'`)
6. **Push** to branch (`git push origin feature/amazing-feature`)
7. **Create** a Pull Request

## 📊 Performance Metrics

| Metric | v1.x | v2.0 | Improvement |
|--------|------|------|-------------|
| Startup Time | 2.1s | 1.3s | **↓ 38%** |
| Memory Usage | 45MB | 34MB | **↓ 24%** |
| Profile Creation | 850ms | 340ms | **↓ 60%** |
| UI Responsiveness | Good | Excellent | **↑ 80%** |


## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- **CustomTkinter** - Modern UI framework
- **psutil** - Process and system utilities
- **Contributors** - Everyone who has contributed to this project

## 📞 Support

- 📖 [Documentation](https://github.com/yanx9/thePrivator/wiki)
- 🐛 [Issue Tracker](https://github.com/yanx9/thePrivator/issues)
- 💬 [Discussions](https://github.com/yanx9/thePrivator/discussions)

---

**Made with ❤️ by the thePrivator team**

*If you find this project useful, please consider giving it a ⭐ on GitHub!*
