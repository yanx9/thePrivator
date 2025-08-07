"""
Main application window with improved interface.
"""

import customtkinter as ctk
from typing import Optional, List
import threading
import sys
from pathlib import Path

# Ensure src is in path
src_dir = Path(__file__).parent.parent.absolute()
if str(src_dir) not in sys.path:
    sys.path.insert(0, str(src_dir))

# Local imports (without relative imports)
from core.profile_manager import ProfileManager, ChromiumProfile
from core.chromium_launcher import ChromiumLauncher
from core.config_manager import ConfigManager
from utils.logger import get_logger
from gui.profile_dialog import ProfileDialog


class MainWindow(ctk.CTk):
    """Main thePrivator application window."""
    
    def __init__(self, config_dir: Optional[Path] = None):
        super().__init__()
        
        self.logger = get_logger(__name__)
        self.config_manager = ConfigManager(config_dir)
        self.profile_manager = ProfileManager(config_dir)
        self.chromium_launcher = ChromiumLauncher()
        
        self.selected_profile_id: Optional[str] = None
        
        # Store profile widget references for efficient updates
        self.profile_widgets = {}  # profile_id -> {'name_btn': btn, 'status_label': label}
        
        self._setup_window()
        self._create_widgets()
        self._load_profiles()
        
        # Start auto-refresh every 1 second
        self._refresh_status()
        
        # Handle window closing
        self.protocol("WM_DELETE_WINDOW", self._on_closing)
        
    def _setup_window(self) -> None:
        """Configures main window."""
        self.title("thePrivator 2.0 - Chromium Profile Manager")
        
        # Load geometry from configuration
        geometry = self.config_manager.get('window_geometry', '900x700')
        self.geometry(geometry)
        self.minsize(700, 500)
        
        # Theme configuration
        ctk.set_appearance_mode(self.config_manager.get('theme', 'dark'))
        ctk.set_default_color_theme(self.config_manager.get('color_theme', 'blue'))
        
        # Grid configuration
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
        
        # Information
        try:
            stats = self.profile_manager.get_stats()
            stats_text = f"Profiles: {stats['total_profiles']}\nActive: {stats['active_profiles']}"
        except:
            stats_text = "Profiles: 0\nActive: 0"
            
        self.stats_label = ctk.CTkLabel(
            self.sidebar,
            text=stats_text,
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
        
        # Tool buttons
        self.import_btn = ctk.CTkButton(
            self.sidebar,
            text="📥 Import",
            command=self._import_profile,
            height=35,
            fg_color="gray",
            hover_color="darkgray"
        )
        self.import_btn.grid(row=9, column=0, padx=20, pady=2, sticky="ew")
        
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
        
        # Header with search - REMOVED MANUAL REFRESH BUTTON
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
        self.search_entry.grid(row=0, column=1, padx=5, pady=10, sticky="ew")
        self.search_entry.bind("<KeyRelease>", self._on_search)
        
        # Auto-refresh status indicator (replaces manual refresh button)
        # Note: Full profile list rebuilds only happen on search, add, delete, etc.
        # Status updates happen every 1s without flickering via _update_profile_status_display()
        self.auto_refresh_label = ctk.CTkLabel(
            self.header_frame,
            text="🔄 Auto-refresh: ON",
            font=ctk.CTkFont(size=12),
            text_color="green"
        )
        self.auto_refresh_label.grid(row=0, column=2, padx=(5, 10), pady=10)
        
        # Profile list
        self.profiles_scrollable = ctk.CTkScrollableFrame(
            self.main_frame,
            label_text="Chromium Profiles"
        )
        self.profiles_scrollable.grid(row=1, column=0, sticky="nsew", padx=10, pady=5)
        self.profiles_scrollable.grid_columnconfigure(0, weight=1)
        
        # Table header
        self._create_table_header()
        
    def _create_table_header(self) -> None:
        """Creates profile table header."""
        self.header_row = ctk.CTkFrame(self.profiles_scrollable)
        self.header_row.grid(row=0, column=0, sticky="ew", padx=5, pady=5)
        self.header_row.grid_columnconfigure((0, 1, 2, 3), weight=1)
        
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
        """Loads profiles into list."""
        try:
            # Clear existing list (except header) and widget references
            for widget in self.profiles_scrollable.winfo_children()[1:]:
                widget.destroy()
            self.profile_widgets.clear()
                
            profiles = self.profile_manager.get_all_profiles()
            running_profiles = {p.profile_id for p in self.chromium_launcher.get_running_profiles()}
            
            # Filter by search
            search_term = self.search_entry.get().lower() if hasattr(self, 'search_entry') else ""
            if search_term:
                profiles = [p for p in profiles if search_term in p.name.lower()]
            
            for i, profile in enumerate(profiles, 1):
                self._create_profile_row(i, profile, profile.id in running_profiles)
                
            # Update statistics
            self._update_stats()
        except Exception as e:
            self.logger.error(f"Error loading profiles: {e}")
            self.status_label.configure(text="Error loading profiles", text_color="red")
            
    def _create_profile_row(self, row: int, profile: ChromiumProfile, is_running: bool) -> None:
        """Creates profile row."""
        # Background color depending on status
        fg_color = ("gray75", "gray25") if row % 2 == 0 else ("gray85", "gray15")
        
        frame = ctk.CTkFrame(self.profiles_scrollable, fg_color=fg_color)
        frame.grid(row=row, column=0, sticky="ew", padx=5, pady=1)
        frame.grid_columnconfigure((0, 1, 2, 3), weight=1)
        
        # Name (clickable) - fixed callback
        def select_profile_callback(pid=profile.id):
            return lambda: self._select_profile(pid)
        
        name_btn = ctk.CTkButton(
            frame,
            text=f"{'🟢' if is_running else '⚫'} {profile.name}",
            command=select_profile_callback(),
            height=35,
            anchor="w"
        )
        name_btn.grid(row=0, column=0, padx=5, pady=5, sticky="ew")
        
        # User-Agent (shortened)
        ua_text = profile.user_agent[:40] + "..." if len(profile.user_agent) > 40 else profile.user_agent
        ua_label = ctk.CTkLabel(frame, text=ua_text, anchor="w")
        ua_label.grid(row=0, column=1, padx=5, pady=5, sticky="ew")
        
        # Proxy
        proxy_text = profile.proxy[:30] + "..." if profile.proxy and len(profile.proxy) > 30 else (profile.proxy or "None")
        proxy_label = ctk.CTkLabel(frame, text=proxy_text, anchor="w")
        proxy_label.grid(row=0, column=2, padx=5, pady=5, sticky="ew")
        
        # Status
        if is_running:
            process_info = self.chromium_launcher.get_profile_process(profile.id)
            uptime = process_info.uptime if process_info else "N/A"
            status_text = f"🟢 Running ({uptime})"
        else:
            status_text = "⚫ Stopped"
            
        status_label = ctk.CTkLabel(
            frame,
            text=status_text,
            font=ctk.CTkFont(size=11)
        )
        status_label.grid(row=0, column=3, padx=5, pady=5, sticky="ew")
        
        # Store widget references for efficient updates
        self.profile_widgets[profile.id] = {
            'frame': frame,
            'name_btn': name_btn,
            'status_label': status_label,
            'profile': profile
        }
        
    def _select_profile(self, profile_id: str) -> None:
        """Selects profile."""
        self.selected_profile_id = profile_id
        profile = self.profile_manager.get_profile(profile_id)
        
        if profile:
            # Update button states
            self.edit_profile_btn.configure(state="normal")
            self.delete_profile_btn.configure(state="normal")
            self.export_btn.configure(state="normal")
            
            # Check if profile is running
            is_running = self.chromium_launcher.is_profile_running(profile_id)
            
            if is_running:
                self.launch_profile_btn.configure(state="disabled")
                self.stop_profile_btn.configure(state="normal")
            else:
                self.launch_profile_btn.configure(state="normal")
                self.stop_profile_btn.configure(state="disabled")
                
            self.status_label.configure(
                text=f"Selected: {profile.name}",
                text_color="blue"
            )
            
    def _create_new_profile(self) -> None:
        """Opens new profile creation dialog with surgical UI update."""
        try:
            dialog = ProfileDialog(self, self.profile_manager, self.config_manager)
            if dialog.result:
                # Get the newly created profile
                all_profiles = self.profile_manager.get_all_profiles()
                new_profile = all_profiles[-1] if all_profiles else None  # Assume newest is last
                
                if new_profile:
                    # Check if it should be displayed (search filter)
                    search_term = self.search_entry.get().lower() if hasattr(self, 'search_entry') else ""
                    should_display = not search_term or search_term in new_profile.name.lower()
                    
                    if should_display:
                        # Surgical UI update - just add this one widget
                        self._add_single_profile_widget(new_profile, False)
                
                # Update stats
                self._update_stats()
                
                self.status_label.configure(
                    text="Created new profile",
                    text_color="green"
                )
        except Exception as e:
            self.logger.error(f"Error creating profile: {e}")
            import tkinter.messagebox as msgbox
            msgbox.showerror("Error", f"Cannot open profile creation dialog: {e}")
            
    def _edit_profile(self) -> None:
        """Edits selected profile with surgical UI update."""
        if hasattr(self, 'selected_profile_id') and self.selected_profile_id:
            profile = self.profile_manager.get_profile(self.selected_profile_id)
            if profile:
                try:
                    dialog = ProfileDialog(self, self.profile_manager, self.config_manager, profile)
                    if dialog.result:
                        # Get updated profile
                        updated_profile = self.profile_manager.get_profile(self.selected_profile_id)
                        
                        if updated_profile:
                            # Check if it should still be displayed (search filter)
                            search_term = self.search_entry.get().lower() if hasattr(self, 'search_entry') else ""
                            should_display = not search_term or search_term in updated_profile.name.lower()
                            
                            if should_display:
                                # Update the widget in place
                                if self.selected_profile_id in self.profile_widgets:
                                    # Remove old widget
                                    self._remove_single_profile_widget(self.selected_profile_id)
                                    # Add updated widget
                                    is_running = self.chromium_launcher.is_profile_running(updated_profile.id)
                                    self._add_single_profile_widget(updated_profile, is_running)
                                    # Maintain selection
                                    self.selected_profile_id = updated_profile.id
                            else:
                                # Profile no longer matches search, remove it
                                self._remove_single_profile_widget(self.selected_profile_id)
                        
                        self.status_label.configure(
                            text="Updated profile",
                            text_color="green"
                        )
                except Exception as e:
                    self.logger.error(f"Error editing profile: {e}")
                    import tkinter.messagebox as msgbox
                    msgbox.showerror("Error", f"Cannot open edit dialog: {e}")
                    
    def _delete_profile(self) -> None:
        """Deletes selected profile using surgical UI update."""
        if hasattr(self, 'selected_profile_id') and self.selected_profile_id:
            profile = self.profile_manager.get_profile(self.selected_profile_id)
            if profile:
                # Check if profile is running
                if self.chromium_launcher.is_profile_running(profile.id):
                    import tkinter.messagebox as msgbox
                    msgbox.showwarning(
                        "Profile Running",
                        f"Profile '{profile.name}' is currently running.\n"
                        "Stop it before deletion."
                    )
                    return
                
                # Confirmation
                import tkinter.messagebox as msgbox
                if msgbox.askyesno(
                    "Confirmation",
                    f"Are you sure you want to delete profile '{profile.name}'?\n\n"
                    "This operation is irreversible and will remove all profile data."
                ):
                    try:
                        # Delete from manager
                        self.profile_manager.delete_profile(self.selected_profile_id)
                        
                        # Surgical UI update - just remove this one widget
                        self._remove_single_profile_widget(self.selected_profile_id)
                        
                        # Update stats
                        self._update_stats()
                        
                        self.status_label.configure(
                            text="Deleted profile",
                            text_color="orange"
                        )
                        
                    except Exception as e:
                        msgbox.showerror("Error", f"Cannot delete profile: {e}")
                        
    def _launch_profile(self) -> None:
        """Launches selected profile."""
        if hasattr(self, 'selected_profile_id') and self.selected_profile_id:
            profile = self.profile_manager.get_profile(self.selected_profile_id)
            if profile:
                # Check if Chromium was found
                if not self.chromium_launcher._chromium_path:
                    import tkinter.messagebox as msgbox
                    msgbox.showerror(
                        "Chromium Not Found",
                        "Cannot find Chromium executable.\n\n"
                        "Please install Google Chrome or Chromium and try again.\n"
                        "Or set the path manually in configuration."
                    )
                    return
                
                def launch():
                    error_msg = None
                    try:
                        self.chromium_launcher.launch_profile(profile)
                        self.profile_manager.mark_as_used(profile.id)
                        self.profile_manager.set_active_status(profile.id, True)
                        
                        # Update UI in main thread - fixed callback
                        def success_callback():
                            self._on_profile_launched(profile)
                        self.after(100, success_callback)
                        
                    except Exception as e:
                        error_msg = str(e)
                        # Fixed error callback
                        def error_callback():
                            self._on_launch_error(error_msg)
                        self.after(100, error_callback)
                        
                # Run in separate thread
                threading.Thread(target=launch, daemon=True).start()
                self.status_label.configure(
                    text="Launching...",
                    text_color="yellow"
                )
                
    def _stop_profile(self) -> None:
        """Stops selected profile."""
        if hasattr(self, 'selected_profile_id') and self.selected_profile_id:
            profile = self.profile_manager.get_profile(self.selected_profile_id)
            if profile:
                if self.chromium_launcher.terminate_profile(self.selected_profile_id):
                    self.profile_manager.set_active_status(profile.id, False)
                    self._load_profiles()
                    self.launch_profile_btn.configure(state="normal")
                    self.stop_profile_btn.configure(state="disabled")
                    self.status_label.configure(
                        text="Stopped profile",
                        text_color="orange"
                    )
                else:
                    import tkinter.messagebox as msgbox
                    msgbox.showerror("Error", "Cannot stop profile")
                    
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
                self.status_label.configure(
                    text=f"Imported: {profile.name}",
                    text_color="green"
                )
            except Exception as e:
                import tkinter.messagebox as msgbox
                msgbox.showerror("Import Error", f"Cannot import profile: {e}")
                
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
                        self.status_label.configure(
                            text="Exported profile",
                            text_color="green"
                        )
                    except Exception as e:
                        import tkinter.messagebox as msgbox
                        msgbox.showerror("Export Error", f"Cannot export profile: {e}")
                        
    def _on_search(self, event=None) -> None:
        """Handles profile search with surgical updates."""
        try:
            search_term = self.search_entry.get().lower()
            all_profiles = self.profile_manager.get_all_profiles()
            running_profiles = {p.profile_id for p in self.chromium_launcher.get_running_profiles()}
            
            if search_term:
                # Filter profiles based on search
                filtered_profiles = [p for p in all_profiles if search_term in p.name.lower()]
            else:
                filtered_profiles = all_profiles
            
            # Get IDs for comparison
            should_display_ids = {p.id for p in filtered_profiles}
            currently_displayed_ids = set(self.profile_widgets.keys())
            
            # Remove profiles that no longer match search
            profiles_to_hide = currently_displayed_ids - should_display_ids
            for profile_id in profiles_to_hide:
                self._remove_single_profile_widget(profile_id)
            
            # Add profiles that now match search
            profiles_to_show = should_display_ids - currently_displayed_ids
            for profile in filtered_profiles:
                if profile.id in profiles_to_show:
                    is_running = profile.id in running_profiles
                    self._add_single_profile_widget(profile, is_running)
            
            # Update stats
            self._update_stats()
            
        except Exception as e:
            self.logger.warning(f"Error during search: {e}")
            # Fallback to full reload if surgical update fails
            self._load_profiles()
        
    def _clear_selection(self) -> None:
        """Clears profile selection."""
        self.selected_profile_id = None
        self.edit_profile_btn.configure(state="disabled")
        self.delete_profile_btn.configure(state="disabled")
        self.launch_profile_btn.configure(state="disabled")
        self.stop_profile_btn.configure(state="disabled")
        self.export_btn.configure(state="disabled")
        
    def _on_profile_launched(self, profile: ChromiumProfile) -> None:
        """Callback after profile launch with surgical status update."""
        # Surgical update - just update this profile's status
        self._update_single_profile_status(profile.id, True)
        
        if hasattr(self, 'selected_profile_id') and self.selected_profile_id == profile.id:
            self.launch_profile_btn.configure(state="disabled")
            self.stop_profile_btn.configure(state="normal")
        
        # Update stats
        self._update_stats()
        
        self.status_label.configure(
            text=f"Launched: {profile.name}",
            text_color="green"
        )
        
    def _on_launch_error(self, error: str) -> None:
        """Callback on launch error."""
        import tkinter.messagebox as msgbox
        msgbox.showerror("Launch Error", error)
        self.status_label.configure(
            text="Launch error",
            text_color="red"
        )
        
    def _update_stats(self) -> None:
        """Updates statistics in sidebar."""
        try:
            stats = self.profile_manager.get_stats()
            running_count = len(self.chromium_launcher.get_running_profiles())
            
            self.stats_label.configure(
                text=f"Profiles: {stats['total_profiles']}\nActive: {running_count}"
            )
        except Exception as e:
            self.logger.warning(f"Error updating stats: {e}")
        
    def _refresh_status(self) -> None:
        """Refreshes running profile status every 1 second without flickering."""
        try:
            # Clean up inactive processes
            self.chromium_launcher.cleanup_orphaned_processes()
            
            # Get current data
            current_profiles = self.profile_manager.get_all_profiles()
            running_profiles = {p.profile_id for p in self.chromium_launcher.get_running_profiles()}
            
            # Apply search filter to current profiles
            search_term = self.search_entry.get().lower() if hasattr(self, 'search_entry') else ""
            if search_term:
                filtered_profiles = [p for p in current_profiles if search_term in p.name.lower()]
            else:
                filtered_profiles = current_profiles
            
            # Check if we need a full reload (profile list changed)
            current_profile_ids = {p.id for p in filtered_profiles}
            widget_profile_ids = set(self.profile_widgets.keys())
            
            needs_full_reload = (
                current_profile_ids != widget_profile_ids or  # Profile list changed
                not self.profile_widgets  # No widgets exist yet
            )
            
            if needs_full_reload:
                # Full reload needed - but this should be rare after initial load
                self._load_profiles()
            else:
                # Efficient update - just update status of existing profiles
                # Update profile statuses in manager
                for profile in current_profiles:
                    is_running = profile.id in running_profiles
                    if profile.is_active != is_running:
                        self.profile_manager.set_active_status(profile.id, is_running)
                
                # Update only the displayed status without rebuilding UI
                self._update_profile_status_display(running_profiles)
            
            # Update statistics
            self._update_stats()
            
            # Update auto-refresh indicator
            if hasattr(self, 'auto_refresh_label'):
                self.auto_refresh_label.configure(
                    text="🔄 Auto-refresh: ON",
                    text_color="green"
                )
            
        except Exception as e:
            self.logger.warning(f"Error refreshing status: {e}")
            if hasattr(self, 'auto_refresh_label'):
                self.auto_refresh_label.configure(
                    text="🔄 Auto-refresh: ERROR",
                    text_color="red"
                )
            
        # Schedule next refresh every 1 second (1000ms)
        self.after(1000, self._refresh_status)
        
    def _update_profile_status_display(self, running_profiles: set) -> None:
        """Efficiently updates only the status display of existing profile widgets."""
        try:
            for profile_id, widgets in self.profile_widgets.items():
                if not widgets or 'status_label' not in widgets or 'name_btn' not in widgets:
                    continue
                    
                profile = widgets['profile']
                is_running = profile_id in running_profiles
                
                # Update name button with running indicator
                try:
                    current_text = widgets['name_btn'].cget('text')
                    # Only update if status changed to avoid unnecessary updates
                    expected_text = f"{'🟢' if is_running else '⚫'} {profile.name}"
                    if current_text != expected_text:
                        widgets['name_btn'].configure(text=expected_text)
                except:
                    pass  # Skip if widget was destroyed
                
                # Update status label
                try:
                    if is_running:
                        process_info = self.chromium_launcher.get_profile_process(profile_id)
                        uptime = process_info.uptime if process_info else "N/A"
                        new_status_text = f"🟢 Running ({uptime})"
                    else:
                        new_status_text = "⚫ Stopped"
                    
                    # Only update if text changed to avoid unnecessary updates
                    current_status = widgets['status_label'].cget('text')
                    if current_status != new_status_text:
                        widgets['status_label'].configure(text=new_status_text)
                except:
                    pass  # Skip if widget was destroyed
                    
        except Exception as e:
            self.logger.warning(f"Error updating profile status display: {e}")
            
    def _add_single_profile_widget(self, profile: ChromiumProfile, is_running: bool) -> None:
        """Adds a single profile widget without rebuilding the entire list."""
        try:
            # Find the next available row
            existing_rows = len([w for w in self.profiles_scrollable.winfo_children() if isinstance(w, ctk.CTkFrame)])
            row = existing_rows
            
            # Background color depending on status
            fg_color = ("gray75", "gray25") if row % 2 == 0 else ("gray85", "gray15")
            
            frame = ctk.CTkFrame(self.profiles_scrollable, fg_color=fg_color)
            frame.grid(row=row, column=0, sticky="ew", padx=5, pady=1)
            frame.grid_columnconfigure((0, 1, 2, 3), weight=1)
            
            # Name (clickable)
            def select_profile_callback(pid=profile.id):
                return lambda: self._select_profile(pid)
            
            name_btn = ctk.CTkButton(
                frame,
                text=f"{'🟢' if is_running else '⚫'} {profile.name}",
                command=select_profile_callback(),
                height=35,
                anchor="w"
            )
            name_btn.grid(row=0, column=0, padx=5, pady=5, sticky="ew")
            
            # User-Agent (shortened)
            ua_text = profile.user_agent[:40] + "..." if len(profile.user_agent) > 40 else profile.user_agent
            ua_label = ctk.CTkLabel(frame, text=ua_text, anchor="w")
            ua_label.grid(row=0, column=1, padx=5, pady=5, sticky="ew")
            
            # Proxy
            proxy_text = profile.proxy[:30] + "..." if profile.proxy and len(profile.proxy) > 30 else (profile.proxy or "None")
            proxy_label = ctk.CTkLabel(frame, text=proxy_text, anchor="w")
            proxy_label.grid(row=0, column=2, padx=5, pady=5, sticky="ew")
            
            # Status
            if is_running:
                process_info = self.chromium_launcher.get_profile_process(profile.id)
                uptime = process_info.uptime if process_info else "N/A"
                status_text = f"🟢 Running ({uptime})"
            else:
                status_text = "⚫ Stopped"
                
            status_label = ctk.CTkLabel(
                frame,
                text=status_text,
                font=ctk.CTkFont(size=11)
            )
            status_label.grid(row=0, column=3, padx=5, pady=5, sticky="ew")
            
            # Store widget references
            self.profile_widgets[profile.id] = {
                'frame': frame,
                'name_btn': name_btn,
                'status_label': status_label,
                'profile': profile
            }
            
        except Exception as e:
            self.logger.warning(f"Error adding profile widget: {e}")
    
    def _remove_single_profile_widget(self, profile_id: str) -> None:
        """Removes a single profile widget without rebuilding the entire list."""
        try:
            if profile_id in self.profile_widgets:
                widgets = self.profile_widgets[profile_id]
                if 'frame' in widgets:
                    widgets['frame'].destroy()
                del self.profile_widgets[profile_id]
                
                # Clear selection if this profile was selected
                if hasattr(self, 'selected_profile_id') and self.selected_profile_id == profile_id:
                    self._clear_selection()
                    
        except Exception as e:
            self.logger.warning(f"Error removing profile widget: {e}")
    
    def _update_single_profile_status(self, profile_id: str, is_running: bool) -> None:
        """Updates a single profile's status display."""
        try:
            if profile_id not in self.profile_widgets:
                return
                
            widgets = self.profile_widgets[profile_id]
            if not widgets or 'status_label' not in widgets or 'name_btn' not in widgets:
                return
                
            profile = widgets['profile']
            
            # Update name button with running indicator
            try:
                expected_text = f"{'🟢' if is_running else '⚫'} {profile.name}"
                current_text = widgets['name_btn'].cget('text')
                if current_text != expected_text:
                    widgets['name_btn'].configure(text=expected_text)
            except:
                pass
            
            # Update status label
            try:
                if is_running:
                    process_info = self.chromium_launcher.get_profile_process(profile_id)
                    uptime = process_info.uptime if process_info else "N/A"
                    new_status_text = f"🟢 Running ({uptime})"
                else:
                    new_status_text = "⚫ Stopped"
                
                current_status = widgets['status_label'].cget('text')
                if current_status != new_status_text:
                    widgets['status_label'].configure(text=new_status_text)
            except:
                pass
                
        except Exception as e:
            self.logger.warning(f"Error updating single profile status: {e}")
        
    def _on_closing(self) -> None:
        """Handles window closing."""
        try:
            # Save window geometry
            self.config_manager.set('window_geometry', self.geometry())
            
            # Check if there are running profiles
            running_profiles = self.chromium_launcher.get_running_profiles()
            if running_profiles:
                import tkinter.messagebox as msgbox
                if msgbox.askyesno(
                    "Close Application",
                    f"You have {len(running_profiles)} running profiles.\n"
                    "Do you want to stop them before closing?"
                ):
                    terminated_count = self.chromium_launcher.terminate_all_profiles()
                    self.logger.info(f"Stopped {terminated_count} profiles")
                    
            self.logger.info("Closing application")
            self.destroy()
            
        except Exception as e:
            self.logger.error(f"Error during closing: {e}")
            self.destroy()