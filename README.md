# thePrivator

**thePrivator** is a simple Chromium profile manager built with
[CustomTkinter](https://github.com/TomSchimansky/CustomTkinter). It lets you
create and run multiple Chromium instances with separate user data directories.

## Features

- Create, edit and remove Chromium profiles
- Launch profiles with custom user agents and proxy settings
- Simple GUI built with CustomTkinter

## Installation

```bash
pip install -r requirements.txt
python setup.py install
```

After installation a command line entry point called `theprivator` is available:

```bash
theprivator
```

This will start the GUI application.

## Development

Tests can be executed with `pytest`:

```bash
pytest
```

## License

This project is provided as-is under the MIT license.
