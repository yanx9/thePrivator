# Changelog

All notable changes to thePrivator will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

## [Unreleased] - Future

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
- REST API for automation
- Docker containerization
- Microservices architecture

---

*For more details about any release, please check the [GitHub releases page](https://github.com/yanx9/thePrivator/releases).*