#!/usr/bin/env python3
"""Setup script for thePrivator."""

from setuptools import setup, find_packages
from pathlib import Path

# Keep the Python distribution aligned with the desktop release without importing
# runtime dependencies during package metadata generation.
import json

here = Path(__file__).parent
version = json.loads((here / "package.json").read_text(encoding="utf-8"))["version"]

# Read long description from README
try:
    with open(here / "README.md", encoding="utf-8") as f:
        long_description = f.read()
except FileNotFoundError:
    long_description = "Chromium multi-instance manager with configurable fingerprints"

# Read requirements
def read_requirements(filename):
    """Read requirements from file."""
    try:
        with open(here / filename, encoding="utf-8") as f:
            return [line.strip() for line in f if line.strip() and not line.startswith("#")]
    except FileNotFoundError:
        return []

install_requires = read_requirements("requirements.txt")
dev_requires = read_requirements("requirements-dev.txt")

setup(
    name="theprivator",
    version=version,
    description="Chromium multi-instance manager with configurable fingerprints",
    long_description=long_description,
    long_description_content_type="text/markdown",
    
    # Author info
    author="yanx9",
    author_email="",
    
    # URLs
    url="https://github.com/yanx9/thePrivator",
    project_urls={
        "Bug Reports": "https://github.com/yanx9/thePrivator/issues",
        "Source": "https://github.com/yanx9/thePrivator",
        "Documentation": "https://github.com/yanx9/thePrivator/blob/main/README.md",
    },
    
    # Package info
    packages=find_packages(include=["theprivator_sidecar", "theprivator_sidecar.*"]),
    python_requires=">=3.11",
    
    # Dependencies
    install_requires=install_requires,
    extras_require={
        "dev": dev_requires,
        "test": [
            "pytest>=7.0.0",
            "pytest-cov>=4.0.0",
            "pytest-mock>=3.10.0",
        ]
    },
    
    # Entry points
    entry_points={
        "console_scripts": [
            "theprivator-sidecar=theprivator_sidecar.main:main",
        ],
    },
    
    # Package data
    package_data={
        "theprivator_sidecar": ["*.json", "*.txt"],
    },
    include_package_data=True,
    
    # Classifiers
    classifiers=[
        "Development Status :: 4 - Beta",
        "Intended Audience :: Developers",
        "Intended Audience :: End Users/Desktop",
        "License :: OSI Approved :: MIT License",
        "Operating System :: OS Independent",
        "Programming Language :: Python :: 3",
        "Programming Language :: Python :: 3.11",
        "Programming Language :: Python :: 3.12",
        "Topic :: Internet :: WWW/HTTP :: Browsers",
        "Topic :: Software Development :: Libraries :: Python Modules",
        "Topic :: System :: Systems Administration",
        "Topic :: Utilities",
    ],
    
    # Keywords
    keywords="chromium browser profile manager privacy fingerprint user-agent proxy",
    
    # License
    license="MIT",
    
    # Zip safe
    zip_safe=False,
)