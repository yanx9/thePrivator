"""Export profiles dialog for thePrivator."""

import customtkinter as ctk
from pathlib import Path
from typing import Dict, List
from datetime import datetime
import sys

# Add src to path
src_dir = Path(__file__).parent.parent.absolute()
if str(src_dir) not in sys.path:
    sys.path.insert(0, str(src_dir))

from core.profile_manager import ProfileManager
from utils.logger import get_logger


class ExportDialog(ctk.CTkToplevel):
    """Dialog for selecting and exporting profiles."""
    
    def __init__(self, parent, profile_manager: ProfileManager):
        super().__init__(parent)
        
        self.profile_manager = profile_manager
        self.logger = get_logger(__name__)
        self.selected_profiles: Dict[str, ctk.BooleanVar] = {}
        self.result = None
        
        self._setup_dialog()
        self._create_widgets()
        self._load_profiles()
        
        # Modal
        self.transient(parent)
        self.grab_set()
        self.focus()
        
    def _setup_dialog(self) -> None:
        """Configures the dialog."""
        self.title("Export Profiles")
        self.geometry("600x500")
        self.resizable(True, True)
        
        # Center on screen
        self.update_idletasks()
        x = (self.winfo_screenwidth() // 2) - 300
        y = (self.winfo_screenheight() // 2) - 250
        self.geometry(f"600x500+{x}+{y}")
        
    def _create_widgets(self) -> None:
        """Creates dialog widgets."""
        # Main frame
        main_frame = ctk.CTkFrame(self)
        main_frame.pack(fill="both", expand=True, padx=20, pady=20)
        
        # Title
        title_label = ctk.CTkLabel(
            main_frame,
            text="Select Profiles to Export",
            font=ctk.CTkFont(size=20, weight="bold")
        )
        title_label.pack(pady=(10, 20))
        
        # Selection buttons
        button_frame = ctk.CTkFrame(main_frame)
        button_frame.pack(fill="x", padx=10, pady=(0, 10))
        
        ctk.CTkButton(
            button_frame,
            text="Select All",
            command=self._select_all,
            width=100,
            height=30
        ).pack(side="left", padx=5)
        
        ctk.CTkButton(
            button_frame,
            text="Select None",
            command=self._select_none,
            width=100,
            height=30
        ).pack(side="left", padx=5)
        
        self.selection_label = ctk.CTkLabel(
            button_frame,
            text="0 profiles selected",
            font=ctk.CTkFont(size=12)
        )
        self.selection_label.pack(side="right", padx=10)
        
        # Profile list
        self.profiles_frame = ctk.CTkScrollableFrame(
            main_frame,
            label_text="Available Profiles"
        )
        self.profiles_frame.pack(fill="both", expand=True, padx=10, pady=10)
        
        # Bottom buttons
        bottom_frame = ctk.CTkFrame(main_frame)
        bottom_frame.pack(fill="x", padx=10, pady=20)
        
        ctk.CTkButton(
            bottom_frame,
            text="Cancel",
            command=self.destroy,
            fg_color="gray",
            hover_color="darkgray",
            width=100
        ).pack(side="left", padx=10)
        
        self.export_btn = ctk.CTkButton(
            bottom_frame,
            text="Export Selected",
            command=self._export,
            fg_color="darkgreen",
            hover_color="green",
            width=150
        )
        self.export_btn.pack(side="right", padx=10)
        
    def _load_profiles(self) -> None:
        """Loads available profiles."""
        profiles = self.profile_manager.get_all_profiles()
        
        for i, profile in enumerate(profiles):
            frame = ctk.CTkFrame(self.profiles_frame)
            frame.pack(fill="x", padx=5, pady=2)
            
            # Checkbox
            var = ctk.BooleanVar(value=False)
            self.selected_profiles[profile.id] = var
            
            checkbox = ctk.CTkCheckBox(
                frame,
                text="",
                variable=var,
                command=self._update_selection_count,
                width=20
            )
            checkbox.pack(side="left", padx=10)
            
            # Profile info
            info_text = f"{profile.name}"
            if profile.proxy:
                info_text += f" (Proxy: {profile.proxy[:30]}...)"
                
            ctk.CTkLabel(
                frame,
                text=info_text,
                anchor="w",
                font=ctk.CTkFont(size=13)
            ).pack(side="left", fill="x", expand=True, padx=10)
            
    def _select_all(self) -> None:
        """Selects all profiles."""
        for var in self.selected_profiles.values():
            var.set(True)
        self._update_selection_count()
        
    def _select_none(self) -> None:
        """Deselects all profiles."""
        for var in self.selected_profiles.values():
            var.set(False)
        self._update_selection_count()
        
    def _update_selection_count(self) -> None:
        """Updates the selection count label."""
        count = sum(1 for var in self.selected_profiles.values() if var.get())
        self.selection_label.configure(text=f"{count} profiles selected")
        self.export_btn.configure(state="normal" if count > 0 else "disabled")
        
    def _export(self) -> None:
        """Exports selected profiles."""
        import tkinter.filedialog as filedialog
        import tkinter.messagebox as msgbox
        
        # Get selected profile IDs
        selected_ids = [
            profile_id for profile_id, var in self.selected_profiles.items()
            if var.get()
        ]
        
        if not selected_ids:
            msgbox.showwarning("No Selection", "Please select at least one profile")
            return
        
        # Generate filename
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        default_filename = f"{timestamp}.privator"
        
        file_path = filedialog.asksaveasfilename(
            parent=self,
            title="Export profiles",
            defaultextension=".privator",
            filetypes=[("Privator Archive", "*.privator"), ("All files", "*.*")],
            initialfile=default_filename
        )
        
        if file_path:
            try:
                self.profile_manager.export_profiles_bulk(selected_ids, Path(file_path))
                
                msgbox.showinfo(
                    "Export Successful",
                    f"Successfully exported {len(selected_ids)} profile(s) to:\n{file_path}"
                )
                
                self.result = len(selected_ids)
                self.destroy()
                
            except Exception as e:
                msgbox.showerror("Export Error", f"Failed to export profiles:\n{e}")