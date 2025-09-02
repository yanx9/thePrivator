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
        """Loads profiles with optimized async operations."""
        try:
            start_time = time.time()
            
            # Show loading state immediately
            self.status_label.configure(text="Loading profiles...")
            
            # Clear existing list efficiently
            for widget in self.profiles_scrollable.winfo_children()[1:]:
                widget.destroy()
            self.profile_widgets.clear()
            
            # Get profiles (this is fast - just JSON loading)
            profiles = self.profile_manager.get_all_profiles()
            
            # Create rows immediately with default state (show stopped)
            for i, profile in enumerate(profiles, 1):
                # Initially show as stopped - update running state asynchronously
                self._create_profile_row(i, profile, is_running=False)
                self.last_known_states[profile.id] = False
            
            # Apply current search filter if any
            if hasattr(self, 'search_entry'):
                self._filter_profiles()
            
            self._update_stats()
            self._update_action_buttons()
            
            load_time = time.time() - start_time
            self.logger.debug(f"Loaded {len(profiles)} profiles in {load_time:.2f}s")
            self.status_label.configure(text="Ready")
            
            # Update running states asynchronously to avoid blocking UI
            def update_running_states():
                try:
                    # This is the potentially expensive operation
                    running_profiles = {p.profile_id for p in self.chromium_launcher.get_running_profiles()}
                    
                    # Schedule UI updates for any running profiles
                    def update_ui_states():
                        for profile_id in running_profiles:
                            if profile_id in self.profile_widgets:
                                self.last_known_states[profile_id] = True
                                widgets = self.profile_widgets[profile_id]
                                profile = widgets['profile']
                                
                                if 'name_btn' in widgets and widgets['name_btn'].winfo_exists():
                                    widgets['name_btn'].configure(text=f"🟢 {profile.name}")
                                if 'status_label' in widgets and widgets['status_label'].winfo_exists():
                                    widgets['status_label'].configure(text="🟢 Running")
                        
                        # Update stats with correct running count
                        self._update_stats()
                    
                    # Update UI on main thread
                    self.after(0, update_ui_states)
                    
                except Exception as e:
                    self.logger.warning(f"Error updating running states: {e}")
            
            # Run expensive operation in background
            threading.Thread(target=update_running_states, daemon=True).start()
            
        except Exception as e:
            self.logger.error(f"Error loading profiles: {e}")
            self.status_label.configure(text="Error")
            
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
        """Optimized lightweight status refresh with reduced CPU usage."""
        try:
            # Only run expensive operations every few cycles
            if not hasattr(self, '_refresh_cycle_count'):
                self._refresh_cycle_count = 0
            
            self._refresh_cycle_count += 1
            
            # Clean up orphaned processes only every 10 cycles (10 seconds)
            if self._refresh_cycle_count % 10 == 0:
                self.chromium_launcher.cleanup_orphaned_processes()
            
            # Check for profile structure changes only every 5 cycles (5 seconds)  
            if self._refresh_cycle_count % 5 == 0:
                current_profiles = self.profile_manager.get_all_profiles()
                current_profile_ids = {p.id for p in current_profiles}
                widget_profile_ids = set(self.profile_widgets.keys())
                
                if current_profile_ids != widget_profile_ids:
                    self.logger.info("Profile list changed, reloading")
                    self._load_profiles()
                    return  # Skip status update since _load_profiles handles it
            
            # Quick status check - this is the most frequent operation
            try:
                # Only check running profiles if we have any widgets
                if self.profile_widgets:
                    current_running = {p.profile_id for p in self.chromium_launcher.get_running_profiles()}
                    
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
                            
                            # Update only the changed elements with error handling
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
                                self.logger.debug(f"Widget update error: {e}")
                    
                    if changes > 0:
                        self._update_stats()
                        self.logger.debug(f"Status refresh: {changes} profile(s) changed")
            except Exception as e:
                self.logger.warning(f"Error checking running profiles: {e}")
            
            # Update selected profile buttons only if needed and not too frequently
            if self.selected_profile_ids and self._refresh_cycle_count % 3 == 0:
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
        if not self.selected_profile_ids:
            # No selection - disable all buttons
            self.edit_profile_btn.configure(state="disabled")
            self.delete_profile_btn.configure(state="disabled")
            self.launch_profile_btn.configure(state="disabled")
            self.stop_profile_btn.configure(state="disabled")
            self.export_btn.configure(state="disabled")
            self.status_label.configure(text="Ready")
            return
        
        # Enable buttons based on selection count and states
        selected_count = len(self.selected_profile_ids)
        
        # Edit button only works with single selection
        if selected_count == 1:
            self.edit_profile_btn.configure(state="normal")
        else:
            self.edit_profile_btn.configure(state="disabled")
        
        # Delete and export always work with any number of selections
        self.delete_profile_btn.configure(state="normal")
        self.export_btn.configure(state="normal")
        
        # Check running states for launch/stop buttons
        running_profiles = {p.profile_id for p in self.chromium_launcher.get_running_profiles()}
        selected_running = [pid for pid in self.selected_profile_ids if pid in running_profiles]
        selected_stopped = [pid for pid in self.selected_profile_ids if pid not in running_profiles]
        
        # Launch button enabled if any selected profiles are stopped
        self.launch_profile_btn.configure(state="normal" if selected_stopped else "disabled")
        
        # Stop button enabled if any selected profiles are running  
        self.stop_profile_btn.configure(state="normal" if selected_running else "disabled")
        
        # Update status text
        if selected_count == 1:
            profile = self.profile_manager.get_profile(next(iter(self.selected_profile_ids)))
            if profile:
                self.status_label.configure(text=f"Selected: {profile.name}")
        else:
            self.status_label.configure(text=f"Selected: {selected_count} profiles")
    
    def _refresh_row_colors(self) -> None:
        """Refreshes alternating row colors after profile deletion or filtering."""
        try:
            # Get all frames that are currently gridded (visible in layout)
            visible_frames = []
            
            # Iterate through all children of the scrollable frame (skip header at row 0)
            for child in self.profiles_scrollable.winfo_children()[1:]:
                # Check if the frame is actually gridded (not removed via grid_remove())
                grid_info = child.grid_info()
                if grid_info:  # Non-empty dict means it's gridded
                    visible_frames.append(child)
            
            # Sort frames by their grid row to maintain proper order
            visible_frames.sort(key=lambda frame: frame.grid_info().get('row', 0))
            
            # Re-apply alternating colors based on position in visible list
            for i, frame in enumerate(visible_frames):
                # Row index starts at 1 (after header), so we use i+1 for proper alternation
                row_index = i + 1
                fg_color = ("gray75", "gray25") if row_index % 2 == 0 else ("gray85", "gray15")
                frame.configure(fg_color=fg_color)
                
        except Exception as e:
            self.logger.debug(f"Error refreshing row colors: {e}")
            
    def _create_new_profile(self) -> None:
        """Creates new profile with optimized UI updates."""
        try:
            dialog = ProfileDialog(self, self.profile_manager, self.config_manager)
            if dialog.result:
                # Add the new profile to UI immediately instead of full reload
                new_profile = dialog.result
                row = len(self.profile_widgets) + 1  # After existing profiles
                self._create_profile_row(row, new_profile, is_running=False)
                self.last_known_states[new_profile.id] = False
                
                # Apply search filter to the new profile
                if hasattr(self, 'search_entry'):
                    self._filter_profiles()
                
                self._update_stats()
                self.status_label.configure(text="Created profile")
                self.logger.info(f"Added new profile to UI: {new_profile.name}")
        except Exception as e:
            self.logger.error(f"Error creating profile: {e}")
            import tkinter.messagebox as msgbox
            msgbox.showerror("Error", f"Cannot create profile: {e}")
            
    def _edit_profile(self) -> None:
        """Edits selected profile with optimized UI updates."""
        if len(self.selected_profile_ids) == 1:
            profile_id = next(iter(self.selected_profile_ids))
            profile = self.profile_manager.get_profile(profile_id)
            if profile:
                try:
                    dialog = ProfileDialog(self, self.profile_manager, self.config_manager, profile)
                    if dialog.result:
                        # Update existing widget instead of full reload
                        updated_profile = dialog.result
                        if profile_id in self.profile_widgets:
                            widgets = self.profile_widgets[profile_id]
                            is_running = self.last_known_states.get(profile_id, False)
                            
                            # Update profile reference
                            widgets['profile'] = updated_profile
                            
                            # Update name button
                            if 'name_btn' in widgets and widgets['name_btn'].winfo_exists():
                                status_icon = "🟢" if is_running else "⚫"
                                widgets['name_btn'].configure(text=f"{status_icon} {updated_profile.name}")
                            
                            # Find and update other fields if the widget structure supports it
                            frame = widgets['frame']
                            children = frame.winfo_children()
                            if len(children) >= 3:  # UA and Proxy labels
                                # Update User-Agent
                                ua_text = updated_profile.user_agent[:45] + "..." if len(updated_profile.user_agent) > 45 else updated_profile.user_agent
                                children[1].configure(text=ua_text)
                                
                                # Update Proxy 
                                proxy_text = updated_profile.proxy[:30] + "..." if updated_profile.proxy and len(updated_profile.proxy) > 30 else (updated_profile.proxy or "None")
                                children[2].configure(text=proxy_text)
                        
                        self.status_label.configure(text="Updated profile")
                        self.logger.info(f"Updated profile in UI: {updated_profile.name}")
                except Exception as e:
                    self.logger.error(f"Error editing profile: {e}")
                    import tkinter.messagebox as msgbox
                    msgbox.showerror("Error", f"Cannot edit profile: {e}")
                    
    def _delete_profile(self) -> None:
        """Deletes selected profiles with optimized async operations."""
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
            
            # Update UI immediately to show deletion in progress
            self.status_label.configure(text="Deleting...")
            
            # Remove widgets and update UI immediately
            deleted_count = 0
            for profile in profiles_to_delete:
                # Remove from known states
                if profile.id in self.last_known_states:
                    del self.last_known_states[profile.id]
                
                # Remove widget immediately for responsive UI
                if profile.id in self.profile_widgets:
                    widgets = self.profile_widgets[profile.id]
                    if 'frame' in widgets:
                        widgets['frame'].destroy()
                    del self.profile_widgets[profile.id]
                
                deleted_count += 1
            
            # Clear selections for deleted profiles
            deleted_ids = {p.id for p in profiles_to_delete}
            self.selected_profile_ids -= deleted_ids
            self._update_action_buttons()
            
            # Fix alternating row colors after deletion
            self._refresh_row_colors()
            self._update_stats()
            
            self.status_label.configure(text=f"Deleted {deleted_count} profile(s)")
            
            # Delete actual profile data and files in background thread
            def delete_files():
                errors = []
                for profile in profiles_to_delete:
                    try:
                        self.profile_manager.delete_profile(profile.id)
                        self.logger.info(f"Deleted profile data: {profile.name}")
                    except Exception as e:
                        errors.append(f"{profile.name}: {str(e)}")
                        self.logger.error(f"Error deleting profile {profile.name}: {e}")
                
                # Show errors if any occurred
                if errors:
                    def show_errors():
                        import tkinter.messagebox as msgbox
                        msgbox.showerror("Deletion Errors", f"Some profile data could not be deleted:\n\n" + "\n".join(errors))
                    self.after(0, show_errors)
            
            # Run file deletion in background to avoid blocking UI
            threading.Thread(target=delete_files, daemon=True).start()
                        
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
        """Stops selected profiles with optimized async operations."""
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
        
        # Update UI immediately to show stopping state
        for profile in profiles_to_stop:
            if profile.id in self.profile_widgets:
                widgets = self.profile_widgets[profile.id]
                if 'name_btn' in widgets and widgets['name_btn'].winfo_exists():
                    widgets['name_btn'].configure(text=f"⏸️ {profile.name}")
                if 'status_label' in widgets and widgets['status_label'].winfo_exists():
                    widgets['status_label'].configure(text="⏸️ Stopping")
        
        def stop_thread():
            stopped_count = 0
            errors = []
            
            # Batch process termination for efficiency
            for profile in profiles_to_stop:
                try:
                    # Use force termination for faster response
                    success = self.chromium_launcher.terminate_profile(profile.id, force=True)
                    if success:
                        # Update state immediately without file I/O
                        self.last_known_states[profile.id] = False
                        stopped_count += 1
                        self.logger.info(f"Stopped profile: {profile.name}")
                        
                        # Schedule UI update
                        def update_profile_ui(prof_id=profile.id, prof_name=profile.name):
                            if prof_id in self.profile_widgets:
                                widgets = self.profile_widgets[prof_id]
                                if 'name_btn' in widgets and widgets['name_btn'].winfo_exists():
                                    widgets['name_btn'].configure(text=f"⚫ {prof_name}")
                                if 'status_label' in widgets and widgets['status_label'].winfo_exists():
                                    widgets['status_label'].configure(text="⚫ Stopped")
                        
                        self.after(0, update_profile_ui)
                    else:
                        errors.append(profile.name)
                except Exception as e:
                    errors.append(f"{profile.name}: {str(e)}")
                    self.logger.error(f"Error stopping profile {profile.name}: {e}")
            
            # Batch update profile manager states (async file I/O)
            def batch_update_states():
                for profile in profiles_to_stop:
                    try:
                        if self.last_known_states.get(profile.id) is False:
                            self.profile_manager.set_active_status(profile.id, False)
                    except Exception as e:
                        self.logger.warning(f"Failed to update profile state: {e}")
            
            # Run state updates in separate thread to avoid blocking
            threading.Thread(target=batch_update_states, daemon=True).start()
            
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
            search_term = self.search_entry.get().lower().strip()
            visible_count = 0
            
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
            
            # Update scrollable frame label
            if search_term:
                self.profiles_scrollable.configure(label_text=f"Profiles ({visible_count} shown)")
            else:
                self.profiles_scrollable.configure(label_text="Chromium Profiles")
            
            # Refresh row colors after filtering to maintain alternating pattern
            self._refresh_row_colors()
                
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
