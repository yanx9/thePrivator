from setuptools import setup, find_packages

setup(
    name="thePrivator",
    version="0.1.0",
    packages=find_packages(),
    install_requires=[
        "customtkinter==5.2.1",
        "psutil==5.9.6",
    ],
    entry_points={
        "console_scripts": [
            "theprivator=thePrivator.main:main",
        ]
    },
)
