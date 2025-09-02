"""Configuration dialog for thePrivator settings."""

import customtkinter as ctk
from pathlib import Path
from typing import Optional
import tkinter.filedialog as filedialog
import sys

# Add src to path
src_dir = Path(__file__).parent.parent.absolute()
if str(src_dir) not in sys.path:
    sys.path.insert(0, str(src_dir))

from core.config_manager import ConfigManager
from utils.logger import get_logger


class ConfigDialog(ctk.CTkToplevel):
    """Configuration settings dialog."""
    
    def __init__(self, parent, config_manager: ConfigManager):
        super().__init__(parent)
        
        self.config_manager = config_manager
        self.logger = get_logger(__name__)
        self.result = False  # True if settings were saved
        
        # Store original values for cancel operation
        self.original_chromium_path = config_manager.get('custom_chromium_path', '')
        self.original_data_directory = config_manager.get('custom_data_directory', '')
        
        self._setup_dialog()
        self._create_widgets()
        self._load_current_settings()
        
        # Modal dialog
        self.transient(parent)
        self.grab_set()
        self.focus()
        
    def _setup_dialog(self) -> None:
        """Configures the dialog window."""
        self.title("Configuration Settings")
        self.geometry("600x400")
        self.resizable(True, True)
        
        # Center on parent window
        if self.master:
            self.update_idletasks()
            parent_x = self.master.winfo_x()
            parent_y = self.master.winfo_y()
            parent_width = self.master.winfo_width()
            parent_height = self.master.winfo_height()
            
            x = parent_x + (parent_width - 600) // 2
            y = parent_y + (parent_height - 400) // 2
            self.geometry(f"600x400+{x}+{y}")
        
    def _create_widgets(self) -> None:
        """Creates dialog widgets."""
        # Main container
        main_frame = ctk.CTkFrame(self)
        main_frame.pack(fill="both", expand=True, padx=20, pady=20)
        
        # Title
        title_label = ctk.CTkLabel(
            main_frame,
            text="⚙️ Configuration Settings",
            font=ctk.CTkFont(size=24, weight="bold")
        )
        title_label.pack(pady=(10, 30))
        
        # Settings frame
        settings_frame = ctk.CTkFrame(main_frame)
        settings_frame.pack(fill="both", expand=True, padx=10, pady=(0, 20))
        
        # Chromium Path Setting
        chromium_frame = ctk.CTkFrame(settings_frame)
        chromium_frame.pack(fill="x", padx=15, pady=15)
        
        ctk.CTkLabel(
            chromium_frame,
            text="🔧 Custom Chromium Executable Path",
            font=ctk.CTkFont(size=14, weight="bold")
        ).pack(anchor="w", padx=15, pady=(15, 5))
        
        ctk.CTkLabel(
            chromium_frame,
            text="Specify a custom Chromium/Chrome executable. Leave empty to use system default.",
            font=ctk.CTkFont(size=11),
            text_color="gray"
        ).pack(anchor="w", padx=15, pady=(0, 10))
        
        chromium_input_frame = ctk.CTkFrame(chromium_frame)
        chromium_input_frame.pack(fill="x", padx=15, pady=(0, 15))
        chromium_input_frame.grid_columnconfigure(0, weight=1)
        
        self.chromium_path_entry = ctk.CTkEntry(
            chromium_input_frame,
            placeholder_text="e.g., C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
            height=35
        )
        self.chromium_path_entry.grid(row=0, column=0, sticky="ew", padx=(10, 5))
        
        self.chromium_browse_btn = ctk.CTkButton(
            chromium_input_frame,
            text="Browse",
            command=self._browse_chromium_path,
            width=80,
            height=35
        )
        self.chromium_browse_btn.grid(row=0, column=1, padx=(5, 10))
        
        # Data Directory Setting
        data_frame = ctk.CTkFrame(settings_frame)
        data_frame.pack(fill="x", padx=15, pady=(0, 15))
        
        ctk.CTkLabel(
            data_frame,
            text="📂 Custom Data Directory",
            font=ctk.CTkFont(size=14, weight="bold")
        ).pack(anchor="w", padx=15, pady=(15, 5))
        
        ctk.CTkLabel(
            data_frame,
            text="Specify a custom directory for profile data. Leave empty to use default (~/.thePrivator).",
            font=ctk.CTkFont(size=11),
            text_color="gray"
        ).pack(anchor="w", padx=15, pady=(0, 10))
        
        data_input_frame = ctk.CTkFrame(data_frame)
        data_input_frame.pack(fill="x", padx=15, pady=(0, 15))
        data_input_frame.grid_columnconfigure(0, weight=1)
        
        self.data_directory_entry = ctk.CTkEntry(
            data_input_frame,
            placeholder_text="e.g., D:\\MyPrivatorData",
            height=35
        )
        self.data_directory_entry.grid(row=0, column=0, sticky="ew", padx=(10, 5))
        
        self.data_browse_btn = ctk.CTkButton(
            data_input_frame,
            text="Browse",
            command=self._browse_data_directory,
            width=80,
            height=35
        )
        self.data_browse_btn.grid(row=0, column=1, padx=(5, 10))
        
        # Current settings info
        info_frame = ctk.CTkFrame(settings_frame)
        info_frame.pack(fill="x", padx=15, pady=(0, 15))
        
        ctk.CTkLabel(
            info_frame,
            text="ℹ️ Current Settings",
            font=ctk.CTkFont(size=12, weight="bold")
        ).pack(anchor="w", padx=15, pady=(10, 5))
        
        self.current_info_label = ctk.CTkLabel(
            info_frame,
            text="",
            font=ctk.CTkFont(size=10),
            text_color="gray",
            justify="left"
        )
        self.current_info_label.pack(anchor="w", padx=15, pady=(0, 10))
        
        # Buttons frame
        buttons_frame = ctk.CTkFrame(main_frame)
        buttons_frame.pack(fill="x", pady=(0, 10))
        
        ctk.CTkButton(
            buttons_frame,
            text="Cancel",
            command=self._cancel,
            fg_color="gray",
            hover_color="darkgray",
            width=100
        ).pack(side="left", padx=(15, 5), pady=10)
        
        ctk.CTkButton(
            buttons_frame,
            text="Reset to Defaults",
            command=self._reset_defaults,
            fg_color="orange",
            hover_color="darkorange",
            width=120
        ).pack(side="left", padx=5, pady=10)
        
        ctk.CTkButton(
            buttons_frame,
            text="Save Settings",
            command=self._save_settings,
            fg_color="darkgreen",
            hover_color="green",
            width=120
        ).pack(side="right", padx=(5, 15), pady=10)
        
    def _load_current_settings(self) -> None:
        """Loads current configuration settings."""
        # Load current values
        chromium_path = self.config_manager.get('custom_chromium_path', '')
        data_directory = self.config_manager.get('custom_data_directory', '')
        
        self.chromium_path_entry.delete(0, 'end')
        if chromium_path:
            self.chromium_path_entry.insert(0, chromium_path)
            
        self.data_directory_entry.delete(0, 'end')
        if data_directory:
            self.data_directory_entry.insert(0, data_directory)
        
        self._update_info_display()
        
    def _update_info_display(self) -> None:
        """Updates the current settings info display."""
        default_data_dir = Path.home() / ".theprivator"
        
        chromium_path = self.chromium_path_entry.get().strip()
        data_directory = self.data_directory_entry.get().strip()
        
        info_text = f"Chromium: {'Custom path' if chromium_path else 'System default'}\n"
        info_text += f"Data Directory: {data_directory if data_directory else str(default_data_dir)}"
        
        self.current_info_label.configure(text=info_text)
        
    def _browse_chromium_path(self) -> None:
        """Opens file dialog to browse for Chromium executable."""
        filetypes = [
            ("Executable files", "*.exe"),
            ("All files", "*.*")
        ]
        
        file_path = filedialog.askopenfilename(
            parent=self,
            title="Select Chromium/Chrome Executable",
            filetypes=filetypes
        )
        
        if file_path:
            self.chromium_path_entry.delete(0, 'end')
            self.chromium_path_entry.insert(0, file_path)
            self._update_info_display()
            
    def _browse_data_directory(self) -> None:
        """Opens directory dialog to browse for data directory."""
        directory = filedialog.askdirectory(
            parent=self,
            title="Select Data Directory"
        )
        
        if directory:
            self.data_directory_entry.delete(0, 'end')
            self.data_directory_entry.insert(0, directory)
            self._update_info_display()
            
    def _reset_defaults(self) -> None:
        """Resets all settings to defaults."""
        import tkinter.messagebox as msgbox
        
        if msgbox.askyesno(
            "Reset Settings",
            "Reset all configuration settings to defaults?\n\nThis will clear custom paths.",
            parent=self
        ):
            self.chromium_path_entry.delete(0, 'end')
            self.data_directory_entry.delete(0, 'end')
            self._update_info_display()
            
    def _validate_settings(self) -> bool:
        """Validates the current settings."""
        import tkinter.messagebox as msgbox
        
        chromium_path = self.chromium_path_entry.get().strip()
        data_directory = self.data_directory_entry.get().strip()
        
        # Validate chromium path if provided
        if chromium_path:
            path = Path(chromium_path)
            if not path.exists():
                msgbox.showerror(
                    "Invalid Path",
                    f"Chromium executable not found:\n{chromium_path}",
                    parent=self
                )
                return False
            if not path.is_file():
                msgbox.showerror(
                    "Invalid Path", 
                    f"Path is not a file:\n{chromium_path}",
                    parent=self
                )
                return False
                
        # Validate data directory if provided
        if data_directory:
            path = Path(data_directory)
            try:
                # Try to create the directory if it doesn't exist
                path.mkdir(parents=True, exist_ok=True)
                if not path.is_dir():
                    msgbox.showerror(
                        "Invalid Directory",
                        f"Path is not a directory:\n{data_directory}",
                        parent=self
                    )
                    return False
            except Exception as e:
                msgbox.showerror(
                    "Directory Error",
                    f"Cannot create or access directory:\n{data_directory}\n\nError: {e}",
                    parent=self
                )
                return False
                
        return True
        
    def _save_settings(self) -> None:
        """Saves the configuration settings."""
        if not self._validate_settings():
            return
            
        try:
            # Get values
            chromium_path = self.chromium_path_entry.get().strip()
            data_directory = self.data_directory_entry.get().strip()
            
            # Save to configuration
            self.config_manager.set('custom_chromium_path', chromium_path)
            self.config_manager.set('custom_data_directory', data_directory)
            self.config_manager.save()
            
            self.result = True
            self.logger.info("Configuration settings saved successfully")
            
            import tkinter.messagebox as msgbox
            msgbox.showinfo(
                "Settings Saved",
                "Configuration settings have been saved successfully.\n\nNote: Some changes may require restarting the application.",
                parent=self
            )
            
            self.destroy()
            
        except Exception as e:
            self.logger.error(f"Error saving configuration: {e}")
            import tkinter.messagebox as msgbox
            msgbox.showerror(
                "Save Error",
                f"Failed to save configuration settings:\n{e}",
                parent=self
            )
            
    def _cancel(self) -> None:
        """Cancels the dialog without saving."""
        self.destroy()
        
    def get_result(self) -> bool:
        """Returns whether settings were saved."""
        return self.result