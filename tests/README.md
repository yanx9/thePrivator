# thePrivator Tests

This directory contains test scripts and examples for thePrivator.

## Test Scripts

### `api_test.py`
Basic API functionality tests. Tests all core API endpoints including:
- Profile management (CRUD operations)
- Profile launching and termination
- Process management
- Automation framework integration
- System health and statistics

**Usage:**
```bash
# Make sure API server is running first
python -m theprivator --api-port 8080

# Run tests (from project root)
python tests/api_test.py
```

### `automation_examples.py`
Comprehensive automation integration examples and tests for:
- Selenium WebDriver
- Playwright
- Puppeteer (pyppeteer)

**Usage:**
```bash
# Run automation tests
python tests/automation_examples.py

# Demo API endpoints only
python tests/automation_examples.py --demo-api
```

### `migration_test.py`
Migration tool test script for testing profile migration from older versions.

**Usage:**
```bash
python tests/migration_test.py
```

## Prerequisites

For automation tests, install optional dependencies:
```bash
pip install -r requirements-automation.txt
```

For Playwright, also run:
```bash
playwright install chromium
```

## Running All Tests

1. Start the API server:
```bash
python -m theprivator --api-port 8080
```

2. In another terminal, run tests:
```bash
python tests/api_test.py
python tests/automation_examples.py
```

## Notes

- All tests are designed to be non-destructive and clean up after themselves
- Test profiles are created and deleted automatically
- Screenshots and test artifacts are saved to the current working directory
- Tests will skip frameworks that are not installed