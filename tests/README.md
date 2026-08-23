# thePrivator Tests

This directory contains test scripts and examples for thePrivator.

## Test Scripts

### Unit Tests
- `test_profile_manager.py` - Unit tests for profile management
- `test_chromium_launcher.py` - Unit tests for Chromium launcher
- `test_validators.py` - Unit tests for validation functions

### Integration Tests
- `api_test.py` - API functionality tests covering:
  - Profile management (CRUD operations)
  - Profile launching and termination
  - Process management
  - Automation framework integration
  - System health and statistics

- `automation_examples.py` - Automation integration examples and tests for:
  - Selenium WebDriver
  - Playwright
  - Puppeteer (pyppeteer)

- `migration_test.py` - Migration tool test script for testing profile migration from older versions

## Usage

### Running Unit Tests
```bash
# From project root
python -m pytest theprivator/tests/test_*.py -v
# or
python -m theprivator.tests.test_profile_manager
```

### Running Integration Tests
```bash
# Make sure API server is running first
python -m theprivator --api-port 8080

# Run API tests (from project root)
python -m theprivator.tests.api_test

# Run automation tests
python -m theprivator.tests.automation_examples

# Demo API endpoints only
python -m theprivator.tests.automation_examples --demo-api

# Run migration tests
python -m theprivator.tests.migration_test
```

## Prerequisites

For automation tests, install optional dependencies:
```bash
pip install -r theprivator/requirements-automation.txt
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
python -m theprivator.tests.api_test
python -m theprivator.tests.automation_examples
```

## Notes

- All tests are designed to be non-destructive and clean up after themselves
- Test profiles are created and deleted automatically
- Screenshots and test artifacts are saved to the current working directory
- Tests will skip frameworks that are not installed