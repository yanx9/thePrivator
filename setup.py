from setuptools import setup, find_packages

setup(
    name="thePrivator",
    version="0.1.0",
    packages=find_packages(),
    install_requires=[
        "customtkinter==5.2.1",
        "psutil==5.9.6",
        "setuptools",
        "packaging",
    ],
    entry_points={
        "console_scripts": [
            "thePrivator=main:main",
        ]
    },
)
