"""Legacy profile import dialog for thePrivator."""

import customtkinter as ctk
import tkinter as tk
from tkinter import filedialog, messagebox
from pathlib import Path
from typing import List, Dict, Any, Optional
import threading
import sys

# Add src to path
src_dir = Path(__file__).parent.parent.absolute()
if str(src_dir) not in sys.path:
    sys.path.insert(0, str(src_dir))

from core.profile_manager import ProfileManager
from utils.legacy_migration import LegacyProfileMigrator
from utils.logger import get_logger


class LegacyImportDialog(ctk.CTkToplevel):
    """Dialog for importing legacy profiles."""
    
    def __init__(self, parent, profile_manager: ProfileManager):
        super().__init__(parent)
        
        self.profile_manager = profile_manager
        self.migrator = LegacyProfileMigrator(profile_manager)
        self.logger = get_logger(__name__)
        
        self.legacy_profiles: List[Dict[str, Any]] = []
        self.selected_profiles: Dict[str, ctk.BooleanVar] = {}
        
        self._setup_dialog()
        self._create_widgets()
        
        # Modal
        self.transient(parent)
        self.grab_set()
        self.focus()
        
    def _setup_dialog(self) -> None:
        """Configures the dialog."""
        self.title("Import Legacy Profiles")
        self.geometry("800x600")
        self.resizable(True, True)
        
        # Center on parent
        self.update_idletasks()
        x = (self.winfo_screenwidth() // 2) - (800 // 2)
        y = (self.winfo_screenheight() // 2) - (600 // 2)
        self.geometry(f"800x600+{x}+{y}")
        
    def _create_widgets(self) -> None:
        """Creates dialog widgets."""
        # Main frame
        main_frame = ctk.CTkFrame(self)
        main_frame.pack(fill="both", expand=True, padx=20, pady=20)
        
        # Title
        title_label = ctk.CTkLabel(
            main_frame,
            text="Import Legacy Profiles",
            font=ctk.CTkFont(size=20, weight="bold")
        )
        title_label.pack(pady=(10, 20))
        
        # Instructions
        instructions = ctk.CTkTextbox(main_frame, height=80, wrap="word")
        instructions.pack(fill="x", padx=10, pady=(0, 20))
        instructions.insert("1.0", 
            "This tool will help you import profiles from the old thePrivator format.\n\n"
            "1. Click 'Browse' to select your old 'Profiles' directory\n"
            "2. Review the found profiles and select which ones to import\n"
            "3. Click 'Import Selected' to migrate the chosen profiles\n\n"
            "Note: User data will be copied to the new location, which may take some time for large profiles."
        )
        instructions.configure(state="disabled")
        
        # Browse section
        browse_frame = ctk.CTkFrame(main_frame)
        browse_frame.pack(fill="x", padx=10, pady=10)
        
        ctk.CTkLabel(
            browse_frame,
            text="Legacy Profiles Directory:",
            font=ctk.CTkFont(size=14, weight="bold")
        ).pack(anchor="w", padx=10, pady=(10, 5))
        
        path_frame = ctk.CTkFrame(browse_frame)
        path_frame.pack(fill="x", padx=10, pady=(0, 10))
        
        self.path_entry = ctk.CTkEntry(
            path_frame,
            placeholder_text="Select the directory containing your old profiles...",
            height=35
        )
        self.path_entry.pack(side="left", fill="x", expand=True, padx=(0, 5))
        
        self.browse_btn = ctk.CTkButton(
            path_frame,
            text="Browse",
            command=self._browse_directory,
            width=100
        )
        self.browse_btn.pack(side="right")
        
        self.scan_btn = ctk.CTkButton(
            browse_frame,
            text="Scan for Profiles",
            command=self._scan_profiles,
            state="disabled",
            height=35
        )
        self.scan_btn.pack(pady=(0, 10))
        
        # Profile list section
        self.profiles_frame = ctk.CTkFrame(main_frame)
        self.profiles_frame.pack(fill="both", expand=True, padx=10, pady=10)
        
        # Header
        header_frame = ctk.CTkFrame(self.profiles_frame)
        header_frame.pack(fill="x", padx=10, pady=(10, 5))
        
        ctk.CTkLabel(
            header_frame,
            text="Found Profiles:",
            font=ctk.CTkFont(size=16, weight="bold")
        ).pack(side="left", padx=10, pady=10)
        
        # Select all/none buttons
        select_frame = ctk.CTkFrame(header_frame)
        select_frame.pack(side="right", padx=10)
        
        self.select_all_btn = ctk.CTkButton(
            select_frame,
            text="Select All",
            command=self._select_all,
            width=80,
            height=30
        )
        self.select_all_btn.pack(side="left", padx=2)
        
        self.select_none_btn = ctk.CTkButton(
            select_frame,
            text="Select None",
            command=self._select_none,
            width=80,
            height=30
        )
        self.select_none_btn.pack(side="left", padx=2)
        
        # Scrollable list
        self.profiles_list = ctk.CTkScrollableFrame(
            self.profiles_frame,
            label_text="No profiles scanned yet"
        )
        self.profiles_list.pack(fill="both", expand=True, padx=10, pady=5)
        
        # Progress and status
        self.status_frame = ctk.CTkFrame(main_frame)
        self.status_frame.pack(fill="x", padx=10, pady=10)
        
        self.status_label = ctk.CTkLabel(
            self.status_frame,
            text="Ready to scan for legacy profiles",
            font=ctk.CTkFont(size=12)
        )
        self.status_label.pack(pady=10)
        
        self.progress_bar = ctk.CTkProgressBar(self.status_frame)
        self.progress_bar.pack(fill="x", padx=20, pady=(0, 10))
        self.progress_bar.set(0)
        
        # Buttons
        buttons_frame = ctk.CTkFrame(main_frame)
        buttons_frame.pack(fill="x", padx=10, pady=20)
        
        self.close_btn = ctk.CTkButton(
            buttons_frame,
            text="Close",
            command=self.destroy,
            fg_color="gray",
            hover_color="darkgray",
            width=120
        )
        self.close_btn.pack(side="left", padx=10)
        
        self.import_btn = ctk.CTkButton(
            buttons_frame,
            text="Import Selected",
            command=self._import_selected,
            state="disabled",
            fg_color="darkgreen",
            hover_color="green",
            width=150
        )
        self.import_btn.pack(side="right", padx=10)
        
    def _browse_directory(self) -> None:
        """Opens directory selection dialog."""
        directory = filedialog.askdirectory(
            title="Select Legacy Profiles Directory",
            initialdir=str(Path.home())
        )
        
        if directory:
            self.path_entry.delete(0, "end")
            self.path_entry.insert(0, directory)
            self.scan_btn.configure(state="normal")
            
    def _scan_profiles(self) -> None:
        """Scans for legacy profiles."""
        legacy_dir = Path(self.path_entry.get().strip())
        
        if not legacy_dir.exists():
            messagebox.showerror("Error", "Directory does not exist!")
            return
            
        self.status_label.configure(text="Scanning for legacy profiles...")
        self.progress_bar.set(0.3)
        
        def scan_thread():
            try:
                self.legacy_profiles = self.migrator.scan_legacy_profiles(legacy_dir)
                self.after(0, self._display_profiles)
            except Exception as e:
                self.after(0, lambda: self._scan_error(str(e)))
                
        threading.Thread(target=scan_thread, daemon=True).start()
        
    def _display_profiles(self) -> None:
        """Displays found legacy profiles."""
        # Clear existing widgets
        for widget in self.profiles_list.winfo_children():
            widget.destroy()
            
        self.selected_profiles.clear()
        
        if not self.legacy_profiles:
            self.status_label.configure(text="No legacy profiles found")
            self.profiles_list.configure(label_text="No profiles found")
            self.progress_bar.set(0)
            return
            
        self.status_label.configure(text=f"Found {len(self.legacy_profiles)} legacy profiles")
        self.profiles_list.configure(label_text=f"Found {len(self.legacy_profiles)} profiles")
        self.progress_bar.set(0.6)
        
        # Create profile widgets
        for i, profile_data in enumerate(self.legacy_profiles):
            self._create_profile_widget(i, profile_data)
            
        self.progress_bar.set(1.0)
        self.import_btn.configure(state="normal")
        
        # Auto-select all profiles initially
        self._select_all()
        
    def _create_profile_widget(self, index: int, profile_data: Dict[str, Any]) -> None:
        """Creates a widget for a single legacy profile."""
        config = profile_data['config']
        folder_path = profile_data['folder_path']
        folder_name = folder_path.name
        
        # Main frame for this profile
        profile_frame = ctk.CTkFrame(self.profiles_list)
        profile_frame.pack(fill="x", padx=5, pady=2)
        profile_frame.grid_columnconfigure(1, weight=1)
        
        # Checkbox
        var = ctk.BooleanVar(value=True)
        self.selected_profiles[folder_name] = var
        
        checkbox = ctk.CTkCheckBox(
            profile_frame,
            text="",
            variable=var,
            width=20
        )
        checkbox.grid(row=0, column=0, padx=10, pady=10, sticky="w")
        
        # Profile info
        info_frame = ctk.CTkFrame(profile_frame)
        info_frame.grid(row=0, column=1, padx=10, pady=5, sticky="ew")
        info_frame.grid_columnconfigure(0, weight=1)
        
        # Profile name
        name = config.get('name', folder_name)
        name_label = ctk.CTkLabel(
            info_frame,
            text=f"Name: {name}",
            font=ctk.CTkFont(size=14, weight="bold"),
            anchor="w"
        )
        name_label.grid(row=0, column=0, sticky="ew", padx=10, pady=2)
        
        # Folder name (if different from profile name)
        if folder_name != name:
            folder_label = ctk.CTkLabel(
                info_frame,
                text=f"Folder: {folder_name}",
                font=ctk.CTkFont(size=11),
                text_color="gray",
                anchor="w"
            )
            folder_label.grid(row=1, column=0, sticky="ew", padx=10, pady=1)
            
        # User agent (shortened)
        user_agent = config.get('user_agent', 'No user agent')
        if len(user_agent) > 60:
            user_agent = user_agent[:60] + "..."
        ua_label = ctk.CTkLabel(
            info_frame,
            text=f"User-Agent: {user_agent}",
            font=ctk.CTkFont(size=11),
            anchor="w"
        )
        ua_label.grid(row=2, column=0, sticky="ew", padx=10, pady=1)
        
        # Proxy info
        if config.get('proxy_flag'):
            proxy_url = config.get('proxy_url', '')
            proxy_port = config.get('proxy_port', '')
            proxy_text = f"Proxy: {proxy_url}:{proxy_port}"
        else:
            proxy_text = "Proxy: None"
            
        proxy_label = ctk.CTkLabel(
            info_frame,
            text=proxy_text,
            font=ctk.CTkFont(size=11),
            anchor="w"
        )
        proxy_label.grid(row=3, column=0, sticky="ew", padx=10, pady=1)
        
        # Additional info
        details = []
        if 'chromium_version' in config:
            details.append(f"Chromium v{config['chromium_version']}")
        if profile_data['has_user_data']:
            size_str = self.migrator.format_file_size(profile_data['user_data_size'])
            details.append(f"User data: {size_str}")
        else:
            details.append("No user data")
            
        if details:
            details_text = " • ".join(details)
            details_label = ctk.CTkLabel(
                info_frame,
                text=details_text,
                font=ctk.CTkFont(size=10),
                text_color="gray",
                anchor="w"
            )
            details_label.grid(row=4, column=0, sticky="ew", padx=10, pady=(1, 5))
            
    def _select_all(self) -> None:
        """Selects all profiles."""
        for var in self.selected_profiles.values():
            var.set(True)
            
    def _select_none(self) -> None:
        """Deselects all profiles."""
        for var in self.selected_profiles.values():
            var.set(False)
            
    def _import_selected(self) -> None:
        """Imports selected profiles."""
        # Get selected profile names
        selected_names = [
            name for name, var in self.selected_profiles.items() 
            if var.get()
        ]
        
        if not selected_names:
            messagebox.showwarning("No Selection", "Please select at least one profile to import.")
            return
            
        # Confirm import
        count = len(selected_names)
        if not messagebox.askyesno(
            "Confirm Import",
            f"Import {count} selected profile{'s' if count > 1 else ''}?\n\n"
            "This will:\n"
            "• Create new profiles in thePrivator\n"
            "• Copy user data to the new location\n"
            "• Convert proxy settings to the new format\n\n"
            "This operation may take several minutes for profiles with large user data."
        ):
            return
            
        # Start import process
        self._start_import(selected_names)
        
    def _start_import(self, selected_names: List[str]) -> None:
        """Starts the import process in a separate thread."""
        self.status_label.configure(text="Importing profiles...")
        self.progress_bar.set(0)
        self.import_btn.configure(state="disabled")
        self.scan_btn.configure(state="disabled")
        self.browse_btn.configure(state="disabled")
        
        def import_thread():
            try:
                legacy_dir = Path(self.path_entry.get().strip())
                results = self.migrator.migrate_selected_profiles(legacy_dir, selected_names)
                self.after(0, lambda: self._import_completed(results))
            except Exception as e:
                self.after(0, lambda: self._import_error(str(e)))
                
        threading.Thread(target=import_thread, daemon=True).start()
        
        # Update progress periodically
        self._update_import_progress(0)
        
    def _update_import_progress(self, step: int) -> None:
        """Updates import progress indicator."""
        if self.import_btn.cget("state") == "disabled":  # Still importing
            progress = min(0.9, step * 0.1)
            self.progress_bar.set(progress)
            self.after(500, lambda: self._update_import_progress(step + 1))
            
    def _import_completed(self, results: Dict[str, Any]) -> None:
        """Handles completed import."""
        self.progress_bar.set(1.0)
        self.status_label.configure(text="Import completed!")
        
        # Re-enable buttons
        self.import_btn.configure(state="normal")
        self.scan_btn.configure(state="normal")
        self.browse_btn.configure(state="normal")
        
        # Show results
        successful = len(results['successful'])
        failed = len(results['failed'])
        total = results['total_processed']
        
        message = f"Import Results:\n\n"
        message += f"• Total processed: {total}\n"
        message += f"• Successfully imported: {successful}\n"
        message += f"• Failed: {failed}\n"
        message += f"• User data copied: {results['user_data_copied']}\n"
        
        if results['successful']:
            message += f"\nSuccessfully imported profiles:\n"
            for profile in results['successful']:
                message += f"• {profile['legacy_name']} → {profile['new_name']}\n"
                
        if results['failed']:
            message += f"\nFailed imports:\n"
            for failed_name in results['failed']:
                message += f"• {failed_name}\n"
                
        if results['errors']:
            message += f"\nErrors:\n"
            for error in results['errors'][:5]:  # Show first 5 errors
                message += f"• {error}\n"
            if len(results['errors']) > 5:
                message += f"... and {len(results['errors']) - 5} more errors\n"
                
        # Show results dialog
        result_dialog = ctk.CTkToplevel(self)
        result_dialog.title("Import Results")
        result_dialog.geometry("600x500")
        result_dialog.transient(self)
        result_dialog.grab_set()
        
        # Center the dialog
        result_dialog.update_idletasks()
        x = (result_dialog.winfo_screenwidth() // 2) - (600 // 2)
        y = (result_dialog.winfo_screenheight() // 2) - (500 // 2)
        result_dialog.geometry(f"600x500+{x}+{y}")
        
        # Results text
        results_text = ctk.CTkTextbox(result_dialog, wrap="word")
        results_text.pack(fill="both", expand=True, padx=20, pady=20)
        results_text.insert("1.0", message)
        results_text.configure(state="disabled")
        
        # OK button
        ok_btn = ctk.CTkButton(
            result_dialog,
            text="OK",
            command=result_dialog.destroy,
            width=100
        )
        ok_btn.pack(pady=20)
        
    def _import_error(self, error: str) -> None:
        """Handles import error."""
        self.progress_bar.set(0)
        self.status_label.configure(text="Import failed!")
        
        # Re-enable buttons
        self.import_btn.configure(state="normal")
        self.scan_btn.configure(state="normal")
        self.browse_btn.configure(state="normal")
        
        messagebox.showerror("Import Error", f"An error occurred during import:\n\n{error}")
        
    def _scan_error(self, error: str) -> None:
        """Handles scan error."""
        self.progress_bar.set(0)
        self.status_label.configure(text="Scan failed!")
        messagebox.showerror("Scan Error", f"An error occurred while scanning:\n\n{error}")