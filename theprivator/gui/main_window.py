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
from gui.widgets.tooltip import ToolTip
from utils.profile_io import ProfileIOManager


class MainWindow(ctk.CTk):
    """Main thePrivator application window - optimized for fast startup."""
    
    def __init__(self, config_dir: Optional[Path] = None):
        super().__init__()
        
        self.logger = get_logger(__name__)
        self.config_manager = ConfigManager(config_dir)
        self.profile_manager = ProfileManager(config_dir, self.config_manager)
        self.chromium_launcher = ChromiumLauncher(self.config_manager)
        self.profile_io = ProfileIOManager(self.profile_manager, self.chromium_launcher)
        
        self.selected_profile_ids: set = set()  # Changed to support multiple selections
        
        # Lightweight data structures only
        self.profile_widgets = {}  # profile_id -> widget references
        self.last_known_states = {}  # Last known running states
        self.tooltips = {}  # Store tooltip references
        self.refresh_interval = 1000  
        
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
            height=35,
            fg_color="gray",
            hover_color="darkgray"
        )
        self.export_btn.grid(row=10, column=0, padx=20, pady=2, sticky="ew")
        
        # Configuration button
        self.config_btn = ctk.CTkButton(
            self.sidebar,
            text="⚙️ Configuration",
            command=self._open_configuration,
            height=35,
            fg_color="gray",
            hover_color="darkgray"
        )
        self.config_btn.grid(row=11, column=0, padx=20, pady=2, sticky="ew")
        
        # Status
        self.status_label = ctk.CTkLabel(
            self.sidebar,
            text="Ready",
            font=ctk.CTkFont(size=12)
        )
        self.status_label.grid(row=12, column=0, padx=20, pady=(10, 20))
        
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
        
        # Setup comprehensive scrolling
        self._setup_scrolling_for_frame(self.profiles_scrollable)
        
        # Table header
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
        """Loads profiles without heavy operations."""
        try:
            start_time = time.time()
            print(f"[DEBUG] Starting _load_profiles at {time.time()}")
            
            # Clear existing list
            print(f"[DEBUG] Clearing widgets: {time.time() - start_time:.3f}s")
            for widget in self.profiles_scrollable.winfo_children()[1:]:
                widget.destroy()
            self.profile_widgets.clear()
            
            print(f"[DEBUG] Getting all profiles: {time.time() - start_time:.3f}s")
            profiles = self.profile_manager.get_all_profiles()
            print(f"[DEBUG] Got {len(profiles)} profiles: {time.time() - start_time:.3f}s")
            
            # Get current running profiles
            print(f"[DEBUG] Getting running profiles: {time.time() - start_time:.3f}s")
            running_profiles = {p.profile_id for p in self.chromium_launcher.get_running_profiles()}
            print(f"[DEBUG] Found {len(running_profiles)} running profiles: {time.time() - start_time:.3f}s")
            
            # Create rows for ALL profiles (don't filter here)
            print(f"[DEBUG] Creating rows for {len(profiles)} profiles: {time.time() - start_time:.3f}s")
            for i, profile in enumerate(profiles, 1):
                if i % 10 == 0:  # Log every 10th profile
                    print(f"[DEBUG] Created {i} rows: {time.time() - start_time:.3f}s")
                is_running = profile.id in running_profiles
                self._create_profile_row(i, profile, is_running)
                self.last_known_states[profile.id] = is_running
            
            # Apply current search filter if any
            print(f"[DEBUG] Applying search filter: {time.time() - start_time:.3f}s")
            if hasattr(self, 'search_entry'):
                self._filter_profiles()
            
            print(f"[DEBUG] Updating stats: {time.time() - start_time:.3f}s")
            self._update_stats()
            print(f"[DEBUG] Stats updated: {time.time() - start_time:.3f}s")
            
            print(f"[DEBUG] About to call _update_action_buttons: {time.time() - start_time:.3f}s")
            self._update_action_buttons()  # Update button states after loading
            print(f"[DEBUG] Action buttons updated: {time.time() - start_time:.3f}s")
            
            print(f"[DEBUG] About to calculate load_time: {time.time() - start_time:.3f}s")
            load_time = time.time() - start_time
            print(f"[DEBUG] Load time calculated: {load_time:.3f}s")
            
            print(f"[DEBUG] About to log completion: {time.time() - start_time:.3f}s")
            print(f"[DEBUG] _load_profiles completed in {load_time:.3f}s")
            self.logger.debug(f"Loaded {len(profiles)} profiles in {load_time:.2f}s")
            print(f"[DEBUG] Logger debug called: {time.time() - start_time:.3f}s")
            
            print(f"[DEBUG] About to exit _load_profiles method: {time.time() - start_time:.3f}s")
            
        except Exception as e:
            print(f"[DEBUG] ERROR in _load_profiles: {e}")
            self.logger.error(f"Error loading profiles: {e}")
            self.status_label.configure(text="Error")
            
        print(f"[DEBUG] _load_profiles method ending: {time.time() - start_time:.3f}s")
            
    def _create_profile_row(self, row: int, profile: ChromiumProfile, is_running: bool) -> None:
        """Creates profile row with hover effects and tooltips."""
        fg_color = ("gray75", "gray25") if row % 2 == 0 else ("gray85", "gray15")
        
        frame = ctk.CTkFrame(self.profiles_scrollable, fg_color=fg_color)
        frame.grid(row=row, column=0, sticky="ew", padx=5, pady=1)
        
        # Column weights to match header
        frame.grid_columnconfigure(0, weight=2)  # Name
        frame.grid_columnconfigure(1, weight=3)  # User-Agent
        frame.grid_columnconfigure(2, weight=2)  # Proxy  
        frame.grid_columnconfigure(3, weight=1)  # Status
        
        # Name button with enhanced styling
        def select_callback(pid=profile.id):
            return lambda: self._select_profile(pid)
        
        # Create styled name button
        name_btn = ctk.CTkButton(
            frame,
            text=f"{'🟢' if is_running else '⚫'} {profile.name}",
            command=select_callback(),
            height=35,
            anchor="w",
            font=ctk.CTkFont(size=12, weight="bold"),  # Bold font
            fg_color="transparent",  # Transparent background
            hover_color=("gray65", "gray35"),  # Darker on hover
            text_color=("gray10", "gray90"),  # Better contrast
            border_width=0,                   # <-- will become 1 on selection
            border_color="white"              # <-- thin white border when selected
        )
        name_btn.grid(row=0, column=0, padx=5, pady=5, sticky="ew")
        
        # Tooltip: use a provider that reads the latest notes on demand
        def notes_provider(pid=profile.id, name=profile.name, pm=self.profile_manager):
            p = pm.get_profile(pid)
            notes = (getattr(p, 'notes', '') or '').strip()
            if not notes:
                return ""
            if len(notes) > 300:
                notes = notes[:297] + "..."
            return f"📝 Notes for {name}:\n\n{notes}"

        tooltip = ToolTip(
            name_btn,
            text=notes_provider,   # callable evaluated right before showing
            delay=400,
            wraplength=350
        )

        # Store tooltip reference for potential updates (optional)
        if 'tooltips' not in self.__dict__:
            self.tooltips = {}
        self.tooltips[profile.id] = tooltip
        
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
        
        # Bind scrolling to all widgets in this row
        row_widgets = [frame, name_btn, ua_label, proxy_label, status_label]
        for widget in row_widgets:
            self._bind_mousewheel_recursive(widget, self.profiles_scrollable)

        # Store references
        self.profile_widgets[profile.id] = {
            'frame': frame,
            'name_btn': name_btn,
            'status_label': status_label,
            'profile': profile
        }
        
        # Apply selection styling if this profile is selected
        if profile.id in self.selected_profile_ids:
            try:
                name_btn.configure(border_width=1, border_color="white")
            except Exception:
                pass

    def _bind_mousewheel_recursive(self, widget, canvas_widget):
        """Recursively binds mouse wheel to widget and all its children."""
        def _on_mousewheel(event):
            # Calculate scroll amount
            if event.delta:
                # Windows
                delta = -1 * (event.delta / 120)
            else:
                # Linux
                if event.num == 4:
                    delta = -1
                elif event.num == 5:
                    delta = 1
                else:
                    delta = 0
            
            # Scroll the target canvas
            try:
                if hasattr(canvas_widget, '_parent_canvas'):
                    canvas_widget._parent_canvas.yview_scroll(int(delta), "units")
                elif hasattr(canvas_widget, 'canvas'):
                    canvas_widget.canvas.yview_scroll(int(delta), "units")
            except Exception as e:
                self.logger.debug(f"Scroll error: {e}")
        
        # Bind to current widget
        widget.bind("<MouseWheel>", _on_mousewheel, "+")  # "+" means add, don't replace
        widget.bind("<Button-4>", _on_mousewheel, "+")
        widget.bind("<Button-5>", _on_mousewheel, "+")
        
        # Recursively bind to all children
        try:
            for child in widget.winfo_children():
                self._bind_mousewheel_recursive(child, canvas_widget)
        except:
            pass

    def _setup_scrolling_for_frame(self, scrollable_frame):
        """Sets up comprehensive scrolling for a scrollable frame."""
        # Initial binding
        self._bind_mousewheel_recursive(scrollable_frame, scrollable_frame)
        
        # Also bind to the internal canvas directly
        def delayed_bind():
            try:
                if hasattr(scrollable_frame, '_parent_canvas'):
                    canvas = scrollable_frame._parent_canvas
                elif hasattr(scrollable_frame, 'canvas'):
                    canvas = scrollable_frame.canvas
                else:
                    return
                    
                def canvas_scroll(event):
                    if event.delta:
                        delta = -1 * (event.delta / 120)
                    else:
                        delta = -1 if event.num == 4 else 1 if event.num == 5 else 0
                    canvas.yview_scroll(int(delta), "units")
                
                canvas.bind("<MouseWheel>", canvas_scroll, "+")
                canvas.bind("<Button-4>", canvas_scroll, "+")
                canvas.bind("<Button-5>", canvas_scroll, "+")
            except:
                pass
        
        # Delay to ensure canvas is created
        scrollable_frame.after(100, delayed_bind)

    def _refresh_status(self) -> None:
        """Lightweight status refresh that updates in-place."""
        try:
            import time
            start_time = time.time()
            print(f"[DEBUG] _refresh_status: Starting")
            self.logger.debug("Running status refresh cycle")
            
            # Clean up orphaned processes first
            print(f"[DEBUG] _refresh_status: About to cleanup orphaned processes: {time.time() - start_time:.3f}s")
            self.chromium_launcher.cleanup_orphaned_processes()
            print(f"[DEBUG] _refresh_status: Orphaned processes cleaned: {time.time() - start_time:.3f}s")
            
            # Get current running profiles
            print(f"[DEBUG] _refresh_status: About to get running profiles: {time.time() - start_time:.3f}s")
            current_running = {p.profile_id for p in self.chromium_launcher.get_running_profiles()}
            print(f"[DEBUG] _refresh_status: Got running profiles: {time.time() - start_time:.3f}s")
            
            # Check if profile list structure changed (added/removed profiles)
            print(f"[DEBUG] _refresh_status: About to get all profiles: {time.time() - start_time:.3f}s")
            current_profiles = self.profile_manager.get_all_profiles()
            print(f"[DEBUG] _refresh_status: Got all profiles: {time.time() - start_time:.3f}s")
            
            current_profile_ids = {p.id for p in current_profiles}
            widget_profile_ids = set(self.profile_widgets.keys())
            print(f"[DEBUG] _refresh_status: Calculated profile ID sets: {time.time() - start_time:.3f}s")
            
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
                                    text=f"{'🟢' if is_running_now else '⚫'} {profile.name}",
                                    font=ctk.CTkFont(size=12, weight="bold")
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
            if self.selected_profile_ids:
                self._update_action_buttons()
                    
        except Exception as e:
            self.logger.error(f"Error in refresh cycle: {e}")
            
        # Schedule next refresh
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
        """Selects/deselects profile and visually marks the selected rows."""
        # Toggle selection
        if profile_id in self.selected_profile_ids:
            # Deselect profile
            self.selected_profile_ids.remove(profile_id)
            try:
                if profile_id in self.profile_widgets:
                    self.profile_widgets[profile_id]['name_btn'].configure(border_width=0)
            except Exception:
                pass
        else:
            # Select profile
            self.selected_profile_ids.add(profile_id)
            try:
                if profile_id in self.profile_widgets:
                    self.profile_widgets[profile_id]['name_btn'].configure(
                        border_width=1, border_color="white"
                    )
            except Exception:
                pass
        
        # Update button states based on selection
        self._update_action_buttons()
    
    def _update_action_buttons(self) -> None:
        """Updates action button states based on current selections."""
        import time
        start_time = time.time()
        print(f"[DEBUG] _update_action_buttons: Starting")
        
        print(f"[DEBUG] _update_action_buttons: Checking selection count: {time.time() - start_time:.3f}s")
        if not self.selected_profile_ids:
            print(f"[DEBUG] _update_action_buttons: No selection - disabling buttons: {time.time() - start_time:.3f}s")
            # No selection - disable all buttons
            self.edit_profile_btn.configure(state="disabled")
            self.delete_profile_btn.configure(state="disabled")
            self.launch_profile_btn.configure(state="disabled")
            self.stop_profile_btn.configure(state="disabled")
            self.export_btn.configure(state="disabled")
            self.status_label.configure(text="Ready")
            print(f"[DEBUG] _update_action_buttons: Completed (no selection) in {time.time() - start_time:.3f}s")
            return
        
        # Enable buttons based on selection count and states
        selected_count = len(self.selected_profile_ids)
        print(f"[DEBUG] _update_action_buttons: Selected count = {selected_count}: {time.time() - start_time:.3f}s")
        
        # Edit button only works with single selection
        if selected_count == 1:
            self.edit_profile_btn.configure(state="normal")
        else:
            self.edit_profile_btn.configure(state="disabled")
        print(f"[DEBUG] _update_action_buttons: Configured edit button: {time.time() - start_time:.3f}s")
        
        # Delete and export always work with any number of selections
        self.delete_profile_btn.configure(state="normal")
        self.export_btn.configure(state="normal")
        print(f"[DEBUG] _update_action_buttons: Configured delete/export buttons: {time.time() - start_time:.3f}s")
        
        # Check running states for launch/stop buttons
        print(f"[DEBUG] _update_action_buttons: About to call get_running_profiles: {time.time() - start_time:.3f}s")
        running_profiles = {p.profile_id for p in self.chromium_launcher.get_running_profiles()}
        print(f"[DEBUG] _update_action_buttons: Got running profiles: {time.time() - start_time:.3f}s")
        
        selected_running = [pid for pid in self.selected_profile_ids if pid in running_profiles]
        selected_stopped = [pid for pid in self.selected_profile_ids if pid not in running_profiles]
        print(f"[DEBUG] _update_action_buttons: Calculated running/stopped: {time.time() - start_time:.3f}s")
        
        # Launch button enabled if any selected profiles are stopped
        self.launch_profile_btn.configure(state="normal" if selected_stopped else "disabled")
        
        # Stop button enabled if any selected profiles are running  
        self.stop_profile_btn.configure(state="normal" if selected_running else "disabled")
        print(f"[DEBUG] _update_action_buttons: Configured launch/stop buttons: {time.time() - start_time:.3f}s")
        
        # Update status text
        if selected_count == 1:
            print(f"[DEBUG] _update_action_buttons: Getting profile for status: {time.time() - start_time:.3f}s")
            profile = self.profile_manager.get_profile(next(iter(self.selected_profile_ids)))
            if profile:
                self.status_label.configure(text=f"Selected: {profile.name}")
        else:
            self.status_label.configure(text=f"Selected: {selected_count} profiles")
        
        total_time = time.time() - start_time
        print(f"[DEBUG] _update_action_buttons: Completed in {total_time:.3f}s")
    
    def _refresh_row_colors(self) -> None:
        """Refreshes alternating row colors after profile deletion or filtering."""
        try:
            import time
            start_time = time.time()
            print(f"[DEBUG] _refresh_row_colors: Starting (OPTIMIZED)")
            
            # OPTIMIZED: Use cached widget references instead of expensive winfo_children() calls
            visible_frames = []
            
            print(f"[DEBUG] _refresh_row_colors: Using cached widgets: {time.time() - start_time:.3f}s")
            
            # Get visible frames from our cached profile_widgets (much faster than GUI traversal)
            for profile_id, widgets in self.profile_widgets.items():
                if not widgets or 'frame' not in widgets:
                    continue
                    
                frame = widgets['frame']
                
                # OPTIMIZED: Check if frame is visible using grid_info() only once
                try:
                    grid_info = frame.grid_info()
                    if grid_info:  # Non-empty dict means it's gridded (visible)
                        # Store both frame and its row for sorting
                        visible_frames.append((frame, grid_info.get('row', 0)))
                except Exception:
                    # Frame might be destroyed, skip it
                    continue
            
            print(f"[DEBUG] _refresh_row_colors: Found {len(visible_frames)} visible frames: {time.time() - start_time:.3f}s")
            
            # OPTIMIZED: Sort by row number (already extracted above)
            visible_frames.sort(key=lambda item: item[1])
            print(f"[DEBUG] _refresh_row_colors: Sorted frames: {time.time() - start_time:.3f}s")
            
            # OPTIMIZED: Apply colors without additional system calls
            for i, (frame, _) in enumerate(visible_frames):
                if i % 10 == 0 and i > 0:  # Log every 10th frame
                    print(f"[DEBUG] _refresh_row_colors: Configured {i} frames: {time.time() - start_time:.3f}s")
                    
                # Row index starts at 1 (after header), so we use i+1 for proper alternation
                row_index = i + 1
                fg_color = ("gray75", "gray25") if row_index % 2 == 0 else ("gray85", "gray15")
                
                # OPTIMIZED: Only configure if color actually needs to change
                try:
                    current_color = frame.cget('fg_color')
                    if current_color != fg_color:
                        frame.configure(fg_color=fg_color)
                except Exception:
                    # Frame might be destroyed, skip it
                    continue
            
            total_time = time.time() - start_time
            print(f"[DEBUG] _refresh_row_colors: Completed in {total_time:.3f}s")
                
        except Exception as e:
            self.logger.debug(f"Error refreshing row colors: {e}")
            
    def _create_new_profile(self) -> None:
        """Creates new profile."""
        try:
            dialog = ProfileDialog(self, self.profile_manager, self.config_manager)
            if dialog.result:
                # Don't reload everything - let refresh pick it up
                self.status_label.configure(text="Created profile")
                # Force immediate refresh
                self.after(100, self._refresh_status)
        except Exception as e:
            self.logger.error(f"Error creating profile: {e}")
            import tkinter.messagebox as msgbox
            msgbox.showerror("Error", f"Cannot create profile: {e}")
            
    def _edit_profile(self) -> None:
        """Edits selected profile (only works with single selection)."""
        if len(self.selected_profile_ids) == 1:
            profile_id = next(iter(self.selected_profile_ids))
            profile = self.profile_manager.get_profile(profile_id)
            if profile:
                try:
                    dialog = ProfileDialog(self, self.profile_manager, self.config_manager, profile)
                    if dialog.result:
                        self._load_profiles()
                        self.status_label.configure(text="Updated profile")
                except Exception as e:
                    self.logger.error(f"Error editing profile: {e}")
                    import tkinter.messagebox as msgbox
                    msgbox.showerror("Error", f"Cannot edit profile: {e}")
                    
    def _delete_profile(self) -> None:
        """Deletes selected profiles."""
        if not self.selected_profile_ids:
            return
            
        profiles_to_delete = []
        running_profiles = []
        
        for profile_id in self.selected_profile_ids:
            profile = self.profile_manager.get_profile(profile_id)
            if profile:
                if self.chromium_launcher.is_profile_running(profile.id):
                    running_profiles.append(profile.name)
                else:
                    profiles_to_delete.append(profile)
        
        if running_profiles:
            import tkinter.messagebox as msgbox
            msgbox.showwarning("Profiles Running", f"Stop the following profiles before deletion:\n{', '.join(running_profiles)}")
            return
        
        if not profiles_to_delete:
            return
            
        import tkinter.messagebox as msgbox
        profile_names = [p.name for p in profiles_to_delete]
        if msgbox.askyesno("Confirmation", f"Delete {len(profiles_to_delete)} profile(s)?\n\n{', '.join(profile_names)}\n\nThis will permanently remove all profile data."):
            try:
                deleted_count = 0
                for profile in profiles_to_delete:
                    # Remove from known states
                    if profile.id in self.last_known_states:
                        del self.last_known_states[profile.id]
                        
                    # Delete profile
                    self.profile_manager.delete_profile(profile.id)

                    # Remove widget immediately
                    if profile.id in self.profile_widgets:
                        widgets = self.profile_widgets[profile.id]
                        if 'frame' in widgets:
                            widgets['frame'].destroy()
                        del self.profile_widgets[profile.id]
                    
                    deleted_count += 1
                    self.logger.info(f"Deleted profile: {profile.name}")

                # Clear selections for deleted profiles
                deleted_ids = {p.id for p in profiles_to_delete}
                self.selected_profile_ids -= deleted_ids
                self._update_action_buttons()
                
                # Fix alternating row colors after deletion
                self._refresh_row_colors()
                
                self.status_label.configure(text=f"Deleted {deleted_count} profile(s)")
                self._update_stats()
            except Exception as e:
                msgbox.showerror("Error", f"Cannot delete: {e}")
                        
    def _launch_profile(self) -> None:
        """Launches selected profiles."""
        if not self.selected_profile_ids:
            return
            
        profiles_to_launch = []
        for profile_id in self.selected_profile_ids:
            profile = self.profile_manager.get_profile(profile_id)
            if profile and not self.chromium_launcher.is_profile_running(profile.id):
                profiles_to_launch.append(profile)
        
        if not profiles_to_launch:
            return
            
        if not self.chromium_launcher._chromium_path:
            import tkinter.messagebox as msgbox
            msgbox.showerror("Chromium Not Found", "Please install Chrome/Chromium")
            return
        
        def launch_multiple():
            launched_count = 0
            errors = []
            
            for profile in profiles_to_launch:
                try:
                    self.chromium_launcher.launch_profile(profile)
                    self.profile_manager.mark_as_used(profile.id)
                    self.profile_manager.set_active_status(profile.id, True)
                    launched_count += 1
                    self.after(100, lambda p=profile: self._on_profile_launched(p))
                except Exception as e:
                    errors.append(f"{profile.name}: {str(e)}")
            
            if errors:
                error_msg = "\n".join(errors)
                self.after(100, lambda: self._on_launch_error(f"Failed to launch some profiles:\n{error_msg}"))
            else:
                self.after(100, lambda: self.status_label.configure(text=f"Launched {launched_count} profile(s)"))
                        
        threading.Thread(target=launch_multiple, daemon=True).start()
        self.status_label.configure(text="Launching...")
        profile_names = [p.name for p in profiles_to_launch]
        self.logger.info(f"Launching profiles: {', '.join(profile_names)}")
                
    def _stop_profile(self) -> None:
        """Stops selected profiles in background thread."""
        if not self.selected_profile_ids:
            return
            
        profiles_to_stop = []
        for profile_id in self.selected_profile_ids:
            profile = self.profile_manager.get_profile(profile_id)
            if profile and self.chromium_launcher.is_profile_running(profile.id):
                profiles_to_stop.append(profile)
        
        if not profiles_to_stop:
            return
        
        # Disable button immediately to prevent double-clicks
        self.stop_profile_btn.configure(state="disabled")
        self.status_label.configure(text="Stopping...")
        
        def stop_thread():
            stopped_count = 0
            errors = []
            
            for profile in profiles_to_stop:
                try:
                    success = self.chromium_launcher.terminate_profile(profile.id)
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
                        
                        stopped_count += 1
                        self.logger.info(f"Stopped profile: {profile.name}")
                    else:
                        errors.append(profile.name)
                except Exception as e:
                    errors.append(f"{profile.name}: {str(e)}")
                    self.logger.error(f"Error stopping profile {profile.name}: {e}")
            
            def update_ui():
                if errors:
                    error_msg = "\n".join(errors)
                    self.status_label.configure(text="Some profiles failed to stop")
                    import tkinter.messagebox as msgbox
                    msgbox.showerror("Error", f"Cannot stop some profiles:\n{error_msg}")
                else:
                    self.status_label.configure(text=f"Stopped {stopped_count} profile(s)")
                
                self._update_stats()
                self._update_action_buttons()
            
            self.after(0, update_ui)
        
        threading.Thread(target=stop_thread, daemon=True).start()
                    
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
        """Exports selected profiles using ProfileIOManager."""
        if not self.selected_profile_ids:
            import tkinter.messagebox as msgbox
            msgbox.showwarning("No Selection", "Please select at least one profile to export")
            return
            
        try:
            result = self.profile_io.export_selected_profiles(
                list(self.selected_profile_ids), 
                parent_window=self
            )
            
            if result:
                self.status_label.configure(
                    text=f"Exported {result['profile_count']} profile(s)", 
                    text_color="green"
                )
                
        except Exception as e:
            self.logger.error(f"Error exporting profiles: {e}")
            import tkinter.messagebox as msgbox
            msgbox.showerror("Error", f"Cannot export profiles: {e}")

    def _import_profile(self) -> None:
        """Imports profiles using ProfileIOManager."""
        try:
            # Show progress
            self.status_label.configure(text="Importing...", text_color="yellow")
            self.update_idletasks()
            
            result = self.profile_io.import_profiles(parent_window=self)
            
            if result:
                # Force full reload of profile list
                self._load_profiles()
                self._update_stats()
                
                self.status_label.configure(
                    text=f"Imported {result['profile_count']} profile(s)", 
                    text_color="green"
                )
            else:
                self.status_label.configure(text="Ready")
                    
        except Exception as e:
            import tkinter.messagebox as msgbox
            msgbox.showerror("Import Error", f"Cannot import profiles:\n{e}")
            self.status_label.configure(text="Import failed", text_color="red")
            self.logger.error(f"Import error: {e}")
                        
    def _on_search(self, event=None) -> None:
        """Handles search with efficient filtering."""
        # Cancel any pending search
        if hasattr(self, '_search_timer'):
            self.after_cancel(self._search_timer)
        
        # Schedule search after 100ms of no typing (reduced from 300ms)
        self._search_timer = self.after(100, self._filter_profiles)
            
    def _filter_profiles(self) -> None:
        """Efficiently filters profiles without recreating widgets."""
        try:
            import time
            start_time = time.time()
            print(f"[DEBUG] _filter_profiles: Starting")
            
            search_term = self.search_entry.get().lower().strip()
            visible_count = 0
            
            print(f"[DEBUG] _filter_profiles: Showing/hiding widgets: {time.time() - start_time:.3f}s")
            # Show/hide existing widgets based on search
            for profile_id, widgets in self.profile_widgets.items():
                if not widgets or 'frame' not in widgets:
                    continue
                    
                profile = widgets['profile']
                frame = widgets['frame']
                
                # Check if profile matches search
                if not search_term or search_term in profile.name.lower():
                    frame.grid()  # Show widget
                    visible_count += 1
                else:
                    frame.grid_remove()  # Hide widget (keeps in memory)
            
            print(f"[DEBUG] _filter_profiles: Updating label: {time.time() - start_time:.3f}s")
            # Update scrollable frame label
            if search_term:
                self.profiles_scrollable.configure(label_text=f"Profiles ({visible_count} shown)")
            else:
                self.profiles_scrollable.configure(label_text="Chromium Profiles")
            
            print(f"[DEBUG] _filter_profiles: About to call _refresh_row_colors: {time.time() - start_time:.3f}s")
            # OPTIMIZED: Only refresh row colors if we actually filtered (not during initial load)
            if search_term:
                print(f"[DEBUG] _filter_profiles: Calling _refresh_row_colors (search term present)")
                self._refresh_row_colors()
            else:
                print(f"[DEBUG] _filter_profiles: Skipping _refresh_row_colors (no search term - initial load)")
            
            total_time = time.time() - start_time
            print(f"[DEBUG] _filter_profiles: Completed in {total_time:.3f}s")
                
        except Exception as e:
            self.logger.error(f"Error filtering profiles: {e}")
        
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
        
        if profile.id in self.selected_profile_ids:
            self._update_action_buttons()
        
        self._update_stats()
        self.status_label.configure(text=f"Launched: {profile.name}")
        
    def _on_launch_error(self, error: str) -> None:
        """Callback on launch error."""
        import tkinter.messagebox as msgbox
        msgbox.showerror("Launch Error", error)
        self.status_label.configure(text="Launch error")
        self.logger.error(f"Launch error: {error}")
    
    def _open_configuration(self) -> None:
        """Opens the configuration dialog."""
        try:
            from gui.config_dialog import ConfigDialog
            
            dialog = ConfigDialog(self, self.config_manager)
            self.wait_window(dialog)
            
            # If settings were changed, we might need to refresh components
            if dialog.get_result():
                self.status_label.configure(
                    text="Configuration updated",
                    text_color="green"
                )
                self.logger.info("Configuration dialog completed with changes")
                
                # Refresh chromium path in launcher
                self.chromium_launcher._chromium_path = self.chromium_launcher._find_chromium_executable()
                
        except Exception as e:
            self.logger.error(f"Error opening configuration dialog: {e}")
            import tkinter.messagebox as msgbox
            msgbox.showerror("Error", f"Cannot open configuration dialog: {e}")

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
