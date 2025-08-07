#!/usr/bin/env python3
"""
thePrivator - Chromium Profile Manager
Main application entry point.
"""

import sys
import os
import logging
import argparse
from pathlib import Path
from typing import Optional

# Add src to Python path
src_dir = Path(__file__).parent.absolute()
if str(src_dir) not in sys.path:
    sys.path.insert(0, str(src_dir))

try:
    import customtkinter as ctk
except ImportError:
    print("Error: customtkinter is not installed.")
    print("Install it with: pip install customtkinter")
    sys.exit(1)

# Now we can import our modules
from gui.main_window import MainWindow
from utils.logger import setup_logger
from utils.exceptions import PrivatorException


class ThePrivatorApp:
    """Main thePrivator application class."""
    
    def __init__(self, config_dir: Optional[Path] = None):
        self.config_dir = config_dir or Path.home() / ".theprivator"
        self.logger = setup_logger(self.config_dir / "logs")
        self.main_window: Optional[MainWindow] = None
        
    def run(self) -> None:
        """Runs the application."""
        try:
            self.logger.info("Starting thePrivator v2.0")
            
            # CustomTkinter configuration
            ctk.set_appearance_mode("dark")
            ctk.set_default_color_theme("blue")
            
            # Create main window
            self.main_window = MainWindow(config_dir=self.config_dir)
            
            # Start main loop
            self.main_window.mainloop()
            
        except PrivatorException as e:
            self.logger.error(f"Application error: {e}")
            self._show_error_dialog(str(e))
        except Exception as e:
            self.logger.critical(f"Critical error: {e}", exc_info=True)
            self._show_error_dialog(f"An unexpected error occurred: {e}")
        finally:
            self._cleanup()
            
    def _show_error_dialog(self, message: str) -> None:
        """Shows error dialog."""
        try:
            import tkinter.messagebox as msgbox
            msgbox.showerror("thePrivator Error", message)
        except:
            print(f"ERROR: {message}", file=sys.stderr)
        
    def _cleanup(self) -> None:
        """Cleans up resources before closing."""
        self.logger.info("Closing application...")
        if self.main_window:
            try:
                self.main_window.destroy()
            except:
                pass


def parse_args():
    """Parses command line arguments."""
    parser = argparse.ArgumentParser(
        description="thePrivator - Chromium Profile Manager",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Usage examples:
  python main.py                    # Run GUI
  python main.py --config-dir /path # Use custom config directory
  python main.py --version          # Show version
        """
    )
    
    parser.add_argument(
        "--config-dir",
        type=Path,
        help="Custom configuration directory"
    )
    
    parser.add_argument(
        "--version",
        action="version",
        version="thePrivator 2.0.0"
    )
    
    parser.add_argument(
        "--debug",
        action="store_true",
        help="Enable debug mode"
    )
    
    return parser.parse_args()


def main() -> None:
    """CLI entry point."""
    args = parse_args()
    
    # Configure logging level
    if args.debug:
        logging.getLogger('theprivator').setLevel(logging.DEBUG)
    
    app = ThePrivatorApp(config_dir=args.config_dir)
    app.run()


if __name__ == "__main__":
    main()