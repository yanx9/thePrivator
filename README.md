# thePrivator

**thePrivator** is a small tool for managing Chromium profiles with a simple GUI built on `customtkinter`.

## Features

- Create, edit and delete Chromium profiles.
- Launch Chromium instances with custom settings such as proxy and user agent.
- Store profile information in JSON for easy reuse.

## Installation

```bash
# clone the repository
git clone https://github.com/yanx9/thePrivator
cd thePrivator

# install as a package
pip install .
```

Installing the package exposes a `theprivator` command which can be executed directly from the terminal.

## Usage

```bash
theprivator
```

This will start the GUI application. Profiles are stored in the `Profiles/` directory next to the installation.

## Building an Executable

If you wish to create a standalone executable you can use [PyInstaller](https://pyinstaller.org/):

```bash
pip install pyinstaller
pyinstaller --onefile -w -n thePrivator main.py
```

The resulting binary can be distributed without requiring Python to be installed.

## Development

The test suite can be executed with:

```bash
python -m unittest Tests/coreTests.py
```
