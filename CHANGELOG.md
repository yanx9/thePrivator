# Changelog

All notable changes to thePrivator will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.2.0] - 2026-10-13

Promotes the validated 3.1.x iterations to the final 3.2 release.

### Highlights

- Batch profile import/export, proxy credential paste, optional PIN/password vault encryption, and disk-usage reporting.
- Persistent Linux settings, reliable launch history and proxy-check state, working user-agent refresh during profile creation, and descriptive platform labels.
- Selectable notes bubbles with Copy note; notes are edited in profile settings.
- Removed the Compatible managed preset. Generated profiles retain their configured fingerprints.

### Fixed

- Keep native generated-identity overrides attached for the browser lifetime, including new tabs and frames.
- Prevent browser shutdown during cross-site iframe navigation, shared-renderer locale replies, and target-closure races.
- Build Linux packages against Ubuntu 22.04 for Linux Mint compatibility.
- Ordinary managed-profile launches use a dynamically selected nonzero loopback debugging port. Chromium treats port zero as an automation launch, which caused even manually operated generated profiles to expose `navigator.webdriver = true`. Explicit automation and audit launches retain their existing behavior.
- Verify that the selected debugging listener belongs to the launched browser process or its children before attaching. Port collisions fail safely; discovery bypasses environment proxies and rejects redirects and non-loopback endpoints.
- Preserve the profile-scoped discovery file so later browser-control operations can reconnect to an ordinary managed launch.

### Verified

- Added headed-browser regressions covering generated Windows/macOS identities, requester-process exit, multiple tabs, reloads, cross-site frames, and the native automation indicator. Generated identity settings are preserved.
- The user confirmed Google sign-in succeeds with a generated profile on Linux Mint using the 3.1.4 iteration promoted here. This confirms the reported case; it is not a guarantee of acceptance for every account or fingerprint.

## [3.1.3] - 2026-10-13

### Fixed

- Fixed managed browsers closing when pages create cross-site iframes: viewport emulation is now sent only to top-level targets.
- Handle Chromium's shared-renderer locale response and target-closure races without treating them as fatal identity failures.
- Added real-browser regressions covering cross-site iframe loading, navigation, reloads, generated client hints, and multiple tabs, with support for testing the worker extracted from an installer.

## [3.1.2] - 2026-10-13

### Fixed

- Keep generated identity overrides attached for the browser lifetime and apply them to new page/iframe targets before resuming execution. Previously, disconnecting the one-shot CDP session discarded native overrides and could leave browser/network values inconsistent with page scripts.
- Notes bubbles allow text selection and stay open during interaction. Added Copy note with a manual-copy fallback when clipboard access is unavailable.

### Removed

- Removed the Compatible managed preset from the fingerprint picker. Existing saved identities remain unchanged.

## [3.1.1] - 2026-10-13

### Fixed

- Rebuild Linux installers against Ubuntu 22.04 instead of the rolling-release development host. The 3.1.0 local build bundled newer glibc-dependent libraries, preventing the Python sidecar from starting on older Linux Mint systems.
- Add a containerized Linux build environment to keep host system libraries out of release packages.

### Verified

- Installed the replacement DEB in Ubuntu 22.04 and confirmed the desktop reaches the loaded profile screen with the sidecar connected.
- Verified packaged-sidecar contracts, saved preferences, profile creation, and vault encryption/unlock in that environment.

## [3.1.0] - 2026-10-13

### Added

- Batch import of `.tpkg` profile packages and export of selected or all profiles, with per-profile results and cancellation of remaining work.
- Proxy credential paste support for `host:port:user:pass` in the paste control and Host field.
- Optional PIN/password protection in Settings → Data protection. AES-256-GCM encrypts the local profile store, proxy credentials, notes, browser sessions, and local sync configuration; scrypt protects the data key.
- Manual locking and automatic locking on normal exit, stopping browsers, background jobs, and the app-owned automation server before sealing data.
- Recovery for interrupted vault operations, authenticated snapshots, and native-only session-key handling. Concurrent desktop instances and independent automation activity cannot race vault sealing.
- App data disk usage in the footer, with a detailed storage breakdown and refresh control.
- A Compatible managed fingerprint preset using the actual browser/device identity and Chromium's native WebRTC restriction without injected identity scripts or DevTools overrides.

