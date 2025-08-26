"""
Main application window - Fast startup without automatic size calculation.
Save this file as: src/gui/main_window.py
"""

import customtkinter as ctk
from typing import Optional, List, Dict, Any
import threading
import sys
from pathlib import Path
import time

# Ensure src is in path
src_dir = Path(__file__).parent.parent.absolute()
if str(src_dir) not in sys.path:
    sys.path.insert(0, str(src_dir))

# Local imports
from core.profile_manager import ProfileManager, ChromiumProfile
from core.chromium_launcher import ChromiumLauncher
from core.config_manager import ConfigManager
from utils.logger import get_logger
from gui.profile_dialog import ProfileDialog
from gui.legacy_import_dialog import LegacyImportDialog


class MainWindow(ctk.CTk):
    """Main thePrivator application window - optimized for fast startup."""
    
    def __init__(self, config_dir: Optional[Path] = None):
        super().__init__()
        
        self.logger = get_logger(__name__)
        self.config_manager = ConfigManager(config_dir)
        self.profile_manager = ProfileManager(config_dir)
        self.chromium_launcher = ChromiumLauncher()
        
        self.selected_profile_id: Optional[str] = None
        
        # Lightweight data structures only
        self.profile_widgets = {}  # profile_id -> widget references
        self.last_known_states = {}  # Last known running states
        self.refresh_interval = 1000  # 2 seconds in milliseconds
        
        self._setup_window()
        self._create_widgets()
        self._load_profiles()
        
        # Start lightweight refresh
        self.logger.info(f"Starting auto-refresh with {self.refresh_interval}ms interval")
        self._refresh_status()
        
        # Handle window closing
        self.protocol("WM_DELETE_WINDOW", self._on_closing)
        
    def _setup_window(self) -> None:
        """Configures main window."""
        self.title("thePrivator 2.0 - Chromium Profile Manager")
        
        geometry = self.config_manager.get('window_geometry', '900x700')
        self.geometry(geometry)
        self.minsize(700, 500)
        
        ctk.set_appearance_mode(self.config_manager.get('theme', 'dark'))
        ctk.set_default_color_theme(self.config_manager.get('color_theme', 'blue'))
        
        self.grid_columnconfigure(1, weight=1)
        self.grid_rowconfigure(0, weight=1)
        
    def _create_widgets(self) -> None:
        """Creates interface widgets."""
        self._create_sidebar()
        self._create_main_panel()
        
    def _create_sidebar(self) -> None:
        """Creates sidebar panel."""
        self.sidebar = ctk.CTkFrame(self, width=250)
        self.sidebar.grid(row=0, column=0, sticky="nsew", padx=(10, 5), pady=10)
        self.sidebar.grid_rowconfigure(8, weight=1)
        
        # Logo/Title
        self.logo_label = ctk.CTkLabel(
            self.sidebar,
            text="🌐 thePrivator",
            font=ctk.CTkFont(size=24, weight="bold")
        )
        self.logo_label.grid(row=0, column=0, padx=20, pady=(20, 10))
        
        # Simple stats only
        self.stats_label = ctk.CTkLabel(
            self.sidebar,
            text="Profiles: 0\nActive: 0",
            font=ctk.CTkFont(size=12)
        )
        self.stats_label.grid(row=1, column=0, padx=20, pady=(0, 20))
        
        # Action buttons
        self.new_profile_btn = ctk.CTkButton(
            self.sidebar,
            text="➕ New Profile",
            command=self._create_new_profile,
            height=40
        )
        self.new_profile_btn.grid(row=2, column=0, padx=20, pady=5, sticky="ew")
        
        self.edit_profile_btn = ctk.CTkButton(
            self.sidebar,
            text="✏️ Edit Profile",
            command=self._edit_profile,
            state="disabled",
            height=40
        )
        self.edit_profile_btn.grid(row=3, column=0, padx=20, pady=5, sticky="ew")
        
        self.launch_profile_btn = ctk.CTkButton(
            self.sidebar,
            text="🚀 Launch Profile",
            command=self._launch_profile,
            state="disabled",
            fg_color="darkgreen",
            hover_color="green",
            height=40
        )
        self.launch_profile_btn.grid(row=4, column=0, padx=20, pady=5, sticky="ew")
        
        self.stop_profile_btn = ctk.CTkButton(
            self.sidebar,
            text="⏹️ Stop Profile",
            command=self._stop_profile,
            state="disabled",
            fg_color="orange",
            hover_color="darkorange",
            height=40
        )
        self.stop_profile_btn.grid(row=5, column=0, padx=20, pady=5, sticky="ew")
        
        self.delete_profile_btn = ctk.CTkButton(
            self.sidebar,
            text="🗑️ Delete Profile",
            command=self._delete_profile,
            state="disabled",
            fg_color="darkred",
            hover_color="red",
            height=40
        )
        self.delete_profile_btn.grid(row=6, column=0, padx=20, pady=5, sticky="ew")
        
        # Separator
        separator = ctk.CTkFrame(self.sidebar, height=2)
        separator.grid(row=7, column=0, padx=20, pady=20, sticky="ew")
        
        # Import/Export buttons
        import_frame = ctk.CTkFrame(self.sidebar)
        import_frame.grid(row=9, column=0, padx=20, pady=2, sticky="ew")
        import_frame.grid_columnconfigure(0, weight=1)
        import_frame.grid_columnconfigure(1, weight=1)
        
        self.import_btn = ctk.CTkButton(
            import_frame,
            text="📥 Import",
            command=self._import_profile,
            height=35,
            fg_color="gray",
            hover_color="darkgray"
        )
        self.import_btn.grid(row=0, column=0, padx=(0, 2), sticky="ew")
        
        self.legacy_import_btn = ctk.CTkButton(
            import_frame,
            text="📦 Legacy",
            command=self._import_legacy_profiles,
            height=35,
            fg_color="gray",
            hover_color="darkgray"
        )
        self.legacy_import_btn.grid(row=0, column=1, padx=(2, 0), sticky="ew")
        
        self.export_btn = ctk.CTkButton(
            self.sidebar,
            text="📤 Export",
            command=self._export_profile,
            state="disabled",
            height=35,
            fg_color="gray",
            hover_color="darkgray"
        )
        self.export_btn.grid(row=10, column=0, padx=20, pady=2, sticky="ew")
        
        # Status
        self.status_label = ctk.CTkLabel(
            self.sidebar,
            text="Ready",
            font=ctk.CTkFont(size=12),
            text_color="green"
        )
        self.status_label.grid(row=11, column=0, padx=20, pady=(10, 20))
        
    def _create_main_panel(self) -> None:
        """Creates main panel."""
        self.main_frame = ctk.CTkFrame(self)
        self.main_frame.grid(row=0, column=1, sticky="nsew", padx=(5, 10), pady=10)
        self.main_frame.grid_columnconfigure(0, weight=1)
        self.main_frame.grid_rowconfigure(1, weight=1)
        
        # Header with search
        self.header_frame = ctk.CTkFrame(self.main_frame)
        self.header_frame.grid(row=0, column=0, sticky="ew", padx=10, pady=(10, 5))
        self.header_frame.grid_columnconfigure(1, weight=1)
        
        self.search_label = ctk.CTkLabel(
            self.header_frame,
            text="🔍 Search:",
            font=ctk.CTkFont(size=14, weight="bold")
        )
        self.search_label.grid(row=0, column=0, padx=(10, 5), pady=10)
        
        self.search_entry = ctk.CTkEntry(
            self.header_frame,
            placeholder_text="Type profile name...",
            height=35
        )
        self.search_entry.grid(row=0, column=1, padx=(5, 10), pady=10, sticky="ew")
        self.search_entry.bind("<KeyRelease>", self._on_search)
        
        # Profile list
        self.profiles_scrollable = ctk.CTkScrollableFrame(
            self.main_frame,
            label_text="Chromium Profiles"
        )
        self.profiles_scrollable.grid(row=1, column=0, sticky="nsew", padx=10, pady=5)
        self.profiles_scrollable.grid_columnconfigure(0, weight=1)
        
        # Table header - without size column
        self._create_table_header()
        
    def _create_table_header(self) -> None:
        """Creates profile table header."""
        self.header_row = ctk.CTkFrame(self.profiles_scrollable)
        self.header_row.grid(row=0, column=0, sticky="ew", padx=5, pady=5)
        
        # Column weights
        self.header_row.grid_columnconfigure(0, weight=2)  # Name
        self.header_row.grid_columnconfigure(1, weight=3)  # User-Agent  
        self.header_row.grid_columnconfigure(2, weight=2)  # Proxy
        self.header_row.grid_columnconfigure(3, weight=1)  # Status
        
        headers = [
            ("📋 Name", 0),
            ("🌐 User-Agent", 1), 
            ("🔗 Proxy", 2),
            ("📊 Status", 3)
        ]
        
        for header_text, col in headers:
            label = ctk.CTkLabel(
                self.header_row,
                text=header_text,
                font=ctk.CTkFont(size=13, weight="bold")
            )
            label.grid(row=0, column=col, padx=5, pady=8, sticky="ew")
            
    def _load_profiles(self) -> None:
        """Loads profiles with alphabetical sorting."""
        try:
            start_time = time.time()
            
            # Clear existing list only if needed
            for widget in self.profiles_scrollable.winfo_children()[1:]:
                widget.destroy()
            self.profile_widgets.clear()
            
            profiles = self.profile_manager.get_all_profiles()
            
            # Sort profiles alphabetically by name (case-insensitive)
            profiles.sort(key=lambda p: p.name.lower())
            
            # Get current running profiles
            running_profiles = {p.profile_id for p in self.chromium_launcher.get_running_profiles()}
            
            # Filter by search
            search_term = self.search_entry.get().lower() if hasattr(self, 'search_entry') else ""
            if search_term:
                profiles = [p for p in profiles if search_term in p.name.lower()]
            
            # Create rows
            for i, profile in enumerate(profiles, 1):
                is_running = profile.id in running_profiles
                self._create_profile_row(i, profile, is_running)
                self.last_known_states[profile.id] = is_running
            
            self._update_stats()
            
            load_time = time.time() - start_time
            self.logger.debug(f"Loaded {len(profiles)} profiles in {load_time:.2f}s")
            
        except Exception as e:
            self.logger.error(f"Error loading profiles: {e}")
            self.status_label.configure(text="Error", text_color="red")
            
    def _create_profile_row(self, row: int, profile: ChromiumProfile, is_running: bool) -> None:
        """Creates profile row without heavy operations."""
        fg_color = ("gray75", "gray25") if row % 2 == 0 else ("gray85", "gray15")
        
        frame = ctk.CTkFrame(self.profiles_scrollable, fg_color=fg_color)
        frame.grid(row=row, column=0, sticky="ew", padx=5, pady=1)
        
        # Column weights to match header
        frame.grid_columnconfigure(0, weight=2)  # Name
        frame.grid_columnconfigure(1, weight=3)  # User-Agent
        frame.grid_columnconfigure(2, weight=2)  # Proxy  
        frame.grid_columnconfigure(3, weight=1)  # Status
        
        # Name
        def select_callback(pid=profile.id):
            return lambda: self._select_profile(pid)
        
        name_btn = ctk.CTkButton(
            frame,
            text=f"{'🟢' if is_running else '⚫'} {profile.name}",
            command=select_callback(),
            height=35,
            anchor="w"
        )
        name_btn.grid(row=0, column=0, padx=5, pady=5, sticky="ew")
        
        # User-Agent
        ua_text = profile.user_agent[:45] + "..." if len(profile.user_agent) > 45 else profile.user_agent
        ua_label = ctk.CTkLabel(frame, text=ua_text, anchor="w", font=ctk.CTkFont(size=11))
        ua_label.grid(row=0, column=1, padx=5, pady=5, sticky="ew")
        
        # Proxy
        proxy_text = profile.proxy[:30] + "..." if profile.proxy and len(profile.proxy) > 30 else (profile.proxy or "None")
        proxy_label = ctk.CTkLabel(frame, text=proxy_text, anchor="w", font=ctk.CTkFont(size=11))
        proxy_label.grid(row=0, column=2, padx=5, pady=5, sticky="ew")
        
        # Status
        if is_running:
            status_text = "🟢 Running"
        else:
            status_text = "⚫ Stopped"
            
        status_label = ctk.CTkLabel(frame, text=status_text, anchor="center", font=ctk.CTkFont(size=11))
        status_label.grid(row=0, column=3, padx=5, pady=5, sticky="ew")
        
        # Store references
        self.profile_widgets[profile.id] = {
            'frame': frame,
            'name_btn': name_btn,
            'status_label': status_label,
            'profile': profile
        }
        
    def _refresh_status(self) -> None:
        """Lightweight status refresh that updates in-place."""
        try:
            self.logger.debug("Running status refresh cycle")
            
            # Clean up orphaned processes first
            self.chromium_launcher.cleanup_orphaned_processes()
            
            # Get current running profiles
            current_running = {p.profile_id for p in self.chromium_launcher.get_running_profiles()}
            
            # Check if profile list structure changed (added/removed profiles)
            current_profiles = self.profile_manager.get_all_profiles()
            current_profile_ids = {p.id for p in current_profiles}
            widget_profile_ids = set(self.profile_widgets.keys())
            
            if current_profile_ids != widget_profile_ids:
                # Only reload if profiles were added/removed
                self.logger.info("Profile list changed, reloading")
                self._load_profiles()
            else:
                # Just update statuses in-place
                changes = 0
                for profile_id, widgets in self.profile_widgets.items():
                    if not widgets:
                        continue
                        
                    is_running_now = profile_id in current_running
                    was_running = self.last_known_states.get(profile_id, False)
                    
                    if is_running_now != was_running:
                        changes += 1
                        self.last_known_states[profile_id] = is_running_now
                        profile = widgets['profile']
                        
                        # Update only the changed elements
                        try:
                            if 'name_btn' in widgets and widgets['name_btn'].winfo_exists():
                                widgets['name_btn'].configure(
                                    text=f"{'🟢' if is_running_now else '⚫'} {profile.name}"
                                )
                            if 'status_label' in widgets and widgets['status_label'].winfo_exists():
                                widgets['status_label'].configure(
                                    text="🟢 Running" if is_running_now else "⚫ Stopped"
                                )
                        except Exception as e:
                            self.logger.debug(f"Widget update error (likely destroyed): {e}")
                        
                        self.logger.debug(f"Profile '{profile.name}' status changed")
                
                if changes > 0:
                    self._update_stats()
                    self.logger.info(f"Status refresh: {changes} profile(s) changed")
            
            # Update selected profile buttons if needed
            if self.selected_profile_id and self.selected_profile_id in current_running:
                is_selected_running = self.selected_profile_id in current_running
                if self.launch_profile_btn.cget("state") != ("disabled" if is_selected_running else "normal"):
                    self.launch_profile_btn.configure(state="disabled" if is_selected_running else "normal")
                    self.stop_profile_btn.configure(state="normal" if is_selected_running else "disabled")
                    
        except Exception as e:
            self.logger.error(f"Error in refresh cycle: {e}")
            
        # Schedule next refresh (faster interval for better detection)
        self.after(self.refresh_interval, self._refresh_status)
            
    def _update_stats(self) -> None:
        """Updates statistics."""
        try:
            stats = self.profile_manager.get_stats()
            running_count = len([pid for pid in self.last_known_states if self.last_known_states[pid]])
            
            self.stats_label.configure(
                text=f"Profiles: {stats['total_profiles']}\nActive: {running_count}"
            )
        except Exception as e:
            self.logger.warning(f"Error updating stats: {e}")
            
    def _select_profile(self, profile_id: str) -> None:
        """Selects profile."""
        self.selected_profile_id = profile_id
        profile = self.profile_manager.get_profile(profile_id)
        
        if profile:
            self.edit_profile_btn.configure(state="normal")
            self.delete_profile_btn.configure(state="normal")
            self.export_btn.configure(state="normal")
            
            is_running = self.chromium_launcher.is_profile_running(profile_id)
            
            if is_running:
                self.launch_profile_btn.configure(state="disabled")
                self.stop_profile_btn.configure(state="normal")
            else:
                self.launch_profile_btn.configure(state="normal")
                self.stop_profile_btn.configure(state="disabled")
            
            self.status_label.configure(text=f"Selected: {profile.name}", text_color="blue")
            
    def _create_new_profile(self) -> None:
        """Creates new profile."""
        try:
            dialog = ProfileDialog(self, self.profile_manager, self.config_manager)
            if dialog.result:
                # Don't reload everything - let refresh pick it up
                self.status_label.configure(text="Created profile", text_color="green")
                # Force immediate refresh
                self.after(100, self._refresh_status)
        except Exception as e:
            self.logger.error(f"Error creating profile: {e}")
            import tkinter.messagebox as msgbox
            msgbox.showerror("Error", f"Cannot create profile: {e}")
            
    def _edit_profile(self) -> None:
        """Edits selected profile."""
        if hasattr(self, 'selected_profile_id') and self.selected_profile_id:
            profile = self.profile_manager.get_profile(self.selected_profile_id)
            if profile:
                try:
                    dialog = ProfileDialog(self, self.profile_manager, self.config_manager, profile)
                    if dialog.result:
                        self._load_profiles()
                        self.status_label.configure(text="Updated profile", text_color="green")
                except Exception as e:
                    self.logger.error(f"Error editing profile: {e}")
                    import tkinter.messagebox as msgbox
                    msgbox.showerror("Error", f"Cannot edit profile: {e}")
                    
    def _delete_profile(self) -> None:
        """Deletes selected profile."""
        if hasattr(self, 'selected_profile_id') and self.selected_profile_id:
            profile = self.profile_manager.get_profile(self.selected_profile_id)
            if profile:
                if self.chromium_launcher.is_profile_running(profile.id):
                    import tkinter.messagebox as msgbox
                    msgbox.showwarning("Profile Running", f"Stop '{profile.name}' before deletion.")
                    return
                
                import tkinter.messagebox as msgbox
                if msgbox.askyesno("Confirmation", f"Delete profile '{profile.name}'?\n\nThis will permanently remove all profile data."):
                    try:
                        # Remove from known states
                        if profile.id in self.last_known_states:
                            del self.last_known_states[profile.id]
                            
                        # After successful deletion
                        self.profile_manager.delete_profile(self.selected_profile_id)

                        # Remove widget immediately
                        if self.selected_profile_id in self.profile_widgets:
                            widgets = self.profile_widgets[self.selected_profile_id]
                            if 'frame' in widgets:
                                widgets['frame'].destroy()
                            del self.profile_widgets[self.selected_profile_id]

                        # Clear selection
                        self.selected_profile_id = None
                        self.edit_profile_btn.configure(state="disabled")
                        self.delete_profile_btn.configure(state="disabled")
                        self.export_btn.configure(state="disabled")
                        self.launch_profile_btn.configure(state="disabled")
                        self.stop_profile_btn.configure(state="disabled")

                        self.status_label.configure(text="Deleted profile", text_color="orange")
                        self._update_stats()
                        self.logger.info(f"Deleted profile: {profile.name}")
                    except Exception as e:
                        msgbox.showerror("Error", f"Cannot delete: {e}")
                        
    def _launch_profile(self) -> None:
        """Launches selected profile."""
        if hasattr(self, 'selected_profile_id') and self.selected_profile_id:
            profile = self.profile_manager.get_profile(self.selected_profile_id)
            if profile:
                if not self.chromium_launcher._chromium_path:
                    import tkinter.messagebox as msgbox
                    msgbox.showerror("Chromium Not Found", "Please install Chrome/Chromium")
                    return
                
                def launch():
                    try:
                        self.chromium_launcher.launch_profile(profile)
                        self.profile_manager.mark_as_used(profile.id)
                        self.profile_manager.set_active_status(profile.id, True)
                        self.after(100, lambda: self._on_profile_launched(profile))
                    except Exception as e:
                        self.after(100, lambda: self._on_launch_error(str(e)))
                        
                threading.Thread(target=launch, daemon=True).start()
                self.status_label.configure(text="Launching...", text_color="yellow")
                self.logger.info(f"Launching profile: {profile.name}")
                
    def _stop_profile(self) -> None:
        """Stops selected profile in background thread."""
        if not (hasattr(self, 'selected_profile_id') and self.selected_profile_id):
            return
            
        profile = self.profile_manager.get_profile(self.selected_profile_id)
        if not profile:
            return
        
        # Disable button immediately to prevent double-clicks
        self.stop_profile_btn.configure(state="disabled")
        self.status_label.configure(text="Stopping...", text_color="yellow")
        
        def stop_thread():
            try:
                success = self.chromium_launcher.terminate_profile(profile.id)
                
                def update_ui():
                    if success:
                        self.profile_manager.set_active_status(profile.id, False)
                        self.last_known_states[profile.id] = False
                        
                        # Update UI
                        if profile.id in self.profile_widgets:
                            widgets = self.profile_widgets[profile.id]
                            if 'name_btn' in widgets:
                                widgets['name_btn'].configure(text=f"⚫ {profile.name}")
                            if 'status_label' in widgets:
                                widgets['status_label'].configure(text="⚫ Stopped")
                        
                        self.launch_profile_btn.configure(state="normal")
                        self.status_label.configure(text="Stopped profile", text_color="orange")
                        self._update_stats()
                        self.logger.info(f"Stopped profile: {profile.name}")
                    else:
                        self.stop_profile_btn.configure(state="normal")
                        self.status_label.configure(text="Failed to stop", text_color="red")
                        import tkinter.messagebox as msgbox
                        msgbox.showerror("Error", "Cannot stop profile")
                
                self.after(0, update_ui)
                
            except Exception as e:
                self.logger.error(f"Error stopping profile: {e}")
                self.after(0, lambda: self.status_label.configure(text="Error", text_color="red"))
        
        threading.Thread(target=stop_thread, daemon=True).start()
                    
    def _import_profile(self) -> None:
        """Imports profile from file."""
        import tkinter.filedialog as filedialog
        
        file_path = filedialog.askopenfilename(
            title="Select profile file",
            filetypes=[("JSON files", "*.json"), ("All files", "*.*")]
        )
        
        if file_path:
            try:
                profile = self.profile_manager.import_profile(Path(file_path))
                self._load_profiles()
                self.status_label.configure(text=f"Imported: {profile.name}", text_color="green")
                self.logger.info(f"Imported profile: {profile.name}")
            except Exception as e:
                import tkinter.messagebox as msgbox
                msgbox.showerror("Import Error", f"Cannot import: {e}")
                
    def _import_legacy_profiles(self) -> None:
        """Opens legacy profile import dialog."""
        try:
            dialog = LegacyImportDialog(self, self.profile_manager)
            self.wait_window(dialog)
            self._load_profiles()
            self._update_stats()
            self.logger.info("Completed legacy profile import")
        except Exception as e:
            self.logger.error(f"Error opening legacy import: {e}")
            import tkinter.messagebox as msgbox
            msgbox.showerror("Error", f"Cannot open import: {e}")
            
    def _export_profile(self) -> None:
        """Exports selected profile."""
        if hasattr(self, 'selected_profile_id') and self.selected_profile_id:
            profile = self.profile_manager.get_profile(self.selected_profile_id)
            if profile:
                import tkinter.filedialog as filedialog
                
                file_path = filedialog.asksaveasfilename(
                    title="Save profile as",
                    defaultextension=".json",
                    filetypes=[("JSON files", "*.json")],
                    initialvalue=f"{profile.name}.json"
                )
                
                if file_path:
                    try:
                        self.profile_manager.export_profile(profile.id, Path(file_path))
                        self.status_label.configure(text="Exported", text_color="green")
                        self.logger.info(f"Exported profile: {profile.name}")
                    except Exception as e:
                        import tkinter.messagebox as msgbox
                        msgbox.showerror("Export Error", f"Cannot export: {e}")
                        
    def _on_search(self, event=None) -> None:
        """Handles search with debouncing."""
        # Cancel any pending reload
        if hasattr(self, '_search_timer'):
            self.after_cancel(self._search_timer)
        
        # Schedule reload after 300ms of no typing
        self._search_timer = self.after(300, self._load_profiles)
        
    def _on_profile_launched(self, profile: ChromiumProfile) -> None:
        """Callback after profile launch."""
        # Update state immediately
        self.last_known_states[profile.id] = True
        
        # Force immediate UI update
        if profile.id in self.profile_widgets:
            widgets = self.profile_widgets[profile.id]
            if 'name_btn' in widgets:
                widgets['name_btn'].configure(text=f"🟢 {profile.name}")
            if 'status_label' in widgets:
                widgets['status_label'].configure(text="🟢 Running")
        
        if hasattr(self, 'selected_profile_id') and self.selected_profile_id == profile.id:
            self.launch_profile_btn.configure(state="disabled")
            self.stop_profile_btn.configure(state="normal")
        
        self._update_stats()
        self.status_label.configure(text=f"Launched: {profile.name}", text_color="green")
        
    def _on_launch_error(self, error: str) -> None:
        """Callback on launch error."""
        import tkinter.messagebox as msgbox
        msgbox.showerror("Launch Error", error)
        self.status_label.configure(text="Launch error", text_color="red")
        self.logger.error(f"Launch error: {error}")
            

    def _on_closing(self) -> None:
        """Handles window closing."""
        try:
            self.config_manager.set('window_geometry', self.geometry())
            
            running_profiles = self.chromium_launcher.get_running_profiles()
            if running_profiles:
                import tkinter.messagebox as msgbox
                if msgbox.askyesno(
                    "Close Application",
                    f"Stop {len(running_profiles)} running profiles before closing?"
                ):
                    self.chromium_launcher.terminate_all_profiles()
                    self.logger.info(f"Stopped {len(running_profiles)} profiles on exit")
                    
            self.logger.info("Closing application")
            self.destroy()
            
        except Exception as e:
            self.logger.error(f"Error during closing: {e}")
            self.destroy()