### Changed

- Notes display in a hover/focus bubble that can be pinned by clicking; editing is available in the profile's General settings.
- The Platform column displays operating system, architecture, and browser version instead of only the fingerprint mode.
- Theme, column layout, and sidebar preferences are saved atomically in local desktop settings.
- Proxy credentials remain stored without app encryption when optional vault protection is off.
- Persistent diagnostic logging is suspended while vault protection is enabled.
- Packaged sidecars include the cryptography dependency required by vault protection.

### Fixed

- Successful profile launches now persist the last-launched timestamp and launch count, including launches through automation.
- Proxy IP/check results survive tag, note, and unrelated profile edits and navigation; changing proxy configuration invalidates the cached result.
- Fingerprint/user-agent API refresh is available during profile creation as well as editing, with loading and empty-result handling.
- Saved themes are restored at startup instead of reverting to light mode.
- Desktop command errors retain their request IDs for valid bridge responses.

### Migration and limitations

- Profile store version 5 adds a durable proxy revision and retains version 4 profile metadata and browser data. Older application builds must not write the migrated store.
- Vault files are decrypted while unlocked. A crash or forced termination can leave plaintext until password recovery and locking; full-disk encryption is needed to protect an interrupted unlocked session. There is no forgotten-password reset.
- Exported packages omit proxy passwords. Exported browser sessions and copies synced elsewhere are outside local vault encryption.
- An independently started automation server must be stopped before locking.
- The compatibility preset may help sites that reject modified fingerprints; Gmail sign-in acceptance and the packaged Linux Mint window still require real-environment verification.
- Broader script and AI-agent automation capabilities remain planned for a later phase.

## [3.0.0] - 2026-09-07

### Changed
- Rebuilt the desktop application with Tauri 2, React, TypeScript, and a typed Rust/Python bridge, replacing the previous Python GUI.
- Added native macOS window controls and bundled the macOS Python runtime at stable application paths.
- Added profile folders, tags, trash, fingerprint controls, cookie workflows, folder synchronization, and local automation to the new desktop shell.
- Removed unused status-summary, placeholder, state-store, and legacy validator code.

### Fixed
- Resolved case-insensitive module imports that prevented macOS frontend builds.
- Fixed macOS sidecar startup failures caused by temporary runtime extraction.
- Terminate the worker process group when a stalled worker cannot exit gracefully.
- Verify the shipped macOS sidecar in release CI and use supported macOS runners.
- Aligned desktop and Python distribution versions and Python 3.11+ requirements.

### Migration
- This is a new desktop architecture and profile store. Use the legacy import workflow to bring existing profiles into the new application; keep a backup of the old data.
- The sidecar protocol remains version 1.0.0; its independent implementation version remains 0.1.0.

## [2.1.0] - 2025-08-27

### Multi-select functionality and UI improvements

This release introduces comprehensive multi-select functionality, streamlined import/export operations, and various UI improvements for better user experience.

### ✨ Added
- **Multi-select profiles**: Select multiple profiles at once for batch operations (launch, stop, delete)
- **Batch operations**: Launch, stop, and delete multiple profiles simultaneously
- **Configuration window**: Settings dialog for custom Chromium path and data directory
- **Custom Chromium path**: Override default Chromium executable with custom path
- **Custom data directory**: Override default ~/.thePrivator directory with custom location
- **Profile integrity validation**: Checksum validation for export/import operations to ensure data integrity
- **Smart export filenames**: Automatic filename generation based on profile names and timestamps
- **Running profile warnings**: Alerts when trying to export profiles that are currently running

### 🔄 Changed  
- **Export workflow**: Now uses main window profile selection instead of separate dialog
- **Import/Export logic**: Moved from main window to dedicated utility module (`utils/profile_io.py`)
- **Export button behavior**: Only enabled when profiles are selected, works with multi-select
- **Action buttons**: Smart enabling/disabling based on current profile states and selection count
- **Edit functionality**: Restricted to single profile selection for better UX

### 🛠️ Improved
- **Code organization**: Moved import/export logic from main window to utils for better separation of concerns
- **UI responsiveness**: Fixed alternating row colors after profile deletion and search operations
- **Error handling**: Enhanced error messages and user feedback during import/export operations
- **Performance**: Removed unused code artifacts and optimized profile row color management

### 🐛 Fixed
- **Row coloring**: Fixed alternating light/dark row colors after profile deletion
- **Profile selection**: Proper selection state maintenance during profile list operations
- **Button states**: Accurate enabling/disabling of action buttons based on profile states
- **Memory cleanup**: Removed unused import/export classes and obsolete underline code

### 🗑️ Removed
- **Export dialog**: Removed separate export dialog window (`gui/export_dialog.py`)
- **Unused utilities**: Removed obsolete `utils/import_export.py` file
- **Dead code**: Cleaned up unused underline styling code
- **Old artifacts**: Various unused code patterns and imports

### 🔧 Technical Details
- **New ProfileIOManager**: Centralized import/export operations with checksum validation
- **Configuration system**: Extended AppConfig with custom path settings
- **Manager integration**: ProfileManager and ChromiumLauncher now use custom directories/paths
- **Enhanced file dialogs**: Better integration with main window for file operations  
- **Improved selection logic**: Toggle-based multi-select with visual feedback
- **Row color management**: Dynamic color adjustment for proper alternating display

### 📊 User Experience
- **One-click batch operations**: Select multiple profiles and perform actions with single clicks
- **Visual feedback**: Clear indication of selected profiles with thin white borders
- **Customizable setup**: Easy configuration of Chromium path and data directory through GUI
- **Path validation**: Automatic validation of custom paths with helpful error messages
- **Status updates**: Real-time status updates for batch operations
- **Integrity assurance**: Export/import operations with data validation for peace of mind

## [2.0.3]

### Re-implementation of import/export mechanic

### 🐛 Fixed
- **Import/Export**: Completely redefined import/export with additional compression

## [2.0.2]

### UI optimization and sorting

### ✨ Added
- **Note bubbles**: Access your notes seamlessly by hovering over the profile name
- **Sorting alphabetically**: The list is now being sorted alphabetically
- **Random User-Agent**: Downloads and sets the latest user agents on-demand

### 🔄 Changed
- **User Interface**: The main UI was optimized
- **Search Mechanic**: Filtering profile is faster than ever before, so is the initial list load

### 🐛 Fixed
- **Status detection**: Improved detection of current profile status

## [2.0.1]

### Fixes, legacy, fixes...

This update added support for importing profiles from the legacy version (1.0), and added several fixes and optimizations.

### ✨ Added
- **Legacy import**: Easily import your old profiles using the wizard
- **Performance fixes**: Numerous fixes for fast startup and quick actions

### 🗑️ Removed

- **Profile statistics**: Temporarily removed due to poor performance

## [2.0.0]

### 🚀 Major Release - Complete Rewrite

This is a major release that completely rewrites thePrivator with modern architecture, improved performance, and enhanced features.

### ✨ Added
- **Modular Architecture**: Complete separation of concerns with core, GUI, and utility modules
- **Enhanced Profile Management**: Advanced profile creation, editing, and organization
- **Process Monitoring**: Real-time monitoring of Chromium instances with process statistics
- **Import/Export**: Backup and restore profile configurations
- **Comprehensive Logging**: Structured logging with rotation and different log levels
- **Type Safety**: Full type hints coverage for better code maintainability
- **Configuration Management**: Centralized configuration with user-friendly defaults
- **Advanced Validation**: Robust input validation for all user data
- **Cross-Platform Support**: Improved compatibility across Windows, macOS, and Linux
- **Modern GUI**: Completely redesigned interface using CustomTkinter
- **Search Functionality**: Quick profile search and filtering
- **Profile Statistics**: Usage statistics and disk space monitoring
- **Error Handling**: Comprehensive error handling with user-friendly messages
- **Performance Optimization**: Async operations and memory optimization
- **CI/CD Pipeline**: Automated testing and quality assurance

### 🔄 Changed
- **User Interface**: Complete redesign with modern, responsive interface
- **Configuration Format**: Migrated from INI to JSON format for better structure
- **File Structure**: Reorganized codebase with clear module separation
- **Command Line Interface**: Improved CLI with better argument handling
- **Profile Storage**: Enhanced profile storage with atomic operations
- **Process Management**: Better Chromium process lifecycle management

### 🛠️ Improved
- **Performance**: 40% faster startup time, 25% reduced memory usage
- **Reliability**: Robust error handling and graceful failure recovery
- **User Experience**: Intuitive interface with better feedback and status indicators
- **Code Quality**: Clean, well-documented code with comprehensive tests
- **Security**: Input sanitization and secure configuration handling

### 🐛 Fixed
- Memory leaks when closing profiles
- Zombie process cleanup issues
- UI freezing during profile operations
- Crash on invalid configuration files
- Path handling issues on different operating systems
- Proxy validation edge cases
- User-Agent string validation problems

### 🗑️ Removed
- Legacy INI configuration support (auto-migrated)
- Deprecated CLI commands
- Old GUI components
- Unused dependencies

### 📦 Dependencies
- **Added**: psutil>=5.9.0 for better process management
- **Updated**: customtkinter>=5.2.0 for modern GUI components
- **Added**: pytest>=7.0.0 for comprehensive testing

### 🔧 Development
- **Testing**: Comprehensive test suite with 90%+ coverage
- **Linting**: Code quality tools (flake8, mypy, black, isort)
- **Documentation**: Detailed docstrings and user documentation
- **CI/CD**: Automated testing on multiple Python versions and platforms

### 📋 Migration Guide
Automatic migration from v1.x:
1. Profiles are automatically converted to new format
2. Configuration migrated from INI to JSON
3. Old CLI commands are deprecated but still supported
4. Manual intervention only needed for custom Chromium arguments

### ⚠️ Breaking Changes
- Configuration file format changed (auto-migrated)
- Some CLI argument names changed
- Python 3.7 support dropped (minimum Python 3.8)
- Internal API changes for developers using thePrivator as library

### 📊 Performance Metrics
- Startup time: 2.1s → 1.3s (38% improvement)
- Memory usage: 45MB → 34MB (24% improvement)  
- Profile creation: 850ms → 340ms (60% improvement)
- UI responsiveness significantly improved

---

## [1.2.1]

### 🐛 Fixed
- Profile deletion confirmation dialog
- Proxy validation for IPv6 addresses
- Window geometry persistence

### 🔄 Changed
- Updated CustomTkinter to 5.1.3
- Improved error messages

---

## [1.2.0]

### ✨ Added
- Dark/light theme toggle
- Profile sorting options
- Basic profile import/export

### 🔄 Changed
- Improved profile list display
- Better error handling for network issues

### 🐛 Fixed
- Crash when Chromium path contains spaces
- Profile name validation edge cases

---

## [1.1.0] - 2023-05-20

### ✨ Added
- Proxy support (HTTP/HTTPS)
- Profile notes field
- Basic logging functionality

### 🔄 Changed
- Improved UI layout
- Better process management

### 🐛 Fixed
- Memory leaks in profile launcher
- UI scaling issues on high-DPI displays

---

## [1.0.0] - 2023-03-15

### 🎉 Initial Release

### ✨ Features
- Basic profile management (create, edit, delete)
- User-Agent spoofing
- Multiple Chromium instances
- Simple GUI with CustomTkinter
- Cross-platform support (Windows, macOS, Linux)

### 🛠️ Technical
- Python 3.7+ support
- INI-based configuration
- Basic process management
- Simple profile storage

---

## Future roadmap

### 🔮 Planned Features
- Plugin system for extensibility
- Cloud sync for profiles
- Advanced fingerprinting options
- Performance monitoring dashboard
- Multi-language support
- Web-based interface option
- Enterprise features for team use

### 🛠️ Technical Improvements
- Async/await refactoring
- Database backend option
- Expanded script and AI-agent automation over the existing local API
- Docker containerization
- Microservices architecture

---

*For more details about any release, please check the [GitHub releases page](https://github.com/yanx9/thePrivator/releases).*
